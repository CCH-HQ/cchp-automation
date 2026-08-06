import type { JsonRpcNotification } from "./app-server"

export type NormalizedEventKind =
  | "plan"
  | "usage"
  | "raw_usage"
  | "collaboration"
  | "item"
  | "turn_started"
  | "turn_completed"
  | "thread_status"
  | "delta"
  | "error"
  | "warning"
  | "unknown"

export interface NormalizedCollaboration {
  itemId: string
  tool: string
  sender: string
  receivers: string[]
  states: Record<string, string>
  prompt?: string
  role?: string
}

export interface NormalizedEvent {
  kind: NormalizedEventKind
  source: string
  threadId?: string
  turnId?: string
  semantic: boolean
  params: Record<string, unknown>
  item?: Record<string, unknown>
  collaboration?: NormalizedCollaboration
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function stateMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [id, raw] of Object.entries(record(value))) {
    const status = record(raw).status
    const type = typeof status === "string" ? status : record(status).type
    if (typeof type === "string") result[id] = type
  }
  return result
}

export function normalizeAppServerNotification(notification: JsonRpcNotification): NormalizedEvent {
  const params = record(notification.params)
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined
  const turnId = typeof params.turnId === "string" ? params.turnId : undefined
  const base = { source: notification.method, threadId, turnId, params }

  switch (notification.method) {
    case "turn/plan/updated":
      return { ...base, kind: "plan", semantic: true }
    case "thread/tokenUsage/updated":
      return { ...base, kind: "usage", semantic: false }
    case "rawResponse/completed":
      return { ...base, kind: "raw_usage", semantic: false }
    case "turn/started": {
      const turn = record(params.turn)
      return {
        ...base,
        kind: "turn_started",
        turnId: typeof turn.id === "string" ? turn.id : turnId,
        semantic: false,
      }
    }
    case "turn/completed": {
      const turn = record(params.turn)
      return {
        ...base,
        kind: "turn_completed",
        turnId: typeof turn.id === "string" ? turn.id : turnId,
        semantic: true,
      }
    }
    case "thread/status/changed":
    case "remoteControl/status/changed":
    case "thread/started":
    case "thread/archived":
    case "thread/deleted":
    case "thread/unarchived":
    case "thread/closed":
    case "thread/name/updated":
    case "thread/goal/updated":
    case "thread/goal/cleared":
    case "thread/environment/connected":
    case "thread/environment/disconnected":
    case "thread/settings/updated":
      return { ...base, kind: "thread_status", semantic: false }
    case "item/started":
    case "item/completed": {
      const item = record(params.item)
      if (item.type === "collabAgentToolCall") {
        const states = stateMap(item.agentsStates)
        const terminal = Object.values(states).some((status) =>
          ["completed", "errored", "interrupted", "cancelled", "canceled", "shutdown", "notFound"].includes(status),
        )
        return {
          ...base,
          kind: "collaboration",
          semantic: terminal,
          item,
          collaboration: {
            itemId: typeof item.id === "string" ? item.id : "unknown",
            tool: typeof item.tool === "string" ? item.tool : "unknown",
            sender: typeof item.senderThreadId === "string" ? item.senderThreadId : threadId ?? "unknown",
            receivers: ids(item.receiverThreadIds),
            states,
            ...(typeof item.prompt === "string" && item.prompt ? { prompt: item.prompt } : {}),
            ...((typeof item.agentType === "string" && item.agentType) || (typeof item.role === "string" && item.role)
              ? { role: typeof item.agentType === "string" && item.agentType ? item.agentType : item.role as string }
              : {}),
          },
        }
      }
      const status = item.status
      const semantic =
        notification.method === "item/completed" &&
        (item.type === "agentMessage" ||
          (item.type === "commandExecution" && status === "completed") ||
          (item.type === "fileChange" && status === "completed") ||
          (item.type === "mcpToolCall" && status === "completed"))
      return { ...base, kind: "item", semantic, item }
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/mcpToolCall/progress":
    case "turn/diff/updated":
    case "item/plan/delta":
    case "command/exec/outputDelta":
    case "process/outputDelta":
    case "process/exited":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/patchUpdated":
    case "serverRequest/resolved":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "hook/started":
    case "hook/completed":
    case "rawResponseItem/completed":
    case "thread/compacted":
    case "model/verification":
    case "model/safetyBuffering/updated":
    case "turn/moderationMetadata":
    case "mcpServer/oauthLogin/completed":
    case "mcpServer/startupStatus/updated":
    case "skills/changed":
    case "account/updated":
    case "account/rateLimits/updated":
    case "app/list/updated":
    case "externalAgentConfig/import/progress":
    case "externalAgentConfig/import/completed":
    case "fs/changed":
    case "fuzzyFileSearch/sessionUpdated":
    case "fuzzyFileSearch/sessionCompleted":
      return { ...base, kind: "delta", semantic: false }
    case "error":
      return { ...base, kind: "error", semantic: false }
    case "warning":
    case "configWarning":
    case "guardianWarning":
    case "deprecationNotice":
    case "model/rerouted":
      return { ...base, kind: "warning", semantic: false }
    default:
      return { ...base, kind: "unknown", semantic: false }
  }
}

/** Normalize `codex exec --json` event envelopes into the same lifecycle model. */
export function normalizeExecEvent(raw: unknown): NormalizedEvent {
  const value = record(raw)
  const type = typeof value.type === "string" ? value.type : "unknown"
  const params = value
  const threadId = typeof value.thread_id === "string" ? value.thread_id : undefined
  const turnId = typeof value.turn_id === "string" ? value.turn_id : undefined
  if (type === "thread.started") return { kind: "thread_status", source: type, threadId, turnId, semantic: false, params }
  if (type === "turn.started") return { kind: "turn_started", source: type, threadId, turnId, semantic: false, params }
  if (type === "turn.completed") return { kind: "turn_completed", source: type, threadId, turnId, semantic: true, params, item: record(value.usage) }
  if (type === "turn.failed" || type === "error") return { kind: "error", source: type, threadId, turnId, semantic: false, params }
  if (type === "item.completed" || type === "item.started") {
    const item = record(value.item)
    return { kind: "item", source: type, threadId, turnId, semantic: type === "item.completed", params, item }
  }
  if (type.includes("message") || type.includes("delta")) return { kind: "delta", source: type, threadId, turnId, semantic: false, params }
  return { kind: "unknown", source: type, threadId, turnId, semantic: false, params }
}
