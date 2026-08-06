import { expect, test } from "bun:test"
import { REFERENCE_MAX_BYTES } from "./references"
import { ReviewRunner } from "./review-runner"

test("bounds review concurrency and rejects malformed/oversized batches", async () => {
  let active = 0
  let peak = 0
  const runner = new ReviewRunner({
    run: async ({ task }) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active--
      return { sessionId: task.id, output: `ok:${task.id}` }
    },
  }, { maxActive: 3, timeoutMs: 1000 })
  const tasks = Array.from({ length: 8 }, (_, index) => ({ id: `t${index}`, role: "finder", passKind: "review_shard" as const, prompt: "inspect" }))
  const result = await runner.run(tasks)
  expect(peak).toBe(3)
  expect(result.every((item) => item.state === "completed")).toBe(true)
  expect((await runner.run([{ id: "bad", role: "", passKind: "review_shard", prompt: "" }]))[0]?.state).toBe("failed")
})

test("bounds the assembled reference injection before spawning a reviewer", async () => {
  let observed = ""
  const runner = new ReviewRunner({
    run: async ({ prompt }) => {
      observed = prompt
      return { sessionId: "session", output: "ok" }
    },
  })
  const taskPrompt = "Review Go authorization security, privacy, performance, accessibility and architecture."
  expect((await runner.run([{ id: "bounded", role: "security verifier", passKind: "verifier", prompt: taskPrompt }]))[0]?.state).toBe("completed")
  expect(observed).toContain(taskPrompt)
  expect(observed).toContain("read-only leaf reviewer")
  expect(Buffer.byteLength(observed, "utf8")).toBeLessThanOrEqual(REFERENCE_MAX_BYTES + 2_048)
})
