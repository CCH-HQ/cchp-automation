import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { durableWriteFile } from "./durable-file"
import { processIdentity, type RunFence } from "./run-lock"

export interface JsonRpcNotification {
  method: string
  params: unknown
}

export interface JsonRpcServerRequest extends JsonRpcNotification {
  id: string | number
}

export interface JsonRpcPeerOptions {
  write(line: string): void | Promise<void>
  onNotification?(notification: JsonRpcNotification): void | Promise<void>
  onServerRequest?(request: JsonRpcServerRequest): unknown | Promise<unknown>
  requestTimeoutMs?: number
}

interface PendingRequest {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

export class JsonRpcError extends Error {
  constructor(
    message: string,
    readonly code = -32000,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = "JsonRpcError"
  }
}

export class JsonRpcPeer {
  private nextId = 1
  private readonly pending = new Map<string | number, PendingRequest>()
  private closed = false

  constructor(private readonly options: JsonRpcPeerOptions) {}

  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.closed) throw new Error("JSON-RPC connection is closed")
    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`JSON-RPC request timed out: ${method}`))
      }, this.options.requestTimeoutMs ?? 120_000)
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      })
    })
    try {
      await this.send({ jsonrpc: "2.0", id, method, params })
    } catch (error) {
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timeout)
        this.pending.delete(id)
        pending.reject(error as Error)
      }
    }
    return promise
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new Error("JSON-RPC connection is closed")
    await this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })
  }

  async accept(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("app-server emitted a non-object JSON-RPC message")
    }
    const message = raw as Record<string, unknown>
    // Codex 0.146.0 emits response/notification envelopes without the optional
    // jsonrpc field, while still accepting standard JSON-RPC requests. Treat a
    // missing field as the pinned app-server wire dialect; reject explicit
    // non-2.0 values.
    if (message.jsonrpc !== undefined && message.jsonrpc !== "2.0") {
      throw new Error("app-server emitted an invalid JSON-RPC version")
    }
    const hasId = typeof message.id === "number" || typeof message.id === "string"
    const hasMethod = typeof message.method === "string"

    if (hasId && !hasMethod) {
      const id = message.id as string | number
      const pending = this.pending.get(id)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pending.delete(id)
      if (message.error) {
        const error = message.error as Record<string, unknown>
        pending.reject(
          new JsonRpcError(
            typeof error.message === "string" ? error.message : `JSON-RPC ${pending.method} failed`,
            typeof error.code === "number" ? error.code : -32000,
            error.data,
          ),
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (!hasMethod) throw new Error("app-server JSON-RPC message has neither response nor method")
    const notification = { method: message.method as string, params: message.params }
    if (!hasId) {
      await this.options.onNotification?.(notification)
      return
    }

    const request = { ...notification, id: message.id as string | number }
    try {
      const result = this.options.onServerRequest
        ? await this.options.onServerRequest(request)
        : await failClosedServerRequest(request)
      await this.send({ jsonrpc: "2.0", id: request.id, result })
    } catch (error) {
      const rpcError = error instanceof JsonRpcError ? error : new JsonRpcError((error as Error).message)
      await this.send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: rpcError.code, message: rpcError.message, ...(rpcError.data ? { data: rpcError.data } : {}) },
      })
    }
  }

  close(reason = "JSON-RPC connection closed"): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(`${reason}: ${pending.method}`))
    }
    this.pending.clear()
  }

  private async send(message: Record<string, unknown>): Promise<void> {
    await this.options.write(`${JSON.stringify(message)}\n`)
  }
}

export async function failClosedServerRequest(request: JsonRpcServerRequest): Promise<unknown> {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" }
    case "item/tool/requestUserInput":
      return { answers: {} }
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: "denied" }
    default:
      throw new JsonRpcError(`headless supervisor refuses server request ${request.method}`, -32601)
  }
}

export interface CodexAppServerOptions {
  codexBin: string
  codexHome: string
  cwd: string
  env: Record<string, string>
  onNotification(notification: JsonRpcNotification): void | Promise<void>
  onStderr?(line: string): void
  onServerRequest?(request: JsonRpcServerRequest): unknown | Promise<unknown>
  onExit?(event: CodexAppServerExit): void | Promise<void>
  requestTimeoutMs?: number
  processRecordPath?: string
  runId?: string
  writerFence?: Pick<RunFence, "writerId" | "generation">
}

export interface AppServerProcessRecord {
  schemaVersion: 1
  pid: number
  pgid: number
  startTicks: string
  bootId: string
  codexHome: string
  runId?: string
  writerId?: string
  writerGeneration?: number
  createdAt: string
}

