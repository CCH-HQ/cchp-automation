import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareCodexHome } from "./config"
import { parseProviders } from "./providers"

test("writes an isolated strict Codex config with loopback providers and no caller secrets", () => {
  const botWorkdir = mkdtempSync(join(tmpdir(), "cchp-codex-"))
  mkdirSync(join(botWorkdir, "repo", ".git"), { recursive: true })
  const providerSet = parseProviders({
    providerJson: JSON.stringify({
      "gpt-cchp": {
        format: "openai-responses",
        base_url: "https://upstream.example/v1",
        models: { "gpt-5.6-sol": { context: 372000, output: 131072, vision: true } },
      },
      review: {
        format: "openai-compatible",
        base_url: "https://review.example/v1",
        models: { small: { upstream_id: "openai/gpt-5.6-sol-mini", context: 128000, output: 32000 } },
      },
    }),
    providerKeysJson: JSON.stringify({ "gpt-cchp": "main-secret", review: "review-secret" }),
    model: "gpt-cchp/gpt-5.6-sol",
    smallModel: "review/small",
  })

  const result = prepareCodexHome({
    botWorkdir,
    engineDir: "/opt/cchp-engine",
    bunCommand: "/opt/cchp/bin/bun",
    repoDir: `${botWorkdir}/repo`,
    bridgeBaseUrl: "http://127.0.0.1:43123",
    bridgeTokenEnv: "CCHP_CODEX_BRIDGE_TOKEN",
    providerSet,
    sandboxMode: "workspace-write",
    fffCommand: "fff-mcp",
    serenaCommand: "serena",
    seeServer: "/opt/cchp-engine/src/mcp/see-server.ts",
    seeCliBin: "/home/runner/.local/lib/see-cli/see",
  })
  const config = readFileSync(result.configPath, "utf8")
  const reviewer = readFileSync(join(result.codexHome, "agents", "reviewer.toml"), "utf8")
  const explorer = readFileSync(join(result.codexHome, "agents", "explorer.toml"), "utf8")
  const planner = readFileSync(join(result.codexHome, "agents", "planner.toml"), "utf8")
  const implementer = readFileSync(join(result.codexHome, "agents", "implementer.toml"), "utf8")
  const defaultAgent = readFileSync(join(result.codexHome, "agents", "default.toml"), "utf8")
  const worker = readFileSync(join(result.codexHome, "agents", "worker.toml"), "utf8")
  const modelCatalog = JSON.parse(readFileSync(join(result.codexHome, "models.json"), "utf8")) as {
    models: Array<Record<string, unknown>>
  }

  expect(result.codexHome).toBe(join(botWorkdir, "codex-home"))
  expect(config).toContain('model = "gpt-5.6-sol"')
  expect(config).toContain('allow_login_shell = false')
  expect(config).toContain('model_provider = "cchp_gpt_cchp_')
  expect(config).toContain('base_url = "http://127.0.0.1:43123/providers/gpt-cchp/v1"')
  expect(config).toContain('env_key = "CCHP_CODEX_BRIDGE_TOKEN"')
  expect(config).toContain(`model_catalog_json = "${join(result.codexHome, "models.json")}"`)
  expect(config).toContain("[features.multi_agent_v2]")
  expect(config).not.toContain("use_legacy_landlock = true")
  expect(config).not.toContain("[permissions.cchp-workspace]")
  expect(config).not.toContain("[sandbox_workspace_write]")
  expect(config).not.toContain("[features.network_proxy]")
  expect(config).toContain('[features]\nshell_snapshot = false\ncode_mode_host = false')
  expect(config).toContain('[shell_environment_policy]\ninherit = "all"\nignore_default_excludes = false')
  for (const name of [
    "CCHP_CODEX_BRIDGE_TOKEN",
    "CCHP_GITHUB_BROKER_SOCKET",
    "CCHP_GITHUB_BROKER_TOKEN",
    "CCHP_GITHUB_BROKER_FINALIZER",
    "CCHP_PROCESS_RECORD_HMAC_KEY",
    "SEE_API_KEY",
    "HEROUI_AUTH_TOKEN",
  ]) {
    expect(config).toContain(`"${name}" = "exclude"`)
  }
  // gpt-5.6-sol is code-mode-only. This setting makes collaboration tools
  // DirectModelOnly so they remain top-level and cannot be swallowed by exec.
  expect(config).toContain("non_code_mode_only = true")
  expect(config).not.toContain("max_depth")
  expect(config).not.toContain("[mcp_servers.agents]")
  expect(config).toContain('[mcp_servers.cchp_github]')
  const githubMcp = config.slice(
    config.indexOf("[mcp_servers.cchp_github]"),
    config.indexOf("[mcp_servers.fff]") === -1 ? config.length : config.indexOf("[mcp_servers.fff]"),
  )
  expect(githubMcp).toContain('command = "/opt/cchp/bin/bun"')
  for (const name of ["PATH", "HOME", "LANG", "TMPDIR"]) {
    expect(githubMcp).toContain(`"${name}"`)
  }
  expect(githubMcp).not.toContain("CCHP_CODEX_BRIDGE_TOKEN")
  expect(reviewer).toContain(`model = "${providerSet.reviewModelKey}"`)
  expect(reviewer).toContain('model_provider = "cchp_review_')
  for (const role of [planner, implementer, defaultAgent, worker]) {
    expect(role).toContain(`model = "${providerSet.workerModelKey}"`)
    expect(role).toContain('model_provider = "cchp_gpt_cchp_')
  }
  expect(modelCatalog.models).toEqual([
    expect.objectContaining({
      slug: providerSet.main.modelKey,
      multi_agent_version: "v2",
      tool_mode: "code_mode_only",
      apply_patch_tool_type: "freeform",
    }),
    expect.objectContaining({
      slug: providerSet.reviewModelKey,
      multi_agent_version: "disabled",
      tool_mode: "code_mode_only",
      apply_patch_tool_type: null,
    }),
    expect.objectContaining({
      slug: providerSet.workerModelKey,
      multi_agent_version: "disabled",
      tool_mode: "code_mode_only",
      apply_patch_tool_type: "freeform",
    }),
  ])
  expect(modelCatalog.models.every((model) => typeof model.base_instructions === "string")).toBe(true)
  expect(config).toContain('[mcp_servers.fff]\ncommand = "fff-mcp"\nenv_vars =')
  expect(config).not.toContain('args = ["--stdio"]')
  expect(config).toContain('[mcp_servers.see_upload]')
  expect(config).toContain('[mcp_servers.see_upload]\ncommand = "/opt/cchp/bin/bun"')
  expect(config).toContain('enabled_tools = ["upload_file"]')
  expect(config).toContain('"CCHP_GITHUB_BROKER_SOCKET"')
  expect(config).toContain('"CCHP_GITHUB_BROKER_TOKEN"')
  expect(config).toContain('"BOT_LOGIN"')
  expect(config).toContain('"BOT_GIT_NAME"')
  expect(config).toContain('"BOT_SLUG"')
  expect(config).not.toContain("SEE_API_KEY_FILE")
  expect(config).not.toContain("SEE_API_KEY =")
  for (const role of [reviewer, explorer, planner]) {
    expect(role.indexOf("developer_instructions = ")).toBeLessThan(role.indexOf("[features]"))
    expect(role).toContain('[mcp_servers.fff]\ncommand = "fff-mcp"')
    expect(role).toContain('enabled_tools = ["find_files", "grep", "multi_grep"]')
    expect(role).toContain('[mcp_servers.serena]\ncommand = "serena"')
    expect(role).toContain('enabled_tools = ["search_for_pattern", "get_symbols_overview", "find_symbol", "find_referencing_symbols", "find_implementations", "find_declaration", "get_diagnostics_for_file", "get_current_config", "initial_instructions"]')
    expect(role).toContain('[mcp_servers.cchp_github]\ncommand = "/opt/cchp/bin/bun"')
    expect(role).toContain('enabled_tools = ["get_pr_diff"')
    for (const forbidden of [
      "write_review_artifact", "post_comment", "merge_pr", "create_pull_request",
      "replace_in_files", "replace_symbol_body", "insert_after_symbol", "insert_before_symbol",
      "rename_symbol", "safe_delete_symbol", "write_memory", "delete_memory", "rename_memory", "edit_memory",
    ]) expect(role).not.toContain(`\"${forbidden}\"`)
  }
  for (const role of [reviewer, explorer, planner, implementer, defaultAgent, worker]) {
    expect(role).toContain("[agents]\nenabled = false")
    expect(role).toContain("[features]\nmulti_agent = false")
    expect(role).toContain("[features.multi_agent_v2]\nenabled = false")
  }
  expect(implementer).not.toContain("[mcp_servers.")
  for (const role of [reviewer, explorer, planner, implementer, defaultAgent, worker]) expect(role).not.toContain("[mcp_servers.see_upload]")
  expect(`${config}\n${reviewer}`).not.toContain("main-secret")
  expect(`${config}\n${reviewer}`).not.toContain("review-secret")
  expect(`${config}\n${reviewer}`).not.toContain("https://upstream.example")
  expect(`${config}\n${reviewer}`).not.toContain("https://review.example")
})

