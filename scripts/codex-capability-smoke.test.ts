import { expect, test } from "bun:test"
import { capabilityEngineRoot, collaborationLifecycleObserved, customToolCall, extractToolRefs, isChildProviderRequest, isCollaborationToolName, metadataProbeProtected, parentObservedChildOutput, parentObservedNativeChildOutput, toolCall, waitAgentArguments, waitForProgressingCompletion, workspaceEnforcement } from "./codex-capability-smoke"

test("resolves the engine root from the smoke script instead of the caller working directory", () => {
  expect(capabilityEngineRoot("/opt/cchp-engine/scripts")).toBe("/opt/cchp-engine")
})

test("maps wait_agent arguments to the selected collaboration ABI", () => {
  expect(waitAgentArguments("native-v2", "/root/child", 2_000)).toEqual({ timeout_ms: 2_000 })
  expect(waitAgentArguments("explicit-exec", "child", 2_000)).toEqual({ target: "child", timeout_ms: 2_000 })
})

test("bounds capability turns by inactivity while allowing an active multi-step turn to exceed the old wall-clock limit", async () => {
  let progressAt = Date.now()
  let resolveCompletion!: () => void
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve })
  const waiting = waitForProgressingCompletion(
    completion,
    () => progressAt,
    () => "stage=interrupt",
    { inactivityMs: 30, absoluteMs: 200, pollMs: 5 },
  )
  await Bun.sleep(20)
  progressAt = Date.now()
  await Bun.sleep(20)
  progressAt = Date.now()
  resolveCompletion()
  await expect(waiting).resolves.toBeUndefined()
})

test("fails closed after a capability turn stops making provider progress", async () => {
  await expect(waitForProgressingCompletion(
    new Promise<void>(() => {}),
    () => Date.now() - 100,
    () => "stage=wait-interrupt",
    { inactivityMs: 10, absoluteMs: 100, pollMs: 2 },
  )).rejects.toThrow(/idleMs=.*stage=wait-interrupt/)
})

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

test("accepts metadata protection only for a concrete sandbox denial", () => {
  expect(metadataProbeProtected({ output: "touch: .git/probe: Permission denied", exit_code: 1 }, ".git/probe")).toBe(true)
  expect(metadataProbeProtected({ output: "touch: .git/probe: command not found", exit_code: 127 }, ".git/probe")).toBe(false)
  expect(metadataProbeProtected({ output: "exec tool unavailable", exit_code: undefined }, ".git/probe")).toBe(false)
  expect(metadataProbeProtected({ output: "touch: /tmp/probe: Operation not permitted", exit_code: 1 }, ".git/probe")).toBe(false)
})

test("binds workspace enforcement evidence to the generated config", () => {
  expect(workspaceEnforcement('sandbox_mode = "workspace-write"\n')).toBe("direct")
  expect(workspaceEnforcement('sandbox_mode = "workspace-write"\nuse_legacy_landlock = true\n')).toBe("legacy-landlock")
  expect(workspaceEnforcement('sandbox_mode = "read-only"\n')).toBe("unknown")
})
