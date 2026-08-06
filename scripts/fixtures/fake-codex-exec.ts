#!/usr/bin/env bun

import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const scenario = process.env.FAKE_CODEX_EXEC_SCENARIO ?? "normal"
const tracePath = process.env.FAKE_CODEX_EXEC_TRACE ?? (
  process.env.BOT_WORKDIR ? join(process.env.BOT_WORKDIR, "fake-codex-exec-trace.jsonl") : undefined
)
const descendantPidPath = process.env.FAKE_CODEX_EXEC_DESCENDANT_PID

function emit(value: unknown, newline = true): void {
  process.stdout.write(`${JSON.stringify(value)}${newline ? "\n" : ""}`)
}

function trace(value: unknown): void {
  if (tracePath) appendFileSync(tracePath, `${JSON.stringify(value)}\n`, "utf8")
}

let prompt = ""
for await (const chunk of Bun.stdin.stream()) prompt += Buffer.from(chunk).toString("utf8")
trace({
  argv: process.argv.slice(2),
  prompt,
  cwd: process.cwd(),
  envKeys: Object.keys(process.env).sort(),
  env: {
    CODEX_HOME: process.env.CODEX_HOME,
    REPO_DIR: process.env.REPO_DIR,
    BOT_WORKDIR: process.env.BOT_WORKDIR,
    CCHP_EXPLICIT_AGENT_DEPTH: process.env.CCHP_EXPLICIT_AGENT_DEPTH,
    hasBridgeCapability: Boolean(process.env.CCHP_CODEX_BRIDGE_TOKEN),
  },
})

const args = process.argv.slice(2)
const resumeIndex = args.indexOf("resume")
const sessionId = resumeIndex >= 0 && args[resumeIndex + 1] && !args[resumeIndex + 1]!.startsWith("-")
  ? args[resumeIndex + 1]!
  : "thread-fixture"

if (scenario === "malformed") {
  process.stdout.write("{not-json}\n")
  process.exit(0)
}

emit({ type: "thread.started", thread_id: sessionId })
emit({ type: "turn.started" })

if (scenario === "hang") {
  process.on("SIGINT", () => trace({ signal: "SIGINT" }))
  process.on("SIGTERM", () => trace({ signal: "SIGTERM" }))
  const descendant = Bun.spawn(["sh", "-c", "trap '' INT TERM; while :; do sleep 1; done"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  if (descendantPidPath) writeFileSync(descendantPidPath, `${descendant.pid}\n`, "utf8")
  await new Promise(() => undefined)
}

if (scenario === "unknown") {
  emit({ type: "future.event" })
  process.exit(0)
}

if (scenario === "slow") await Bun.sleep(80)

if (scenario === "failed") {
  emit({ type: "item.completed", item: { id: "item-1", type: "agent_message", text: "partial" } })
  emit({ type: "turn.failed", error: { message: "fixture failure" } })
  process.exit(1)
}

emit({ type: "item.completed", item: { id: "item-1", type: "agent_message", text: `completed:${prompt.trim()}` } })
if (scenario !== "missing_terminal") {
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: 12,
      cached_input_tokens: 2,
      cache_write_input_tokens: 0,
      output_tokens: 3,
      reasoning_output_tokens: 1,
    },
  }, scenario !== "tail_without_newline")
}
