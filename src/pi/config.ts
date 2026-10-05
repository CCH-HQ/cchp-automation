import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { piModelsJson, type PiProviderSet } from "./providers"

export interface PreparePiHomeInput {
  botWorkdir: string
  engineDir: string
  repoDir: string
  providerSet: PiProviderSet
  systemPrompt: string
  task: string
  runId: string
  brokerSocket: string
  brokerTokenEnv: string
  brokerFinalizer: string
  runtimeEnv: Record<string, string | undefined>
  bunCommand?: string
  seeServer?: string
  agentModel?: string
  agentAllowShell?: boolean
  bridge?: { baseUrl: string; tokenEnv: string; providerIds: ReadonlySet<string> }
}

export interface PreparedPiHome {
  agentDir: string
  modelsPath: string
  mcpPath: string
  settingsPath: string
  sessionDir: string
  todoPath: string
  extensionPath: string
}

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 })
  chmodSync(path, 0o600)
}

function literalEnv(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined
}

function mcpEnvironment(input: PreparePiHomeInput): Record<string, string> {
  const source = input.runtimeEnv
  const environment: Record<string, string> = {
    BOT_REPO: source.BOT_REPO ?? "",
    BOT_TASK: input.task,
    BOT_RUN_ID: input.runId,
    BOT_WORKDIR: input.botWorkdir,
    REPO_DIR: input.repoDir,
    BOT_CAN_WRITE: source.BOT_CAN_WRITE ?? "0",
    CCHP_GITHUB_BROKER_SOCKET: input.brokerSocket,
    CCHP_GITHUB_BROKER_TOKEN: `\${${input.brokerTokenEnv}}`,
    CCHP_GITHUB_BROKER_FINALIZER: input.brokerFinalizer,
    CCHP_PI_NATIVE_REVIEW: "1",
    CCHP_PI_AGENT_DEPTH: `\${CCHP_PI_AGENT_DEPTH}`,
    CCHP_PI_AGENT_MODEL: input.agentModel ?? "",
    CCHP_PI_AGENT_ALLOW_SHELL: input.agentAllowShell ? "1" : "0",
    PI_BIN: source.PI_BIN ?? "",
    PI_CODING_AGENT_DIR: join(input.botWorkdir, "pi-home"),
    CCHP_PI_AGENT_SESSION_DIR: join(input.botWorkdir, "ctx", "pi", "child-sessions"),
    CCHP_PI_BRIDGE_TOKEN: `\${CCHP_PI_BRIDGE_TOKEN}`,
  }
  for (const key of [
    "BOT_PR_NUMBER", "BOT_ISSUE_NUMBER", "BOT_DISCUSSION_NUMBER", "BOT_HEAD_SHA", "BOT_PLAN_COMMENT_ID",
    "BOT_ROADMAP_PROJECT", "BOT_RELEASE_TAG", "BOT_DEFAULT_BRANCH", "BOT_PR_IS_FORK", "CCHP_WORKFLOW_RUN_ID",
  ]) {
    const value = literalEnv(source[key])
    if (value) environment[key] = value
  }
  return environment
}

export function preparePiHome(input: PreparePiHomeInput): PreparedPiHome {
  const agentDir = join(input.botWorkdir, "pi-home")
  const sessionDir = join(input.botWorkdir, "ctx", "pi", "sessions")
  const todoPath = join(input.botWorkdir, "ctx", "pi", "todo.json")
  const extensionPath = join(input.engineDir, "pi", "extensions", "cchp-todo.ts")
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  mkdirSync(join(input.botWorkdir, "ctx", "pi"), { recursive: true, mode: 0o700 })

  const modelsPath = join(agentDir, "models.json")
  const mcpPath = join(agentDir, "mcp.json")
  const settingsPath = join(agentDir, "settings.json")
  writePrivate(modelsPath, piModelsJson(input.providerSet, input.bridge))
  const mcpServers: Record<string, unknown> = {
    cchp_github: {
      command: input.bunCommand ?? "bun",
      args: [join(input.engineDir, "src", "mcp", "server.ts")],
      cwd: input.repoDir,
      env: mcpEnvironment(input),
      description: "Trusted, task-scoped GitHub reads and mutations through the CCHP broker",
      exposure: "direct",
    },
    agents: {
      command: input.bunCommand ?? "bun",
      args: [join(input.engineDir, "src", "pi", "agents-server.ts")],
      cwd: input.repoDir,
      env: mcpEnvironment(input),
      description: "Pi-native task-scoped child agents for independent review and verification passes",
      exposure: "direct",
    },
  }
  if (input.seeServer) {
    mcpServers.see_upload = {
      command: input.bunCommand ?? "bun",
      args: [input.seeServer],
      cwd: input.repoDir,
      env: {
        BOT_WORKDIR: input.botWorkdir,
        REPO_DIR: input.repoDir,
        CCHP_GITHUB_BROKER_SOCKET: input.brokerSocket,
        CCHP_GITHUB_BROKER_TOKEN: `\${${input.brokerTokenEnv}}`,
      },
      description: "Validated image and artifact upload for review evidence",
      exposure: "deferred",
    }
  }
  writePrivate(mcpPath, `${JSON.stringify({ mcpServers }, null, 2)}\n`)
  writePrivate(settingsPath, `${JSON.stringify({
    defaultProjectTrust: "always",
    enableInstallTelemetry: false,
    defaultTools: ["read", "grep", "find", "ls", "todo", ...(input.agentAllowShell ? ["write", "edit", "bash"] : []), "+tool_search"],
    sessionDir,
  }, null, 2)}\n`)
  writePrivate(join(agentDir, "APPEND_SYSTEM.md"), `${input.systemPrompt.trim()}\n\nRun id: ${input.runId}\nTask: ${input.task}\n`)
  return { agentDir, modelsPath, mcpPath, settingsPath, sessionDir, todoPath, extensionPath }
}
