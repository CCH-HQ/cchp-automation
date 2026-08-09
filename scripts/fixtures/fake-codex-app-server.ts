#!/usr/bin/env bun

import { appendFileSync, writeFileSync } from "node:fs"

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "normal"
const tracePath = process.env.FAKE_CODEX_TRACE
const descendantPidPath = process.env.FAKE_CODEX_DESCENDANT_PID

function trace(value: string): void {
  if (tracePath) appendFileSync(tracePath, `${value}\n`, "utf8")
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

if (scenario === "ignore_signals" || scenario === "leader_exits") {
  process.on("SIGINT", () => trace("SIGINT"))
  process.on("SIGTERM", () => trace("SIGTERM"))
  const descendant = Bun.spawn(["sh", "-c", "trap '' INT TERM; while :; do sleep 1; done"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  if (descendantPidPath) writeFileSync(descendantPidPath, `${descendant.pid}\n`, "utf8")
}

const reader = Bun.stdin.stream().getReader()
const decoder = new TextDecoder()
let buffer = ""

async function accept(line: string): Promise<void> {
  const message = JSON.parse(line) as Record<string, any>
  trace(String(message.method ?? "response"))
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex-app-server" } })
    return
  }
  if (message.method === "initialized") {
    if (scenario === "crash") process.exit(23)
    if (scenario === "malformed") process.stdout.write("{not-json}\n")
    if (scenario === "leader_exits") process.exit(0)
    return
  }
  if (message.method === "thread/read") {
    if (scenario === "exit_pending") {
      process.exit(0)
      return
    }
    send({ id: message.id, result: { thread: { id: message.params.threadId, status: "idle" } } })
    return
  }
  if (message.method === "thread/resume") {
    send({
      id: message.id,
      result: {
        thread: { id: message.params.threadId, status: "idle" },
        model: message.params.model,
        modelProvider: message.params.modelProvider,
        cwd: message.params.cwd,
      },
    })
    return
  }
  if (message.method === "thread/delete") {
    send({ id: message.id, result: {} })
    send({ method: "thread/deleted", params: { threadId: message.params.threadId } })
    return
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} })
    return
  }
  if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: `unsupported ${message.method}` } })
  }
}

while (true) {
  const { value, done } = await reader.read()
  buffer += decoder.decode(value, { stream: !done })
  let newline = buffer.indexOf("\n")
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) await accept(line)
    newline = buffer.indexOf("\n")
  }
  if (done) break
}

if (buffer.trim()) await accept(buffer.trim())

if (scenario === "ignore_signals" || scenario === "leader_exits") {
  await new Promise<never>(() => undefined)
}
