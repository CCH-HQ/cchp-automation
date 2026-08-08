#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { CodexAppServer, type JsonRpcNotification } from "../src/codex/app-server"
import { assertPinnedVersion, probeCapabilities } from "../src/codex/cli"
import { prepareCodexHome } from "../src/codex/config"
import { buildCodexEnvironment, fatalSandboxError } from "../src/codex/supervisor"
import { startGitHubBroker } from "../src/mcp/github-broker"
import type { GitHubClient } from "../src/github/client"
import { parseProviders } from "../src/codex/providers"
import { startProviderBridge } from "../src/codex/provider-bridge"
import { hideProcEnviron } from "../src/github/token-rotation"

type Json = Record<string, unknown>

export interface ToolRef {
  name: string
  namespace?: string
}

export function capabilityEngineRoot(scriptDirectory = import.meta.dir): string {
  return resolve(scriptDirectory, "..")
}

export function waitAgentArguments(
  mode: "explicit-exec" | "native-v2",
  target: string,
  timeoutMs = 10_000,
): { timeout_ms: number; target?: string } {
  return mode === "native-v2" ? { timeout_ms: timeoutMs } : { target, timeout_ms: timeoutMs }
}

export function waitForProgressingCompletion(
  completion: Promise<void>,
  lastProgressAt: () => number,
  diagnostic: () => string,
  options: { inactivityMs?: number; absoluteMs?: number; pollMs?: number } = {},
): Promise<void> {
  // native collaboration 启动或中断 child 时可能几十秒不发 provider request.
  // 保留严格 inactivity bound, 但不能把正常 native tool invocation 判为 hang.
  const inactivityMs = options.inactivityMs ?? 60_000
  const absoluteMs = options.absoluteMs ?? 180_000
  const pollMs = options.pollMs ?? 250
  for (const [name, value] of Object.entries({ inactivityMs, absoluteMs, pollMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  }
  const startedAt = Date.now()
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setInterval> | undefined
    const settle = (operation: () => void) => {
      if (timer) clearInterval(timer)
      timer = undefined
      operation()
    }
    timer = setInterval(() => {
      const now = Date.now()
      const idleMs = now - lastProgressAt()
      const elapsedMs = now - startedAt
      if (idleMs >= inactivityMs || elapsedMs >= absoluteMs) {
        settle(() => reject(new Error(
          `capability turn timed out; idleMs=${idleMs} elapsedMs=${elapsedMs} ${diagnostic()}`,
        )))
      }
    }, pollMs)
    timer.unref?.()
    void completion.then(
      () => settle(resolve),
      (error) => settle(() => reject(error)),
    )
  })
}

export function isChildProviderRequest(requestThreadId: string | undefined, rootThreadId: string | undefined): boolean {
  return Boolean(requestThreadId && rootThreadId && requestThreadId !== rootThreadId)
}

const SANDBOX_DENIAL_PATTERN = /permission denied|operation not permitted|read[- ]only|protected metadata|not permitted/i

export function metadataProbeProtected(
  result: { output?: unknown; exit_code?: unknown },
  probePath: string,
): boolean {
  const output = typeof result.output === "string" ? result.output : ""
  return typeof result.exit_code === "number" &&
    Number.isInteger(result.exit_code) &&
    result.exit_code !== 0 &&
    output.includes(probePath) &&
    SANDBOX_DENIAL_PATTERN.test(output)
}

