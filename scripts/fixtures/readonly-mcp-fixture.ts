#!/usr/bin/env bun
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js"

const fixture = process.argv.includes("start-mcp-server") ? "serena" : "fff"
const toolName = fixture === "fff" ? "grep" : "get_current_config"
const tool: Tool = {
  name: toolName,
  description: `Return the read-only ${fixture} MCP fixture process environment.`,
  inputSchema: fixture === "fff"
    ? { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    : { type: "object", properties: {}, required: [] },
}

function observation(): Record<string, unknown> {
  return {
    fixture,
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: process.argv.slice(2),
    envKeys: Object.keys(process.env).sort(),
    env: Object.fromEntries(
      ["PATH", "HOME", "LANG", "TMPDIR", "CODEX_HOME", "REPO_DIR"]
        .flatMap((name) => typeof process.env[name] === "string" ? [[name, process.env[name]]] : []),
    ),
  }
}

const server = new Server(
  { name: `${fixture}-environment-fixture`, version: "1.0.0" },
  { capabilities: { tools: {} } },
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }))
server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  if (request.params.name !== tool.name) {
    return { isError: true, content: [{ type: "text", text: `unknown tool: ${request.params.name}` }] }
  }
  const value = observation()
  const codexHome = process.env.CODEX_HOME
  if (!codexHome) {
    return { isError: true, content: [{ type: "text", text: "CODEX_HOME is required" }] }
  }
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  appendFileSync(join(codexHome, `fixture-${fixture}-env.jsonl`), `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  return { content: [{ type: "text", text: JSON.stringify(value) }] }
})

await server.connect(new StdioServerTransport())
