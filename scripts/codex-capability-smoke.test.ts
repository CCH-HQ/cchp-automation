import { expect, test } from "bun:test"
import { collaborationLifecycleObserved, customToolCall, extractToolRefs, isChildProviderRequest, isCollaborationToolName, parentObservedChildOutput, parentObservedNativeChildOutput, toolCall } from "./codex-capability-smoke"

test("extracts collaboration tools from classic Responses and Responses Lite requests", () => {
  expect(extractToolRefs({
    tools: [
      { type: "function", name: "spawn_agent" },
      { type: "function", name: "wait_agent" },
      { type: "function", name: "close_agent" },
    ],
  })).toEqual([
    { name: "spawn_agent" },
    { name: "wait_agent" },
    { name: "close_agent" },
  ])

  expect(extractToolRefs({
    input: [{
      type: "additional_tools",
      role: "developer",
      tools: [{
        type: "namespace",
        name: "agents",
        tools: [
          { type: "function", name: "spawn_agent" },
          { type: "function", name: "wait_agent" },
          { type: "function", name: "close_agent" },
        ],
      }],
    }],
  })).toEqual([
    { name: "spawn_agent", namespace: "agents" },
    { name: "wait_agent", namespace: "agents" },
    { name: "close_agent", namespace: "agents" },
  ])
})

test("emits the namespace required by a Responses Lite function call", () => {
  const events = toolCall("response", { name: "spawn_agent", namespace: "agents" }, {
    task_name: "child",
    message: 'CCHP_REVIEW_TASK_V1 {"task_id":"child","pass_kind":"review_shard"}\nreview',
    pass_kind: "review_shard",
  })
  expect(events[1]).toMatchObject({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "spawn_agent",
      namespace: "agents",
    },
  })
  expect(JSON.parse(String((events[1] as { item: { arguments: string } }).item.arguments))).toEqual({
    task_name: "child",
    message: 'CCHP_REVIEW_TASK_V1 {"task_id":"child","pass_kind":"review_shard"}\nreview',
    pass_kind: "review_shard",
  })

  expect(toolCall("classic", { name: "spawn_agent" }, {})[1]).not.toHaveProperty("item.namespace")
})

test("emits a custom exec call that can invoke deferred MCP tools", () => {
  expect(customToolCall("probe", { name: "exec" }, "text('ok');")[1]).toMatchObject({
    type: "response.output_item.done",
    item: {
      type: "custom_tool_call",
      name: "exec",
      input: "text('ok');",
    },
  })
})

test("classifies every request from a non-root thread as child traffic", () => {
  expect(isChildProviderRequest("child-thread", "root-thread")).toBe(true)
  expect(isChildProviderRequest("root-thread", "root-thread")).toBe(false)
  expect(isChildProviderRequest(undefined, "root-thread")).toBe(false)
})

test("requires child output to arrive in a parent tool output", () => {
  expect(parentObservedChildOutput({
    input: [{ type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ message: "CHILD_OK" }) }],
  })).toBe(false)
  expect(parentObservedChildOutput({
    input: [{ type: "function_call_output", output: "started" }],
  })).toBe(false)
  expect(parentObservedChildOutput({
    input: [{ type: "custom_tool_call_output", result: "child result CHILD_OK" }],
  })).toBe(true)

  expect(parentObservedNativeChildOutput({
    input: [{ type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ message: "CHILD_OK" }) }],
  })).toBe(false)
  expect(parentObservedNativeChildOutput({
    input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "child completed: CHILD_OK" }] }],
  })).toBe(true)
})

test("rejects every collaboration namespace in a child catalog", () => {
  expect(isCollaborationToolName("agents.spawn_agent")).toBe(true)
  expect(isCollaborationToolName("agents.close_agent")).toBe(true)
  expect(isCollaborationToolName("mcp__agents.new_tool")).toBe(true)
  expect(isCollaborationToolName("collaboration.custom_tool")).toBe(true)
  expect(isCollaborationToolName("fff.grep")).toBe(false)
})

test("observes native collaboration events and explicit agents MCP lifecycle independently", () => {
  expect(collaborationLifecycleObserved("native-v2", [
    { type: "collabAgentToolCall", tool: "spawn_agent" },
  ])).toBe(true)
  expect(collaborationLifecycleObserved("native-v2", [
    { type: "mcpToolCall", server: "agents", tool: "spawn_agent" },
  ])).toBe(false)

  expect(collaborationLifecycleObserved("explicit-exec", [
    { type: "mcpToolCall", server: "agents", tool: "spawn_agent" },
    { type: "mcpToolCall", server: "agents", tool: "wait_agent" },
  ])).toBe(true)
  expect(collaborationLifecycleObserved("explicit-exec", [
    { type: "mcpToolCall", server: "fff", tool: "grep" },
  ])).toBe(false)
})
