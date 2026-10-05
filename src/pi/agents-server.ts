#!/usr/bin/env bun
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { runPiRpc, type PiRpcResult } from "./rpc"

type Args = Record<string, unknown>
type ChildState = "queued" | "running" | "completed" | "failed" | "cancelled"
type AgentRole = "explorer" | "planner" | "implementer" | "reviewer" | "default" | "worker"
type PassKind = "review_shard" | "correctness" | "verifier" | "refuter" | "reproducer" | "adjudicator" | "completeness"

interface Attempt {
  attempt: number
  sessionId: string
  state: ChildState
  startedAt: string
  completedAt?: string
  output?: string
  error?: string
}

interface Child {
  childId: string
  parentId: string
  role: AgentRole
  passKind?: PassKind
  sessionId: string
  deadlineAt: string
  state: ChildState
  attempts: Attempt[]
  mailbox: string[]
  controller?: AbortController
  promise?: Promise<void>
  output?: string
  error?: string
}

const ROLES = new Set<AgentRole>(["explorer", "planner", "implementer", "reviewer", "default", "worker"])
const PASS_KINDS = new Set<PassKind>(["review_shard", "correctness", "verifier", "refuter", "reproducer", "adjudicator", "completeness"])
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000

function text(args: Args, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`)
  return value.trim()
}

function schema(properties: Record<string, object>, requiredKeys: string[]): Tool["inputSchema"] {
  return { type: "object", properties, required: requiredKeys }
}

function safeId(value: string): string {
  const result = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "")
  if (!result) throw new Error("task_name must contain a safe identifier")
  return result.slice(0, 96)
}

function secretValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => Boolean(value) && /(?:token|secret|password|credential|private[-_]?key|api[-_]?key)/i.test(name))
    .map(([, value]) => value!)
    .filter((value) => value.length > 4)
    .sort((a, b) => b.length - a.length)
}

function redact(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return secretValues().reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value)
}

function publicAgent(agent: Child): Record<string, unknown> {
  return {
    agent_id: agent.childId,
    task_name: agent.childId,
    canonical_task_name: `/${agent.parentId.replace(/^\/+/, "")}/${agent.childId}`,
    parent_id: agent.parentId,
    agent_type: agent.role,
    ...(agent.passKind ? { pass_kind: agent.passKind } : {}),
    state: agent.state,
    session_id: agent.sessionId,
    deadline_at: agent.deadlineAt,
    ...(agent.output !== undefined ? { output: redact(agent.output) } : {}),
    ...(agent.error !== undefined ? { error: redact(agent.error) } : {}),
    attempts: agent.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      sessionId: attempt.sessionId,
      state: attempt.state,
      startedAt: attempt.startedAt,
      ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
      ...(attempt.output !== undefined ? { output: redact(attempt.output) } : {}),
      ...(attempt.error !== undefined ? { error: redact(attempt.error) } : {}),
    })),
  }
}

function response(operation: string, agents: Child[], delivery?: string): string {
  return JSON.stringify({
    schema_version: 1,
    operation,
    agents: agents.map(publicAgent),
    ...(delivery ? { delivery } : {}),
  })
}

function childEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  const env = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as Record<string, string>
  env.CCHP_PI_AGENT_DEPTH = "1"
  env.CCHP_PI_AGENT_CHILD = "1"
  env.PI_OFFLINE = "1"
  env.PI_SKIP_VERSION_CHECK = "1"
  env.PI_TELEMETRY = "0"
  delete env.CCHP_BOT_PROVIDER_KEYS
  delete env.CCHP_BOT_PROVIDERS
  delete env.GH_TOKEN
  delete env.CCHP_APP_CLIENT_ID
  delete env.CCHP_APP_PRIVATE_KEY
  delete env.SEE_API_KEY
  delete env.HEROUI_AUTH_TOKEN
  return env
}

function childTimeoutMs(): number {
  const configured = Number(process.env.CCHP_PI_AGENT_TIMEOUT_MS ?? "")
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS
}

export function createPiAgentsServer(env: Record<string, string | undefined> = process.env): {
  server: Server
  children: Map<string, Child>
} {
  for (const name of ["BOT_WORKDIR", "REPO_DIR", "PI_BIN", "PI_CODING_AGENT_DIR", "CCHP_PI_AGENT_MODEL"]) {
    if (!env[name]?.trim()) throw new Error(`${name} is required`)
  }
  const workdir = env.BOT_WORKDIR!
  const repoDir = env.REPO_DIR!
  const agentDir = env.PI_CODING_AGENT_DIR!
  const sessionDir = env.CCHP_PI_AGENT_SESSION_DIR?.trim() || join(workdir, "ctx", "pi", "child-sessions")
  const model = env.CCHP_PI_AGENT_MODEL!
  const piBin = env.PI_BIN!
  const allowShell = env.CCHP_PI_AGENT_ALLOW_SHELL === "1"
  const depth = env.CCHP_PI_AGENT_DEPTH ?? "0"
  const runId = env.BOT_RUN_ID ?? "pi"
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  const children = new Map<string, Child>()

  const startAttempt = (child: Child, prompt: string): void => {
    if (child.state === "running") throw new Error(`agent ${child.childId} is already running`)
    const attemptNumber = child.attempts.length + 1
    const startedAt = new Date().toISOString()
    const eventLogPath = join(workdir, "ctx", "pi", "children", `${safeId(child.childId)}-${attemptNumber}.events.jsonl`)
    mkdirSync(join(workdir, "ctx", "pi", "children"), { recursive: true, mode: 0o700 })
    const controller = new AbortController()
    const attempt: Attempt = { attempt: attemptNumber, sessionId: child.sessionId, state: "running", startedAt }
    child.attempts.push(attempt)
    child.controller = controller
    child.state = "running"
    child.error = undefined
    const timeout = setTimeout(() => controller.abort(), childTimeoutMs())
    child.promise = runPiRpc({
      piBin,
      cwd: repoDir,
      env: childEnvironment(env),
      prompt,
      model,
      thinking: env.BOT_TASK === "pr_opened" ? "low" : "medium",
      sessionDir,
      sessionName: `cchp-child-${child.childId}`,
      sessionId: child.sessionId,
      eventLogPath,
      allowShell,
      abortSignal: controller.signal,
    }).then((result: PiRpcResult) => {
      attempt.state = result.state === "SUCCEEDED" ? "completed" : result.state === "CANCELLED" ? "cancelled" : "failed"
      attempt.completedAt = new Date().toISOString()
      attempt.output = result.finalMessage
      if (result.state !== "SUCCEEDED") attempt.error = result.finalMessage || `child exited with code ${result.exitCode}`
      child.state = attempt.state
      child.output = result.finalMessage
      child.error = attempt.error
    }).catch((error) => {
      attempt.state = "failed"
      attempt.completedAt = new Date().toISOString()
      attempt.error = error instanceof Error ? error.message : String(error)
      child.state = "failed"
      child.error = attempt.error
    }).finally(() => {
      clearTimeout(timeout)
      child.controller = undefined
      if (child.mailbox.length > 0 && child.state !== "running") {
        const next = child.mailbox.splice(0).join("\n\n")
        startAttempt(child, next)
      }
    })
  }

  const server = new Server({ name: "agents", version: "1.0.0" }, { capabilities: { tools: {} } })
  const defs: Tool[] = [
    {
      name: "spawn_agent",
      description: "Spawn a Pi child for an independent CCHP review or verification pass.",
      inputSchema: schema({
        task_name: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
        agent_type: { type: "string", enum: [...ROLES] },
        fork_turns: { type: ["string", "null"] },
        pass_kind: { type: "string", enum: [...PASS_KINDS] },
      }, env.BOT_TASK === "pr_opened" ? ["task_name", "message", "pass_kind"] : ["task_name", "message"]),
    },
    { name: "send_message", description: "Queue a message for a Pi child; it is delivered as its next turn.", inputSchema: schema({ target: { type: "string" }, message: { type: "string" } }, ["target", "message"]) },
    { name: "followup_task", description: "Resume a completed Pi child session with a fresh task message.", inputSchema: schema({ target: { type: "string" }, message: { type: "string" } }, ["target", "message"]) },
    { name: "wait_agent", description: "Wait for one child or every current child to reach a terminal state.", inputSchema: schema({ target: { type: "string" }, timeout_ms: { type: "integer", minimum: 1 } }, []) },
    { name: "interrupt_agent", description: "Terminate a running Pi child and record a cancelled terminal state.", inputSchema: schema({ target: { type: "string" } }, ["target"]) },
    { name: "list_agents", description: "List every Pi child and its current state.", inputSchema: schema({}, []) },
  ]
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: defs }))
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = (request.params.arguments ?? {}) as Args
    try {
      if (request.params.name === "spawn_agent") {
        if (depth === "1") throw new Error("child agent delegation depth exceeded")
        const childId = safeId(text(args, "task_name"))
        if (children.has(childId)) throw new Error(`agent ${childId} already exists; use a fresh task_name`)
        const message = text(args, "message")
        const role = (typeof args.agent_type === "string" && ROLES.has(args.agent_type as AgentRole) ? args.agent_type : "default") as AgentRole
        const passKind = args.pass_kind === undefined ? undefined : String(args.pass_kind) as PassKind
        if (env.BOT_TASK === "pr_opened" && (!passKind || !PASS_KINDS.has(passKind))) throw new Error("pass_kind is required for pr_opened")
        if (args.fork_turns != null && args.fork_turns !== "none") throw new Error("fork_turns must be none")
        const child: Child = {
          childId,
          parentId: "root",
          role,
          ...(passKind ? { passKind } : {}),
          sessionId: `${runId}-${childId}`,
          deadlineAt: new Date(Date.now() + childTimeoutMs()).toISOString(),
          state: "queued",
          attempts: [],
          mailbox: [],
        }
        children.set(childId, child)
        startAttempt(child, message)
        return { content: [{ type: "text", text: response("spawn_agent", [child], "queued") }] }
      }

      const target = request.params.name === "list_agents" ? undefined : text(args, "target").split("/").filter(Boolean).pop()
      if (request.params.name === "list_agents") return { content: [{ type: "text", text: response("list_agents", [...children.values()]) }] }
      const child = target ? children.get(target) : undefined
      if (!child) throw new Error(`unknown agent: ${target ?? "<empty>"}`)

      if (request.params.name === "send_message") {
        const message = text(args, "message")
        child.mailbox.push(message)
        if (child.state !== "running") {
          const next = child.mailbox.splice(0).join("\n\n")
          startAttempt(child, next)
        }
        return { content: [{ type: "text", text: response("send_message", [child], "queued") }] }
      }
      if (request.params.name === "followup_task") {
        if (child.state === "running") throw new Error(`agent ${child.childId} is still running`)
        startAttempt(child, text(args, "message"))
        return { content: [{ type: "text", text: response("followup_task", [child], "queued") }] }
      }
      if (request.params.name === "interrupt_agent") {
        if (child.controller) child.controller.abort()
        return { content: [{ type: "text", text: response("interrupt_agent", [child], "requested") }] }
      }
      if (request.params.name === "wait_agent") {
        const timeout = typeof args.timeout_ms === "number" && Number.isSafeInteger(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : childTimeoutMs()
        const pending = child.promise ?? Promise.resolve()
        await Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, timeout))])
        return { content: [{ type: "text", text: response("wait_agent", [child]) }] }
      }
      throw new Error(`unknown agents operation: ${request.params.name}`)
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }
    }
  })
  return { server, children }
}

if (import.meta.main) {
  const { server } = createPiAgentsServer()
  await server.connect(new StdioServerTransport())
}
