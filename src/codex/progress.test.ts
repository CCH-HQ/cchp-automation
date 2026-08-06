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
  expect(await tracker.applyPlan("root", plan)).toBe(true)
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
