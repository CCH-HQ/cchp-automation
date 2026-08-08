import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgentsServer } from "./agents-mcp-server"

const fakeCodex = join(import.meta.dir, "../../scripts/fixtures/fake-codex-exec.ts")

test("explicit agents MCP exposes the native v2 vocabulary and isolates leaf config", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-agents-mcp-"))
  const rootHome = join(workdir, "root-codex-home")
  mkdirSync(rootHome, { recursive: true })
  writeFileSync(join(rootHome, "config.toml"), [
    'model = "root-model"',
    'review_model = "review-model"',
    "[features]",
    "multi_agent = false",
    "",
    "[mcp_servers.cchp_github]",
    'command = "bun"',
    "",
    "[mcp_servers.agents]",
    'command = "bun"',
    "",
    "[mcp_servers.see_upload]",
    'command = "bun"',
    "",
    "[mcp_servers.fff]",
    'command = "fff-mcp"',
    'enabled_tools = ["replace_everything"]',
    "",
    "[mcp_servers.serena]",
    'command = "serena"',
    'enabled_tools = ["replace_in_files", "write_memory"]',
    "",
  ].join("\n"))
  mkdirSync(join(rootHome, "agents"))
  mkdirSync(join(rootHome, "skills", "fixture"), { recursive: true })
  writeFileSync(join(rootHome, "agents", "explorer.toml"), [
    'name = "explorer"',
    "",
    "[mcp_servers.see_upload]",
    'command = "bun"',
    "",
    "[mcp_servers.fff]",
    'command = "fff-mcp"',
    "",
    "[mcp_servers.serena]",
    'command = "serena"',
    'enabled_tools = ["replace_in_files"]',
    "",
  ].join("\n"))
  writeFileSync(join(rootHome, "skills", "fixture", "SKILL.md"), "# Fixture\n")
  writeFileSync(join(rootHome, "state_5.sqlite"), "live root runtime state")
  const repoDir = join(workdir, "repo")
  mkdirSync(repoDir)

  const created = createAgentsServer({
    BOT_TASK: "pr_opened",
    BOT_WORKDIR: workdir,
    BOT_RUN_ID: "run-1",
    REPO_DIR: repoDir,
    CODEX_HOME: rootHome,
    CODEX_BIN: "codex",
    PATH: process.env.PATH,
    HOME: workdir,
    CCHP_CODEX_BRIDGE_TOKEN: "bridge-capability",
    CCHP_GITHUB_BROKER_SOCKET: "/tmp/forbidden.sock",
    CCHP_GITHUB_BROKER_TOKEN: "forbidden",
  })
  try {
    expect(created.tools.map((tool) => tool.name)).toEqual([
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "interrupt_agent",
      "close_agent",
      "list_agents",
    ])
    const spawn = created.tools.find((tool) => tool.name === "spawn_agent")!
    expect(spawn.inputSchema.required).toEqual(["task_name", "message", "pass_kind"])
    expect(spawn.inputSchema.properties).toHaveProperty("pass_kind")
    expect(spawn.inputSchema.properties).toHaveProperty("fork_turns")
    expect(spawn.inputSchema.properties).not.toHaveProperty("model")
    expect(spawn.inputSchema.properties).not.toHaveProperty("reasoning_effort")
    expect(spawn.inputSchema.properties).not.toHaveProperty("service_tier")

    const leafConfig = readFileSync(join(workdir, "explicit-codex-home", "config.toml"), "utf8")
    expect(leafConfig).not.toContain("[mcp_servers.agents]")
    expect(leafConfig).not.toContain("[mcp_servers.cchp_github]")
    expect(leafConfig).not.toContain("[mcp_servers.see_upload]")
    expect(leafConfig).toContain("[mcp_servers.fff]")
    expect(leafConfig).toContain('enabled_tools = ["find_files", "grep", "multi_grep"]')
    expect(leafConfig).toContain("[mcp_servers.serena]")
    expect(leafConfig).toContain('enabled_tools = ["search_for_pattern", "get_symbols_overview", "find_symbol", "find_referencing_symbols", "find_implementations", "find_declaration", "get_diagnostics_for_file", "get_current_config", "initial_instructions"]')
    expect(leafConfig).not.toContain("replace_in_files")
    expect(leafConfig).not.toContain("write_memory")
    const leafExplorer = readFileSync(join(workdir, "explicit-codex-home", "agents", "explorer.toml"), "utf8")
    const explorerProfile = readFileSync(join(workdir, "explicit-codex-home", "explorer.config.toml"), "utf8")
    expect(explorerProfile).toContain("[mcp_servers.fff]")
    expect(explorerProfile).not.toContain("name =")
    expect(explorerProfile).not.toContain("replace_in_files")
    expect(leafExplorer).toContain("explorer")
    expect(leafExplorer).not.toContain("[mcp_servers.see_upload]")
    expect(leafExplorer).toContain("[mcp_servers.fff]")
    expect(leafExplorer).toContain("[mcp_servers.serena]")
    expect(leafExplorer).not.toContain("replace_in_files")
    expect(readFileSync(join(workdir, "explicit-codex-home", "skills", "fixture", "SKILL.md"), "utf8")).toContain("Fixture")
    expect(existsSync(join(workdir, "explicit-codex-home", "state_5.sqlite"))).toBe(false)
  } finally {
    await created.adapter.shutdown()
  }
})

