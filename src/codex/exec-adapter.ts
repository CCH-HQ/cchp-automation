import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { normalizeExecEvent, type NormalizedEvent } from "./events"

export type CodexExecTerminal = "completed" | "failed" | "interrupted"

export interface ExecRunOptions {
  codexBin: string
  cwd: string
  env: Record<string, string>
  prompt: string
  resumeSessionId?: string
  model?: string
  profile?: string
  sandbox?: "read-only" | "workspace-write" | "danger-full-access"
  ephemeral?: boolean
  strictConfig?: boolean
  ignoreUserConfig?: boolean
  outputLastMessage?: string
  outputSchema?: string
  timeoutMs?: number
  interruptGraceMs?: number
  termGraceMs?: number
  killGraceMs?: number
  signal?: AbortSignal
  onEvent?: (event: NormalizedEvent) => void | Promise<void>
  onStderr?: (line: string) => void | Promise<void>
}

export interface ExecRunResult {
  exitCode: number
  signal: NodeJS.Signals | null
  sessionId: string
  terminal: CodexExecTerminal
  events: NormalizedEvent[]
  lastMessage?: string
  stderr: string
}

export interface CodexExecHandle {
  pid: number
  started: Promise<{ sessionId: string }>
  completed: Promise<ExecRunResult>
  interrupt(): Promise<void>
  detachForRestart(): Promise<void>
}

export class CodexExecProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "CodexExecProtocolError"
  }
}

export class CodexExecTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`codex exec exceeded ${timeoutMs}ms`)
    this.name = "CodexExecTimeoutError"
  }
}