test("explicit fallback disables native collaboration and registers exactly one agents MCP", () => {
  const botWorkdir = mkdtempSync(join(tmpdir(), "cchp-codex-explicit-"))
  mkdirSync(join(botWorkdir, "repo", ".git"), { recursive: true })
  const providerSet = parseProviders({
    providerJson: JSON.stringify({
      "gpt-cchp": {
        format: "openai-responses",
        base_url: "https://upstream.example/v1",
        models: {
          "gpt-5.6-sol": { context: 372000, output: 131072, vision: true },
          small: { upstream_id: "gpt-5.6-sol", context: 128000, output: 32000 },
        },
      },
    }),
    providerKeysJson: JSON.stringify({ "gpt-cchp": "secret" }),
    model: "gpt-cchp/gpt-5.6-sol",
    smallModel: "gpt-cchp/small",
  })
  const result = prepareCodexHome({
    botWorkdir,
    engineDir: "/opt/cchp-engine",
    bunCommand: "/opt/cchp/bin/bun",
    repoDir: `${botWorkdir}/repo`,
    bridgeBaseUrl: "http://127.0.0.1:43123",
    bridgeTokenEnv: "CCHP_CODEX_BRIDGE_TOKEN",
    providerSet,
    sandboxMode: "workspace-write",
    collaborationMode: "explicit-exec",
  })
  const config = readFileSync(result.configPath, "utf8")
  expect(config).toContain("multi_agent = false")
  expect(config).toContain("[features.multi_agent_v2]\nenabled = false")
  expect(config.match(/\[mcp_servers\.agents\]/g)).toHaveLength(1)
  expect(config).not.toContain("max_concurrent_threads_per_session")
  const agentsMcp = config.slice(config.indexOf("[mcp_servers.agents]"))
  expect(agentsMcp).toContain('command = "/opt/cchp/bin/bun"')
  expect(agentsMcp).toContain('"BOT_TASK"')
  expect(agentsMcp).toContain('"CCHP_PROCESS_RECORD_HMAC_KEY"')
  for (const name of ["PATH", "HOME", "LANG", "TMPDIR"]) {
    expect(agentsMcp).toContain(`"${name}"`)
  }
})

