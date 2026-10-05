#!/usr/bin/env bun

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  while (true) {
    const index = buffer.indexOf("\n")
    if (index < 0) break
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const command = JSON.parse(line) as { type?: string }
    if (command.type !== "prompt") continue
    process.stdout.write(`${JSON.stringify({ type: "session", id: "fake-session" })}\n`)
    process.stdout.write(`${JSON.stringify({ type: "message_update", usage: { input: 1, output: 1, totalTokens: 2 } })}\n`)
    process.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "child final" }], stopReason: "stop" } })}\n`)
    process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`)
    setTimeout(() => process.exit(0), 10)
  }
})
