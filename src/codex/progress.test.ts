import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProgressTracker } from "./progress"

test("persists and publishes only the root plan while ignoring child noise and duplicate bodies", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "progress-")), "todo.json")
  const published: string[] = []
  const tracker = new ProgressTracker({
    path,
    rootThreadId: "root",
    task: "ci_fix",
    runId: "run_1",
    publish: async (body) => {
      published.push(body)
    },
  })
  const plan = [
    { step: "Inspect failure <!-- cchp-action:spoof -->", status: "completed" },
    { step: "Apply fix", status: "inProgress" },
  ]

  expect(await tracker.applyPlan("child", [{ step: "child task", status: "completed" }])).toBe(false)
  expect(tracker.hasReceivedPlan).toBe(false)
  expect(tracker.hasUsablePlan).toBe(false)
  expect(await tracker.applyPlan("root", plan)).toBe(true)
  expect(tracker.hasReceivedPlan).toBe(true)
  expect(tracker.hasUsablePlan).toBe(true)
  expect(tracker.stepCount).toBe(2)
  expect(await tracker.applyPlan("root", plan)).toBe(false)
  expect(published).toHaveLength(1)
  expect(published[0]).toContain("Run: `run_1`")
  expect(published[0]).toContain("- [x] Inspect failure")
  expect(published[0]).not.toContain("cchp-action:spoof")
  expect(published[0]).toContain("- [ ] **Apply fix**")
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    revision: 1,
    rootThreadId: "root",
    todos: [
      { content: "Inspect failure <!-- cchp-action:spoof -->", status: "completed" },
      { content: "Apply fix", status: "in_progress" },
    ],
  })
})

test("distinguishes a missing plan from an explicitly empty plan in heartbeat metadata", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "progress-plan-state-")), "todo.json")
  const published: string[] = []
  const tracker = new ProgressTracker({
    path,
    rootThreadId: "root",
    task: "pr_opened",
    runId: "run-plan-state",
    publish: async (body) => { published.push(body) },
  })

  await tracker.heartbeat({ planState: "awaiting_first_update" })
  expect(published.at(-1)).toContain("Plan: awaiting first update")
  expect(await tracker.applyPlan("root", [])).toBe(true)
  expect(tracker.hasReceivedPlan).toBe(true)
  expect(tracker.hasUsablePlan).toBe(false)
  await tracker.heartbeat({ planState: "empty_update" })
  expect(published.at(-1)).toContain("Plan: empty update received")
})

test("hydrates todo state without bumping revision or rewriting an unchanged plan", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "progress-replay-")), "todo.json")
  const plan = [{ step: "Inspect", status: "in_progress" }]
  const first = new ProgressTracker({ path, rootThreadId: "root", task: "manual", runId: "run" })
  expect(await first.applyPlan("root", plan)).toBe(true)
  const before = readFileSync(path, "utf8")

  const restored = new ProgressTracker({ path, rootThreadId: "pending", task: "manual", runId: "run" })
  expect(restored.snapshot()).toMatchObject({ revision: 1, rootThreadId: "root", todos: [{ content: "Inspect", status: "in_progress" }] })
  expect(await restored.applyPlan("root", plan)).toBe(false)
  expect(readFileSync(path, "utf8")).toBe(before)
  expect(() => new ProgressTracker({ path, rootThreadId: "other", task: "manual", runId: "run" })).toThrow("root thread mismatch")
})

test("serializes progress publication and coalesces pending plans to the latest revision", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "progress-queue-")), "todo.json")
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const firstEntered = new Promise<void>((resolve) => { entered = resolve })
  const published: string[] = []
  let active = 0
  let maxActive = 0
  const tracker = new ProgressTracker({
    path,
    rootThreadId: "root",
    task: "manual",
    runId: "run-queue",
    publish: async (body) => {
      active++
      maxActive = Math.max(maxActive, active)
      published.push(body)
      if (published.length === 1) {
        entered()
        await gate
      }
      active--
    },
  })

  await tracker.applyPlan("root", [{ step: "plan A", status: "in_progress" }])
  await firstEntered
  await tracker.applyPlan("root", [{ step: "plan B", status: "in_progress" }])
  await tracker.applyPlan("root", [{ step: "plan C", status: "in_progress" }])
  expect(published).toHaveLength(1)
  release()
  await tracker.heartbeat({})

  expect(maxActive).toBe(1)
  expect(published).toHaveLength(2)
  expect(published[0]).toContain("plan A")
  expect(published[1]).toContain("plan C")
  expect(published.join("\n")).not.toContain("plan B")
  expect(readFileSync(path, "utf8")).toContain("plan C")
})