export function workspaceEnforcement(config: string): "direct" | "legacy-landlock" | "unknown" {
  if (/^\s*use_legacy_landlock\s*=\s*true\s*$/m.test(config)) return "legacy-landlock"
  if (/^\s*sandbox_mode\s*=\s*"workspace-write"\s*$/m.test(config)) return "direct"
  return "unknown"
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
  hideProcEnviron((message) => process.stderr.write(`[codex-capability] ${message}\n`))
  const expected = process.env.CCHP_CODEX_VERSION ?? "0.146.0"
  const selectedMode = collaborationMode()
  const engineRoot = capabilityEngineRoot()
  const capability = probeCapabilities(process.env.CODEX_BIN ?? "codex")
  if (selectedMode === "native-v2") {
    assertPinnedVersion(capability.version, expected)
    if (!capability.multiAgentV2) throw new Error("multi_agent_v2 is not stable/enabled")
  }

  const root = mkdtempSync(join(tmpdir(), "cchp-capability-"))
  const repo = join(root, "repo")
  const readonlyProbePath = join(repo, ".codex-read-only-probe")
  const gitMetadataProbePath = join(repo, ".git", "cchp-workspace-write-probe")
  const agentsMetadataProbePath = join(repo, ".agents", "cchp-workspace-write-probe")
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, "README.md"), "smoke\n")
  const initializedRepo = Bun.spawnSync(["git", "init", "--quiet", repo], { stdout: "pipe", stderr: "pipe" })
  if (initializedRepo.exitCode !== 0) {
    throw new Error(`failed to initialize capability fixture repository: ${initializedRepo.stderr.toString()}`)
  }
  mkdirSync(join(repo, ".agents"), { recursive: true })
  let requestNumber = 0
  let rootStage: "sandbox" | "fff" | "serena" | "spawn" | "send" | "wait" | "followup" | "list" | "spawn-interrupt" | "interrupt" | "wait-interrupt" | "audit-interrupt" | "close-interrupt" | "final" = "sandbox"
  let childStage: "fff" | "serena" | "final" = "fff"
  let rootModelThreadId: string | undefined
  let workspaceThreadId: string | undefined
  let workspaceStage: "apply-patch" | "shell-boundary" | "git-metadata" | "agents-metadata" | "final" = "apply-patch"
  const workspaceRequestedOperations = new Set<string>()
  const workspaceCompletedOperations = new Set<string>()
  let workspaceBoundaryObservation = ""
  let workspaceNetworkEvidence: { reason: "proxy-structured-denial" | "os-connect-denied"; target: string } | undefined
  const parentObservedSentinels = new Set<string>()
  const requestedOperations = new Set<string>()
  const completedOperations = new Set<string>()
  const operationByCallId = new Map<string, string>()
  let interruptRequestObserved = false
  let interruptStreamCancelled = false
  let nativeInterruptListObserved = false
  let resolveInterruptRequest!: () => void
  const interruptRequest = new Promise<void>((resolve) => { resolveInterruptRequest = resolve })
  const requestTools: string[][] = []
  const childRequestTools: string[][] = []
  const requestShapes: string[] = []
  const requestCatalogs: string[] = []
  const decisions: string[] = []
  const requestOwners = new Map<string, { threadId: string; turnId: string }>()
  let lastProviderProgressAt = Date.now()
  const smokeBasePort = Number(process.env.CCHP_SMOKE_PORT ?? 39765)
  if (!Number.isInteger(smokeBasePort) || smokeBasePort < 1024 || smokeBasePort > 64000) throw new Error("CCHP_SMOKE_PORT must be a valid unprivileged port")
  let upstream: ReturnType<typeof Bun.serve> | undefined
  let lastListenError: unknown
  for (let offset = selectedMode === "native-v2" ? 1 : 0; offset < 20; offset++) {
    try {
      upstream = Bun.serve({ hostname: "127.0.0.1", port: smokeBasePort + offset, async fetch(request) {
    const body = await request.json() as Json
    lastProviderProgressAt = Date.now()
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
    const requestTurnId = typeof metadata.turn_id === "string" ? metadata.turn_id : undefined
    if (!requestTurnId) throw new Error("provider request is missing client_metadata.turn_id")
    requestOwners.set(id, { threadId: requestThreadId, turnId: requestTurnId })
    if (workspaceThreadId && requestThreadId === workspaceThreadId) {
      for (const output of [...outputs, ...customOutputs]) {
        const callId = typeof output.call_id === "string" ? output.call_id : undefined
        const operation = callId ? operationByCallId.get(callId) : undefined
        if (!operation?.startsWith("workspace_")) continue
        const serialized = JSON.stringify(output.output ?? output.result ?? "")
        if (operation === "workspace_apply_patch" && !/\"isError\"\s*:\s*true|\"is_error\"\s*:\s*true|^\"?error:/i.test(serialized)) {
          workspaceCompletedOperations.add(operation)
        }
        if (operation === "workspace_shell_boundary") {
          workspaceBoundaryObservation = serialized.slice(-2_000)
          for (const reason of ["proxy-structured-denial", "os-connect-denied"] as const) {
            const sentinel = `CCHP_NETWORK_POLICY_BLOCKED:${reason}:https://example.com`
            if (serialized.includes(sentinel)) workspaceNetworkEvidence = { reason, target: "https://example.com" }
          }
          if (serialized.includes("CCHP_SHELL_CAPABILITIES_EXCLUDED") && workspaceNetworkEvidence) {
            workspaceCompletedOperations.add(operation)
          }
        }
        if (operation === "workspace_git_metadata" && serialized.includes("GIT_METADATA_PROTECTED")) {
          workspaceCompletedOperations.add(operation)
        }
        if (operation === "workspace_agents_metadata" && serialized.includes("AGENTS_METADATA_PROTECTED")) {
          workspaceCompletedOperations.add(operation)
        }
      }
      if (workspaceStage === "apply-patch" && exec) {
        workspaceStage = "shell-boundary"
        workspaceRequestedOperations.add("workspace_apply_patch")
        operationByCallId.set(`call_${id}`, "workspace_apply_patch")
        const patch = [
          "*** Begin Patch",
          "*** Update File: README.md",
          "@@",
          " smoke",
          "+workspace-write-ok",
          "*** End Patch",
        ].join("\n")
        return sse(customToolCall(id, exec, `const result = await tools.apply_patch(${JSON.stringify(patch)}); text(result);`))
      }
      if (workspaceStage === "shell-boundary" && exec) {
        workspaceStage = "git-metadata"
        workspaceRequestedOperations.add("workspace_shell_boundary")
        operationByCallId.set(`call_${id}`, "workspace_shell_boundary")
        const command = [
          "set -eu",
          "[ -z \"${CCHP_CODEX_BRIDGE_TOKEN:-}\" ] || exit 96",
          "[ -z \"${CCHP_GITHUB_BROKER_SOCKET:-}\" ] || exit 97",
          "[ -z \"${CCHP_GITHUB_BROKER_TOKEN:-}\" ] || exit 98",
          "[ -z \"${CCHP_GITHUB_BROKER_FINALIZER:-}\" ] || exit 99",
          "command -v bun >/dev/null 2>&1 || exit 100",
          "printf '%s\\n' CCHP_SHELL_CAPABILITIES_EXCLUDED",
          `bun ${JSON.stringify(join(engineRoot, "scripts", "network-policy-probe.ts"))} https://example.com`,
        ].join("\n")
        return sse(customToolCall(id, exec, `const result = await tools.exec_command({ cmd: ${JSON.stringify(command)}, workdir: ${JSON.stringify(repo)} }); const output = result.output ?? ""; text(result.exit_code === 0 && output.includes("CCHP_SHELL_CAPABILITIES_EXCLUDED") && output.includes("CCHP_NETWORK_POLICY_BLOCKED:") ? output.slice(-2000) : "CCHP_WORKSPACE_BOUNDARY_FAILED:exit=" + String(result.exit_code) + ":" + output.slice(-1500));`))
      }
      const startupPattern = "Unable to spawn codex-linux-sandbox|fs sandbox helper failed|bwrap: Failed .*Permission denied|permission profiles requiring direct runtime enforcement are incompatible with --use-legacy-landlock|panicked at .*linux-sandbox"
      const denialPattern = "permission denied|operation not permitted|read[- ]only|protected metadata|not permitted"
      if (workspaceStage === "git-metadata" && exec) {
        workspaceStage = "agents-metadata"
        workspaceRequestedOperations.add("workspace_git_metadata")
        operationByCallId.set(`call_${id}`, "workspace_git_metadata")
        return sse(customToolCall(id, exec, `const result = await tools.exec_command({ cmd: "touch .git/cchp-workspace-write-probe", workdir: ${JSON.stringify(repo)} }); const output = result.output ?? ""; const startupFailed = new RegExp(${JSON.stringify(startupPattern)}, "i").test(output); const denied = typeof result.exit_code === "number" && Number.isInteger(result.exit_code) && result.exit_code !== 0 && output.includes(".git/cchp-workspace-write-probe") && new RegExp(${JSON.stringify(denialPattern)}, "i").test(output); text(!startupFailed && denied ? "GIT_METADATA_PROTECTED" : "GIT_METADATA_PROTECTION_FAILED:" + output.slice(-1000));`))
      }
      if (workspaceStage === "agents-metadata" && exec) {
        workspaceStage = "final"
        workspaceRequestedOperations.add("workspace_agents_metadata")
        operationByCallId.set(`call_${id}`, "workspace_agents_metadata")
        return sse(customToolCall(id, exec, `const result = await tools.exec_command({ cmd: "touch .agents/cchp-workspace-write-probe", workdir: ${JSON.stringify(repo)} }); const output = result.output ?? ""; const startupFailed = new RegExp(${JSON.stringify(startupPattern)}, "i").test(output); const denied = typeof result.exit_code === "number" && Number.isInteger(result.exit_code) && result.exit_code !== 0 && output.includes(".agents/cchp-workspace-write-probe") && new RegExp(${JSON.stringify(denialPattern)}, "i").test(output); text(!startupFailed && denied ? "AGENTS_METADATA_PROTECTED" : "AGENTS_METADATA_PROTECTION_FAILED:" + output.slice(-1000));`))
      }
      return sse(outputMessage(id, "WORKSPACE_WRITE_OK_FINAL"))
    }
    rootModelThreadId ??= requestThreadId
    const childRequest = isChildProviderRequest(requestThreadId, rootModelThreadId)
    if (!childRequest) {
      for (const sentinel of ["CHILD_INITIAL_OK", "CHILD_QUEUED_OK", "CHILD_FOLLOWUP_OK"]) {
        if (parentObservedChildOutput(body, sentinel) || (selectedMode === "native-v2" && parentObservedNativeChildOutput(body, sentinel))) {
          parentObservedSentinels.add(sentinel)
        }
      }
      for (const output of [...outputs, ...customOutputs]) {
        const callId = typeof output.call_id === "string" ? output.call_id : undefined
        const operation = callId ? operationByCallId.get(callId) : undefined
        if (!operation) continue
        const serialized = JSON.stringify(output.output ?? output.result ?? "")
        if (operation === "sandbox_exec") {
          if (serialized.includes("SANDBOX_READ_ONLY_ENFORCED")) completedOperations.add(operation)
          continue
        }
        if (!/\"isError\"\s*:\s*true|\"is_error\"\s*:\s*true|^\"?error:/i.test(serialized)) {
          completedOperations.add(operation)
        }
        if (
          selectedMode === "native-v2" &&
          serialized.includes("/root/interrupt_child") &&
          /interrupted|cancelled|canceled|completed/i.test(serialized)
        ) nativeInterruptListObserved = true
      }
    }
    if (childRequest) childRequestTools.push(names)
    decisions.push(`${requestNumber}:thread=${requestThreadId}:turn=${requestTurnId}:child=${childRequest}:root=${rootStage}:childStage=${childStage}:functionOutputs=${outputs.length}:${outputs.map((item) => JSON.stringify(item.output)).join(",").slice(-500)}:customOutputs=${customOutputs.length}`)
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
    if (rootStage === "sandbox" && exec) {
      rootStage = "fff"
      requestedOperations.add("sandbox_exec")
      operationByCallId.set(`call_${id}`, "sandbox_exec")
      return sse(customToolCall(id, exec, `const result = await tools.exec_command({ cmd: "pwd; touch .codex-read-only-probe", workdir: ${JSON.stringify(repo)} }); const output = result.output ?? ""; const startupFailed = /Unable to spawn codex-linux-sandbox|fs sandbox helper failed|bwrap: Failed .*Permission denied/i.test(output); text(!startupFailed && result.exit_code !== 0 && output.includes(${JSON.stringify(repo)}) ? "SANDBOX_READ_ONLY_ENFORCED" : "SANDBOX_READ_ONLY_FAILED");`))
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
      return sse(toolCall(id, selectedMode === "explicit-exec" ? { ...wait, namespace: "mcp__agents" } : wait, waitAgentArguments(selectedMode, primaryTarget)))
    }
    if (rootStage === "followup" && followup) {
      // followup_task itself owns the child turn and reports its terminal
      // output. Waiting again races with an already terminal child and can
      // leave the capability probe waiting for provider traffic forever.
      rootStage = "list"
      requestedOperations.add("followup_task")
      operationByCallId.set(`call_${id}`, "followup_task")
      return sse(toolCall(id, selectedMode === "explicit-exec" ? { ...followup, namespace: "mcp__agents" } : followup, {
        target: primaryTarget,
        message: "CHILD_FOLLOWUP_PROBE: reply exactly CHILD_FOLLOWUP_OK",
      }))
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
      rootStage = selectedMode === "explicit-exec" ? "wait-interrupt" : "audit-interrupt"
      requestedOperations.add("interrupt_agent")
      operationByCallId.set(`call_${id}`, "interrupt_agent")
      return sse(toolCall(id, selectedMode === "explicit-exec" ? { ...interrupt, namespace: "mcp__agents" } : interrupt, { target: interruptTarget }))
    }
    if (rootStage === "wait-interrupt" && wait) {
      rootStage = "close-interrupt"
      requestedOperations.add("wait_interrupt_agent")
      operationByCallId.set(`call_${id}`, "wait_interrupt_agent")
      return sse(toolCall(id, selectedMode === "explicit-exec" ? { ...wait, namespace: "mcp__agents" } : wait, waitAgentArguments(selectedMode, interruptTarget)))
    }
    if (rootStage === "audit-interrupt" && list) {
      rootStage = "final"
      requestedOperations.add("audit_interrupt_agent")
      operationByCallId.set(`call_${id}`, "audit_interrupt_agent")
      return sse(toolCall(id, list, {}))
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
    engineDir: engineRoot,
    repoDir: repo,
    bridgeBaseUrl: bridge.baseUrl,
    bridgeTokenEnv: bridgeEnv,
    providerSet: providers,
    sandboxMode: "read-only",
    collaborationMode: selectedMode,
    baseInstructions: "You are the CCHP capability smoke root coordinator.",
    fffCommand: join(engineRoot, "scripts", "fixtures", "readonly-mcp-fixture.ts"),
    serenaCommand: join(engineRoot, "scripts", "fixtures", "readonly-mcp-fixture.ts"),
  })
  const notifications: JsonRpcNotification[] = []
  const appServerStderr: string[] = []
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
      lastProviderProgressAt = Date.now()
      notifications.push(notification)
      if (
        notification.method === "turn/completed" &&
        expectedRootThreadId &&
        String((notification.params as Json).threadId ?? "") === expectedRootThreadId
      ) resolveCompleted()
    },
    onStderr(line) {
      lastProviderProgressAt = Date.now()
      appServerStderr.push(line)
      process.stderr.write(`[codex-app-server] ${line}\n`)
    },
  })
  let workspaceApp: CodexAppServer | undefined
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
    const thread = await app.request<Json>("thread/start", {
      model: "gpt-5.6-sol",
      modelProvider: providers.providers[0]!.codexId,
      cwd: repo,
      approvalPolicy: "never",
      sandbox: "read-only",
      experimentalRawEvents: true,
    })
    expectedRootThreadId = String((thread.thread as Json).id)
    const closeInstruction = selectedMode === "explicit-exec"
      ? "close the interrupted child with close_agent"
      : "native-v2 has no close_agent; interrupt the second child and confirm its terminal state with list_agents"
    lastProviderProgressAt = Date.now()
    await app.request("turn/start", { threadId: expectedRootThreadId, input: [{ type: "text", text: `Call fff and serena. Spawn one child, send it a queued message, wait, follow it up, list agents, spawn a second child, interrupt it, wait for interruption, ${closeInstruction}, and finish with ROOT_OK_FINAL.` }] })
    await waitForProgressingCompletion(
      completed,
      () => lastProviderProgressAt,
      () => `requests=${requestNumber} rootStage=${rootStage} childStage=${childStage} requested=${[...requestedOperations].join("|")} completed=${[...completedOperations].join("|")} decisions=${decisions.join("|")} tools=${requestTools.map((entries) => entries.join("|")).join(";")}`,
    )
    const methods = notifications.map((item) => item.method)
    if (!methods.includes("turn/completed")) throw new Error("root turn completion was not observed")
    const rawCompletions = notifications
      .filter((notification) => notification.method === "rawResponse/completed")
      .map((notification) => notification.params as Json)
    if (!rawCompletions.some((raw) => raw.responseId === "resp_1")) {
      throw new Error("Codex 0.146.0 did not correlate the first upstream completion through rawResponse/completed")
    }
    for (const raw of rawCompletions) {
      const owner = requestOwners.get(String(raw.responseId ?? ""))
      if (owner && (raw.threadId !== owner.threadId || raw.turnId !== owner.turnId)) {
        throw new Error(`rawResponse/completed owner drifted for ${String(raw.responseId)}: expected ${owner.threadId}/${owner.turnId}, got ${String(raw.threadId)}/${String(raw.turnId)}`)
      }
    }
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
      "sandbox_exec", "spawn_agent", "send_message", "wait_agent", "followup_task", "list_agents",
      "spawn_interrupt_agent", "interrupt_agent",
    ]
    if (selectedMode === "explicit-exec") requiredOperations.push("wait_interrupt_agent", "close_agent")
    else requiredOperations.push("audit_interrupt_agent")
    const missingOperations = requiredOperations.filter((operation) => !requestedOperations.has(operation) || !completedOperations.has(operation))
    if (
      (!sawLifecycle || childRequestTools.length === 0 || childCollaborationTools.length > 0)
      || !sawCollaborationTools
      || !requiredSentinels.every((sentinel) => parentObservedSentinels.has(sentinel))
      || !finalMessages.includes("ROOT_OK_FINAL")
      || missingOperations.length > 0
      || !interruptRequestObserved
      || (selectedMode === "native-v2" && !nativeInterruptLifecycle)
      || (selectedMode === "native-v2" && !nativeInterruptListObserved)
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
      throw new Error(`collab agent lifecycle/final root message was not observed; missingOperations=${missingOperations.join("|")} parentObservedSentinels=${[...parentObservedSentinels].join("|")} nativeInteractions=${nativeInteractions.size} interruptRequestObserved=${interruptRequestObserved} interruptStreamCancelled=${interruptStreamCancelled} nativeInterruptLifecycle=${nativeInterruptLifecycle} nativeInterruptListObserved=${nativeInterruptListObserved} childCollaborationTools=${childCollaborationTools.join("|")} methods=${methods.join(",")} items=${items} lifecycle=${lifecycleDetails} finalMessages=${finalMessages.join("|")} warnings=${warnings} startup=${startup} stderr=${appServerStderr.join("|")} shapes=${requestShapes.join(";")} tools=${requestTools.map((entries) => entries.join("|")).join(";")} decisions=${decisions.join("|")} catalogs=${requestCatalogs.join(";")}`)
    }
    if (existsSync(readonlyProbePath)) throw new Error("read-only sandbox allowed a repository write")
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
    await app.stop()

    const workspaceRoot = join(root, "workspace-write-smoke")
    mkdirSync(workspaceRoot, { recursive: true })
    const workspacePrepared = prepareCodexHome({
      botWorkdir: workspaceRoot,
      engineDir: engineRoot,
      repoDir: repo,
      bridgeBaseUrl: bridge.baseUrl,
      bridgeTokenEnv: bridgeEnv,
      providerSet: providers,
      sandboxMode: "workspace-write",
      collaborationMode: selectedMode,
      baseInstructions: "You are the CCHP workspace-write capability probe.",
      fffCommand: join(engineRoot, "scripts", "fixtures", "readonly-mcp-fixture.ts"),
      serenaCommand: join(engineRoot, "scripts", "fixtures", "readonly-mcp-fixture.ts"),
    })
    const workspaceNotifications: JsonRpcNotification[] = []
    const workspaceStderr: string[] = []
    const secretSentinels = {
      GH_TOKEN: "github-sentinel",
      CCHP_BOT_PROVIDER_KEYS: "provider-sentinel",
      CCHP_BOT_PROVIDERS: "provider-config-sentinel",
      CCHP_PK_GPT_CCHP: "provider-key-sentinel",
      CCHP_APP_CLIENT_ID: "app-client-sentinel",
      CCHP_APP_PRIVATE_KEY: "app-private-sentinel",
      SEE_API_KEY: "see-sentinel",
      HEROUI_AUTH_TOKEN: "heroui-sentinel",
    }
    const workspaceEnvInput = {
      ...Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "LANG", "LC_ALL", "TERM", "NO_COLOR"]
          .flatMap((name) => typeof process.env[name] === "string" ? [[name, process.env[name]!]] : []),
      ),
      ...secretSentinels,
      CODEX_HOME: workspacePrepared.codexHome,
      [bridgeEnv]: bridge.token,
      BOT_REPO: "CCH-HQ/fixture",
      BOT_TASK: "manual",
      BOT_WORKDIR: workspaceRoot,
      REPO_DIR: repo,
      BOT_RUN_ID: "capability-smoke-workspace-write",
      CCHP_GITHUB_BROKER_SOCKET: broker.socketPath,
      CCHP_GITHUB_BROKER_TOKEN: broker.token,
      CCHP_GITHUB_BROKER_FINALIZER: join(root, "ctx", "review-finalized.json"),
    }
    for (const [name, value] of Object.entries(secretSentinels)) {
      if (workspaceEnvInput[name as keyof typeof workspaceEnvInput] !== value) throw new Error(`capability smoke failed to seed ${name}`)
    }
    const workspaceCodexEnv = buildCodexEnvironment(workspaceEnvInput)
    for (const name of Object.keys(secretSentinels)) {
      if (workspaceCodexEnv[name] != null) throw new Error(`Codex app-server environment retained ${name}`)
    }
    const appServerLongLivedSecretsAbsent = true
    let resolveWorkspaceCompleted!: () => void
    const workspaceCompleted = new Promise<void>((resolve) => { resolveWorkspaceCompleted = resolve })
    workspaceApp = new CodexAppServer({
      codexBin: process.env.CODEX_BIN ?? "codex",
      codexHome: workspacePrepared.codexHome,
      cwd: repo,
      env: workspaceCodexEnv,
      onNotification(notification) {
        lastProviderProgressAt = Date.now()
        workspaceNotifications.push(notification)
        if (
          notification.method === "turn/completed" &&
          workspaceThreadId &&
          String((notification.params as Json).threadId ?? "") === workspaceThreadId
        ) resolveWorkspaceCompleted()
      },
      onStderr(line) {
        lastProviderProgressAt = Date.now()
        workspaceStderr.push(line)
        process.stderr.write(`[codex-workspace-app-server] ${line}\n`)
      },
    })
    await workspaceApp.start()
    const workspaceThread = await workspaceApp.request<Json>("thread/start", {
      model: "gpt-5.6-sol",
      modelProvider: providers.providers[0]!.codexId,
      cwd: repo,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      experimentalRawEvents: true,
    })
    workspaceThreadId = String((workspaceThread.thread as Json).id)
    lastProviderProgressAt = Date.now()
    await workspaceApp.request("turn/start", {
      threadId: workspaceThreadId,
      input: [{ type: "text", text: "Use apply_patch to update README.md, then prove .git and .agents metadata remain protected, and finish with WORKSPACE_WRITE_OK_FINAL." }],
    })
    await waitForProgressingCompletion(
      workspaceCompleted,
      () => lastProviderProgressAt,
      () => `workspace-write stage=${workspaceStage} requested=${[...workspaceRequestedOperations].join("|")} completed=${[...workspaceCompletedOperations].join("|")}`,
    )

    const workspaceFinalMessages = workspaceNotifications
      .filter((notification) => notification.method === "item/completed")
      .map((notification) => {
        const params = notification.params as Json
        const item = params.item && typeof params.item === "object" ? params.item as Json : {}
        return item.type === "agentMessage" ? String(item.text ?? "") : ""
      })
    const requiredWorkspaceOperations = ["workspace_apply_patch", "workspace_shell_boundary", "workspace_git_metadata", "workspace_agents_metadata"]
    const missingWorkspaceOperations = requiredWorkspaceOperations.filter((operation) =>
      !workspaceRequestedOperations.has(operation) || !workspaceCompletedOperations.has(operation),
    )
    const sandboxFailures = workspaceStderr.flatMap((line) => {
      const failure = fatalSandboxError(line)
      return failure ? [failure] : []
    })
    const rootSandboxFailures = appServerStderr.flatMap((line) => {
      const failure = fatalSandboxError(line)
      return failure ? [failure] : []
    })
    const workspaceConfig = readFileSync(workspacePrepared.configPath, "utf8")
    const enforcement = workspaceEnforcement(workspaceConfig)
    const shellSnapshotDirectoryAbsent = !existsSync(join(workspacePrepared.codexHome, "shell_snapshots"))
    if (
      missingWorkspaceOperations.length > 0 ||
      !workspaceFinalMessages.includes("WORKSPACE_WRITE_OK_FINAL") ||
      readFileSync(join(repo, "README.md"), "utf8") !== "smoke\nworkspace-write-ok\n" ||
      !appServerLongLivedSecretsAbsent ||
      !shellSnapshotDirectoryAbsent ||
      !workspaceNetworkEvidence ||
      existsSync(gitMetadataProbePath) ||
      existsSync(agentsMetadataProbePath) ||
      rootSandboxFailures.length > 0 ||
      enforcement !== "direct" ||
      sandboxFailures.length > 0
    ) {
      throw new Error(
        `workspace-write capability failed; missing=${missingWorkspaceOperations.join("|")} final=${workspaceFinalMessages.join("|")} ` +
        `shellBoundary=${workspaceBoundaryObservation} ` +
        `shellSnapshots=${existsSync(join(workspacePrepared.codexHome, "shell_snapshots"))} ` +
        `gitProbe=${existsSync(gitMetadataProbePath)} agentsProbe=${existsSync(agentsMetadataProbePath)} ` +
        `sandboxFailures=${[...rootSandboxFailures, ...sandboxFailures].join("|")} enforcement=${enforcement} stderr=${workspaceStderr.join("|")} ` +
        `tools=${requestTools.slice(-6).map((entries) => entries.join("|")).join(";")} catalogs=${requestCatalogs.slice(-3).join(";")}`,
      )
    }
    await workspaceApp.stop()
    workspaceApp = undefined
    const workspaceWriteEvidence = {
      status: "passed",
      thread_completed: true,
      apply_patch: "passed",
      ordinary_repo_write: "passed",
      app_server_long_lived_secrets_absent: appServerLongLivedSecretsAbsent ? "passed" : "failed",
      shell_capabilities_excluded: "passed",
      shell_snapshot_directory_absent: shellSnapshotDirectoryAbsent ? "passed" : "failed",
      external_network: {
        result: "policy-blocked",
        reason: workspaceNetworkEvidence.reason,
        probe_target: workspaceNetworkEvidence.target,
        configured_enforcement: enforcement,
      },
      git_metadata_protected: "passed",
      agents_metadata_protected: "passed",
      configured_enforcement: enforcement,
      requested_operations: [...workspaceRequestedOperations],
      completed_operations: [...workspaceCompletedOperations],
    }
    const report = {
      schema_version: 2,
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
      native_interrupt_list_observed: nativeInterruptListObserved,
      native_child_collaboration_tools: childCollaborationTools,
      workspace_write: workspaceWriteEvidence,
    }
    writeFileSync(join(root, `capability-${selectedMode}.json`), JSON.stringify(report, null, 2))
    writeModeArtifact(report)
    process.stdout.write(`[codex-capability] passed version=${capability.version} mode=${selectedMode} requests=${requestNumber}\n`)
  } finally {
    await workspaceApp?.stop().catch(() => 0)
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
      schema_version: 2,
      run_id: process.env.CCHP_ARTIFACT_RUN_ID ?? "local",
      status: "failed",
      collaborationMode: collaborationMode(),
      error_type: error instanceof Error ? error.name : "Error",
    })
    process.stderr.write(`[codex-capability] failed: ${(error as Error).message}\n`)
    process.exit(1)
  })
}