test("launches an explicit child without GitHub, provider, App, SEE or HeroUI credentials", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-agents-mcp-env-"))
  const rootHome = join(workdir, "root-codex-home")
  const repoDir = join(workdir, "repo")
  mkdirSync(rootHome, { recursive: true })
  mkdirSync(repoDir)
  writeFileSync(join(rootHome, "config.toml"), 'model = "root-model"\nreview_model = "review-model"\n[features]\nmulti_agent = false\n')
  const created = createAgentsServer({
    BOT_TASK: "manual",
    BOT_WORKDIR: workdir,
    BOT_RUN_ID: "run-env",
    REPO_DIR: repoDir,
    CODEX_HOME: rootHome,
    CODEX_BIN: fakeCodex,
    PATH: process.env.PATH,
    HOME: workdir,
    CCHP_CODEX_BRIDGE_TOKEN: "bridge-capability",
    CCHP_GITHUB_BROKER_SOCKET: "/secret/broker.sock",
    CCHP_GITHUB_BROKER_TOKEN: "broker-sentinel",
    CCHP_GITHUB_BROKER_FINALIZER: "/secret/finalizer",
    GH_TOKEN: "github-sentinel",
    CCHP_GH_TOKEN_FILE: "/secret/token",
    CCHP_BOT_PROVIDER_KEYS: "provider-sentinel",
    CCHP_BOT_PROVIDERS: "provider-config-sentinel",
    CCHP_PK_GPT_CCHP: "provider-key-sentinel",
    CCHP_APP_CLIENT_ID: "app-client-sentinel",
    CCHP_APP_PRIVATE_KEY: "app-private-sentinel",
    SEE_API_KEY: "see-sentinel",
    HEROUI_AUTH_TOKEN: "heroui-sentinel",
    UNRELATED_SECRET: "unrelated-sentinel",
  })
  try {
    await created.adapter.spawn("root", { id: "child-env", role: "explorer", prompt: "inspect" })
    await created.adapter.waitAgent("child-env")
    const invocation = JSON.parse(readFileSync(join(workdir, "fake-codex-exec-trace.jsonl"), "utf8").trim()) as {
      envKeys: string[]
      env: Record<string, unknown>
      argv: string[]
    }
    expect(invocation.argv).toContain("--profile")
    expect(invocation.argv).toContain("explorer")
    expect(invocation.env).toMatchObject({
      CODEX_HOME: join(workdir, "explicit-codex-home"),
      REPO_DIR: repoDir,
      BOT_WORKDIR: workdir,
      CCHP_EXPLICIT_AGENT_DEPTH: "1",
      hasBridgeCapability: true,
    })
    for (const forbidden of [
      "CCHP_GITHUB_BROKER_SOCKET", "CCHP_GITHUB_BROKER_TOKEN", "CCHP_GITHUB_BROKER_FINALIZER",
      "GH_TOKEN", "CCHP_GH_TOKEN_FILE", "CCHP_BOT_PROVIDER_KEYS", "CCHP_BOT_PROVIDERS",
      "CCHP_PK_GPT_CCHP", "CCHP_APP_CLIENT_ID", "CCHP_APP_PRIVATE_KEY", "SEE_API_KEY",
      "HEROUI_AUTH_TOKEN", "UNRELATED_SECRET",
    ]) expect(invocation.envKeys).not.toContain(forbidden)
  } finally {
    await created.adapter.shutdown()
  }
})

