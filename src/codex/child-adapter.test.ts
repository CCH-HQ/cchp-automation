import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ExplicitChildAdapter, explicitChildWorkKey, stopProvenProcessGroup } from "./child-adapter"
import { attachRecordHmac } from "./authenticated-record"
import type { ExecRunResult } from "./exec-adapter"
import { ReviewAdmissionLedger } from "./review-admission"
import { processIdentity } from "./run-lock"

const fakeCodex = resolve(import.meta.dir, "../../scripts/fixtures/fake-codex-exec.ts")
chmodSync(fakeCodex, 0o755)
const RECORD_HMAC_KEY = "1".repeat(64)
process.env.CCHP_PROCESS_RECORD_HMAC_KEY = RECORD_HMAC_KEY

test("running-child work identity ignores heartbeat and updatedAt", () => {
  const first = explicitChildWorkKey({
    generation: 1, state: "running", sessionId: "sess", attempt: 1, promptSha256: "abc", queuedPrompts: [],
  })
  const heartbeatOnly = explicitChildWorkKey({
    generation: 1, state: "running", sessionId: "sess", attempt: 1, promptSha256: "abc", queuedPrompts: [],
  })
  const newPrompt = explicitChildWorkKey({
    generation: 1, state: "running", sessionId: "sess", attempt: 1, promptSha256: "def", queuedPrompts: [],
  })
  expect(heartbeatOnly).toBe(first)
  expect(newPrompt).not.toBe(first)
})

test("stops a proven process group after its leader has already exited", async () => {
  let groupLive = true
  const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = []
  const kill = (pid: number, signal: NodeJS.Signals | 0) => {
    if (signal === 0) {
      if (pid === 321 || (pid === -321 && !groupLive)) {
        const error = new Error("not found") as NodeJS.ErrnoException
        error.code = "ESRCH"
        throw error
      }
      return
    }
    signals.push({ pid, signal })
    if (pid === -321) groupLive = false
  }
  await expect(stopProvenProcessGroup(
    { identity: { pid: 321, bootId: "boot", startTicks: "ticks" }, processGroupId: 321 },
    { kill, identify: () => { throw new Error("leader identity must not be read after exit") }, sleep: async () => undefined },
  )).resolves.toBe("stopped")
  expect(signals).toEqual([{ pid: -321, signal: "SIGINT" }])
})

test("spawns a live explicit child, waits for terminal status and persists its result", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-"))
  const resultRoot = join(root, "ctx", "child-results")
  try {
    const adapter = new ExplicitChildAdapter({
      runId: "run-fixture",
      exec: {
        codexBin: fakeCodex,
        cwd: root,
        env: { PATH: process.env.PATH ?? "" },
        sandbox: "read-only",
      },
      resultRoot,
      timeoutMs: 1_000,
    })

    const spawned = await adapter.spawn("root", {
      id: "child-1",
      role: "reviewer",
      passKind: "review_shard",
      prompt: "inspect",
    })
    expect(spawned).toMatchObject({
      runId: "run-fixture",
      parentRunId: "run-fixture",
      childId: "child-1",
      parentId: "root",
      role: "reviewer",
      passKind: "review_shard",
      sessionId: "thread-fixture",
    })

    const terminal = await adapter.waitAgent("child-1")
    expect(terminal).toMatchObject({ state: "completed", output: "completed:inspect" })
    expect(terminal.resultPath).toBe(join(resultRoot, "child-1.json"))
    expect(JSON.parse(readFileSync(terminal.resultPath!, "utf8"))).toMatchObject({
      schemaVersion: 3,
      mode: "explicit_child",
      runId: "run-fixture",
      childId: "child-1",
      parentId: "root",
      state: "completed",
      sessionId: "thread-fixture",
      output: "completed:inspect",
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("launches explicit review and worker roles with their configured leaf models", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-model-"))
  const models: Array<string | undefined> = []
  let session = 0
  const adapter = new ExplicitChildAdapter({
    runId: "run-models",
    exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
    childModels: { review: "review-leaf", worker: "worker-leaf" },
    resultRoot: join(root, "results"),
    startExec: (options) => {
      models.push(options.model)
      const sessionId = `thread-${++session}`
      return {
        pid: process.pid,
        started: Promise.resolve({ sessionId }),
        completed: Promise.resolve({
          exitCode: 0,
          signal: null,
          sessionId,
          terminal: "completed",
          events: [],
          lastMessage: `completed:${options.prompt}`,
          stderr: "",
        }),
        interrupt: async () => undefined,
        detachForRestart: async () => undefined,
      }
    },
  })
  try {
    await adapter.spawn("root", { id: "review-child", role: "reviewer", passKind: "review_shard", prompt: "review" })
    await adapter.waitAgent("review-child")
    await adapter.spawn("root", { id: "worker-child", role: "implementer", prompt: "implement" })
    await adapter.waitAgent("worker-child")
    expect(models).toEqual(["review-leaf", "worker-leaf"])
  } finally {
    await adapter.shutdown()
    rmSync(root, { recursive: true, force: true })
  }
})

test("persists only capture-time redacted explicit child output and diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-redaction-"))
  const resultRoot = join(root, "results")
  const secret = "old-bridge-secret-123"
  const adapter = new ExplicitChildAdapter({
    runId: "run-redaction",
    exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
    resultRoot,
    redactDiagnostic: (value) => value.split(secret).join("[REDACTED]"),
    startExec: () => ({
      pid: process.pid,
      started: Promise.resolve({ sessionId: "thread-redacted" }),
      completed: Promise.resolve({
        exitCode: 1,
        signal: null,
        sessionId: "thread-redacted",
        terminal: "failed",
        events: [],
        lastMessage: `provider returned ${secret}`,
        stderr: `Authorization: Bearer ${secret}`,
      }),
      interrupt: async () => undefined,
      detachForRestart: async () => undefined,
    }),
  })
  try {
    await adapter.spawn("root", { id: "child-1", role: "explorer", prompt: "inspect" })
    const terminal = await adapter.waitAgent("child-1")
    const serialized = readFileSync(join(resultRoot, "child-1.json"), "utf8")
    expect(JSON.stringify(terminal)).not.toContain(secret)
    expect(serialized).not.toContain(secret)
    expect(serialized).toContain("[REDACTED]")

    const restored = new ExplicitChildAdapter({
      runId: "run-redaction",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
      resultRoot,
    })
    expect(JSON.stringify(restored.listAgents())).not.toContain(secret)
    await restored.shutdown()
  } finally {
    await adapter.shutdown()
    rmSync(root, { recursive: true, force: true })
  }
})

