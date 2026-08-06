import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ArtifactExplicitChildLifecycle } from "./explicit-lifecycle"

function writeArtifact(root: string, name: string, value: Record<string, unknown>): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`)
}

const attempt = {
  attempt: 1,
  sessionId: "thread-child",
  state: "completed",
  terminal: "completed",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  output: "done",
}

test("reconciles explicit child artifacts and lets the newest running generation win", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-explicit-lifecycle-"))
  const resultPath = join(root, "child-1.json")
  writeArtifact(root, "child-1.json", {
    schemaVersion: 2, mode: "explicit_child", runId: "run-1", parentRunId: "run-1",
    childId: "child-1", parentId: "root", spawnItemId: "explicit:child-1", generation: 1, role: "explorer", state: "completed",
    sessionId: "thread-child", deadlineAt: "2026-01-01T01:00:00.000Z", sandbox: "read-only",
    tokenScope: "child", output: "done", attempts: [attempt], updatedAt: "2026-01-01T00:00:02.000Z",
  })
  writeArtifact(root, "child-1.running.json", {
    schemaVersion: 2, mode: "explicit_child", kind: "explicit_child_running",
    runId: "run-1", parentRunId: "run-1", childId: "child-1", parentId: "root", spawnItemId: "explicit:child-1", generation: 2, role: "explorer",
    state: "running", sessionId: "thread-child", deadlineAt: "2026-01-01T01:00:00.000Z",
    sandbox: "read-only", tokenScope: "child", resultPath, activePrompt: "follow up",
    queuedPrompts: [], attempts: [attempt], attempt: 2, ownerId: "owner", ownerEpoch: 2,
    resumeState: "resuming", heartbeatAt: "2026-01-01T00:00:01.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
  })
  const snapshot = new ArtifactExplicitChildLifecycle({ resultRoot: root, runId: "run-1" }).reconcile()
  expect(snapshot.active.map((child) => child.childId)).toEqual(["child-1"])
  expect(snapshot.active[0]?.generation).toBe(2)
  expect(snapshot.terminal).toEqual([])
})

test("fails closed when running and terminal generations drift identity", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-explicit-lifecycle-identity-"))
  const resultPath = join(root, "child-1.json")
  writeArtifact(root, "child-1.json", {
    schemaVersion: 2, mode: "explicit_child", runId: "run-1", parentRunId: "run-1",
    childId: "child-1", parentId: "root", spawnItemId: "explicit:child-1", generation: 1, role: "explorer", state: "completed",
    sessionId: "thread-child", deadlineAt: "2026-01-01T01:00:00.000Z", sandbox: "read-only",
    tokenScope: "child", output: "done", attempts: [attempt], updatedAt: "2026-01-01T00:00:01.000Z",
  })
  writeArtifact(root, "child-1.running.json", {
    schemaVersion: 2, mode: "explicit_child", kind: "explicit_child_running",
    runId: "run-1", parentRunId: "run-1", childId: "child-1", parentId: "other", spawnItemId: "explicit:child-1", generation: 2, role: "explorer",
    state: "running", sessionId: "thread-child", deadlineAt: "2026-01-01T01:00:00.000Z",
    sandbox: "read-only", tokenScope: "child", resultPath, activePrompt: "follow up",
    queuedPrompts: [], attempts: [attempt], attempt: 2, ownerId: "owner", ownerEpoch: 2,
    resumeState: "resuming", heartbeatAt: "2026-01-01T00:00:02.000Z", updatedAt: "2026-01-01T00:00:02.000Z",
  })
  expect(() => new ArtifactExplicitChildLifecycle({ resultRoot: root, runId: "run-1" }).reconcile()).toThrow(/identity drift/)
})

test("fails closed for foreign-run and unsafe explicit artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-explicit-lifecycle-invalid-"))
  writeArtifact(root, "child-1.running.json", {
    schemaVersion: 2, mode: "explicit_child", kind: "explicit_child_running",
    runId: "other", parentRunId: "other", childId: "child-1", parentId: "root", role: "explorer",
    state: "queued", deadlineAt: "2026-01-01T01:00:00.000Z", sandbox: "read-only", tokenScope: "child",
    resultPath: join(root, "elsewhere.json"), queuedPrompts: [], attempts: [], attempt: 1,
    ownerId: "owner", ownerEpoch: 1, resumeState: "initial",
    heartbeatAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  })
  expect(() => new ArtifactExplicitChildLifecycle({ resultRoot: root, runId: "run-1" }).reconcile())
    .toThrow(/another run|unsafe result path/)
})