test("fails closed for an unsupported explicit child role", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-agents-mcp-role-"))
  const rootHome = join(workdir, "root-codex-home")
  const repoDir = join(workdir, "repo")
  mkdirSync(rootHome, { recursive: true })
  mkdirSync(repoDir)
  writeFileSync(join(rootHome, "config.toml"), 'model = "root-model"\nreview_model = "review-model"\n[features]\nmulti_agent = false\n')
  const created = createAgentsServer({
    BOT_TASK: "manual", BOT_WORKDIR: workdir, BOT_RUN_ID: "run-role", REPO_DIR: repoDir, CODEX_HOME: rootHome,
    CODEX_BIN: fakeCodex, PATH: process.env.PATH,
  })
  try {
    await expect(created.adapter.spawn("root", { id: "bad-role", role: "security verifier", prompt: "inspect" }))
      .rejects.toThrow("unsupported explicit child role security verifier")
  } finally {
    await created.adapter.shutdown()
  }
})

test("fails closed for a missing or unsupported BOT_TASK", () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-agents-mcp-task-"))
  const rootHome = join(workdir, "root-codex-home")
  const repoDir = join(workdir, "repo")
  mkdirSync(rootHome, { recursive: true })
  mkdirSync(repoDir)
  writeFileSync(join(rootHome, "config.toml"), 'model = "root-model"\nreview_model = "review-model"\n[features]\nmulti_agent = false\n')
  expect(() => createAgentsServer({ BOT_WORKDIR: workdir, REPO_DIR: repoDir, CODEX_HOME: rootHome }))
    .toThrow("unsupported BOT_TASK: <empty>")
  expect(() => createAgentsServer({ BOT_TASK: "unknown", BOT_WORKDIR: workdir, REPO_DIR: repoDir, CODEX_HOME: rootHome }))
    .toThrow("unsupported BOT_TASK: unknown")
})

test("requires pass_kind only for pr_opened review delegation", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-agents-mcp-schema-"))
  const rootHome = join(workdir, "root-codex-home")
  const repoDir = join(workdir, "repo")
  mkdirSync(rootHome, { recursive: true })
  mkdirSync(repoDir)
  writeFileSync(join(rootHome, "config.toml"), 'model = "root-model"\nreview_model = "review-model"\n[features]\nmulti_agent = false\n')
  const review = createAgentsServer({ BOT_TASK: "pr_opened", BOT_WORKDIR: workdir, BOT_RUN_ID: "review", REPO_DIR: repoDir, CODEX_HOME: rootHome })
  const ordinary = createAgentsServer({ BOT_TASK: "manual", BOT_WORKDIR: workdir, BOT_RUN_ID: "manual", REPO_DIR: repoDir, CODEX_HOME: rootHome })
  try {
    expect(review.tools.find((tool) => tool.name === "spawn_agent")!.inputSchema.required)
      .toEqual(["task_name", "message", "pass_kind"])
    expect(ordinary.tools.find((tool) => tool.name === "spawn_agent")!.inputSchema.required)
      .toEqual(["task_name", "message"])
    const ordinaryProperties = ordinary.tools.find((tool) => tool.name === "spawn_agent")!.inputSchema.properties as Record<string, unknown>
    expect(ordinaryProperties).toEqual({
      task_name: { type: "string" },
      message: { type: "string" },
      agent_type: { type: "string", enum: ["explorer", "planner", "implementer", "reviewer", "default", "worker"] },
      fork_turns: { type: ["string", "null"] },
    })
  } finally {
    await review.adapter.shutdown()
    await ordinary.adapter.shutdown()
  }
})
