import { chmodSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { expect, test } from "bun:test"

const serverPath = join(import.meta.dir, "agents-server.ts")
const fakePiPath = join(import.meta.dir, "../../scripts/fixtures/fake-pi-rpc.ts")

function textResult(value: unknown): Record<string, unknown> {
  const content = (value as { content?: Array<{ type?: string; text?: string }> }).content ?? []
  const text = content.find((entry) => entry.type === "text")?.text
  if (!text) throw new Error("MCP response did not contain text")
  return JSON.parse(text) as Record<string, unknown>
}

test("Pi agents MCP starts a child and returns its feedback", async () => {
  chmodSync(fakePiPath, 0o755)
  const root = mkdtempSync(join(tmpdir(), "cchp-pi-agents-"))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env as Record<string, string>,
      BOT_TASK: "manual",
      BOT_RUN_ID: "run-1",
      BOT_WORKDIR: root,
      REPO_DIR: root,
      PI_BIN: fakePiPath,
      PI_CODING_AGENT_DIR: root,
      CCHP_PI_AGENT_MODEL: "fake/model",
      CCHP_PI_AGENT_SESSION_DIR: join(root, "sessions"),
      CCHP_PI_AGENT_DEPTH: "0",
      CCHP_PI_AGENT_ALLOW_SHELL: "0",
    },
  })
  const client = new Client({ name: "agents-test", version: "1.0.0" }, {})
  await client.connect(transport)
  const spawned = textResult(await client.callTool({ name: "spawn_agent", arguments: { task_name: "review-one", message: "inspect", agent_type: "reviewer" } }))
  expect((spawned.agents as Array<Record<string, unknown>>)[0]?.state).toBe("running")
  const waited = textResult(await client.callTool({ name: "wait_agent", arguments: { target: "review-one", timeout_ms: 10_000 } }))
  const agent = (waited.agents as Array<Record<string, unknown>>)[0]!
  expect(agent.state).toBe("completed")
  expect(agent.output).toBe("child final")
  await client.close()
})