export interface CodexAppServerExit {
  expected: boolean
  reason: "stdout_eof" | "process_exit" | "spawn_error" | "protocol_error"
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  error?: Error
}

export interface CodexAppServerStopOptions {
  interruptGraceMs?: number
  termGraceMs?: number
  killGraceMs?: number
}

export interface ThreadReadResponse {
  thread: Record<string, unknown>
}

export interface ThreadResumeParams {
  threadId: string
  model?: string | null
  modelProvider?: string | null
  cwd?: string | null
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted" | null
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null
}

export interface ThreadResumeResponse {
  thread: Record<string, unknown>
  model?: string
  modelProvider?: string
  cwd?: string
}

export class CodexAppServer {
  private process?: ReturnType<typeof Bun.spawn>
  private peer?: JsonRpcPeer
  private stdoutTask?: Promise<void>
  private stderrTask?: Promise<void>
  private exitTask?: Promise<number>
  private stopTask?: Promise<number>
  private stopping = false
  private exitReported = false
  private pidRecord?: { path: string; record: AppServerProcessRecord }

  constructor(private readonly options: CodexAppServerOptions) {}

  async start(): Promise<Record<string, unknown>> {
    if (this.process) throw new Error("Codex app-server already started")
    this.stopping = false
    this.exitReported = false
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = Bun.spawn([this.options.codexBin, "app-server", "--stdio", "--strict-config"], {
        cwd: this.options.cwd,
        env: { ...this.options.env, CODEX_HOME: this.options.codexHome },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
      })
    } catch (error) {
      await this.reportExit({
        expected: false,
        reason: "spawn_error",
        exitCode: null,
        signalCode: null,
        error: error as Error,
      })
      throw error
    }
    this.process = child
    const processRecordPath = this.options.processRecordPath ?? process.env.CCHP_CODEX_PID_FILE
    if (processRecordPath) {
      const identity = processIdentity(child.pid)
      const record: AppServerProcessRecord = {
        schemaVersion: 1,
        pid: child.pid,
        pgid: child.pid,
        startTicks: identity.startTicks,
        bootId: identity.bootId,
        codexHome: this.options.codexHome,
        ...(this.options.runId ? { runId: this.options.runId } : {}),
        ...(this.options.writerFence ? { writerId: this.options.writerFence.writerId, writerGeneration: this.options.writerFence.generation } : {}),
        createdAt: new Date().toISOString(),
      }
      durableWriteFile(processRecordPath, `${JSON.stringify(record, null, 2)}\n`)
      this.pidRecord = { path: processRecordPath, record }
    }
    this.peer = new JsonRpcPeer({
      requestTimeoutMs: this.options.requestTimeoutMs,
      write: async (line) => {
        if (!child.stdin || typeof child.stdin === "number") {
          throw new Error("Codex app-server stdin is unavailable")
        }
        child.stdin.write(line)
        await child.stdin.flush()
      },
      onNotification: this.options.onNotification,
      onServerRequest: this.options.onServerRequest ?? failClosedServerRequest,
    })
    this.stdoutTask = this.consumeStdout(child.stdout as ReadableStream<Uint8Array>)
    this.stderrTask = this.consumeStderr(child.stderr as ReadableStream<Uint8Array>)
    this.exitTask = child.exited.then(async (exitCode) => {
      this.peer?.close("Codex app-server process exited")
      await this.reportExit({
        expected: this.stopping,
        reason: "process_exit",
        exitCode,
        signalCode: child.signalCode,
      })
      this.removeOwnedPidRecord()
      return exitCode
    })
    try {
      const initialized = await this.peer.request<Record<string, unknown>>("initialize", {
        clientInfo: { name: "cchp-automation", title: "CCHP Codex supervisor", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      })
      await this.peer.notify("initialized")
      return initialized
    } catch (error) {
      await this.stop({ interruptGraceMs: 100, termGraceMs: 100, killGraceMs: 1_000 })
      throw error
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.peer) throw new Error("Codex app-server is not started")
    return this.peer.request<T>(method, params)
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (!this.peer) throw new Error("Codex app-server is not started")
    return this.peer.notify(method, params)
  }

  get pid(): number | undefined {
    return this.process?.pid
  }

  threadRead(threadId: string, includeTurns = false): Promise<ThreadReadResponse> {
    return this.request("thread/read", { threadId, ...(includeTurns ? { includeTurns: true } : {}) })
  }

  threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.request("thread/resume", params)
  }

  async threadDelete(threadId: string): Promise<Record<string, never>> {
    return this.request("thread/delete", { threadId })
  }

  async interruptTurn(threadId: string, turnId: string): Promise<Record<string, never>> {
    return this.request("turn/interrupt", { threadId, turnId })
  }

  stop(options: CodexAppServerStopOptions = {}): Promise<number> {
    if (this.stopTask) return this.stopTask
    this.stopTask = this.stopInternal(options).finally(() => {
      this.stopTask = undefined
    })
    return this.stopTask
  }

  private async stopInternal(options: CodexAppServerStopOptions): Promise<number> {
    const child = this.process
    if (!child) return 0
    this.stopping = true
    this.peer?.close("Codex app-server stopped")
    try {
      if (child.stdin && typeof child.stdin !== "number") child.stdin.end()
    } catch {
      // Process may already have closed stdin.
    }
    const interruptGraceMs = options.interruptGraceMs ?? 15_000
    const termGraceMs = options.termGraceMs ?? 15_000
    const killGraceMs = options.killGraceMs ?? 5_000
    try {
      this.signalProcessGroup(child, "SIGINT")
      if (!(await this.waitForExit(child, interruptGraceMs))) {
        this.signalProcessGroup(child, "SIGTERM")
        if (!(await this.waitForExit(child, termGraceMs))) {
          this.signalProcessGroup(child, "SIGKILL")
          if (!(await this.waitForExit(child, killGraceMs))) {
            throw new Error(`Codex app-server process group ${child.pid} did not exit after SIGKILL`)
          }
        }
      }
      const exitCode = await child.exited
      await this.allSettledWithin([this.stdoutTask, this.stderrTask], killGraceMs)
      return exitCode
    } finally {
      this.process = undefined
      this.peer = undefined
      this.stdoutTask = undefined
      this.stderrTask = undefined
      this.exitTask = undefined
      this.stopping = false
      this.removeOwnedPidRecord()
    }
  }

  private removeOwnedPidRecord(): void {
    const record = this.pidRecord
    this.pidRecord = undefined
    if (!record || !existsSync(record.path)) return
    try {
      const raw = readFileSync(record.path, "utf8").trim()
      if (raw === String(record.record.pid)) {
        unlinkSync(record.path)
        return
      }
      const current = JSON.parse(raw) as Partial<AppServerProcessRecord>
      const identity = processIdentity(record.record.pid)
      if (
        current.schemaVersion === 1
        && current.pid === record.record.pid
        && current.startTicks === record.record.startTicks
        && current.bootId === record.record.bootId
        && identity.startTicks === record.record.startTicks
        && identity.bootId === record.record.bootId
        && (!record.record.writerId || current.writerId === record.record.writerId)
        && (!record.record.writerGeneration || current.writerGeneration === record.record.writerGeneration)
      ) unlinkSync(record.path)
    } catch { /* a newer process record must never be removed by this instance */ }
  }

  private async consumeStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const { value, done } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) await this.peer?.accept(JSON.parse(line))
          newline = buffer.indexOf("\n")
        }
        if (done) break
      }
      if (buffer.trim()) await this.peer?.accept(JSON.parse(buffer))
    } catch (error) {
      this.peer?.close("Codex app-server protocol error")
      await this.reportExit({
        expected: this.stopping,
        reason: "protocol_error",
        exitCode: null,
        signalCode: null,
        error: error as Error,
      })
      const child = this.process
      if (child) {
        try {
          this.signalProcessGroup(child, "SIGTERM")
        } catch {
          // The process may already have exited after emitting malformed output.
        }
      }
    } finally {
      this.peer?.close("Codex app-server stdout closed")
      if (!this.stopping && this.process) {
        const child = this.process
        // A normal crash closes stdout just before the OS exit becomes visible.
        // Give the process watcher a short chance to report its richer code/signal;
        // a server that closes only stdout is still surfaced as stdout_eof.
        if (!(await this.waitForExit(child, 50))) {
          await this.reportExit({
            expected: false,
            reason: "stdout_eof",
            exitCode: null,
            signalCode: null,
          })
        }
      }
    }
  }

  private async consumeStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line) this.options.onStderr?.(line)
        newline = buffer.indexOf("\n")
      }
      if (done) break
    }
    if (buffer) this.options.onStderr?.(buffer)
  }

  private signalProcessGroup(child: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals): void {
    try {
      if (process.platform === "win32") child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }

  private async waitForExit(child: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        child.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs))
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async allSettledWithin(
    tasks: Array<Promise<void> | undefined>,
    timeoutMs: number,
  ): Promise<void> {
    const active = tasks.filter((task): task is Promise<void> => task !== undefined)
    if (!active.length) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled(active),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs))
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async reportExit(event: CodexAppServerExit): Promise<void> {
    if (this.exitReported) return
    this.exitReported = true
    try {
      await this.options.onExit?.(event)
    } catch {
      // Lifecycle reporting must never produce an unhandled rejection.
    }
  }
}
