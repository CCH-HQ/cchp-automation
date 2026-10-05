import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { preparePiHome } from "./config"
import { parsePiProviders } from "./providers"

function providerSet() {
  return parsePiProviders({
    providerJson: JSON.stringify({ relay: { api: "openai-responses", base_url: "https://example.test/v1", models: { latest: {} } } }),
    providerKeysJson: JSON.stringify({ relay: "secret-key" }),
    model: "relay/latest",
  })
}

describe("Pi run configuration", () => {
  test("writes native models and MCP configuration with broker references", () => {
    const root = mkdtempSync(join(tmpdir(), "cchp-pi-config-"))
    const prepared = preparePiHome({
      botWorkdir: root,
      engineDir: "/engine",
      repoDir: "/repo",
      providerSet: providerSet(),
      systemPrompt: "system",
      task: "engage",
      runId: "run-1",
      brokerSocket: "/run/broker.sock",
      brokerTokenEnv: "CCHP_GITHUB_BROKER_TOKEN",
      brokerFinalizer: "/run/finalizer.json",
      runtimeEnv: { BOT_REPO: "CCH-HQ/example", BOT_CAN_WRITE: "1" },
      bunCommand: "/usr/bin/bun",
    })
    const models = readFileSync(prepared.modelsPath, "utf8")
    const mcp = readFileSync(prepared.mcpPath, "utf8")
    expect(models).toContain("openai-responses")
    expect(models).not.toContain("secret-key")
    expect(mcp).toContain("cchp_github")
    expect(mcp).toContain("CCHP_GITHUB_BROKER_TOKEN")
    expect(readFileSync(join(prepared.agentDir, "APPEND_SYSTEM.md"), "utf8")).toContain("Run id: run-1")
  })
})
