import { expect, test } from "bun:test"
import { normalizeAppServerNotification } from "./events"

test("normalizes plan, usage and multi-agent lifecycle notifications", () => {
  expect(
    normalizeAppServerNotification({
      method: "turn/plan/updated",
      params: { threadId: "root", turnId: "turn", plan: [{ step: "fix", status: "inProgress" }] },
    }),
  ).toMatchObject({ kind: "plan", threadId: "root", turnId: "turn", semantic: true })

  expect(
    normalizeAppServerNotification({
      method: "thread/tokenUsage/updated",
      params: { threadId: "root", turnId: "turn", tokenUsage: { total: {}, last: {} } },
    }),
  ).toMatchObject({ kind: "usage", threadId: "root", turnId: "turn", semantic: false })

  expect(
    normalizeAppServerNotification({
      method: "rawResponse/completed",
      params: {
        threadId: "child",
        turnId: "child-turn",
        responseId: "resp-child",
        usage: { totalTokens: 42 },
      },
    }),
  ).toMatchObject({
    kind: "raw_usage",
    threadId: "child",
    turnId: "child-turn",
    semantic: false,
  })

  expect(
    normalizeAppServerNotification({
      method: "item/completed",
      params: {
        threadId: "root",
        turnId: "turn",
        item: {
          type: "collabAgentToolCall",
          id: "spawn_1",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "root",
          receiverThreadIds: ["child"],
          agentsStates: { child: { status: "running", message: null } },
        },
      },
    }),
  ).toMatchObject({
    kind: "collaboration",
    threadId: "root",
    semantic: false,
    collaboration: { tool: "spawnAgent", receivers: ["child"], states: { child: "running" } },
  })
})

test("does not count reasoning or output deltas as semantic progress", () => {
  for (const method of [
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
    "item/agentMessage/delta",
    "item/commandExecution/outputDelta",
  ]) {
    expect(normalizeAppServerNotification({ method, params: { threadId: "root", turnId: "turn" } })).toMatchObject({
      kind: "delta",
      semantic: false,
    })
  }
})

test("normalizes object-form cancelled collaboration state as terminal", () => {
  expect(normalizeAppServerNotification({
    method: "item/completed",
    params: {
      threadId: "root",
      item: {
        type: "collabAgentToolCall",
        id: "spawn",
        tool: "spawn_agent",
        senderThreadId: "root",
        receiverThreadIds: ["child"],
        agentsStates: { child: { status: { type: "cancelled" } } },
      },
    },
  })).toMatchObject({
    kind: "collaboration",
    semantic: true,
    collaboration: { states: { child: "cancelled" } },
  })
})

test("classifies the current Codex app-server notification surface without abort-worthy unknowns", () => {
  for (const method of [
    "turn/diff/updated",
    "item/plan/delta",
    "item/commandExecution/terminalInteraction",
    "item/fileChange/patchUpdated",
    "serverRequest/resolved",
    "hook/started",
    "hook/completed",
    "thread/compacted",
    "mcpServer/startupStatus/updated",
  ]) {
    expect(normalizeAppServerNotification({ method, params: { threadId: "root", turnId: "turn" } })).toMatchObject({
      kind: "delta",
      semantic: false,
    })
  }

  for (const method of ["model/rerouted", "guardianWarning", "deprecationNotice"]) {
    expect(normalizeAppServerNotification({ method, params: { threadId: "root" } })).toMatchObject({
      kind: "warning",
      semantic: false,
    })
  }

  expect(normalizeAppServerNotification({ method: "thread/closed", params: { threadId: "root" } })).toMatchObject({
    kind: "thread_status",
    semantic: false,
  })
  expect(normalizeAppServerNotification({ method: "future/protocol/event", params: { threadId: "root" } })).toMatchObject({
    kind: "unknown",
  })
})
