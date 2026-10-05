import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

export interface PiRpcOptions {
  piBin: string
  cwd: string
  env: Record<string, string>
  prompt: string
  model: string
  thinking?: string
  extensionPath?: string
  sessionDir: string
  sessionName: string
  sessionId: string
  eventLogPath: string
  allowShell: boolean
  abortSignal?: AbortSignal
  onEvent?: (event: Record<string, unknown>) => void
}

export interface PiRpcResult {
  state: "SUCCEEDED" | "FAILED" | "CANCELLED"
  exitCode: number
  sessionId?: string
  finalMessage?: string
  usage: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  events: number
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value.map((part) => {
    if (part && typeof part === "object" && !Array.isArray(part) && (part as Record<string, unknown>).type === "text") {
      return typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text as string : ""
    }
    return ""
  }).join("")
}

function usageFrom(value: unknown): PiRpcResult["usage"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  const source = value as Record<string, unknown>
  const number = (key: string): number => typeof source[key] === "number" && Number.isFinite(source[key]) ? Number(source[key]) : 0
  const input = number("input")
  const output = number("output")
  const cacheRead = number("cacheRead")
  const cacheWrite = number("cacheWrite")
  return { input, output, cacheRead, cacheWrite, total: number("totalTokens") || input + output + cacheRead + cacheWrite }
}

async function readJsonLines(stream: ReadableStream<Uint8Array>, onRecord: (record: Record<string, unknown>) => Promise<void> | void): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    while (true) {
      const index = buffer.indexOf("\n")
      if (index < 0) break
      const line = buffer.slice(0, index).replace(/\r$/, "")
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const record = JSON.parse(line) as unknown
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Pi RPC emitted a non-object JSON record")
      await onRecord(record as Record<string, unknown>)
    }
  }
  if (buffer.trim()) throw new Error("Pi RPC emitted an unterminated JSON record")
}

async function writeCommand(stdin: { write(value: string): void; flush(): Promise<number> | number }, value: Record<string, unknown>): Promise<void> {
  stdin.write(`${JSON.stringify(value)}\n`)
  await stdin.flush()
}

export async function runPiRpc(options: PiRpcOptions): Promise<PiRpcResult> {
  mkdirSync(dirname(options.eventLogPath), { recursive: true, mode: 0o700 })
  mkdirSync(options.sessionDir, { recursive: true, mode: 0o700 })
  const child = Bun.spawn([
    options.piBin,
    "--mode", "rpc",
    "--approve",
    "--session-dir", options.sessionDir,
    "--name", options.sessionName,
    "--session-id", options.sessionId,
    "--model", options.model,
    ...(options.thinking ? ["--thinking", options.thinking] : []),
    ...(options.extensionPath ? ["--extension", options.extensionPath] : []),
  ], {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const log = (record: Record<string, unknown>) => appendFileSync(options.eventLogPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 })
  let settled = false
  let finalMessage = ""
  let sessionId: string | undefined
  let usage = usageFrom(undefined)
  let events = 0
  let providerError = ""
  let aborted = Boolean(options.abortSignal?.aborted)
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const abort = () => {
    aborted = true
    try { child.kill("SIGTERM") } catch {}
    killTimer = setTimeout(() => {
      try { child.kill("SIGKILL") } catch {}
    }, 5_000)
  }
  options.abortSignal?.addEventListener("abort", abort, { once: true })
  if (options.abortSignal?.aborted) abort()
  const stdoutTask = readJsonLines(child.stdout, async (record) => {
    events++
    log(record)
    options.onEvent?.(record)
    if (record.type === "session" && typeof record.id === "string") sessionId = record.id
    if (record.type === "message_update") usage = usageFrom(record.usage)
    if (record.type === "message_end") {
      const message = record.message
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const candidate = message as Record<string, unknown>
        if (candidate.role === "assistant") {
          finalMessage = textFromContent(candidate.content)
          if (candidate.stopReason === "error") providerError = typeof candidate.errorMessage === "string" ? candidate.errorMessage : "Pi provider error"
        }
      }
    }
    if (record.type === "agent_settled" && !settled) {
      settled = true
      child.stdin.end()
      shutdownTimer = setTimeout(() => {
        try { child.kill("SIGTERM") } catch {}
        killTimer = setTimeout(() => {
          try { child.kill("SIGKILL") } catch {}
        }, 5_000)
      }, 5_000)
    }
  })
  await writeCommand(child.stdin, { id: "cchp-prompt", type: "prompt", message: options.prompt })
  const stderrTask = new Response(child.stderr).text()
  const exitCode = await child.exited
  options.abortSignal?.removeEventListener("abort", abort)
  if (shutdownTimer) clearTimeout(shutdownTimer)
  if (killTimer) clearTimeout(killTimer)
  await Promise.all([stdoutTask, stderrTask])
  const stderr = await stderrTask
  if (aborted) {
    return { state: "CANCELLED", exitCode: exitCode || 1, ...(sessionId ? { sessionId } : {}), ...(finalMessage ? { finalMessage } : {}), usage, events }
  }
  if (!settled) {
    const detail = providerError || stderr.trim() || `Pi exited before agent_settled with code ${exitCode}`
    return { state: "FAILED", exitCode: exitCode || 1, ...(sessionId ? { sessionId } : {}), ...(finalMessage ? { finalMessage } : { finalMessage: detail }), usage, events }
  }
  if (providerError) return { state: "FAILED", exitCode: exitCode || 1, ...(sessionId ? { sessionId } : {}), finalMessage: providerError, usage, events }
  return { state: "SUCCEEDED", exitCode: 0, ...(sessionId ? { sessionId } : {}), ...(finalMessage ? { finalMessage } : {}), usage, events }
}

export function readPiEventLog(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}
