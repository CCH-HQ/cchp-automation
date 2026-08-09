import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ArtifactExplicitChildLifecycle } from "./explicit-lifecycle"
import { attachRecordHmac } from "./authenticated-record"

const RECORD_HMAC_KEY = "1".repeat(64)

function writeArtifact(root: string, name: string, value: Record<string, unknown>): void {
  mkdirSync(root, { recursive: true })
  const artifact = name.endsWith(".running.json")
    ? attachRecordHmac({
        ...value,
        schemaVersion: 5 as const,
        spawnItemId: value.spawnItemId ?? `explicit:${String(value.childId ?? "unknown")}`,
        generation: value.generation ?? 1,
        launchState: value.launchState ?? (value.processIdentity ? "checkpointed" : "idle"),
      }, RECORD_HMAC_KEY)
    : value
  writeFileSync(join(root, name), `${JSON.stringify(artifact, null, 2)}\n`)
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
process.env.CCHP_PROCESS_RECORD_HMAC_KEY = RECORD_HMAC_KEY

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

test("keeps a same-generation running marker authoritative until terminal admission commits", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-explicit-lifecycle-terminal-fence-"))
  const resultPath = join(root, "child-1.json")
  writeArtifact(root, "child-1.json", {
    schemaVersion: 3, mode: "explicit_child", runId: "run-1", parentRunId: "run-1",
    childId: "child-1", parentId: "root", spawnItemId: "explicit:child-1", generation: 1, role: "explorer", state: "completed",
    sessionId: "thread-child", deadlineAt: "2026-01-01T01:00:00.000Z", sandbox: "read-only",
    tokenScope: "child", output: "done", attempts: [attempt], updatedAt: "2026-01-01T00:00:02.000Z",
  })
  writeArtifact(root, "child-1.running.json", {
    schemaVersion: 2, mode: "explicit_child", kind: "explicit_child_running",
    runId: "run-1", parentRunId: "run-1", childId: "child-1", parentId: "root", spawnItemId: "explicit:child-1", generation: 1, role: "explorer",
    state: "running", sessionId: "thread-child", deadlineAt: "2026-01-01T01:00:00.000Z",
    sandbox: "read-only", tokenScope: "child", resultPath, activePrompt: "inspect",
    queuedPrompts: [], attempts: [], attempt: 1, ownerId: "owner", ownerEpoch: 1,
    resumeState: "initial", heartbeatAt: "2026-01-01T00:00:01.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
  })

  const snapshot = new ArtifactExplicitChildLifecycle({ resultRoot: root, runId: "run-1" }).reconcile()
  expect(snapshot.active.map((child) => child.childId)).toEqual(["child-1"])
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

test("rejects a tampered running marker before process-group cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-explicit-lifecycle-forged-"))
  const path = join(root, "child-1.running.json")
  writeArtifact(root, "child-1.running.json", {
    mode: "explicit_child", kind: "explicit_child_running",
    runId: "run-1", parentRunId: "run-1", childId: "child-1", parentId: "root", role: "explorer",
    state: "running", sessionId: "thread-child", deadlineAt: "2026-01-01T01:00:00.000Z",
    sandbox: "read-only", tokenScope: "child", resultPath: join(root, "child-1.json"), activePrompt: "inspect",
    queuedPrompts: [], attempts: [], attempt: 1, ownerId: "owner", ownerEpoch: 1,
    resumeState: "initial", heartbeatAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  })
  const artifact = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  artifact.ownerEpoch = 2
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`)
  const signals: number[] = []
  const lifecycle = new ArtifactExplicitChildLifecycle({
    resultRoot: root,
    runId: "run-1",
    kill: (target, signal) => { if (signal !== 0) signals.push(target) },
  })
  await expect(lifecycle.interruptActive("terminal cleanup")).rejects.toThrow("invalid mac")
  expect(signals).toEqual([])
})

test("attempts every active process-group cleanup and aggregates failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-explicit-lifecycle-cleanup-"))
  const groups = new Map([[101, true], [202, true]])
  for (const pid of groups.keys()) {
    writeArtifact(root, `child-${pid}.running.json`, {
      schemaVersion: 4, mode: "explicit_child", kind: "explicit_child_running",
      runId: "run-cleanup", parentRunId: "run-cleanup", childId: `child-${pid}`, parentId: "root",
      spawnItemId: `explicit:child-${pid}`, generation: 1, role: "explorer", state: "running",
      sessionId: `thread-${pid}`, deadlineAt: new Date(Date.now() + 60_000).toISOString(), sandbox: "read-only",
      tokenScope: "child", resultPath: join(root, `child-${pid}.json`), activePrompt: "wait",
      queuedPrompts: [], attempts: [], attempt: 1, pid, processGroupId: pid,
      processIdentity: { pid, bootId: "boot", startTicks: "ticks" }, launchState: "checkpointed",
      ownerId: "owner", ownerEpoch: 1, resumeState: "initial",
      heartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })
  }
  const signals: number[] = []
  const lifecycle = new ArtifactExplicitChildLifecycle({
    resultRoot: root,
    runId: "run-cleanup",
    sleep: async () => undefined,
    kill: (target, signal) => {
      const pid = Math.abs(target)
      if (signal === 0) {
        if (target > 0 || !groups.get(pid)) {
          const error = new Error("not found") as NodeJS.ErrnoException
          error.code = "ESRCH"
          throw error
        }
        return
      }
      signals.push(target)
      if (pid === 101) throw new Error("signal denied")
      groups.set(pid, false)
    },
  })
  await expect(lifecycle.interruptActive("terminal cleanup")).rejects.toThrow("process groups failed to stop")
  expect(signals).toContain(-101)
  expect(signals).toContain(-202)
  expect(groups.get(202)).toBe(false)
})