test("does not restore public diagnostics from legacy unredacted child artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-legacy-redaction-"))
  const resultRoot = join(root, "results")
  const secret = "old-rotated-bridge-token-123"
  mkdirSync(resultRoot, { recursive: true })
  writeFileSync(join(resultRoot, "legacy.json"), `${JSON.stringify({
    schemaVersion: 2,
    mode: "explicit_child",
    runId: "run-legacy",
    parentRunId: "run-legacy",
    childId: "legacy",
    parentId: "root",
    spawnItemId: "explicit:legacy",
    generation: 1,
    role: "explorer",
    state: "completed",
    sessionId: "thread-legacy",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    sandbox: "read-only",
    tokenScope: "child",
    output: `completed with ${secret}`,
    error: `Bearer ${secret}`,
    attempts: [{
      attempt: 1,
      sessionId: "thread-legacy",
      state: "completed",
      terminal: "completed",
      startedAt: "a",
      completedAt: "b",
      output: `attempt ${secret}`,
      error: `token=${secret}`,
    }],
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`)
  try {
    const adapter = new ExplicitChildAdapter({
      runId: "run-legacy",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
      resultRoot,
    })
    const restored = JSON.stringify(adapter.listAgents())
    expect(restored).not.toContain(secret)
    expect(restored).not.toContain("completed with")
    expect(adapter.listAgents()[0]).toMatchObject({ state: "completed", output: undefined, error: undefined })
    await adapter.shutdown()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("redacts synchronous and started-promise launch failures before persistence and rejection", async () => {
  const secret = "bridge-startup-secret-123"
  for (const scenario of ["sync", "started"] as const) {
    const root = mkdtempSync(join(tmpdir(), `cchp-child-start-${scenario}-`))
    const resultRoot = join(root, "results")
    const adapter = new ExplicitChildAdapter({
      runId: `run-${scenario}`,
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
      resultRoot,
      redactDiagnostic: (value) => value.split(secret).join("[REDACTED]"),
      startExec: () => {
        if (scenario === "sync") throw new Error(`startup ${secret}`)
        return {
          pid: process.pid,
          started: Promise.reject(new Error(`protocol ${secret}`)),
          completed: new Promise(() => {}),
          interrupt: async () => undefined,
          detachForRestart: async () => undefined,
        }
      },
    })
    try {
      await expect(adapter.spawn("root", { id: "child", role: "explorer", prompt: "inspect" }))
        .rejects.toThrow("[REDACTED]")
      const serialized = readFileSync(join(resultRoot, "child.json"), "utf8")
      expect(serialized).not.toContain(secret)
      expect(serialized).toContain("[REDACTED]")
    } finally {
      await adapter.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test("surfaces every explicit child detach failure during restart preparation", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-restart-cleanup-failure-"))
  const resultRoot = join(root, "results")
  const adapter = new ExplicitChildAdapter({
    runId: "run-restart-cleanup-failure",
    exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
    resultRoot,
    startExec: () => ({
      pid: process.pid,
      started: Promise.resolve({ sessionId: "thread-cleanup" }),
      completed: new Promise(() => undefined),
      interrupt: async () => undefined,
      detachForRestart: async () => { throw new Error("detach failed") },
    }),
  })
  try {
    expect(await adapter.spawn("root", { id: "child", role: "explorer", prompt: "wait" })).toMatchObject({ state: "running" })
    await expect(adapter.prepareRestart()).rejects.toThrow("failed to detach for restart")
    expect(JSON.parse(readFileSync(join(resultRoot, "child.running.json"), "utf8"))).toMatchObject({
      state: "running",
      launchState: "checkpointed",
      pid: expect.any(Number),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("persists and restores an ordinary explicit child without review pass metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-ordinary-"))
  const resultRoot = join(root, "results")
  try {
    const first = new ExplicitChildAdapter({
      runId: "run-ordinary",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
      resultRoot,
    })
    const spawned = await first.spawn("root", { id: "child-ordinary", role: "explorer", prompt: "inspect" })
    expect(spawned).not.toHaveProperty("passKind")
    expect(await first.waitAgent("child-ordinary")).toMatchObject({ state: "completed", output: "completed:inspect" })
    expect(JSON.parse(readFileSync(join(resultRoot, "child-ordinary.json"), "utf8"))).not.toHaveProperty("passKind")

    const second = new ExplicitChildAdapter({
      runId: "run-ordinary",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
      resultRoot,
    })
    expect(second.listAgents()[0]).not.toHaveProperty("passKind")
    await second.shutdown()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("keeps review admission fail-closed when passKind is omitted", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-review-pass-"))
  const admissions = new ReviewAdmissionLedger(join(root, "ctx", "review-admission.jsonl"), "run-review-pass")
  admissions.admit({ taskId: "child-1", role: "reviewer", passKind: "correctness", mode: "explicit_child", prompt: "inspect" })
  const adapter = new ExplicitChildAdapter({
    runId: "run-review-pass",
    exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
    resultRoot: join(root, "results"),
    admissionLedger: admissions,
  })
  try {
    await expect(adapter.spawn("root", { id: "child-1", role: "reviewer", prompt: "inspect" }))
      .rejects.toThrow("requires pass kind")
  } finally {
    await adapter.shutdown()
    rmSync(root, { recursive: true, force: true })
  }
})

test("fails closed when Codex completes without a final message", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-empty-result-"))
  const resultRoot = join(root, "results")
  try {
    const adapter = new ExplicitChildAdapter({
      runId: "run-empty-result",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
      resultRoot,
      startExec: () => ({
        pid: process.pid,
        started: Promise.resolve({ sessionId: "thread-empty" }),
        completed: Promise.resolve({
          exitCode: 0,
          signal: null,
          sessionId: "thread-empty",
          terminal: "completed",
          events: [],
          stderr: "",
        }),
        interrupt: async () => undefined,
        detachForRestart: async () => undefined,
      }),
    })
    await adapter.spawn("root", { id: "child-empty", role: "reviewer", passKind: "review_shard", prompt: "inspect" })
    expect(await adapter.waitAgent("child-empty")).toMatchObject({
      state: "failed",
      error: "codex exec completed without a final message",
    })
    expect(JSON.parse(readFileSync(join(resultRoot, "child-empty.json"), "utf8"))).toMatchObject({
      schemaVersion: 3,
      mode: "explicit_child",
      state: "failed",
      error: "codex exec completed without a final message",
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("followup resumes the same session and sendMessage queues the next turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-followup-"))
  const trace = join(root, "trace.jsonl")
  try {
    const adapter = new ExplicitChildAdapter({
      runId: "run-followup",
      exec: {
        codexBin: fakeCodex,
        cwd: root,
        env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_SCENARIO: "slow", FAKE_CODEX_EXEC_TRACE: trace },
      },
      resultRoot: join(root, "results"),
      timeoutMs: 5_000,
    })

    const first = await adapter.spawn("root", { id: "child-1", role: "reviewer", passKind: "review_shard", prompt: "first" })
    expect(first.state).toBe("running")
    await adapter.sendMessage("child-1", "queued")
    const afterQueued = await adapter.waitAgent("child-1")
    expect(afterQueued).toMatchObject({ state: "completed", sessionId: "thread-fixture", output: "completed:queued" })
    expect(afterQueued.attempts.map((attempt) => attempt.output)).toEqual(["completed:first", "completed:queued"])

    const followed = await adapter.followupTask("child-1", "followup")
    expect(followed).toMatchObject({ state: "completed", sessionId: "thread-fixture", output: "completed:followup", generation: 2 })
    expect(followed.attempts.map((attempt) => attempt.output)).toEqual(["completed:first", "completed:queued", "completed:followup"])
    expect(JSON.parse(readFileSync(join(root, "results", "child-1.json"), "utf8"))).toMatchObject({
      spawnItemId: "explicit:child-1",
      generation: 2,
      output: "completed:followup",
    })
    const invocations = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; prompt: string })
    expect(invocations).toHaveLength(3)
    expect(invocations[0]!.argv).toContain("exec")
    expect(invocations[1]!.argv).toEqual(["exec", "--json", "--strict-config", "--profile", "reviewer", "resume", "thread-fixture", "-"])
    expect(invocations[2]!.argv).toEqual(["exec", "--json", "--strict-config", "--profile", "reviewer", "resume", "thread-fixture", "-"])
    expect(invocations.map((invocation) => invocation.prompt.trim())).toEqual(["first", "queued", "followup"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("all waiters share one completion until queued prompts reach terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-stable-completion-"))
  const complete: Array<(result: ExecRunResult) => void> = []
  let attempts = 0
  try {
    const adapter = new ExplicitChildAdapter({
      runId: "run-stable-completion",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
      resultRoot: join(root, "results"),
      timeoutMs: 1_000,
      startExec: () => {
        attempts++
        return {
          pid: process.pid,
          started: Promise.resolve({ sessionId: "thread-stable" }),
          completed: new Promise<ExecRunResult>((resolve) => complete.push(resolve)),
          interrupt: async () => undefined,
          detachForRestart: async () => undefined,
        }
      },
    })

    await adapter.spawn("root", { id: "child-stable", role: "explorer", prompt: "first" })
    await adapter.sendMessage("child-stable", "queued")
    let firstSettled = false
    const firstWaiter = adapter.waitAgent("child-stable").finally(() => { firstSettled = true })
    complete[0]!({
      exitCode: 0,
      signal: null,
      sessionId: "thread-stable",
      terminal: "completed",
      events: [],
      lastMessage: "completed:first",
      stderr: "",
    })
    while (attempts < 2) await Bun.sleep(1)

    let secondSettled = false
    const secondWaiter = adapter.waitAgent("child-stable").finally(() => { secondSettled = true })
    await Bun.sleep(5)
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)

    complete[1]!({
      exitCode: 0,
      signal: null,
      sessionId: "thread-stable",
      terminal: "completed",
      events: [],
      lastMessage: "completed:queued",
      stderr: "",
    })
    expect(await firstWaiter).toMatchObject({ state: "completed", output: "completed:queued" })
    expect(await secondWaiter).toMatchObject({ state: "completed", output: "completed:queued" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("interruptAgent terminates a running child and closeAgent is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-interrupt-"))
  try {
    const adapter = new ExplicitChildAdapter({
      runId: "run-interrupt",
      resultRoot: join(root, "results"),
      timeoutMs: 2_000,
      exec: {
        codexBin: fakeCodex,
        cwd: root,
        env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_SCENARIO: "hang" },
        interruptGraceMs: 20,
        termGraceMs: 20,
        killGraceMs: 500,
      },
    })
    await adapter.spawn("root", { id: "child-1", role: "reviewer", passKind: "review_shard", prompt: "hang" })
    await adapter.interruptAgent("child-1")
    expect(await adapter.waitAgent("child-1")).toMatchObject({ state: "interrupted" })
    await adapter.closeAgent("child-1", "parent cancelled")
    await adapter.closeAgent("child-1", "second close is ignored")
    const result = JSON.parse(readFileSync(join(root, "results", "child-1.json"), "utf8"))
    expect(result).toMatchObject({ state: "interrupted" })
    expect(result.closeReason).toBeUndefined()
    const closeEvents = readFileSync(join(root, "results", "explicit-close.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(closeEvents).toHaveLength(1)
    expect(closeEvents[0]).toMatchObject({
      event: "explicit_child_closed",
      childId: "child-1",
      generation: 1,
      closeReason: "parent cancelled",
    })

    const restored = new ExplicitChildAdapter({
      runId: "run-interrupt",
      resultRoot: join(root, "results"),
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
    })
    expect(restored.listAgents()[0]).toMatchObject({ state: "interrupted", closeReason: "parent cancelled" })
    await expect(restored.followupTask("child-1", "resume")).rejects.toThrow("child child-1 is closed")
    await restored.shutdown()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("rejects duplicate, unknown and invalid-state child operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-state-"))
  try {
    const adapter = new ExplicitChildAdapter({
      runId: "run-state",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
      resultRoot: join(root, "results"),
      timeoutMs: 1_000,
    })
    await adapter.spawn("root", { id: "child-1", role: "reviewer", passKind: "review_shard", prompt: "first" })
    await expect(adapter.spawn("root", { id: "child-1", role: "reviewer", passKind: "review_shard", prompt: "duplicate" })).rejects.toThrow("already exists")
    await expect(adapter.sendMessage("unknown", "message")).rejects.toThrow("unknown child")
    await expect(adapter.followupTask("child-1", "message")).rejects.toThrow("must be terminal")
    await adapter.waitAgent("child-1")
    await expect(adapter.followupTask("child-1", "")).rejects.toThrow("non-empty")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an admitted explicit child binds before completion and publishes an immutable result", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-admitted-"))
  const admissions = new ReviewAdmissionLedger(join(root, "ctx", "review-admission.jsonl"), "run-admitted")
  admissions.admit({ taskId: "child-1", role: "reviewer", passKind: "correctness", mode: "explicit_child", prompt: "inspect" })
  let runningMarkerPresentAtTerminalBinding = false
  const markTerminal = admissions.markTerminal.bind(admissions)
  admissions.markTerminal = (...args: Parameters<ReviewAdmissionLedger["markTerminal"]>) => {
    runningMarkerPresentAtTerminalBinding = existsSync(join(root, "results", "child-1.running.json"))
    return markTerminal(...args)
  }
  try {
    const adapter = new ExplicitChildAdapter({
      runId: "run-admitted",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" }, sandbox: "read-only" },
      resultRoot: join(root, "results"),
      admissionLedger: admissions,
    })
    await adapter.spawn("root", { id: "child-1", role: "reviewer", passKind: "correctness", prompt: "assembled", admissionPrompt: "inspect" })
    const terminal = await adapter.waitAgent("child-1")
    expect(terminal.state).toBe("completed")
    expect(runningMarkerPresentAtTerminalBinding).toBe(true)
    expect(existsSync(join(root, "results", "child-1.running.json"))).toBe(false)
    expect(admissions.task("child-1")).toMatchObject({
      state: "completed",
      spawnItemId: "explicit:child-1",
      childThreadId: "thread-fixture",
      childSessionId: "thread-fixture",
      result: {
        schemaVersion: 1,
        artifactPath: join(root, "results", "child-1.json"),
        artifactSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        outputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("restores a completed result binding without changing its artifact on shutdown or close", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-completed-restart-"))
  const resultRoot = join(root, "results")
  const admissions = new ReviewAdmissionLedger(join(root, "ctx", "review-admission.jsonl"), "run-completed-restart")
  admissions.admit({ taskId: "child-1", role: "reviewer", passKind: "correctness", mode: "explicit_child", prompt: "inspect" })
  try {
    const first = new ExplicitChildAdapter({
      runId: "run-completed-restart",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
      resultRoot,
      admissionLedger: admissions,
    })
    await first.spawn("root", { id: "child-1", role: "reviewer", passKind: "correctness", prompt: "assembled", admissionPrompt: "inspect" })
    await first.waitAgent("child-1")
    const resultPath = join(resultRoot, "child-1.json")
    const original = readFileSync(resultPath, "utf8")
    const binding = admissions.task("child-1")!.result

    const second = new ExplicitChildAdapter({
      runId: "run-completed-restart",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
      resultRoot,
      admissionLedger: admissions,
    })
    expect(second.listAgents()[0]!.result).toEqual(binding)
    expect(second.listAgents()[0]!.attempts).toMatchObject([{ attempt: 1, output: "completed:assembled" }])
    await second.shutdown()
    expect(readFileSync(resultPath, "utf8")).toBe(original)
    await second.closeAgent("child-1", "closed after restart")
    expect(readFileSync(resultPath, "utf8")).toBe(original)
    expect(admissions.task("child-1")!.result).toEqual(binding)

    const third = new ExplicitChildAdapter({
      runId: "run-completed-restart",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
      resultRoot,
      admissionLedger: admissions,
    })
    expect(third.listAgents()[0]).toMatchObject({
      childId: "child-1",
      state: "completed",
      closeReason: "closed after restart",
    })
    await expect(third.followupTask("child-1", "must not resume")).rejects.toThrow("child child-1 is closed")
    expect(readFileSync(resultPath, "utf8")).toBe(original)
    await third.shutdown()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("rejects a restored completed artifact whose admission binding drifted", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-completed-drift-"))
  const resultRoot = join(root, "results")
  const admissions = new ReviewAdmissionLedger(join(root, "ctx", "review-admission.jsonl"), "run-completed-drift")
  admissions.admit({ taskId: "child-1", role: "reviewer", passKind: "correctness", mode: "explicit_child", prompt: "inspect" })
  try {
    const first = new ExplicitChildAdapter({
      runId: "run-completed-drift",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
      resultRoot,
      admissionLedger: admissions,
    })
    await first.spawn("root", { id: "child-1", role: "reviewer", passKind: "correctness", prompt: "assembled", admissionPrompt: "inspect" })
    await first.waitAgent("child-1")
    const resultPath = join(resultRoot, "child-1.json")
    const artifact = JSON.parse(readFileSync(resultPath, "utf8"))
    artifact.updatedAt = new Date(Date.parse(artifact.updatedAt) + 1).toISOString()
    writeFileSync(resultPath, `${JSON.stringify(artifact, null, 2)}\n`)
    expect(() => new ExplicitChildAdapter({
      runId: "run-completed-drift",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
      resultRoot,
      admissionLedger: admissions,
    })).toThrow("terminal result drift")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("run rejects a pre-aborted signal without starting Codex", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-pre-abort-"))
  const trace = join(root, "trace.jsonl")
  try {
    const adapter = new ExplicitChildAdapter({
      runId: "run-pre-abort",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_TRACE: trace } },
      resultRoot: join(root, "results"),
    })
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.run({ task: { id: "child-1", role: "reviewer", passKind: "review_shard", prompt: "ignored" }, prompt: "ignored", signal: controller.signal })).rejects.toThrow("aborted")
    expect(existsSync(trace)).toBe(false)
    expect(adapter.listAgents()).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("run interrupts a child when aborted while spawn awaits thread.started", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-spawn-abort-"))
  let rejectStarted!: (error: unknown) => void
  const started = new Promise<{ sessionId: string }>((_resolve, reject) => { rejectStarted = reject })
  let interruptCalls = 0
  try {
    const adapter = new ExplicitChildAdapter({
      runId: "run-spawn-abort",
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
      resultRoot: join(root, "results"),
      startExec: () => ({
        pid: process.pid,
        started,
        completed: new Promise(() => undefined),
        interrupt: async () => {
          interruptCalls++
          rejectStarted(new Error("interrupt requested before start"))
        },
        detachForRestart: async () => undefined,
      }),
    })
    const controller = new AbortController()
    const running = adapter.run({ task: { id: "child-1", role: "reviewer", passKind: "review_shard", prompt: "inspect" }, prompt: "inspect", signal: controller.signal })
    await Bun.sleep(10)
    controller.abort()
    await expect(running).rejects.toThrow(/aborted|interrupt/)
    expect(interruptCalls).toBe(1)
    expect(adapter.listAgents()[0]).toMatchObject({ state: "interrupted" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("rejects admission role, mode, prompt, terminal, and binding drift before launching Codex", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-admission-drift-"))
  const trace = join(root, "trace.jsonl")
  const admissions = new ReviewAdmissionLedger(join(root, "ctx", "review-admission.jsonl"), "run-drift")
  admissions.admit({ taskId: "child-1", role: "reviewer", passKind: "correctness", mode: "explicit_child", prompt: "inspect" })
  const adapter = new ExplicitChildAdapter({
    runId: "run-drift",
    exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_TRACE: trace } },
    resultRoot: join(root, "results"),
    admissionLedger: admissions,
  })
  try {
    await expect(adapter.spawn("root", { id: "child-1", role: "planner", passKind: "correctness", prompt: "inspect" })).rejects.toThrow("identity drift")
    expect(existsSync(trace)).toBe(false)
  } finally {
    await adapter.shutdown()
    rmSync(root, { recursive: true, force: true })
  }
})

test("recovers a durable running child by resuming its original Codex session", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-restart-"))
  const resultRoot = join(root, "results")
  const trace = join(root, "trace.jsonl")
  const first = new ExplicitChildAdapter({
    runId: "run-restart",
    resultRoot,
    timeoutMs: 5_000,
    exec: {
      codexBin: fakeCodex,
      cwd: root,
      env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_SCENARIO: "hang", FAKE_CODEX_EXEC_TRACE: trace },
      interruptGraceMs: 20,
      termGraceMs: 20,
      killGraceMs: 500,
    },
  })
  try {
    expect(await first.spawn("root", { id: "child-1", role: "reviewer", passKind: "review_shard", prompt: "recover me" })).toMatchObject({ state: "running", sessionId: "thread-fixture" })
    const runningPath = join(resultRoot, "child-1.running.json")
    expect(JSON.parse(readFileSync(runningPath, "utf8"))).toMatchObject({
      mode: "explicit_child",
      kind: "explicit_child_running",
      state: "running",
      sessionId: "thread-fixture",
      activePrompt: "recover me",
      pid: expect.any(Number),
    })
    await first.prepareRestart()
    expect(existsSync(join(resultRoot, "child-1.json"))).toBe(false)

    const second = new ExplicitChildAdapter({
      runId: "run-restart",
      resultRoot,
      timeoutMs: 5_000,
      exec: {
        codexBin: fakeCodex,
        cwd: root,
        env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_TRACE: trace },
      },
    })
    try {
      expect(await second.waitAgent("child-1")).toMatchObject({
        state: "completed",
        sessionId: "thread-fixture",
        output: "completed:recover me",
      })
      expect(existsSync(runningPath)).toBe(false)
      const invocations = readFileSync(trace, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as { argv?: string[]; prompt?: string })
        .filter((entry): entry is { argv: string[]; prompt: string } => Array.isArray(entry.argv) && typeof entry.prompt === "string")
      expect(invocations).toHaveLength(2)
      expect(invocations[1]!.argv).toEqual(["exec", "--json", "--strict-config", "--profile", "reviewer", "resume", "thread-fixture", "-"])
      expect(invocations[1]!.prompt.trim()).toBe("recover me")
    } finally {
      await second.shutdown()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("preserves queued prompts across an explicit child server restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-restart-queue-"))
  const resultRoot = join(root, "results")
  const trace = join(root, "trace.jsonl")
  const first = new ExplicitChildAdapter({
    runId: "run-restart-queue",
    resultRoot,
    timeoutMs: 5_000,
    exec: {
      codexBin: fakeCodex,
      cwd: root,
      env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_SCENARIO: "hang", FAKE_CODEX_EXEC_TRACE: trace },
      interruptGraceMs: 20,
      termGraceMs: 20,
      killGraceMs: 500,
    },
  })
  try {
    await first.spawn("root", { id: "child-1", role: "reviewer", passKind: "review_shard", prompt: "active" })
    await first.sendMessage("child-1", "queued")
    await first.prepareRestart()
    const checkpoint = JSON.parse(readFileSync(join(resultRoot, "child-1.running.json"), "utf8"))
    expect(checkpoint.queuedPrompts).toEqual(["queued"])

    const second = new ExplicitChildAdapter({
      runId: "run-restart-queue",
      resultRoot,
      timeoutMs: 5_000,
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_TRACE: trace } },
    })
    try {
      expect(await second.waitAgent("child-1")).toMatchObject({ state: "completed", output: "completed:queued" })
      const invocations = readFileSync(trace, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as { argv?: string[]; prompt?: string })
        .filter((entry): entry is { argv: string[]; prompt: string } => Array.isArray(entry.argv) && typeof entry.prompt === "string")
      expect(invocations.map((invocation) => invocation.prompt.trim())).toEqual(["active", "active", "queued"])
      expect(invocations.slice(1).every((invocation) => invocation.argv.includes("resume"))).toBe(true)
    } finally {
      await second.shutdown()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("stops an expired checkpointed process before committing timed_out", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-expired-checkpoint-"))
  const resultRoot = join(root, "results")
  const resultPath = join(resultRoot, "child-1.json")
  const runningPath = join(resultRoot, "child-1.running.json")
  const child = Bun.spawn(["sleep", "30"], {
    cwd: root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: process.platform !== "win32",
  })
  try {
    mkdirSync(resultRoot, { recursive: true })
    const identity = processIdentity(child.pid)
    writeFileSync(runningPath, `${JSON.stringify(attachRecordHmac({
      schemaVersion: 5 as const,
      mode: "explicit_child",
      kind: "explicit_child_running",
      runId: "run-expired",
      parentRunId: "run-expired",
      childId: "child-1",
      parentId: "root",
      spawnItemId: "explicit:child-1",
      generation: 1,
      role: "explorer",
      state: "running",
      sessionId: "thread-expired",
      deadlineAt: new Date(Date.now() - 1_000).toISOString(),
      sandbox: "read-only",
      tokenScope: "child",
      resultPath,
      activePrompt: "inspect",
      activeStartedAt: new Date(Date.now() - 2_000).toISOString(),
      queuedPrompts: [],
      attempts: [],
      attempt: 1,
      pid: child.pid,
      processGroupId: child.pid,
      processIdentity: identity,
      launchState: "checkpointed",
      ownerId: "crashed-owner",
      ownerEpoch: 1,
      resumeState: "initial",
      heartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, RECORD_HMAC_KEY), null, 2)}\n`)
    const trace = join(root, "trace.jsonl")
    const adapter = new ExplicitChildAdapter({
      runId: "run-expired",
      resultRoot,
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_TRACE: trace } },
    })
    expect(await adapter.waitAgent("child-1")).toMatchObject({ state: "timed_out" })
    expect(await Promise.race([child.exited.then(() => true), Bun.sleep(1_000).then(() => false)])).toBe(true)
    expect(existsSync(trace)).toBe(false)
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({ state: "timed_out" })
    expect(existsSync(runningPath)).toBe(false)
  } finally {
    if (process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGKILL") } catch { /* already stopped */ }
    } else {
      child.kill("SIGKILL")
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test("rejects a tampered running marker before recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-forged-checkpoint-"))
  const resultRoot = join(root, "results")
  const resultPath = join(resultRoot, "child-1.json")
  const runningPath = join(resultRoot, "child-1.running.json")
  try {
    mkdirSync(resultRoot, { recursive: true })
    const artifact = attachRecordHmac({
      schemaVersion: 5 as const,
      mode: "explicit_child",
      kind: "explicit_child_running",
      runId: "run-forged",
      parentRunId: "run-forged",
      childId: "child-1",
      parentId: "root",
      spawnItemId: "explicit:child-1",
      generation: 1,
      role: "explorer",
      state: "running",
      sessionId: "thread-forged",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      sandbox: "read-only",
      tokenScope: "child",
      resultPath,
      activePrompt: "inspect",
      queuedPrompts: [],
      attempts: [],
      attempt: 1,
      launchState: "idle",
      ownerId: "owner",
      ownerEpoch: 1,
      resumeState: "initial",
      heartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, RECORD_HMAC_KEY)
    artifact.ownerEpoch = 2
    writeFileSync(runningPath, `${JSON.stringify(artifact, null, 2)}\n`)
    expect(() => new ExplicitChildAdapter({
      runId: "run-forged",
      resultRoot,
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "" } },
    })).toThrow("invalid mac")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("marks a nonterminal checkpoint without a durable session as lost", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-restart-lost-"))
  const resultRoot = join(root, "results")
  const resultPath = join(resultRoot, "child-1.json")
  const runningPath = join(resultRoot, "child-1.running.json")
  try {
    mkdirSync(resultRoot, { recursive: true })
    writeFileSync(runningPath, `${JSON.stringify(attachRecordHmac({
      schemaVersion: 5 as const,
      mode: "explicit_child",
      kind: "explicit_child_running",
      runId: "run-lost",
      parentRunId: "run-lost",
      childId: "child-1",
      parentId: "root",
      spawnItemId: "explicit:child-1",
      generation: 1,
      role: "reviewer",
      passKind: "review_shard",
      state: "queued",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      sandbox: "read-only",
      tokenScope: "child",
      resultPath,
      queuedPrompts: [],
      attempts: [],
      attempt: 1,
      launchState: "idle",
      ownerId: "crashed-owner",
      ownerEpoch: 1,
      resumeState: "initial",
      heartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, RECORD_HMAC_KEY), null, 2)}\n`)
    const trace = join(root, "trace.jsonl")
    const adapter = new ExplicitChildAdapter({
      runId: "run-lost",
      resultRoot,
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_TRACE: trace } },
    })
    expect(await adapter.waitAgent("child-1")).toMatchObject({ state: "lost", error: expect.stringContaining("resume point") })
    expect(existsSync(trace)).toBe(false)
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({ state: "lost" })
    expect(existsSync(runningPath)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("treats a recorded launch without durable process identity as unproven ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-child-launch-unproven-"))
  const resultRoot = join(root, "results")
  const resultPath = join(resultRoot, "child-1.json")
  const runningPath = join(resultRoot, "child-1.running.json")
  try {
    mkdirSync(resultRoot, { recursive: true })
    writeFileSync(runningPath, `${JSON.stringify(attachRecordHmac({
      schemaVersion: 5 as const,
      mode: "explicit_child",
      kind: "explicit_child_running",
      runId: "run-launch-unproven",
      parentRunId: "run-launch-unproven",
      childId: "child-1",
      parentId: "root",
      spawnItemId: "explicit:child-1",
      generation: 1,
      role: "explorer",
      state: "running",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      sandbox: "read-only",
      tokenScope: "child",
      resultPath,
      activePrompt: "inspect",
      activeStartedAt: new Date().toISOString(),
      queuedPrompts: [],
      attempts: [],
      attempt: 1,
      launchState: "prepared",
      ownerId: "crashed-owner",
      ownerEpoch: 1,
      resumeState: "initial",
      heartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, RECORD_HMAC_KEY), null, 2)}\n`)
    const trace = join(root, "trace.jsonl")
    const adapter = new ExplicitChildAdapter({
      runId: "run-launch-unproven",
      resultRoot,
      exec: { codexBin: fakeCodex, cwd: root, env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_TRACE: trace } },
    })
    expect(await adapter.waitAgent("child-1")).toMatchObject({
      state: "lost",
      error: "could not prove ownership of the previous explicit child process",
    })
    expect(existsSync(trace)).toBe(false)
    expect(existsSync(runningPath)).toBe(true)
    expect(existsSync(resultPath)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