export class CodexExecRestartError extends Error {
  constructor() {
    super("codex exec stopped for durable restart")
    this.name = "CodexExecRestartError"
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildArgs(options: ExecRunOptions): string[] {
  const args = ["exec", "--json"]
  if (options.strictConfig ?? true) args.push("--strict-config")
  if (options.ignoreUserConfig) args.push("--ignore-user-config")
  if (options.model) args.push("--model", options.model)
  if (options.profile) args.push("--profile", options.profile)
  if (options.outputLastMessage) args.push("--output-last-message", options.outputLastMessage)
  if (options.outputSchema) args.push("--output-schema", options.outputSchema)

  if (options.resumeSessionId) {
    // Codex 0.146 does not expose `--sandbox` on the resume subcommand. The
    // resumed rollout keeps the sandbox selected when the thread was created.
    args.push("resume", options.resumeSessionId, "-")
  } else {
    if (options.ephemeral) args.push("--ephemeral")
    args.push("--sandbox", options.sandbox ?? "read-only", "-")
  }
  return args
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

function boundedAppend(current: string, chunk: string, limit = 64 * 1024): string {
  const joined = current + chunk
  return joined.length <= limit ? joined : joined.slice(joined.length - limit)
}

/**
 * Start a resumable `codex exec --json` attempt.
 *
 * `started` resolves at the first validated `thread.started` event. `completed`
 * resolves only after the process and both output streams are drained. All
 * lifecycle events are parsed and delivered serially.
 */
export function startCodexExec(options: ExecRunOptions): CodexExecHandle {
  const started = deferred<{ sessionId: string }>()
  const exited = deferred<{ exitCode: number; signal: NodeJS.Signals | null }>()
  // Either lifecycle promise may reject before a caller has received a handle.
  void started.promise.catch(() => undefined)
  void exited.promise.catch(() => undefined)

  const child = spawn(options.codexBin, buildArgs(options), {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  })
  child.once("error", (error) => exited.reject(error))
  child.once("exit", (exitCode, signal) => exited.resolve({ exitCode: exitCode ?? (signal ? 128 : 1), signal }))

  let stdinFailure: Error | undefined
  const stdinTask = new Promise<void>((resolve, reject) => {
    child.stdin.on("error", (error) => {
      stdinFailure = error
      reject(error)
    })
    child.stdin.once("finish", resolve)
    child.stdin.end(`${options.prompt}\n`)
  })
  void stdinTask.catch(() => undefined)

  // Listener installation must precede this check: ENOENT/EACCES are emitted
  // asynchronously even when spawn returns without a PID.
  if (!child.pid) throw new Error("codex exec did not return a process id")

  const events: NormalizedEvent[] = []
  let sessionId: string | undefined
  let terminal: CodexExecTerminal | undefined
  let streamErrorSeen = false
  let lastMessage: string | undefined
  let stderr = ""
  let protocolFailure: Error | undefined
  let timeoutFailure: CodexExecTimeoutError | undefined
  let stopReason: "interrupt" | "timeout" | "protocol" | "restart" | undefined
  let stopTask: Promise<void> | undefined

  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    const result = await Promise.race([
      exited.promise.then(() => true, () => true),
      delay(timeoutMs).then(() => false),
    ])
    return result
  }

  const stop = (reason: "interrupt" | "timeout" | "protocol" | "restart"): Promise<void> => {
    stopReason ??= reason
    stopTask ??= (async () => {
      signalProcessGroup(child, "SIGINT")
      if (await waitForExit(options.interruptGraceMs ?? 1_000)) return
      signalProcessGroup(child, "SIGTERM")
      if (await waitForExit(options.termGraceMs ?? 1_000)) return
      signalProcessGroup(child, "SIGKILL")
      if (!(await waitForExit(options.killGraceMs ?? 5_000))) {
        throw new Error("codex exec process group did not exit after SIGKILL")
      }
    })()
    return stopTask
  }

  const acceptLine = async (line: string): Promise<void> => {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch (error) {
      throw new CodexExecProtocolError("codex exec emitted malformed JSONL", { cause: error })
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CodexExecProtocolError("codex exec event must be a JSON object")
    }
    const type = (raw as Record<string, unknown>).type
    if (typeof type !== "string") throw new CodexExecProtocolError("codex exec event has no string type")
    if (![
      "thread.started",
      "turn.started",
      "turn.completed",
      "turn.failed",
      "item.started",
      "item.updated",
      "item.completed",
      "error",
    ].includes(type)) {
      throw new CodexExecProtocolError(`unexpected codex exec event type ${type}`)
    }

    if (type === "thread.started") {
      const next = (raw as Record<string, unknown>).thread_id
      if (typeof next !== "string" || !next) throw new CodexExecProtocolError("thread.started has no thread_id")
      if (sessionId) throw new CodexExecProtocolError("codex exec emitted duplicate thread.started")
      sessionId = next
    }
    if (type === "turn.completed" || type === "turn.failed") {
      if (terminal) throw new CodexExecProtocolError("codex exec emitted multiple terminal turn events")
      terminal = type === "turn.completed" ? "completed" : "failed"
    }
    if (type === "error") streamErrorSeen = true

    const event = normalizeExecEvent(raw)
    if (event.kind === "unknown") throw new CodexExecProtocolError(`failed to normalize codex exec event ${type}`)
    events.push(event)
    if (type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      lastMessage = event.item.text
    }
    await options.onEvent?.(event)
    if (type === "thread.started") started.resolve({ sessionId: sessionId! })
  }

  const stdoutTask = (async (): Promise<void> => {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk as Buffer, { stream: true })
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) await acceptLine(line)
        newline = buffer.indexOf("\n")
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) await acceptLine(buffer.trim())
  })().catch((error) => {
    protocolFailure = error instanceof Error ? error : new Error(String(error))
    void stop("protocol").catch(() => undefined)
  })

  const stderrTask = (async (): Promise<void> => {
    const decoder = new TextDecoder()
    let lineBuffer = ""
    for await (const chunk of child.stderr) {
      const text = decoder.decode(chunk as Buffer, { stream: true })
      stderr = boundedAppend(stderr, text)
      lineBuffer += text
      let newline = lineBuffer.indexOf("\n")
      while (newline >= 0) {
        const line = lineBuffer.slice(0, newline)
        lineBuffer = lineBuffer.slice(newline + 1)
        await options.onStderr?.(line)
        newline = lineBuffer.indexOf("\n")
      }
    }
    const tail = decoder.decode()
    stderr = boundedAppend(stderr, tail)
    lineBuffer += tail
    if (lineBuffer) await options.onStderr?.(lineBuffer)
  })().catch((error) => {
    protocolFailure ??= error instanceof Error ? error : new Error(String(error))
    void stop("protocol").catch(() => undefined)
  })

  const timeoutMs = options.timeoutMs ?? 1_800_000
  const timer = setTimeout(() => {
    timeoutFailure = new CodexExecTimeoutError(timeoutMs)
    void stop("timeout").catch(() => undefined)
  }, timeoutMs)
  timer.unref?.()

  const abort = (): void => {
    void stop("interrupt").catch(() => undefined)
  }
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) abort()

  const completed = (async (): Promise<ExecRunResult> => {
    try {
      const exit = await exited.promise
      await Promise.all([stdinTask, stdoutTask, stderrTask])
      if (stopTask) await stopTask
      if (stopReason === "restart") throw new CodexExecRestartError()
      if (timeoutFailure) throw timeoutFailure
      if (protocolFailure) throw protocolFailure
      if (stdinFailure) throw stdinFailure
      if (!sessionId) throw new CodexExecProtocolError("codex exec exited without thread.started")
      if (!terminal) {
        if (stopReason === "interrupt") terminal = "interrupted"
        else if (streamErrorSeen) terminal = "failed"
        else throw new CodexExecProtocolError("codex exec exited without a terminal turn event")
      }
      if (streamErrorSeen && terminal === "completed") {
        throw new CodexExecProtocolError("codex exec emitted error before turn.completed")
      }
      if (terminal === "completed" && exit.exitCode !== 0) {
        throw new CodexExecProtocolError(`codex exec completed but exited ${exit.exitCode}`)
      }
      if (terminal === "failed" && exit.exitCode === 0) {
        throw new CodexExecProtocolError("codex exec reported turn.failed but exited 0")
      }
      return {
        exitCode: exit.exitCode,
        signal: exit.signal,
        sessionId,
        terminal,
        events,
        ...(terminal === "completed" && lastMessage ? { lastMessage } : {}),
        stderr,
      }
    } catch (error) {
      if (!sessionId) started.reject(error)
      throw error
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
    }
  })()

  return {
    pid: child.pid,
    started: started.promise,
    completed,
    interrupt: async () => {
      await stop("interrupt")
    },
    detachForRestart: async () => {
      await stop("restart")
    },
  }
}

/** Compatibility helper for callers that only need the final attempt result. */
export async function runCodexExec(options: ExecRunOptions): Promise<ExecRunResult> {
  return startCodexExec(options).completed
}
