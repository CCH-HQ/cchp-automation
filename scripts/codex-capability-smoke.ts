#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CodexAppServer, type JsonRpcNotification } from "../src/codex/app-server"
import { assertPinnedVersion, probeCapabilities } from "../src/codex/cli"
import { prepareCodexHome } from "../src/codex/config"
import { buildCodexEnvironment } from "../src/codex/supervisor"
import { startGitHubBroker } from "../src/mcp/github-broker"
import type { GitHubClient } from "../src/github/client"
import { parseProviders } from "../src/codex/providers"
import { startProviderBridge } from "../src/codex/provider-bridge"

type Json = Record<string, unknown>

export interface ToolRef {
  name: string
  namespace?: string
}

export function isChildProviderRequest(requestThreadId: string | undefined, rootThreadId: string | undefined): boolean {
  return Boolean(requestThreadId && rootThreadId && requestThreadId !== rootThreadId)
}

export function parentObservedChildOutput(body: Json, sentinel = "CHILD_OK"): boolean {
  if (!Array.isArray(body.input)) return false
  return body.input.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const item = value as Json
    if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") return false
    return String(item.output ?? item.result ?? "").includes(sentinel)
  })
}

export function parentObservedNativeChildOutput(body: Json, sentinel = "CHILD_OK"): boolean {
  if (!Array.isArray(body.input)) return false
  return body.input.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const item = value as Json
    if (item.type === "function_call" || item.type === "custom_tool_call") return false
    return JSON.stringify(item).includes(sentinel)
  })
}

export function isCollaborationToolName(name: string): boolean {
  const parts = name.split(".")
  const leaf = parts.at(-1) ?? name
  if (["spawn_agent", "send_message", "followup_task", "wait_agent", "interrupt_agent", "close_agent", "list_agents"].includes(leaf)) return true
  return parts.some((part) => /(^|__)(agents|collaboration)(?:$|__)/i.test(part))
}

export function collaborationLifecycleObserved(
  mode: "explicit-exec" | "native-v2",
  items: Json[],
): boolean {
  if (mode === "native-v2") {
    return items.some((item) => item.type === "subAgentActivity" || item.type === "collabAgentToolCall")
  }
  const tools = new Set(items
    .filter((item) => item.type === "mcpToolCall" && /(^|__)agents$/i.test(String(item.server ?? "")))
    .map((item) => String(item.tool ?? "")))
  return tools.has("spawn_agent") && tools.has("wait_agent")
}

function collaborationMode(): "explicit-exec" | "native-v2" {
  return process.env.CCHP_SMOKE_MODE === "explicit-exec" ? "explicit-exec" : "native-v2"
}

function writeModeArtifact(report: Json): void {
  const directory = process.env.CCHP_SMOKE_ARTIFACT_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `capability-${collaborationMode()}.json`)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`)
  renameSync(temporary, path)
}

function collectToolRefs(values: unknown, namespace: string | undefined, result: ToolRef[]): void {
  if (!Array.isArray(values)) return
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const tool = value as Json
    const name = typeof tool.name === "string" && tool.name ? tool.name : undefined
    if (Array.isArray(tool.tools)) {
      collectToolRefs(tool.tools, name ?? namespace, result)
      continue
    }
    if (!name) continue
    const explicitNamespace = typeof tool.namespace === "string" && tool.namespace
      ? tool.namespace
      : namespace
    result.push({ name, ...(explicitNamespace ? { namespace: explicitNamespace } : {}) })
  }
}

/** Codex can serialize its tool catalog either as classic Responses `tools` or
 * as a Responses Lite `additional_tools` developer input. Preserve namespace
 * identity because the v2 collaboration router uses it for dispatch. */
export function extractToolRefs(body: Json): ToolRef[] {
  const result: ToolRef[] = []
  collectToolRefs(body.tools, undefined, result)
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      const record = item as Json
      if (record.type === "additional_tools") collectToolRefs(record.tools, undefined, result)
    }
  }
  return result
}

function sse(events: Json[]): Response {
  const body = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

function outputMessage(id: string, text: string): Json[] {
  return [
    { type: "response.created", response: { id, status: "in_progress", model: "gpt-5.6-sol" } },
    { type: "response.output_item.done", output_index: 0, item: { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } },
    { type: "response.completed", response: { id, status: "completed", model: "gpt-5.6-sol", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]
}

function hangingSse(id: string, onCancel: () => void): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress", model: "gpt-5.6-sol" } })}\n\n`))
    },
    cancel() {
      onCancel()
    },
  }), { headers: { "content-type": "text/event-stream" } })
}

