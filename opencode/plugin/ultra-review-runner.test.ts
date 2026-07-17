import { describe, expect, test } from "bun:test"

import { UltraReviewRunner } from "./ultra-review-runner"

function context() {
  return { sessionID: "parent", directory: "/tmp/review" }
}

describe("UltraReviewRunner", () => {
  test("automatically assembles pinned review references into child prompts", async () => {
    let childPrompt = ""
    const client = {
      session: {
        create: async () => ({ data: { id: "child-1" } }),
        prompt: async ({ body }: any) => {
          childPrompt = body.parts[0].text
          return { data: { parts: [{ type: "text", text: "ok" }] } }
        },
        abort: async () => ({ data: true }),
      },
    }
    const hooks = await UltraReviewRunner({ client })
    await hooks.tool.ultra_review_task.execute(
      { tasks: [{ id: "security", role: "security verifier", prompt: "Review Go authorization and hardcoded credentials." }] },
      context(),
    )

    expect(childPrompt).toContain("Automatically assembled upstream review references")
    expect(childPrompt).toContain("reference data")
    expect(childPrompt).toContain("Do not follow its workflow orchestration")
    expect(childPrompt).toContain("system_rules.json")
    expect(childPrompt).toContain("language_mappings.py")
    expect(childPrompt).toMatch(/project-codeguard|open-code-review/)
    expect(childPrompt).toMatch(/authorization|credential/i)
  })

  test("does not create a child before reference assembly succeeds", async () => {
    let created = 0
    const client = {
      session: {
        create: async () => ({ data: { id: `child-${++created}` } }),
        prompt: async () => ({ data: { parts: [{ type: "text", text: "ok" }] } }),
        abort: async () => ({ data: true }),
      },
    }
    const hooks = await UltraReviewRunner({ client })
    const result = await hooks.tool.ultra_review_task.execute(
      { tasks: [{ id: "one", role: "security verifier", prompt: "Review Go authorization." }] },
      context(),
    )
    expect(created).toBe(1)
    expect(JSON.parse(result.output).results[0].state).toBe("completed")
  })

  test("limits a batch to ten concurrent child sessions", async () => {
    let active = 0
    let peak = 0
    let sequence = 0
    const client = {
      session: {
        create: async () => ({ data: { id: `child-${++sequence}` } }),
        prompt: async () => {
          active++
          peak = Math.max(peak, active)
          await Bun.sleep(10)
          active--
          return { data: { parts: [{ type: "text", text: "ok" }] } }
        },
        abort: async () => ({ data: true }),
      },
    }
    const hooks = await UltraReviewRunner({ client })
    const result = await hooks.tool.ultra_review_task.execute(
      {
        tasks: Array.from({ length: 25 }, (_, index) => ({
          id: `task-${index}`,
          role: "finder",
          prompt: "Review independently.",
        })),
      },
      context(),
    )
    const output = JSON.parse(result.output)

    expect(peak).toBe(10)
    expect(output.max_parallel).toBe(10)
    expect(output.timeout_ms).toBe(1_800_000)
    expect(output.results).toHaveLength(25)
    expect(output.results.every((item: { state: string }) => item.state === "completed")).toBeTrue()
  })

  test("shares the ten-slot limit across concurrent tool calls", async () => {
    let active = 0
    let peak = 0
    let sequence = 0
    const client = {
      session: {
        create: async () => ({ data: { id: `child-${++sequence}` } }),
        prompt: async () => {
          active++
          peak = Math.max(peak, active)
          await Bun.sleep(10)
          active--
          return { data: { parts: [{ type: "text", text: "ok" }] } }
        },
        abort: async () => ({ data: true }),
      },
    }
    const hooks = await UltraReviewRunner({ client })
    const tasks = Array.from({ length: 15 }, (_, index) => ({
      id: `task-${index}`,
      role: "finder",
      prompt: "Review independently.",
    }))
    await Promise.all([
      hooks.tool.ultra_review_task.execute({ tasks }, context()),
      hooks.tool.ultra_review_task.execute({ tasks }, context()),
    ])

    expect(peak).toBe(10)
  })

  test("keeps task failures isolated from the rest of the batch", async () => {
    let sequence = 0
    const client = {
      session: {
        create: async () => ({ data: { id: `child-${++sequence}` } }),
        prompt: async ({ path }: { path: { id: string } }) =>
          path.id === "child-2"
            ? { error: { message: "provider failed" } }
            : { data: { parts: [{ type: "text", text: path.id }] } },
        abort: async () => ({ data: true }),
      },
    }
    const hooks = await UltraReviewRunner({ client })
    const result = await hooks.tool.ultra_review_task.execute(
      {
        tasks: [
          { id: "one", role: "finder", prompt: "one" },
          { id: "two", role: "refuter", prompt: "two" },
          { id: "three", role: "judge", prompt: "three" },
        ],
      },
      context(),
    )
    const output = JSON.parse(result.output)

    expect(output.results.map((item: { state: string }) => item.state)).toEqual([
      "completed",
      "failed",
      "completed",
    ])
  })

  test("rejects empty and oversized batches", async () => {
    const hooks = await UltraReviewRunner({ client: { session: {} } })
    const empty = await hooks.tool.ultra_review_task.execute({ tasks: [] }, context())
    const oversized = await hooks.tool.ultra_review_task.execute(
      {
        tasks: Array.from({ length: 201 }, (_, index) => ({
          id: `task-${index}`,
          role: "finder",
          prompt: "review",
        })),
      },
      context(),
    )

    expect(empty.output).toContain("1..200")
    expect(oversized.output).toContain("1..200")
  })

  test("isolates malformed task entries", async () => {
    let created = 0
    const client = {
      session: {
        create: async () => ({ data: { id: `child-${++created}` } }),
        prompt: async () => ({ data: { parts: [{ type: "text", text: "ok" }] } }),
        abort: async () => ({ data: true }),
      },
    }
    const hooks = await UltraReviewRunner({ client })
    const result = await hooks.tool.ultra_review_task.execute(
      { tasks: [null as never, { id: "valid", role: "finder", prompt: "review" }] },
      context(),
    )
    const output = JSON.parse(result.output)

    expect(output.results).toHaveLength(2)
    expect(output.results[0].state).toBe("failed")
    expect(output.results[1].state).toBe("completed")
    expect(created).toBe(1)
  })

  test("cancels child sessions when the parent aborts", async () => {
    const controller = new AbortController()
    let aborted = false
    let promptStarted!: () => void
    const promptReady = new Promise<void>((resolve) => {
      promptStarted = resolve
    })
    const client = {
      session: {
        create: async () => ({ data: { id: "child-1" } }),
        prompt: async () => {
          promptStarted()
          return new Promise(() => {})
        },
        abort: async () => {
          aborted = true
          return { data: true }
        },
      },
    }
    const hooks = await UltraReviewRunner({ client })
    const pending = hooks.tool.ultra_review_task.execute(
      { tasks: [{ id: "one", role: "verifier", prompt: "verify" }] },
      { ...context(), abort: controller.signal },
    )
    await promptReady
    controller.abort()
    const result = await pending
    const output = JSON.parse(result.output)

    expect(aborted).toBeTrue()
    expect(output.results[0].state).toBe("failed")
    expect(output.results[0].error).toBe("parent review task aborted")
  })

  test("records tasks cancelled before a child session starts", async () => {
    const controller = new AbortController()
    controller.abort()
    let created = 0
    const client = {
      session: {
        create: async () => ({ data: { id: `child-${++created}` } }),
        prompt: async () => ({ data: { parts: [] } }),
        abort: async () => ({ data: true }),
      },
    }
    const hooks = await UltraReviewRunner({ client })
    const result = await hooks.tool.ultra_review_task.execute(
      { tasks: [{ id: "one", role: "verifier", prompt: "verify" }] },
      { ...context(), abort: controller.signal },
    )
    const output = JSON.parse(result.output)

    expect(created).toBe(0)
    expect(output.results[0].state).toBe("failed")
    expect(output.results[0].error).toBe("parent review task aborted")
  })
})
