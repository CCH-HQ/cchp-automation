#!/usr/bin/env bun
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { ExplicitChildAdapter, type ChildHandle } from "./child-adapter"
import { isReviewPassKind, REVIEW_PASS_KINDS, ReviewAdmissionLedger } from "./review-admission"
import { assembleReferenceContext } from "./references"
import { buildCodexEnvironment } from "./supervisor"
import { validateRecordHmacKey } from "./authenticated-record"
import { READ_ONLY_FFF_TOOLS, READ_ONLY_SERENA_TOOLS } from "./config"
import { TASKS, type Task } from "../types"
import { redactRuntimeDiagnostic } from "./diagnostic-redaction"
import { withCollaborationAdmission } from "./collaboration-admission"

type Args = Record<string, unknown>

const str = (args: Args, key: string): string => {
  const value = args[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`)
  return value
}

function schema(properties: Record<string, object>, required: string[]): Tool["inputSchema"] {
  return { type: "object", properties, required }
}

export function serializeAgentsResponse(
  operation: string,
  agents: ChildHandle[],
  delivery?: string,
  secrets: readonly string[] = [],
): string {
  const redact = (value: string | undefined): string | undefined => value === undefined
    ? undefined
    : redactRuntimeDiagnostic(value, secrets)
  const publicError = (value: string | undefined): string | undefined => value === undefined
    ? undefined
    : "explicit child failed; diagnostics retained in the protected child artifact"
  return JSON.stringify({
    schema_version: 1,
    operation,
    agents: agents.map((agent) => ({
      agent_id: agent.childId,
      task_name: agent.childId,
      canonical_task_name: `/${agent.parentId.replace(/^\/+/, "")}/${agent.childId}`,
      parent_id: agent.parentId,
      agent_type: agent.role,
      ...(agent.passKind ? { pass_kind: agent.passKind } : {}),
      state: agent.state,
      session_id: agent.sessionId,
      deadline_at: agent.deadlineAt,
      output: redact(agent.output),
      error: publicError(agent.error),
      attempts: agent.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        sessionId: attempt.sessionId,
        state: attempt.state,
        terminal: attempt.terminal,
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
        ...(attempt.output !== undefined ? { output: redact(attempt.output) } : {}),
        ...(attempt.error !== undefined ? { error: publicError(attempt.error) } : {}),
      })),
    })),
    ...(delivery ? { delivery } : {}),
  })
}

function childMcpConfig(source: string): string {
  const output: string[] = []
  let mcp: "fff" | "serena" | "drop" | undefined
  const finishMcp = () => {
    if (mcp === "fff" || mcp === "serena") {
      const tools = mcp === "fff" ? READ_ONLY_FFF_TOOLS : READ_ONLY_SERENA_TOOLS
      output.push(`enabled_tools = [${tools.map((tool) => JSON.stringify(tool)).join(", ")}]`)
    }
  }
  for (const line of source.split("\n")) {
    const section = /^\[([^\]]+)\]$/.exec(line)
    if (section) {
      finishMcp()
      const mcpSection = /^mcp_servers\.(.+)$/.exec(section[1]!)
      mcp = mcpSection
        ? mcpSection[1] === "fff" || mcpSection[1] === "serena" ? mcpSection[1] : "drop"
        : undefined
      if (mcp !== "drop") output.push(line)
      continue
    }
    if (mcp === "drop" || (mcp && /^\s*enabled_tools\s*=/.test(line))) continue
    output.push(line)
  }
  finishMcp()
  return output.join("\n")
}

function childCodexHome(rootHome: string, workdir: string): string {
  const target = join(workdir, "explicit-codex-home")
  mkdirSync(target, { recursive: true, mode: 0o700 })
  cpSync(join(rootHome, "config.toml"), join(target, "config.toml"), { force: true })
  for (const directory of ["agents", "skills"]) {
    const source = join(rootHome, directory)
    if (existsSync(source)) cpSync(source, join(target, directory), { recursive: true, force: true })
  }
  const configPath = join(target, "config.toml")
  writeFileSync(configPath, childMcpConfig(readFileSync(configPath, "utf8")), { encoding: "utf8", mode: 0o600 })
  const agentsDir = join(target, "agents")
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".toml")) continue
      const rolePath = join(agentsDir, entry.name)
      const roleConfig = childMcpConfig(readFileSync(rolePath, "utf8"))
      writeFileSync(rolePath, roleConfig, { encoding: "utf8", mode: 0o600 })
      const profile = entry.name.slice(0, -".toml".length)
      const profileConfig = roleConfig
        .split("\n")
        .filter((line) => !/^\s*(name|description)\s*=/.test(line))
        .join("\n")
      writeFileSync(join(target, `${profile}.config.toml`), profileConfig, { encoding: "utf8", mode: 0o600 })
    }
  }
  return target
}

function configuredModel(config: string, key: "model" | "review_model"): string {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, "m").exec(config)
  if (!match?.[1]) throw new Error(`CODEX_HOME/config.toml is missing ${key}`)
  return match[1]
}

export function createAgentsServer(env: Record<string, string | undefined> = process.env): {
  server: Server
  adapter: ExplicitChildAdapter
  tools: Tool[]
} {
  const rawTask = env.BOT_TASK
  if (!TASKS.includes(rawTask as Task)) throw new Error(`unsupported BOT_TASK: ${rawTask || "<empty>"}`)
  const task = rawTask as Task
  const workdir = env.BOT_WORKDIR
  const repoDir = env.REPO_DIR
  const rootHome = env.CODEX_HOME
  if (!workdir || !repoDir || !rootHome) throw new Error("BOT_WORKDIR, REPO_DIR, and CODEX_HOME are required")
  const runId = env.BOT_RUN_ID
  const writerId = env.CCHP_RUN_WRITER_ID
  const generation = Number(env.CCHP_RUN_WRITER_GENERATION)
  if (!runId || !writerId || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("explicit agents MCP requires a valid collaboration admission identity")
  }
  const recordHmacKey = validateRecordHmacKey(env.CCHP_PROCESS_RECORD_HMAC_KEY)
  const admissionIdentity = { runId, writerId, generation }
  const responseSecrets = Object.entries(env)
    .filter(([name, value]) => Boolean(value) && (name === "CCHP_PROCESS_RECORD_HMAC_KEY" || /(?:token|secret|password|credential|private[-_]?key|api[-_]?key)/i.test(name)))
    .map(([, value]) => value!)
  const serialize = (operation: string, agents: ChildHandle[], delivery?: string): string =>
    serializeAgentsResponse(operation, agents, delivery, responseSecrets)
  const childHome = childCodexHome(rootHome, workdir)
  const rootConfig = readFileSync(join(rootHome, "config.toml"), "utf8")
  const childEnv = buildCodexEnvironment(env)
  delete childEnv.CCHP_GITHUB_BROKER_SOCKET
  delete childEnv.CCHP_GITHUB_BROKER_TOKEN
  delete childEnv.CCHP_GITHUB_BROKER_FINALIZER
  delete childEnv.CCHP_PROCESS_RECORD_HMAC_KEY
  childEnv.CODEX_HOME = childHome
  childEnv.REPO_DIR = repoDir

  const reviewAdmissions = task === "pr_opened"
    ? new ReviewAdmissionLedger(join(workdir, "ctx", "codex", "review-admission.jsonl"), env.BOT_RUN_ID ?? "unknown", undefined, true)
    : undefined

  const adapter = new ExplicitChildAdapter({
    exec: {
      codexBin: env.CODEX_BIN ?? "codex",
      cwd: repoDir,
      env: childEnv,
      sandbox: "read-only",
      strictConfig: true,
      onStderr: async (line) => {
        appendFileSync(
          join(workdir, "ctx", "child-results", "codex-exec.stderr.log"),
          `${redactRuntimeDiagnostic(line, responseSecrets)}\n`,
          {
          encoding: "utf8",
          mode: 0o600,
          },
        )
      },
    },
    childModels: {
      review: configuredModel(rootConfig, "review_model"),
      worker: configuredModel(rootConfig, "model"),
    },
    resultRoot: join(workdir, "ctx", "child-results"),
    runId: env.BOT_RUN_ID,
    parentRunId: env.BOT_RUN_ID,
    unlimited: true,
    admissionLedger: reviewAdmissions,
    redactDiagnostic: (value) => redactRuntimeDiagnostic(value, responseSecrets),
    recordHmacKey,
  })
  const spawnProperties: Record<string, object> = {
    task_name: { type: "string" },
    message: { type: "string" },
    agent_type: { type: "string", enum: ["explorer", "planner", "implementer", "reviewer", "default", "worker"] },
    fork_turns: { type: ["string", "null"] },
  }
  if (task === "pr_opened") spawnProperties.pass_kind = { type: "string", enum: [...REVIEW_PASS_KINDS] }
  const defs: Tool[] = [
    { name: "spawn_agent", description: "Spawn one explicit Codex CLI child with the configured review or worker leaf model.", inputSchema: schema(spawnProperties, task === "pr_opened" ? ["task_name", "message", "pass_kind"] : ["task_name", "message"]) },
    { name: "send_message", description: "Queue a message for an active explicit child.", inputSchema: schema({ target: { type: "string" }, message: { type: "string" } }, ["target", "message"]) },
    { name: "followup_task", description: "Resume a terminal explicit child on its existing Codex session.", inputSchema: schema({ target: { type: "string" }, message: { type: "string" } }, ["target", "message"]) },
    { name: "wait_agent", description: "Wait for one child or every current child to reach a terminal state without a timeout.", inputSchema: schema({ target: { type: "string" }, timeout_ms: { type: "integer", minimum: 1 } }, []) },
    { name: "interrupt_agent", description: "Interrupt one explicit child and its process group.", inputSchema: schema({ target: { type: "string" } }, ["target"]) },
    { name: "list_agents", description: "List explicit child state.", inputSchema: schema({}, []) },
  ]
  const server = new Server({ name: "agents", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: defs }))
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = (request.params.arguments ?? {}) as Args
    try {
      switch (request.params.name) {
        case "spawn_agent": {
          if (env.CCHP_EXPLICIT_AGENT_DEPTH === "1") throw new Error("explicit child delegation depth exceeded")
          if (args.fork_turns != null && args.fork_turns !== "none") {
            throw new Error("explicit child mode supports fork_turns=none only")
          }
          const id = str(args, "task_name")
          const role = typeof args.agent_type === "string" && args.agent_type ? args.agent_type : "explorer"
          const rawPassKind = typeof args.pass_kind === "string" && args.pass_kind.trim()
            ? args.pass_kind.trim()
            : undefined
          if (task === "pr_opened" && !rawPassKind) throw new Error("pass_kind must be a non-empty string")
          if (rawPassKind !== undefined && !isReviewPassKind(rawPassKind)) {
            throw new Error("pass_kind is not a supported review pass kind")
          }
          const passKind = isReviewPassKind(rawPassKind) ? rawPassKind : undefined
          const message = str(args, "message")
          const references = reviewAdmissions ? assembleReferenceContext(role, message) : undefined
          return await withCollaborationAdmission(workdir, admissionIdentity, async () => {
            if (reviewAdmissions) {
              if (!passKind) throw new Error("review delegation requires pass_kind")
              reviewAdmissions.admit({ taskId: id, role, passKind, mode: "explicit_child", prompt: message })
            }
            try {
              const handle = await adapter.spawn(env.CCHP_EXPLICIT_PARENT_ID ?? "root", {
                id,
                role,
                ...(passKind ? { passKind } : {}),
                agent: typeof args.agent_type === "string" ? args.agent_type : undefined,
                prompt: references ? `${message}\n\n${references.text}` : message,
                admissionPrompt: message,
              })
              return { content: [{ type: "text", text: serialize("spawn_agent", [handle], "started") }] }
            } catch (error) {
              const message = redactRuntimeDiagnostic(error instanceof Error ? error.message : String(error), responseSecrets)
              if (reviewAdmissions?.task(id) && reviewAdmissions.task(id)?.state === "admitted") {
                reviewAdmissions.markTerminal(id, "failed", message)
              }
              throw new Error(message)
            }
          })
        }
        case "send_message": {
          const handle = await withCollaborationAdmission(workdir, admissionIdentity, () =>
            adapter.sendMessage(str(args, "target"), str(args, "message")))
          return { content: [{ type: "text", text: serialize("send_message", [handle], "queued") }] }
        }
        case "followup_task": {
          if (reviewAdmissions) throw new Error("review followup requires a new unique task_name and spawn_agent admission")
          const handle = await withCollaborationAdmission(workdir, admissionIdentity, () =>
            adapter.followupTask(str(args, "target"), str(args, "message")))
          return { content: [{ type: "text", text: serialize("followup_task", [handle], "terminal") }] }
        }
        case "wait_agent": {
          const timeout = args.timeout_ms == null ? undefined : Number(args.timeout_ms)
          const handles = typeof args.target === "string"
            ? [await adapter.waitAgent(args.target, timeout)]
            : await Promise.all(adapter.listAgents().map((agent) => adapter.waitAgent(agent.childId, timeout)))
          return { content: [{ type: "text", text: serialize("wait_agent", handles, "terminal") }] }
        }
        case "interrupt_agent": {
          const id = str(args, "target")
          await adapter.interruptAgent(id)
          return { content: [{ type: "text", text: serialize("interrupt_agent", adapter.listAgents().filter((agent) => agent.childId === id), "interrupted") }] }
        }
        case "list_agents":
          return { content: [{ type: "text", text: serialize("list_agents", adapter.listAgents()) }] }
        default:
          throw new Error(`unknown tool: ${request.params.name}`)
      }
    } catch (error) {
      const message = redactRuntimeDiagnostic(error instanceof Error ? error.message : String(error), responseSecrets)
      return { isError: true, content: [{ type: "text", text: `error: ${message}` }] }
    }
  })
  return { server, adapter, tools: defs }
}

async function main(): Promise<void> {
  mkdirSync(join(process.env.BOT_WORKDIR ?? ".", "ctx", "child-results"), { recursive: true, mode: 0o700 })
  const { server, adapter } = createAgentsServer(process.env)
  const shutdown = async () => { await adapter.prepareRestart(); process.exit(0) }
  process.once("SIGINT", () => void shutdown())
  process.once("SIGTERM", () => void shutdown())
  await server.connect(new StdioServerTransport())
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`[agents-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