test("non-reasoning small models do not advertise or force reasoning", () => {
  const botWorkdir = mkdtempSync(join(tmpdir(), "cchp-codex-nonreasoning-"))
  const providerSet = parseProviders({
    providerJson: JSON.stringify({
      main: {
        format: "openai-responses",
        base_url: "https://main.example/v1",
        models: { "gpt-5.6-sol": { reasoning: true } },
      },
      small: {
        format: "openai-compatible",
        base_url: "https://small.example/v1",
        models: { leaf: { reasoning: false } },
      },
    }),
    model: "main/gpt-5.6-sol",
    smallModel: "small/leaf",
  })
  const result = prepareCodexHome({
    botWorkdir,
    engineDir: "/opt/cchp-engine",
    repoDir: join(botWorkdir, "repo"),
    bridgeBaseUrl: "http://127.0.0.1:43123",
    bridgeTokenEnv: "CCHP_CODEX_BRIDGE_TOKEN",
    providerSet,
    sandboxMode: "read-only",
  })
  const reviewer = readFileSync(join(result.codexHome, "agents", "reviewer.toml"), "utf8")
  const explorer = readFileSync(join(result.codexHome, "agents", "explorer.toml"), "utf8")
  const config = readFileSync(result.configPath, "utf8")
  expect(config).toContain("use_legacy_landlock = true")
  expect(config).not.toContain("[sandbox_workspace_write]")
  expect(config).not.toContain("[features.network_proxy]")
  expect(reviewer).not.toContain("model_reasoning_effort")
  expect(explorer).not.toContain("model_reasoning_effort")
  const models = JSON.parse(readFileSync(join(result.codexHome, "models.json"), "utf8")) as { models: Array<Record<string, unknown>> }
  expect(models.models.find((model) => model.slug === providerSet.reviewModelKey)).toMatchObject({
    default_reasoning_level: null,
    supported_reasoning_levels: [],
  })
})