export function toolCall(id: string, tool: ToolRef, args: Json): Json[] {
  return [
    { type: "response.created", response: { id, status: "in_progress", model: "gpt-5.6-sol" } },
    { type: "response.output_item.done", output_index: 0, item: { id: `fc_${id}`, type: "function_call", status: "completed", call_id: `call_${id}`, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(args) } },
    { type: "response.completed", response: { id, status: "completed", model: "gpt-5.6-sol", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]
}

export function customToolCall(id: string, tool: ToolRef, input: string): Json[] {
  return [
    { type: "response.created", response: { id, status: "in_progress", model: "gpt-5.6-sol" } },
    { type: "response.output_item.done", output_index: 0, item: { id: `ctc_${id}`, type: "custom_tool_call", status: "completed", call_id: `call_${id}`, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), input } },
    { type: "response.completed", response: { id, status: "completed", model: "gpt-5.6-sol", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]
}

function readFixtureRows(codexHome: string, fixture: "fff" | "serena"): Json[] {
  const path = join(codexHome, `fixture-${fixture}-env.jsonl`)
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Json)
  } catch {
    return []
  }
}

function assertFixtureEnvironment(rows: Json[], fixture: "fff" | "serena", repo: string): void {
  if (rows.length === 0) throw new Error(`${fixture} MCP fixture was not called`)
  const forbidden = [
    "GH_TOKEN", "CCHP_GH_TOKEN_FILE", "CCHP_BOT_PROVIDER_KEYS", "CCHP_BOT_PROVIDERS",
    "CCHP_PK_GPT_CCHP", "CCHP_APP_CLIENT_ID", "CCHP_APP_PRIVATE_KEY", "SEE_API_KEY",
    "HEROUI_AUTH_TOKEN", "CCHP_GITHUB_BROKER_SOCKET", "CCHP_GITHUB_BROKER_TOKEN",
    "CCHP_GITHUB_BROKER_FINALIZER", "github-sentinel", "provider-sentinel",
    "provider-config-sentinel", "app-client-sentinel", "app-private-sentinel", "see-sentinel",
    "heroui-sentinel",
  ]
  for (const row of rows) {
    if (row.fixture !== fixture) throw new Error(`${fixture} MCP fixture identity drifted`)
    const serialized = JSON.stringify(row)
    for (const value of forbidden) {
      if (serialized.includes(value)) throw new Error(`${fixture} MCP fixture environment leaked ${value}`)
    }
    const env = row.env && typeof row.env === "object" && !Array.isArray(row.env) ? row.env as Json : {}
    if (env.REPO_DIR !== repo) throw new Error(`${fixture} MCP fixture REPO_DIR drifted`)
  }
}

async function main(): Promise<void> {
  const expected = process.env.CCHP_CODEX_VERSION ?? "0.146.0"
  const selectedMode = collaborationMode()
  const capability = probeCapabilities(process.env.CODEX_BIN ?? "codex")
  if (selectedMode === "native-v2") {
    assertPinnedVersion(capability.version, expected)
    if (!capability.multiAgentV2) throw new Error("multi_agent_v2 is not stable/enabled")
  }

  const root = mkdtempSync(join(tmpdir(), "cchp-capability-"))
  const repo = join(root, "repo")
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, "README.md"), "smoke\n")
  const initializedRepo = Bun.spawnSync(["git", "init", "--quiet", repo], { stdout: "pipe", stderr: "pipe" })
  if (initializedRepo.exitCode !== 0) {
    throw new Error(`failed to initialize capability fixture repository: ${initializedRepo.stderr.toString()}`)
  }
  let requestNumber = 0
  let rootStage: "fff" | "serena" | "spawn" | "send" | "wait" | "followup" | "wait-followup" | "list" | "spawn-interrupt" | "interrupt" | "wait-interrupt" | "close-interrupt" | "final" = "fff"
  let childStage: "fff" | "serena" | "final" = "fff"
  let rootModelThreadId: string | undefined
  const parentObservedSentinels = new Set<string>()
  const requestedOperations = new Set<string>()
  const completedOperations = new Set<string>()
  const operationByCallId = new Map<string, string>()
  let interruptRequestObserved = false
  let interruptStreamCancelled = false
  let resolveInterruptRequest!: () => void
  const interruptRequest = new Promise<void>((resolve) => { resolveInterruptRequest = resolve })
  const requestTools: string[][] = []
  const childRequestTools: string[][] = []
  const requestShapes: string[] = []
  const requestCatalogs: string[] = []
  const decisions: string[] = []
  const smokeBasePort = Number(process.env.CCHP_SMOKE_PORT ?? 39765)
  if (!Number.isInteger(smokeBasePort) || smokeBasePort < 1024 || smokeBasePort > 64000) throw new Error("CCHP_SMOKE_PORT must be a valid unprivileged port")
  let upstream: ReturnType<typeof Bun.serve> | undefined
  let lastListenError: unknown
  for (let offset = selectedMode === "native-v2" ? 1 : 0; offset < 20; offset++) {
    try {
      upstream = Bun.serve({ hostname: "127.0.0.1", port: smokeBasePort + offset, async fetch(request) {
    const body = await request.json() as Json
    requestShapes.push(`${Object.keys(body).sort().join(",")}:tools=${Array.isArray(body.tools) ? body.tools.length : typeof body.tools}`)
    requestCatalogs.push(JSON.stringify(Array.isArray(body.input) ? body.input.filter((item) => item && typeof item === "object" && (item as Json).type === "additional_tools") : []).slice(0, 20_000))
    const tools = extractToolRefs(body)
    const names = tools.map((tool) => `${tool.namespace ? `${tool.namespace}.` : ""}${tool.name}`)
    requestTools.push(names)
    const spawn = tools.find((tool) => tool.name === "spawn_agent")
    const wait = tools.find((tool) => tool.name === "wait_agent")
    const sendMessage = tools.find((tool) => tool.name === "send_message")
    const followup = tools.find((tool) => tool.name === "followup_task")
    const interrupt = tools.find((tool) => tool.name === "interrupt_agent")
    // Codex 0.146 native catalog has no close_agent. The explicit MCP server
    // still exposes it, so exercise that contract with a synthesized ref.
    const close = tools.find((tool) => tool.name === "close_agent") ?? (selectedMode === "explicit-exec" ? { name: "close_agent" } : undefined)
    const list = tools.find((tool) => tool.name === "list_agents")
    const exec = tools.find((tool) => tool.name === "exec")
    const fff = tools.find((tool) => tool.name === "grep" && tool.namespace?.includes("fff"))
    const serena = tools.find((tool) => tool.name === "get_current_config" && tool.namespace?.includes("serena"))
    const id = `resp_${++requestNumber}`
    const outputs = Array.isArray(body.input) ? (body.input as Json[]).filter((item) => item.type === "function_call_output") : []
    const customOutputs = Array.isArray(body.input) ? (body.input as Json[]).filter((item) => item.type === "custom_tool_call_output") : []
    const metadata = body.client_metadata && typeof body.client_metadata === "object" && !Array.isArray(body.client_metadata)
      ? body.client_metadata as Json
      : {}
    const requestThreadId = typeof metadata.thread_id === "string" ? metadata.thread_id : undefined
    if (!requestThreadId) throw new Error("provider request is missing client_metadata.thread_id")
    rootModelThreadId ??= requestThreadId
    const childRequest = isChildProviderRequest(requestThreadId, rootModelThreadId)
    if (!childRequest) {
      for (const sentinel of ["CHILD_INITIAL_OK", "CHILD_QUEUED_OK", "CHILD_FOLLOWUP_OK"]) {
        if (parentObservedChildOutput(body, sentinel) || (selectedMode === "native-v2" && parentObservedNativeChildOutput(body, sentinel))) {
          parentObservedSentinels.add(sentinel)
        }
      }
      for (const output of outputs) {
        const callId = typeof output.call_id === "string" ? output.call_id : undefined
        const operation = callId ? operationByCallId.get(callId) : undefined
        if (!operation) continue
        const serialized = JSON.stringify(output.output ?? output.result ?? "")
        if (!/\"isError\"\s*:\s*true|\"is_error\"\s*:\s*true|^\"?error:/i.test(serialized)) {
          completedOperations.add(operation)
        }
      }
    }
    if (childRequest) childRequestTools.push(names)
    decisions.push(`${requestNumber}:thread=${requestThreadId ?? "<missing>"}:child=${childRequest}:root=${rootStage}:childStage=${childStage}:functionOutputs=${outputs.length}:${outputs.map((item) => JSON.stringify(item.output)).join(",").slice(-500)}:customOutputs=${customOutputs.length}`)
    if (childRequest) {
      const serializedInput = JSON.stringify(body.input ?? [])
      if (serializedInput.includes("INTERRUPT_CHILD_PROBE")) {
        interruptRequestObserved = true
        resolveInterruptRequest()
        return hangingSse(id, () => { interruptStreamCancelled = true })
      }
      if (childStage === "final" && serializedInput.includes("CHILD_FOLLOWUP_PROBE")) return sse(outputMessage(id, "CHILD_FOLLOWUP_OK"))
      if (childStage === "final" && serializedInput.includes("CHILD_QUEUED_PROBE")) return sse(outputMessage(id, "CHILD_QUEUED_OK"))
      if (childStage === "fff" && fff) {
        childStage = "serena"
        return sse(toolCall(id, fff, { query: "capability-smoke" }))
      }
      if (childStage === "fff" && exec) {
        childStage = "serena"
        return sse(customToolCall(id, exec, "const result = await tools.mcp__fff__grep({ query: 'capability-smoke' }); text(result);"))
      }
      if (childStage === "serena" && serena) {
        childStage = "final"
        return sse(toolCall(id, serena, {}))
      }
      if (childStage === "serena" && exec) {
        childStage = "final"
        return sse(customToolCall(id, exec, "const result = await tools.mcp__serena__get_current_config({}); text(result);"))
      }
      return sse(outputMessage(id, "CHILD_INITIAL_OK"))
    }
    if (rootStage === "fff" && exec) {
      rootStage = "serena"
      return sse(customToolCall(id, exec, "const result = await tools.mcp__fff__grep({ query: 'capability-smoke' }); text(result);"))
    }
    if (rootStage === "serena" && exec) {
      rootStage = "spawn"
      return sse(customToolCall(id, exec, "const result = await tools.mcp__serena__get_current_config({}); text(result);"))
    }
    if (rootStage === "spawn" && spawn) {
      rootStage = "send"
      if (selectedMode === "explicit-exec") {
        for (const fixture of ["fff", "serena"]) {
          rmSync(join(root, "explicit-codex-home", `fixture-${fixture}-env.jsonl`), { force: true })
        }
      }
      const message = "CAPABILITY_CHILD_PROBE: call the fff grep and serena get_current_config tools, then reply exactly CHILD_INITIAL_OK"
      requestedOperations.add("spawn_agent")
      operationByCallId.set(`call_${id}`, "spawn_agent")
      return sse(toolCall(id, selectedMode === "explicit-exec" ? { ...spawn, namespace: "mcp__agents" } : spawn, {
        task_name: "capability_child",
        message,
        fork_turns: "none",
        agent_type: "explorer",
      }))
    }
    const primaryTarget = selectedMode === "explicit-exec" ? "capability_child" : "/root/capability_child"
    const interruptTarget = selectedMode === "explicit-exec" ? "interrupt_child" : "/root/interrupt_child"
    if (rootStage === "send" && sendMessage) {
      rootStage = "wait"
      requestedOperations.add("send_message")
      operationByCallId.set(`call_${id}`, "send_message")
      return sse(toolCall(id, selectedMode === "explicit-exec" ? { ...sendMessage, namespace: "mcp__agents" } : sendMessage, {
        target: primaryTarget,
        message: "CHILD_QUEUED_PROBE: reply exactly CHILD_QUEUED_OK",
      }))
    }
    if (rootStage === "wait" && wait) {
      rootStage = "followup"
      requestedOperations.add("wait_agent")
      operationByCallId.set(`call_${id}`, "wait_agent")
      return sse(toolCall(id, selectedMode === "explicit-exec" ? { ...wait, namespace: "mcp__agents" } : wait, { target: primaryTarget, timeout_ms: 10000 }))
    }
    if (rootStage === "followup" && followup) {
      rootStage = "wait-followup"
      requestedOperations.add("followup_task")
      operationByCallId.set(`call_${id}`, "followup_task")
      return sse(toolCall(id, selectedMode === "explicit-exec" ? { ...followup, namespace: "mcp__agents" } : followup, {
        target: primaryTarget,
        message: "CHILD_FOLLOWUP_PROBE: reply exactly CHILD_FOLLOWUP_OK",
      }))
    }
    if (rootStage === "wait-followup" && wait) {
      rootStage = "list"
      requestedOperations.add("wait_followup_agent")
      operationByCallId.set(`call_${id}`, "wait_followup_agent")
      return sse(toolCall(id, selectedMode === "explicit-exec" ? { ...wait, namespace: "mcp__agents" } : wait, { target: primaryTarget, timeout_ms: 10000 }))
    }
    if (rootStage === "list" && list) {
      rootStage = "spawn-interrupt"
      requestedOperations.add("list_agents")
      operationByCallId.set(`call_${id}`, "list_agents")
      return sse(toolCall(id, selectedMode === "explicit-exec" ? { ...list, namespace: "mcp__agents" } : list, {}))
    }
    if (rootStage === "spawn-interrupt" && spawn) {
      rootStage = "interrupt"
      requestedOperations.add("spawn_interrupt_agent")
      operationByCallId.set(`call_${id}`, "spawn_interrupt_agent")
      return sse(toolCall(id, selectedMode === "explicit-exec" ? { ...spawn, namespace: "mcp__agents" } : spawn, {
        task_name: "interrupt_child",
        message: "INTERRUPT_CHILD_PROBE: stay active until interrupted",
        fork_turns: "none",
        agent_type: "explorer",
      }))
    }
    if (rootStage === "interrupt" && interrupt) {
      await Promise.race([interruptRequest, new Promise<void>((resolve) => setTimeout(resolve, 3000))])
      rootStage = "wait-interrupt"
      requestedOperations.add("interrupt_agent")
      operationByCallId.set(`call_${id}`, "interrupt_agent")
      return sse(toolCall(id, selectedMode === "explicit-exec" ? { ...interrupt, namespace: "mcp__agents" } : interrupt, { target: interruptTarget }))
    }
    if (rootStage === "wait-interrupt" && wait) {
      rootStage = "close-interrupt"
      requestedOperations.add("wait_interrupt_agent")
      operationByCallId.set(`call_${id}`, "wait_interrupt_agent")
      return sse(toolCall(id, selectedMode === "explicit-exec" ? { ...wait, namespace: "mcp__agents" } : wait, { target: interruptTarget, timeout_ms: 10000 }))
    }
    if (rootStage === "close-interrupt" && close) {
      rootStage = "final"
      requestedOperations.add("close_agent")
      operationByCallId.set(`call_${id}`, "close_agent")
      return sse(toolCall(id, selectedMode === "explicit-exec" ? { ...close, namespace: "mcp__agents" } : close, { target: interruptTarget, reason: "capability smoke completed" }))
    }
    return sse(outputMessage(id, "ROOT_OK_FINAL"))
      } })
      break
    } catch (error) {
      lastListenError = error
    }
  }
  if (!upstream) throw lastListenError instanceof Error ? lastListenError : new Error("could not bind capability smoke upstream")
  const providers = parseProviders({
    providerJson: JSON.stringify({ fake: { format: "openai-responses", base_url: `${upstream.url.origin}/v1`, models: { "gpt-5.6-sol": { context: 372000, output: 8192 } } } }),
    providerKeysJson: JSON.stringify({ fake: "fixture-key" }),
    model: "fake/gpt-5.6-sol",
  })
  const bridge = startProviderBridge(providers)
  const bridgeEnv = "CCHP_CODEX_BRIDGE_TOKEN"
  const broker = await startGitHubBroker({
    socketPath: join(root, "ctx", "codex", "github-broker.sock"),
    repo: "CCH-HQ/fixture",
    task: "manual",
    finalizerMarker: join(root, "ctx", "review-finalized.json"),
    expectedRunId: "capability-smoke",
    octokit: {} as GitHubClient,
  })
  const prepared = prepareCodexHome({
    botWorkdir: root,
    engineDir: process.cwd(),
    repoDir: repo,
    bridgeBaseUrl: bridge.baseUrl,
    bridgeTokenEnv: bridgeEnv,
    providerSet: providers,
    sandboxMode: "read-only",
    collaborationMode: selectedMode,
    baseInstructions: "You are the CCHP capability smoke root coordinator.",
    fffCommand: join(process.cwd(), "scripts", "fixtures", "readonly-mcp-fixture.ts"),
    serenaCommand: join(process.cwd(), "scripts", "fixtures", "readonly-mcp-fixture.ts"),
  })
  const notifications: JsonRpcNotification[] = []
  let expectedRootThreadId = ""
  let resolveCompleted!: () => void
  const completed = new Promise<void>((resolve) => { resolveCompleted = resolve })
  const app = new CodexAppServer({
    codexBin: process.env.CODEX_BIN ?? "codex",
    codexHome: prepared.codexHome,
    cwd: repo,
    env: buildCodexEnvironment({
      ...Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "LANG", "LC_ALL", "TERM", "NO_COLOR"]
          .flatMap((name) => typeof process.env[name] === "string" ? [[name, process.env[name]!]] : []),
      ),
      CODEX_HOME: prepared.codexHome,
      [bridgeEnv]: bridge.token,
      BOT_REPO: "CCH-HQ/fixture",
      BOT_TASK: "manual",
      BOT_WORKDIR: root,
      REPO_DIR: repo,
      BOT_RUN_ID: "capability-smoke",
      CCHP_GITHUB_BROKER_SOCKET: broker.socketPath,
      CCHP_GITHUB_BROKER_TOKEN: broker.token,
      CCHP_GITHUB_BROKER_FINALIZER: join(root, "ctx", "review-finalized.json"),
      GH_TOKEN: "github-sentinel",
      CCHP_GH_TOKEN_FILE: "/secret/token",
      CCHP_BOT_PROVIDER_KEYS: "provider-sentinel",
      CCHP_BOT_PROVIDERS: "provider-config-sentinel",
      CCHP_APP_CLIENT_ID: "app-client-sentinel",
      CCHP_APP_PRIVATE_KEY: "app-private-sentinel",
      SEE_API_KEY: "see-sentinel",
      HEROUI_AUTH_TOKEN: "heroui-sentinel",
    }),
    onNotification(notification) {
      notifications.push(notification)
      if (
        notification.method === "turn/completed" &&
        expectedRootThreadId &&
        String((notification.params as Json).threadId ?? "") === expectedRootThreadId
      ) resolveCompleted()
    },
  })
  try {
    await app.start()
    const environ = readFileSync(`/proc/${app.pid}/environ`, "utf8").split("\0").join("\n")
    for (const forbidden of [
      "GH_TOKEN", "CCHP_GH_TOKEN_FILE", "CCHP_BOT_PROVIDER_KEYS", "CCHP_BOT_PROVIDERS",
      "CCHP_APP_CLIENT_ID", "CCHP_APP_PRIVATE_KEY", "SEE_API_KEY", "HEROUI_AUTH_TOKEN",
      "github-sentinel", "provider-sentinel", "provider-config-sentinel", "app-client-sentinel",
      "app-private-sentinel", "see-sentinel", "heroui-sentinel",
    ]) {
      if (environ.includes(forbidden)) throw new Error(`app-server environment leaked ${forbidden}`)
    }
    const thread = await app.request<Json>("thread/start", { model: "gpt-5.6-sol", modelProvider: providers.providers[0]!.codexId, cwd: repo, approvalPolicy: "never", sandbox: "read-only" })
    expectedRootThreadId = String((thread.thread as Json).id)
    const closeInstruction = selectedMode === "explicit-exec"
      ? "close the interrupted child with close_agent"
      : "native-v2 has no close_agent; interrupt the second child and wait for its terminal state"
    await app.request("turn/start", { threadId: expectedRootThreadId, input: [{ type: "text", text: `Call fff and serena. Spawn one child, send it a queued message, wait, follow it up, list agents, spawn a second child, interrupt it, wait for interruption, ${closeInstruction}, and finish with ROOT_OK_FINAL.` }] })
    await Promise.race([completed, new Promise((_, reject) => setTimeout(() => reject(new Error(`capability turn timed out; requests=${requestNumber} tools=${requestTools.map((entries) => entries.join("|")).join(";")}`)), 20_000))])
    const methods = notifications.map((item) => item.method)
    if (!methods.includes("turn/completed")) throw new Error("root turn completion was not observed")
    const lifecycleItems = notifications.map((notification) => {
      const params = notification.params as Json
      return params.item && typeof params.item === "object" ? params.item as Json : {}
    })
    const sawLifecycle = collaborationLifecycleObserved(selectedMode, lifecycleItems)
    const finalMessages = notifications
      .filter((notification) => notification.method === "item/completed")
      .map((notification) => {
        const params = notification.params as Json
        const item = params.item && typeof params.item === "object" ? params.item as Json : {}
        return item.type === "agentMessage" ? String(item.text ?? "") : ""
      })
    const sawCollaborationTools = requestTools.some((tools) => tools.some((name) => name.endsWith("spawn_agent"))) &&
      requestTools.some((tools) => tools.some((name) => name.endsWith("send_message"))) &&
      requestTools.some((tools) => tools.some((name) => name.endsWith("wait_agent"))) &&
      requestTools.some((tools) => tools.some((name) => name.endsWith("followup_task"))) &&
      requestTools.some((tools) => tools.some((name) => name.endsWith("interrupt_agent"))) &&
      (selectedMode === "native-v2" || selectedMode === "explicit-exec" || requestTools.some((tools) => tools.some((name) => name.endsWith("close_agent")))) &&
      requestTools.some((tools) => tools.some((name) => name.endsWith("list_agents")))
    const childCollaborationTools = childRequestTools.flat().filter(isCollaborationToolName)
    const nativeInterruptLifecycle = lifecycleItems.some((item) =>
      item.type === "subAgentActivity" && item.kind === "interrupted" && String(item.agentPath ?? "").endsWith("/interrupt_child"),
    )
    const nativeInteractions = new Set(lifecycleItems
      .filter((item) => item.type === "subAgentActivity" && item.kind === "interacted" && String(item.agentPath ?? "").endsWith("/capability_child"))
      .map((item) => String(item.id ?? "")))
    const requiredSentinels = selectedMode === "explicit-exec"
      ? ["CHILD_QUEUED_OK", "CHILD_FOLLOWUP_OK"]
      : ["CHILD_FOLLOWUP_OK"]
    const requiredOperations = [
      "spawn_agent", "send_message", "wait_agent", "followup_task", "wait_followup_agent", "list_agents",
      "spawn_interrupt_agent", "interrupt_agent", "wait_interrupt_agent",
    ]
    if (selectedMode === "explicit-exec") requiredOperations.push("close_agent")
    const missingOperations = requiredOperations.filter((operation) => !requestedOperations.has(operation) || !completedOperations.has(operation))
    if (
      (!sawLifecycle || childRequestTools.length === 0 || childCollaborationTools.length > 0)
      || !sawCollaborationTools
      || !requiredSentinels.every((sentinel) => parentObservedSentinels.has(sentinel))
      || !finalMessages.includes("ROOT_OK_FINAL")
      || missingOperations.length > 0
      || !interruptRequestObserved
      || (selectedMode === "native-v2" && !nativeInterruptLifecycle)
      || (selectedMode === "native-v2" && nativeInteractions.size < 2)
      || requestNumber > 32
    ) {
      const warnings = notifications.filter((item) => item.method === "configWarning").map((item) => JSON.stringify(item.params)).join("|")
      const startup = notifications
        .filter((item) => item.method === "mcpServer/startupStatus/updated")
        .map((item) => JSON.stringify(item.params))
        .join("|")
      const items = notifications
        .filter((item) => item.method.startsWith("item/"))
        .map((notification) => {
          const params = notification.params as Json
          const item = params.item && typeof params.item === "object" ? params.item as Json : {}
          return `${notification.method}:${String(item.type ?? "<none>")}:${String(item.kind ?? item.status ?? "<none>")}:${Object.keys(item).sort().join(",")}:${JSON.stringify(item.error ?? item.result ?? null).slice(0, 500)}`
        })
        .join("|")
      const lifecycleDetails = lifecycleItems
        .filter((item) => item.type === "subAgentActivity" || item.type === "collabAgentToolCall")
        .map((item) => JSON.stringify(item))
        .join("|")
      throw new Error(`collab agent lifecycle/final root message was not observed; missingOperations=${missingOperations.join("|")} parentObservedSentinels=${[...parentObservedSentinels].join("|")} nativeInteractions=${nativeInteractions.size} interruptRequestObserved=${interruptRequestObserved} interruptStreamCancelled=${interruptStreamCancelled} nativeInterruptLifecycle=${nativeInterruptLifecycle} childCollaborationTools=${childCollaborationTools.join("|")} methods=${methods.join(",")} items=${items} lifecycle=${lifecycleDetails} finalMessages=${finalMessages.join("|")} warnings=${warnings} startup=${startup} shapes=${requestShapes.join(";")} tools=${requestTools.map((entries) => entries.join("|")).join(";")} decisions=${decisions.join("|")} catalogs=${requestCatalogs.join(";")}`)
    }
    const childHome = join(root, "explicit-codex-home")
    for (const fixture of ["fff", "serena"] as const) {
      const rootRows = readFixtureRows(prepared.codexHome, fixture)
      assertFixtureEnvironment(rootRows, fixture, repo)
      if (selectedMode === "native-v2") {
        if (rootRows.length < 2) throw new Error(`${fixture} MCP fixture did not observe both root and native child calls`)
      } else {
        const childRows = readFixtureRows(childHome, fixture)
        if (childRows.length === 0) {
          throw new Error(`${fixture} explicit child MCP fixture was not called; requests=${requestNumber} childStage=${childStage} decisions=${decisions.join("|")}`)
        }
        assertFixtureEnvironment(childRows, fixture, repo)
        if (!childRows.every((row) => (row.env as Json | undefined)?.CODEX_HOME === childHome)) {
          throw new Error(`${fixture} explicit child did not use its isolated CODEX_HOME expected=${childHome} actual=${childRows.map((row) => JSON.stringify((row.env as Json | undefined)?.CODEX_HOME)).join(",")} requests=${requestNumber} childStage=${childStage} decisions=${decisions.join("|")}`)
        }
      }
      if (!rootRows.every((row) => (row.env as Json | undefined)?.CODEX_HOME === prepared.codexHome)) {
        throw new Error(`${fixture} root MCP did not use the prepared CODEX_HOME`)
      }
    }
    const report = {
      schema_version: 1,
      run_id: process.env.CCHP_ARTIFACT_RUN_ID ?? "local",
      status: "passed",
      version: capability.version,
      multi_agent_v2: capability.multiAgentV2,
      collaborationMode: selectedMode,
      notifications: methods,
      requests: requestNumber,
      parent_observed_child: [...parentObservedSentinels],
      requested_operations: [...requestedOperations],
      completed_operations: [...completedOperations],
      interrupt_request_observed: interruptRequestObserved,
      interrupt_stream_cancelled: interruptStreamCancelled,
      native_child_collaboration_tools: childCollaborationTools,
    }
    writeFileSync(join(root, `capability-${selectedMode}.json`), JSON.stringify(report, null, 2))
    writeModeArtifact(report)
    process.stdout.write(`[codex-capability] passed version=${capability.version} mode=${selectedMode} requests=${requestNumber}\n`)
  } finally {
    await app.stop().catch(() => 0)
    await broker.close()
    await bridge.close()
    upstream.stop(true)
    if (process.env.CCHP_KEEP_SMOKE_ROOT === "1") {
      process.stderr.write(`[codex-capability] preserved ${root}\n`)
    } else {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    writeModeArtifact({
      schema_version: 1,
      run_id: process.env.CCHP_ARTIFACT_RUN_ID ?? "local",
      status: "failed",
      collaborationMode: collaborationMode(),
      error_type: error instanceof Error ? error.name : "Error",
    })
    process.stderr.write(`[codex-capability] failed: ${(error as Error).message}\n`)
    process.exit(1)
  })
}
