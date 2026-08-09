import { expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { CodexAppServer } from "./app-server"
import { resolveRuntimeRecovery } from "./runtime"
import { buildCodexEnvironment, fatalSandboxError, Supervisor } from "./supervisor"
import type { ExplicitChildLifecycle, ExplicitChildSnapshot } from "./explicit-lifecycle"
import { ChildGraph } from "./graph"
import { ProvenanceLedger } from "./provenance"
import { ReviewAdmissionLedger } from "./review-admission"
import { reviewContinuationClientMessageId } from "./run-manifest"

process.env.CCHP_PROCESS_RECORD_HMAC_KEY = "1".repeat(64)

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`)
    await Bun.sleep(10)
  }
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function runProcessResumePhase(phase: "seed" | "resume", workdir: string) {
  const fixture = resolve(import.meta.dir, "../../scripts/fixtures/supervisor-process-resume.ts")
  const child = Bun.spawn([process.execPath, fixture], {
    cwd: resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      SUPERVISOR_FIXTURE_PHASE: phase,
      SUPERVISOR_FIXTURE_WORKDIR: workdir,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { pid: child.pid, exitCode, stdout, stderr }
}

test("classifies deterministic sandbox startup failures without echoing stderr", () => {
  expect(fatalSandboxError("Unable to spawn codex-linux-sandbox because: No viable candidates found in PATH"))
    .toBe("Codex Linux sandbox helper is unavailable")
  expect(fatalSandboxError("fs sandbox helper failed: bwrap exited 1"))
    .toBe("Codex Linux sandbox initialization failed")
  expect(fatalSandboxError("bwrap: Failed to make / slave: Permission denied"))
    .toBe("Codex Linux sandbox initialization failed")
  expect(fatalSandboxError("permission profiles requiring direct runtime enforcement are incompatible with --use-legacy-landlock"))
    .toBe("Codex Linux sandbox initialization failed")
  expect(fatalSandboxError("thread 'main' panicked at linux-sandbox/src/linux_run_main.rs:318:9"))
    .toBe("Codex Linux sandbox initialization failed")
  expect(fatalSandboxError("plugin lookup: No viable candidates found in PATH; continuing"))
    .toBeUndefined()
  expect(fatalSandboxError("ordinary command failed")).toBeUndefined()
})

test("builds an explicit Codex environment without caller provider or App credentials", () => {
  const env = buildCodexEnvironment({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    CODEX_HOME: "/tmp/codex",
    BOT_REPO: "CCH-HQ/fixture",
    BOT_TASK: "manual",
    GH_TOKEN: "github-token",
    CCHP_GH_TOKEN_FILE: "/tmp/token",
    CCHP_CODEX_BRIDGE_TOKEN: "loopback-token",
    SEE_API_KEY: "see-token",
    HEROUI_AUTH_TOKEN: "heroui-token",
    CCHP_BOT_PROVIDER_KEYS: '{"gpt-cchp":"provider-token"}',
    CCHP_BOT_PROVIDERS: '{"gpt-cchp":{"headers":{"Authorization":"upstream-token"}}}',
    CCHP_PK_GPT_CCHP: "provider-token",
    CCHP_APP_CLIENT_ID: "client-id",
    CCHP_APP_PRIVATE_KEY: "private-key",
    UNRELATED_SECRET: "unrelated",
  })

  expect(env).toMatchObject({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    CODEX_HOME: "/tmp/codex",
    BOT_REPO: "CCH-HQ/fixture",
    BOT_TASK: "manual",
    CCHP_CODEX_BRIDGE_TOKEN: "loopback-token",
  })
  for (const forbidden of [
    "CCHP_BOT_PROVIDER_KEYS",
    "CCHP_BOT_PROVIDERS",
    "CCHP_PK_GPT_CCHP",
    "CCHP_APP_CLIENT_ID",
    "CCHP_APP_PRIVATE_KEY",
    "GH_TOKEN",
    "CCHP_GH_TOKEN_FILE",
    "SEE_API_KEY",
    "HEROUI_AUTH_TOKEN",
    "UNRELATED_SECRET",
  ]) expect(env).not.toHaveProperty(forbidden)
})

test("uses a run-scoped shell home instead of loading runner profiles", () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-codex-shell-home-"))
  const env = buildCodexEnvironment({
    HOME: "/home/runner",
    BOT_WORKDIR: workdir,
    BOT_REPO: "CCH-HQ/fixture",
  })
  expect(env.HOME).toBe(join(workdir, "codex-shell-home"))
  expect(statSync(env.HOME!).mode & 0o777).toBe(0o700)
})

test("persists a successful app-server root lifecycle and runs finalizer once", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-"))
  let supervisor!: Supervisor
  let finalized = 0
  let threadStartParams: Record<string, unknown> | undefined
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/start") {
        threadStartParams = params
        return { thread: { id: "root" } }
      }
      if (method === "turn/start") {
        queueMicrotask(async () => {
          await supervisor.handleNotification({
            method: "item/completed",
            params: { threadId: "root", item: { id: "message", type: "agentMessage", text: "Inspection complete." } },
          })
          await supervisor.handleNotification({
            method: "turn/completed",
            params: { threadId: "root", turn: { id: "turn", status: "completed" } },
          })
        })
        return { turn: { id: "turn" } }
      }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "manual",
    runId: "run-1",
    prompt: "status",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    totalTokenBudget: 1000,
    executionMode: "native_v2",
    finalizer: (context) => {
      finalized++
      return { valid: true, run_id: context.runId, idempotency_key: context.idempotencyKey, provenance_sha256: context.preterminalProvenanceSha256 }
    },
    deadlines: { wholeRunMs: 10_000, heartbeatMs: 10, noProgressWarningMs: 2_000, noProgressTerminalMs: 8_000 },
  })
  const result = await supervisor.run()
  expect(result).toMatchObject({
    state: "SUCCEEDED",
    exitCode: 0,
    rootThreadId: "root",
    rootTurnId: "turn",
    finalMessage: "Inspection complete.",
    runtime: { codexVersion: "unknown", executionMode: "native_v2" },
    usage: { reservedTokens: 0, responsesInFlight: 0 },
  })
  expect(threadStartParams).toMatchObject({ experimentalRawEvents: true })
  expect(finalized).toBe(1)
  expect(supervisor.currentState).toBe("SUCCEEDED")
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8"))).toMatchObject({
    schemaVersion: 1,
    runId: "run-1",
    state: "SUCCEEDED",
    provenance: { entries: expect.any(Number), headSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    finalizerAttestation: { valid: true, run_id: "run-1", idempotency_key: expect.any(String) },
    finalizerIdempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
  })
})

test("drains an in-flight heartbeat before publishing the final summary", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-heartbeat-drain-"))
  let supervisor!: Supervisor
  let releaseHeartbeat!: () => void
  let heartbeatStarted!: () => void
  const heartbeatGate = new Promise<void>((resolve) => { releaseHeartbeat = resolve })
  const heartbeatObserved = new Promise<void>((resolve) => { heartbeatStarted = resolve })
  let publications = 0
  let finalized = 0
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "manual",
    runId: "run-heartbeat-drain",
    prompt: "status",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    totalTokenBudget: 1_000,
    publishProgress: async () => {
      publications++
      heartbeatStarted()
      await heartbeatGate
    },
    finalizer: (context) => {
      finalized++
      return { valid: true, run_id: context.runId, idempotency_key: context.idempotencyKey, provenance_sha256: context.preterminalProvenanceSha256 }
    },
    deadlines: { wholeRunMs: 10_000, heartbeatMs: 5, noProgressWarningMs: 2_000, noProgressTerminalMs: 8_000 },
  })

  const run = supervisor.run()
  await heartbeatObserved
  const completion = supervisor.handleNotification({
    method: "turn/completed",
    params: { threadId: "root", turn: { id: "turn", status: "completed" } },
  })
  await Bun.sleep(20)
  expect(finalized).toBe(0)
  releaseHeartbeat()
  await completion
  expect(await run).toMatchObject({ state: "SUCCEEDED", exitCode: 0 })
  expect(finalized).toBe(1)
  const publicationCount = publications
  await Bun.sleep(20)
  expect(publications).toBe(publicationCount)
})

test("bounds a stalled progress publication and still enforces the semantic deadline", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-heartbeat-timeout-"))
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  let aborted = 0
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "manual",
    runId: "run-heartbeat-timeout",
    prompt: "status",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    totalTokenBudget: 1_000,
    publishProgress: async (_body, signal) => await new Promise<void>((resolve) => {
      signal?.addEventListener("abort", () => { aborted++; resolve() }, { once: true })
    }),
    deadlines: {
      wholeRunMs: 1_000,
      heartbeatMs: 5,
      progressPublishMs: 10,
      noProgressWarningMs: 1,
      noProgressTerminalMs: 25,
    },
  })
  const started = Date.now()
  expect(await supervisor.run()).toMatchObject({ state: "NO_PROGRESS_TIMEOUT", exitCode: 124 })
  expect(Date.now() - started).toBeLessThan(300)
  expect(aborted).toBeGreaterThan(0)
  expect(readJsonl(join(workdir, "ctx", "codex", "supervisor.jsonl")).some((row) =>
    row.event === "progress_publish_timeout",
  )).toBe(true)
})

test("freezes durable state after terminal settlement despite late runtime callbacks", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-terminal-freeze-"))
  let supervisor!: Supervisor
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") {
        queueMicrotask(() => void supervisor.handleNotification({
          method: "turn/completed",
          params: { threadId: "root", turn: { id: "turn", status: "completed" } },
        }))
        return { turn: { id: "turn" } }
      }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "manual",
    runId: "run-terminal-freeze",
    prompt: "status",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    totalTokenBudget: 1_000,
    deadlines: { wholeRunMs: 10_000, heartbeatMs: 10, noProgressWarningMs: 2_000, noProgressTerminalMs: 8_000 },
  })
  expect(await supervisor.run()).toMatchObject({ state: "SUCCEEDED", exitCode: 0 })

  const artifactPaths = [
    "supervisor.jsonl",
    "provenance.jsonl",
    "usage.jsonl",
    "run-manifest.json",
    "terminal.json",
    "events-unknown.jsonl",
  ].map((name) => join(workdir, "ctx", "codex", name))
  const before = artifactPaths.map((path) => existsSync(path) ? readFileSync(path, "utf8") : undefined)

  expect(await supervisor.recordProviderUsage({
    providerId: "provider",
    model: "model",
    responseId: "late-provider",
    threadId: "root",
    turnId: "turn",
    inputTokens: 8,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 3,
    reasoningOutputTokens: 0,
    totalTokens: 11,
  })).toMatchObject({ acceptedRaw: false, consumed: 0 })
  await supervisor.releaseProviderReservation({
    reservationId: "late-reservation",
    writerId: "late-writer",
    writerGeneration: 1,
    requestId: "late-request",
  }, "late_cleanup")
  await supervisor.handleNotification({
    method: "rawResponse/completed",
    params: {
      threadId: "root",
      turnId: "turn",
      responseId: "late-raw",
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    },
  })
  await supervisor.handleNotification({ method: "turn/started", params: { threadId: "root", turn: { id: "late-turn" } } })
  await supervisor.handleAppServerExit({ expected: false, reason: "process_exit", exitCode: 23, signalCode: null })

  for (const [index, path] of artifactPaths.entries()) {
    expect(existsSync(path) ? readFileSync(path, "utf8") : undefined).toBe(before[index])
  }
  expect(supervisor.currentState).toBe("SUCCEEDED")
  expect(readJsonl(join(workdir, "ctx", "codex", "supervisor.jsonl")).filter((row) => row.event === "terminal")).toHaveLength(1)
})

test("sends the direct workspace-write sandbox override", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-permissions-"))
  let supervisor!: Supervisor
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") {
        queueMicrotask(() => void supervisor.handleNotification({
          method: "turn/completed",
          params: { threadId: "root", turn: { id: "turn", status: "completed" } },
        }))
        return { turn: { id: "turn" } }
      }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "manual",
    runId: "run-permissions",
    prompt: "status",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    totalTokenBudget: 1_000,
    sandboxMode: "workspace-write",
  })

  expect(await supervisor.run()).toMatchObject({ state: "SUCCEEDED" })
  expect(requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
    sandbox: "workspace-write",
  })
  expect(requests.find((request) => request.method === "thread/start")?.params).not.toHaveProperty("permissions")
})

test("redacts terminal reasons before durable persistence", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-redaction-"))
  const supervisor = new Supervisor({
    appServer: {
      start: async () => { throw new Error("authorization=Bearer runtime-secret") },
      stop: async () => 0,
    } as unknown as CodexAppServer,
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "manual",
    runId: "run-redaction",
    prompt: "status",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    totalTokenBudget: 1_000,
    redactDiagnostic: (value) => value.replace("runtime-secret", "[REDACTED]"),
  })

  expect(await supervisor.run()).toMatchObject({ state: "FAILED", terminalReason: "authorization=Bearer [REDACTED]" })
  const terminal = readFileSync(join(workdir, "ctx", "codex", "terminal.json"), "utf8")
  expect(terminal).toContain("[REDACTED]")
  expect(terminal).not.toContain("runtime-secret")
})

test("treats cancelled and object-form failed root completions as terminal failures", async () => {
  for (const [name, status, expected] of [
    ["cancelled", "cancelled", { state: "CANCELLED", exitCode: 130 }],
    ["object-failed", { type: "failed" }, { state: "FAILED", exitCode: 1 }],
  ] as const) {
    const workdir = mkdtempSync(join(tmpdir(), `cchp-supervisor-${name}-`))
    let supervisor!: Supervisor
    let finalized = 0
    const fake = {
      start: async () => ({ userAgent: "fake" }),
      request: async (method: string) => {
        if (method === "thread/start") return { thread: { id: "root" } }
        if (method === "turn/start") {
          queueMicrotask(() => void supervisor.handleNotification({
            method: "turn/completed",
            params: { threadId: "root", turn: { id: "turn", status } },
          }))
          return { turn: { id: "turn" } }
        }
        return {}
      },
      stop: async () => 0,
    } as unknown as CodexAppServer
    supervisor = new Supervisor({
      appServer: fake,
      codexHome: join(workdir, "codex-home"),
      repoDir: workdir,
      workdir,
      task: "manual",
      runId: `run-${name}`,
      prompt: "status",
      model: "gpt-5.6-sol",
      modelProvider: "cchp",
      totalTokenBudget: 1000,
      finalizer: () => {
        finalized++
        return { valid: true }
      },
      deadlines: { wholeRunMs: 10_000, heartbeatMs: 10, noProgressWarningMs: 2_000, noProgressTerminalMs: 8_000 },
    })

    expect(await supervisor.run()).toMatchObject(expected)
    expect(finalized).toBe(0)
  }
})

test("ignores an unexpected app-server exit during FINALIZING and commits one consistent success", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-finalizing-exit-"))
  let supervisor!: Supervisor
  let releaseFinalizer!: () => void
  let enteredFinalizer!: () => void
  let finalizers = 0
  const finalizerGate = new Promise<void>((resolve) => { releaseFinalizer = resolve })
  const finalizerEntered = new Promise<void>((resolve) => { enteredFinalizer = resolve })
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") {
        queueMicrotask(() => void supervisor.handleNotification({
          method: "turn/completed",
          params: { threadId: "root", turn: { id: "turn", status: "completed" } },
        }))
        return { turn: { id: "turn" } }
      }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-finalizing-exit", prompt: "status",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 1000,
    finalizer: async (context) => {
      finalizers++
      enteredFinalizer()
      await finalizerGate
      return { valid: true, run_id: context.runId, idempotency_key: context.idempotencyKey, provenance_sha256: context.preterminalProvenanceSha256 }
    },
  })

  const running = supervisor.run()
  await finalizerEntered
  expect(supervisor.currentState).toBe("FINALIZING")
  const repeatedRun = supervisor.run()
  await supervisor.handleAppServerExit({
    expected: false,
    reason: "process_exit",
    exitCode: 1,
    signalCode: null,
  })
  releaseFinalizer()
  const results = await Promise.race([
    Promise.all([running, repeatedRun]),
    Bun.sleep(200).then(() => "timed-out" as const),
  ])
  expect(results).not.toBe("timed-out")
  expect(results).toEqual([
    expect.objectContaining({ state: "SUCCEEDED", exitCode: 0 }),
    expect.objectContaining({ state: "SUCCEEDED", exitCode: 0 }),
  ])
  expect(finalizers).toBe(1)
  expect(supervisor.currentState).toBe("SUCCEEDED")
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "terminal.json"), "utf8"))).toMatchObject({ state: "SUCCEEDED", exitCode: 0 })
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8"))).toMatchObject({ state: "SUCCEEDED" })
  expect(readJsonl(join(workdir, "ctx", "codex", "supervisor.jsonl")).filter((row) => row.event === "terminal")).toHaveLength(1)
})

test("preserves a whole-run timeout that begins while the external finalizer is still running", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-finalizer-timeout-"))
  let supervisor!: Supervisor
  let releaseFinalizer!: () => void
  let enteredFinalizer!: () => void
  const finalizerGate = new Promise<void>((resolve) => { releaseFinalizer = resolve })
  const finalizerEntered = new Promise<void>((resolve) => { enteredFinalizer = resolve })
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") {
        queueMicrotask(() => void supervisor.handleNotification({
          method: "turn/completed",
          params: { threadId: "root", turn: { id: "turn", status: "completed" } },
        }))
        return { turn: { id: "turn" } }
      }
      if (method === "turn/interrupt") return {}
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-finalizer-timeout", prompt: "status",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 1000,
    finalizer: async (context) => {
      enteredFinalizer()
      await finalizerGate
      return { valid: true, run_id: context.runId, idempotency_key: context.idempotencyKey, provenance_sha256: context.preterminalProvenanceSha256 }
    },
    deadlines: {
      wholeRunMs: 40,
      interruptGraceMs: 150,
      heartbeatMs: 100,
      reconcileMs: 5,
      noProgressWarningMs: 1_000,
      noProgressTerminalMs: 2_000,
      parentResumeMs: 500,
    },
  })

  const running = supervisor.run()
  await finalizerEntered
  await eventually(() => supervisor.currentState === "TIMED_OUT")
  releaseFinalizer()
  expect(await running).toMatchObject({ state: "TIMED_OUT", exitCode: 124, terminalReason: "whole run deadline exceeded" })
  expect(supervisor.currentState).toBe("TIMED_OUT")
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "terminal.json"), "utf8"))).toMatchObject({
    state: "TIMED_OUT",
    exitCode: 124,
  })
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8"))).toMatchObject({ state: "TIMED_OUT" })
})

test("drains provider usage observers before committing a successful terminal state", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-usage-drain-"))
  let supervisor!: Supervisor
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let drains = 0
  let finalized = 0
  let starts = 0
  const fake = {
    start: async () => {
      starts++
      if (starts > 1) throw new Error("restart must not occur after root completion")
      return { userAgent: "fake" }
    },
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") {
        queueMicrotask(() => void supervisor.handleNotification({
          method: "turn/completed",
          params: { threadId: "root", turn: { id: "turn", status: "completed" } },
        }))
        return { turn: { id: "turn" } }
      }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "manual",
    runId: "run-usage-drain",
    prompt: "status",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    totalTokenBudget: 1000,
    sealProviderAndDrain: async () => { drains++; await gate },
    finalizer: (context) => {
      finalized++
      return { valid: true, run_id: context.runId, idempotency_key: context.idempotencyKey, provenance_sha256: context.preterminalProvenanceSha256 }
    },
    deadlines: { wholeRunMs: 2000, heartbeatMs: 100, reconcileMs: 1, parentResumeMs: 500 },
  })
  let completed = false
  const running = supervisor.run().then((result) => {
    completed = true
    return result
  })
  await Bun.sleep(20)
  expect(completed).toBe(false)
  expect(finalized).toBe(0)
  const drainsBeforeRelease = drains
  await supervisor.handleAppServerExit({
    expected: false,
    reason: "process_exit",
    exitCode: 1,
    signalCode: null,
  })
  release()
  expect(await running).toMatchObject({ state: "SUCCEEDED", exitCode: 0 })
  expect(drainsBeforeRelease).toBe(1)
  expect(drains).toBe(1)
  expect(finalized).toBe(1)
  expect(starts).toBe(1)
})

test("rechecks pending usage after the external finalizer and rejects late provider admission", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-finalizer-usage-"))
  let supervisor!: Supervisor
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const finalizerEntered = new Promise<void>((resolve) => { entered = resolve })
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") {
        queueMicrotask(() => void supervisor.handleNotification({
          method: "turn/completed",
          params: { threadId: "root", turn: { id: "turn", status: "completed" } },
        }))
        return { turn: { id: "turn" } }
      }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-finalizer-usage", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000_000,
    executionMode: "native_v2",
    sealProviderAndDrain: async () => {},
    finalizer: async (context) => {
      entered()
      await gate
      return { valid: true, run_id: context.runId, idempotency_key: context.idempotencyKey, provenance_sha256: context.preterminalProvenanceSha256 }
    },
    deadlines: { wholeRunMs: 2_000, heartbeatMs: 100, reconcileMs: 1, parentResumeMs: 500 },
  })
  const running = supervisor.run()
  await finalizerEntered
  expect(await supervisor.authorizeProviderRequest({ providerId: "p", model: "m" })).toMatchObject({
    allowed: false,
    reason: "provider admission is sealed for finalization",
  })
  await supervisor.recordProviderUsage({
    providerId: "p",
    model: "m",
    responseId: "late-response",
    inputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: 2,
  })
  release()
  expect(await running).toMatchObject({
    state: "FAILED",
    terminalReason: "raw response attribution missing for 1 provider completion(s)",
  })
})

test("fails closed when native child admission races the provider finalization barrier", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-late-native-child-"))
  let supervisor!: Supervisor
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const drainEntered = new Promise<void>((resolve) => { entered = resolve })
  let finalized = 0
  let publications = 0
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      if (method === "thread/read" && params?.threadId === "child-late") {
        return { thread: { id: "child-late", turns: [{ id: "child-turn", status: "running" }] } }
      }
      if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "turn", status: "completed" }] } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake, codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-late-native-child", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1000, executionMode: "native_v2",
    publishProgress: async () => { publications++ },
    sealProviderAndDrain: async () => { entered(); await gate },
    finalizer: (context) => {
      finalized++
      return { valid: true, run_id: context.runId, idempotency_key: context.idempotencyKey, provenance_sha256: context.preterminalProvenanceSha256 }
    },
    deadlines: { wholeRunMs: 2000, heartbeatMs: 5, reconcileMs: 10, parentResumeMs: 1000 },
  })
  const running = supervisor.run()
  await Bun.sleep(5)
  const rootCompletion = supervisor.handleNotification({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "completed" } } })
  await drainEntered
  await supervisor.handleNotification({ method: "item/completed", params: {
    threadId: "root",
    item: {
      id: "spawn-late",
      type: "collabAgentToolCall",
      tool: "spawn_agent",
      senderThreadId: "root",
      receiverThreadIds: ["child-late"],
      agentsStates: { "child-late": { status: "running" } },
    },
  } })
  release()
  await rootCompletion
  expect(await running).toMatchObject({
    state: "FAILED",
    exitCode: 1,
    terminalReason: "collaboration arrived after finalization admission fence",
  })
  expect(finalized).toBe(0)
  expect(publications).toBe(0)
})

test("writes the same 124 timeout result to memory, terminal artifact, and manifest", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-timeout-"))
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-timeout", prompt: "wait", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1000,
    deadlines: { wholeRunMs: 30, heartbeatMs: 1000, reconcileMs: 1000, noProgressWarningMs: 1000, noProgressTerminalMs: 2000 },
  })
  const result = await supervisor.run()
  expect(result).toMatchObject({ state: "TIMED_OUT", exitCode: 124 })
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "terminal.json"), "utf8"))).toMatchObject({
    state: "TIMED_OUT",
    exitCode: 124,
  })
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8"))).toMatchObject({
    state: "TIMED_OUT",
    terminalReason: "whole run deadline exceeded",
  })
})

test("returns the authoritative timeout when app-server startup rejects after the deadline", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-timeout-race-"))
  const fake = {
    start: async () => {
      await Bun.sleep(30)
      throw new Error("late startup failure")
    },
    request: async () => ({}),
    stop: async () => 0,
  } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-timeout-race", prompt: "wait", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1000,
    deadlines: { wholeRunMs: 10, heartbeatMs: 1000, reconcileMs: 1000 },
  })

  expect(await supervisor.run()).toMatchObject({ state: "TIMED_OUT", exitCode: 124, terminalReason: "whole run deadline exceeded" })
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "terminal.json"), "utf8"))).toMatchObject({ state: "TIMED_OUT", exitCode: 124 })
})

test("applies the whole-run deadline before resuming FINALIZING", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-finalizing-expired-"))
  const startedAt = new Date(Date.now() - 2_000).toISOString()
  let finalizers = 0
  let starts = 0
  const fake = {
    start: async () => { starts++; return {} },
    request: async () => ({}),
    stop: async () => 0,
  } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-finalizing-expired", prompt: "wait", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1000,
    resume: {
      state: "FINALIZING",
      rootThreadId: "root",
      rootTurnId: "turn",
      restartAttempts: 0,
      startedAt,
      wholeRunDeadlineAt: new Date(Date.now() - 1_000).toISOString(),
      lastSemanticProgressAt: startedAt,
      drainDeadlineAt: new Date(Date.now() - 500).toISOString(),
      finalizationInputProvenanceSha256: "a".repeat(64),
      finalizationPhase: "prepared",
    },
    finalizer: () => { finalizers++; return undefined },
  })

  expect(await supervisor.run()).toMatchObject({ state: "TIMED_OUT", exitCode: 124 })
  expect(finalizers).toBe(0)
  expect(starts).toBe(0)
})

test("reuses one finalizer idempotency key across crash-resume instances", async () => {
  const firstWorkdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-finalizer-key-first-"))
  const secondWorkdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-finalizer-key-second-"))
  const firstCodexDir = join(firstWorkdir, "ctx", "codex")
  const secondCodexDir = join(secondWorkdir, "ctx", "codex")
  mkdirSync(firstCodexDir, { recursive: true })
  mkdirSync(secondCodexDir, { recursive: true })
  const seed = new ProvenanceLedger(join(firstCodexDir, "provenance.jsonl"), "run-finalizer-key")
  seed.record("seed", { stable: true })
  const provenanceHead = seed.head!
  copyFileSync(join(firstCodexDir, "provenance.jsonl"), join(secondCodexDir, "provenance.jsonl"))
  const keys: string[] = []
  const resume = {
    state: "FINALIZING" as const,
    rootThreadId: "root",
    rootTurnId: "turn",
    restartAttempts: 0,
    startedAt: new Date(Date.now() - 100).toISOString(),
    wholeRunDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
    lastSemanticProgressAt: new Date().toISOString(),
    drainDeadlineAt: new Date(Date.now() + 1_000).toISOString(),
    finalizationInputProvenanceSha256: provenanceHead,
    finalizationPhase: "prepared" as const,
  }
  const fake = { start: async () => ({}), request: async () => ({}), stop: async () => 0 } as unknown as CodexAppServer
  for (const workdir of [firstWorkdir, secondWorkdir]) {
    const supervisor = new Supervisor({
      appServer: fake,
      codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
      task: "manual", runId: "run-finalizer-key", prompt: "wait", model: "gpt-5.6-sol", modelProvider: "cchp",
      totalTokenBudget: 1000,
      resume,
      finalizer: (context) => {
        keys.push(context.idempotencyKey)
        return {
          valid: true,
          run_id: context.runId,
          idempotency_key: context.idempotencyKey,
          provenance_sha256: context.preterminalProvenanceSha256,
        }
      },
    })
    expect(await supervisor.run()).toMatchObject({ state: "SUCCEEDED" })
  }
  expect(keys).toHaveLength(2)
  expect(keys[0]).toBe(keys[1])
})

test("ignores a replayed completion from another turn on the owned root thread", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-stale-turn-"))
  let supervisor!: Supervisor
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") {
        queueMicrotask(() => void supervisor.handleNotification({
          method: "turn/completed",
          params: { threadId: "root", turn: { id: "old-turn", status: "completed" } },
        }))
        setTimeout(() => void supervisor.handleNotification({
          method: "turn/completed",
          params: { threadId: "root", turn: { id: "owned-turn", status: "completed" } },
        }), 20)
        return { turn: { id: "owned-turn" } }
      }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-stale-turn", prompt: "wait", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1000,
    deadlines: { wholeRunMs: 1000, heartbeatMs: 100, reconcileMs: 1000, noProgressWarningMs: 500, noProgressTerminalMs: 900 },
  })
  expect(await supervisor.run()).toMatchObject({ state: "SUCCEEDED", rootTurnId: "owned-turn" })
  expect(readJsonl(join(workdir, "ctx", "codex", "supervisor.jsonl"))).toContainEqual(expect.objectContaining({
    event: "stale_root_turn_completion",
    receivedTurnId: "old-turn",
    rootTurnId: "owned-turn",
  }))
})

test("restores the original root drain deadline instead of losing an active child immediately", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-drain-resume-"))
  const codexDir = join(workdir, "ctx", "codex")
  const { mkdirSync } = await import("node:fs")
  mkdirSync(codexDir, { recursive: true })
  const { ChildGraph } = await import("./graph")
  const graph = new ChildGraph(join(codexDir, "graph.jsonl"))
  graph.open("root", "child", "spawn-child")
  let childCompleted = false
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/resume") return { thread: { id: params?.threadId } }
      if (method === "thread/read" && params?.threadId === "child") {
        return { thread: { id: "child", parentThreadId: "root", turns: [{ id: "child-turn", status: childCompleted ? "completed" : "inProgress" }] } }
      }
      if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "turn", status: "completed" }] } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  const startedAt = new Date(Date.now() - 1000).toISOString()
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-drain-resume", prompt: "wait", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1000,
    resume: {
      state: "ROOT_DRAINING",
      rootThreadId: "root",
      rootTurnId: "turn",
      restartAttempts: 0,
      startedAt,
      wholeRunDeadlineAt: new Date(Date.now() + 1000).toISOString(),
      lastSemanticProgressAt: startedAt,
      drainDeadlineAt: new Date(Date.now() + 300).toISOString(),
    },
    deadlines: { wholeRunMs: 1000, heartbeatMs: 100, reconcileMs: 10, parentResumeMs: 300, noProgressWarningMs: 500, noProgressTerminalMs: 900 },
  })
  const running = supervisor.run()
  await Bun.sleep(50)
  expect(supervisor.currentState).toBe("ROOT_DRAINING")
  childCompleted = true
  expect(await running).toMatchObject({ state: "SUCCEEDED", exitCode: 0 })
})

test("fails when finalizer attestation is missing or drifts from the current run", async () => {
  const cases: Array<[string, (context: { runId: string; preterminalProvenanceSha256: string }) => unknown]> = [
    ["missing", () => undefined],
    ["run drift", (context) => ({ valid: true, run_id: `${context.runId}-other`, provenance_sha256: context.preterminalProvenanceSha256 })],
    ["provenance drift", (context) => ({ valid: true, run_id: context.runId, provenance_sha256: "f".repeat(64) })],
  ]
  for (const [name, finalizer] of cases) {
    const workdir = mkdtempSync(join(tmpdir(), `cchp-supervisor-finalizer-${name.replaceAll(" ", "-")}-`))
    let supervisor!: Supervisor
    const fake = {
      start: async () => ({ userAgent: "fake" }),
      request: async (method: string) => {
        if (method === "thread/start") return { thread: { id: "root" } }
        if (method === "turn/start") {
          queueMicrotask(() => void supervisor.handleNotification({
            method: "turn/completed",
            params: { threadId: "root", turn: { id: "turn", status: "completed" } },
          }))
          return { turn: { id: "turn" } }
        }
        return {}
      },
      stop: async () => 0,
    } as unknown as CodexAppServer
    supervisor = new Supervisor({
      appServer: fake,
      codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
      task: "pr_opened", runId: `run-${name}`, prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
      totalTokenBudget: 1000,
      finalizer,
      deadlines: { wholeRunMs: 5000, heartbeatMs: 100, noProgressWarningMs: 1000, noProgressTerminalMs: 4000 },
    })
    expect(await supervisor.run()).toMatchObject({ state: "FAILED", exitCode: 1 })
  }
})

test("allows metadata-only pr_opened completion without review admissions or a review finalizer", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-metadata-only-review-"))
  let supervisor!: Supervisor
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") {
        queueMicrotask(() => void supervisor.handleNotification({
          method: "turn/completed",
          params: { threadId: "root", turn: { id: "turn", status: "completed" } },
        }))
        return { turn: { id: "turn" } }
      }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "pr_opened", runId: "run-metadata-only", prompt: "metadata-only",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 1_000,
    executionMode: "explicit_child",
    reviewRequired: false,
    deadlines: { wholeRunMs: 5_000, heartbeatMs: 100, noProgressWarningMs: 1_000, noProgressTerminalMs: 4_000 },
  })

  expect(await supervisor.run()).toMatchObject({ state: "SUCCEEDED", exitCode: 0 })
  expect(existsSync(join(workdir, "ctx", "codex", "review-admission.jsonl"))).toBeFalse()
})

test("runs one durable same-thread continuation before failing a full review with zero admissions", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-full-review-required-"))
  let supervisor!: Supervisor
  const turnStarts: Array<Record<string, unknown>> = []
  let continuationCompleted = false
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") {
        turnStarts.push(params ?? {})
        const turnId = turnStarts.length === 1 ? "initial-turn" : "continuation-turn"
        if (turnStarts.length === 2) {
          expect(params?.threadId).toBe("root")
          expect(params?.clientUserMessageId).toMatch(/^cchp-review-continuation-[0-9a-f]{64}$/)
          expect(JSON.stringify(params?.input)).toContain("Do not fabricate")
          setTimeout(() => void supervisor.handleNotification({
            method: "turn/completed",
            params: { threadId: "root", turn: { id: "initial-turn", status: "completed" } },
          }), 0)
          setTimeout(() => {
            continuationCompleted = true
            void supervisor.handleNotification({
              method: "turn/completed",
              params: { threadId: "root", turn: { id: turnId, status: "completed" } },
            })
          }, 5)
        } else {
          queueMicrotask(() => void supervisor.handleNotification({
            method: "turn/completed",
            params: { threadId: "root", turn: { id: turnId, status: "completed" } },
          }))
        }
        return { turn: { id: turnId } }
      }
      if (method === "thread/read") return { thread: { id: "root", turns: [
        { id: "initial-turn", status: "completed", items: [] },
        ...(continuationCompleted ? [{
          id: "continuation-turn",
          status: "completed",
          items: [{ type: "userMessage", clientId: turnStarts[1]?.clientUserMessageId }],
        }] : []),
      ] } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "pr_opened", runId: "run-full-review", prompt: "review",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 1_000,
    executionMode: "explicit_child",
    reviewRequired: true,
    deadlines: { wholeRunMs: 5_000, heartbeatMs: 100, reconcileMs: 10, noProgressWarningMs: 1_000, noProgressTerminalMs: 4_000 },
  })

  expect(await supervisor.run()).toMatchObject({
    state: "FAILED",
    exitCode: 1,
    terminalReason: "review finalization requires at least one admitted child task",
  })
  expect(turnStarts).toHaveLength(2)
  expect(turnStarts[0]?.threadId).toBe("root")
  expect(turnStarts[1]?.threadId).toBe("root")
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8"))).toMatchObject({
    state: "FAILED",
    rootTurnId: "continuation-turn",
    reviewContinuation: {
      phase: "completed",
      initialTurnId: "initial-turn",
      continuationTurnId: "continuation-turn",
    },
  })
  expect(readJsonl(join(workdir, "ctx", "codex", "supervisor.jsonl"))).toContainEqual(expect.objectContaining({
    event: "stale_root_turn_completion",
    receivedTurnId: "initial-turn",
    rootTurnId: "continuation-turn",
  }))
})

test("finalizes normally when the zero-admission continuation produces a real native child result", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-review-continuation-admission-"))
  let supervisor!: Supervisor
  let turnStarts = 0
  let continuationCompleted = false
  const reviewPrompt = 'CCHP_REVIEW_TASK_V1 {"task_id":"continuation-review-task","pass_kind":"correctness"}\nInspect the trusted diff and report findings.'
  const collaboration = (status: "running" | "completed") => ({
    method: "item/completed",
    params: {
      threadId: "root",
      item: {
        id: "continuation-spawn",
        type: "collabAgentToolCall",
        tool: "spawn_agent",
        senderThreadId: "root",
        receiverThreadIds: ["review-child"],
        agentType: "reviewer",
        prompt: reviewPrompt,
        agentsStates: { "review-child": { status } },
      },
    },
  })
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/start") return { thread: { id: "root", sessionId: "session" } }
      if (method === "turn/start") {
        turnStarts++
        const turnId = turnStarts === 1 ? "initial-turn" : "continuation-turn"
        if (turnStarts === 1) {
          queueMicrotask(() => void supervisor.handleNotification({
            method: "turn/completed",
            params: { threadId: "root", turn: { id: turnId, status: "completed" } },
          }))
        } else {
          expect(params?.threadId).toBe("root")
          setTimeout(() => void supervisor.handleNotification(collaboration("running")), 0)
          setTimeout(() => void supervisor.handleNotification(collaboration("completed")), 5)
          setTimeout(() => {
            continuationCompleted = true
            void supervisor.handleNotification({
              method: "turn/completed",
              params: { threadId: "root", turn: { id: turnId, status: "completed" } },
            })
          }, 10)
        }
        return { turn: { id: turnId } }
      }
      if (method === "thread/read" && params?.threadId === "review-child") {
        return { thread: {
          id: "review-child",
          parentThreadId: "root",
          sessionId: "session",
          turns: [{
            id: "review-child-turn",
            status: "completed",
            items: [{ id: "review-child-message", type: "agentMessage", text: "No findings." }],
          }],
        } }
      }
      if (method === "thread/read") return { thread: {
        id: "root",
        sessionId: "session",
        turns: [
          { id: "initial-turn", status: "completed", items: [] },
          ...(turnStarts > 1 ? [{
            id: "continuation-turn",
            status: continuationCompleted ? "completed" : "inProgress",
            items: [{ type: "userMessage", clientId: params?.clientUserMessageId }],
          }] : []),
        ],
      } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "pr_opened", runId: "run-continuation-admission", prompt: "review",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 100_000,
    executionMode: "native_v2", reviewRequired: true,
    finalizer: (context) => ({
      valid: true,
      run_id: context.runId,
      idempotency_key: context.idempotencyKey,
      provenance_sha256: context.preterminalProvenanceSha256,
    }),
    deadlines: { wholeRunMs: 5_000, heartbeatMs: 100, reconcileMs: 10, parentResumeMs: 1_000 },
  })

  expect(await supervisor.run()).toMatchObject({ state: "SUCCEEDED", rootTurnId: "continuation-turn" })
  expect(turnStarts).toBe(2)
  expect(readJsonl(join(workdir, "ctx", "codex", "review-admission.jsonl"))).toContainEqual(expect.objectContaining({
    event: "review_terminal",
    taskId: "continuation-review-task",
    state: "completed",
  }))
})

test("reconciles a completed continuation when its turn completion notification is missing", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-review-continuation-reconciled-"))
  let supervisor!: Supervisor
  let turnStarts = 0
  let continuationStarted = false
  let continuationClientId: unknown
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") {
        turnStarts++
        if (turnStarts === 1) {
          queueMicrotask(() => void supervisor.handleNotification({
            method: "turn/completed",
            params: { threadId: "root", turn: { id: "initial-turn", status: "completed" } },
          }))
          return { turn: { id: "initial-turn" } }
        }
        continuationStarted = true
        continuationClientId = params?.clientUserMessageId
        return { turn: { id: "continuation-turn" } }
      }
      if (method === "thread/read") return { thread: { id: "root", turns: [
        { id: "initial-turn", status: "completed", items: [] },
        ...(continuationStarted ? [{
          id: "continuation-turn",
          status: "completed",
          items: [{ type: "userMessage", clientId: continuationClientId }],
        }] : []),
      ] } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "pr_opened", runId: "run-continuation-reconciled", prompt: "review",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 1_000,
    executionMode: "explicit_child", reviewRequired: true,
    deadlines: { wholeRunMs: 5_000, heartbeatMs: 100, reconcileMs: 5, parentResumeMs: 1_000 },
  })

  expect(await supervisor.run()).toMatchObject({
    state: "FAILED",
    terminalReason: "review finalization requires at least one admitted child task",
  })
  expect(turnStarts).toBe(2)
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8"))).toMatchObject({
    state: "FAILED",
    reviewContinuation: { phase: "completed", continuationTurnId: "continuation-turn" },
  })
  expect(readJsonl(join(workdir, "ctx", "codex", "supervisor.jsonl"))).toContainEqual(expect.objectContaining({
    event: "review_continuation_completed",
    source: "thread/read reconciliation",
  }))
})

test("does not let a late continuation response overwrite a whole-run timeout", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-review-continuation-timeout-"))
  let supervisor!: Supervisor
  let turnStarts = 0
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") {
        turnStarts++
        if (turnStarts === 1) {
          queueMicrotask(() => void supervisor.handleNotification({
            method: "turn/completed",
            params: { threadId: "root", turn: { id: "initial-turn", status: "completed" } },
          }))
          return { turn: { id: "initial-turn" } }
        }
        await Bun.sleep(80)
        return { turn: { id: "continuation-turn" } }
      }
      if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "initial-turn", status: "completed" }] } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "pr_opened", runId: "run-continuation-timeout", prompt: "review",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 1_000,
    executionMode: "explicit_child", reviewRequired: true,
    deadlines: {
      wholeRunMs: 30,
      interruptGraceMs: 5,
      heartbeatMs: 100,
      reconcileMs: 5,
      parentResumeMs: 1_000,
    },
  })

  expect(await supervisor.run()).toMatchObject({ state: "TIMED_OUT", terminalReason: "whole run deadline exceeded" })
  await Bun.sleep(100)
  expect(supervisor.currentState).toBe("TIMED_OUT")
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8"))).toMatchObject({
    state: "TIMED_OUT",
    rootTurnId: "initial-turn",
    reviewContinuation: { phase: "dispatching", initialTurnId: "initial-turn" },
  })
})

test("does not run the zero-admission continuation after any real review admission", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-existing-review-admission-"))
  const ledger = new ReviewAdmissionLedger(join(workdir, "ctx", "codex", "review-admission.jsonl"), "run-existing-admission")
  ledger.admit({
    taskId: "existing-review-task",
    role: "reviewer",
    passKind: "correctness",
    mode: "explicit_child",
    prompt: 'CCHP_REVIEW_TASK_V1 {"task_id":"existing-review-task","pass_kind":"correctness"}\nInspect the diff.',
  })
  let supervisor!: Supervisor
  let turnStarts = 0
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") {
        turnStarts++
        queueMicrotask(() => void supervisor.handleNotification({
          method: "turn/completed",
          params: { threadId: "root", turn: { id: "initial-turn", status: "completed" } },
        }))
        return { turn: { id: "initial-turn" } }
      }
      if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "initial-turn", status: "completed" }] } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "pr_opened", runId: "run-existing-admission", prompt: "review",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 1_000,
    executionMode: "explicit_child", reviewRequired: true,
    deadlines: { wholeRunMs: 5_000, heartbeatMs: 100, reconcileMs: 10, noProgressWarningMs: 1_000, noProgressTerminalMs: 4_000 },
  })

  expect(await supervisor.run()).toMatchObject({
    state: "FAILED",
    terminalReason: "review finalization blocked by child tasks: existing-review-task:admitted",
  })
  expect(turnStarts).toBe(1)
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8")).reviewContinuation)
    .toBeUndefined()
})

test("resumes a prepared zero-admission continuation and dispatches it exactly once", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-review-continuation-prepared-"))
  let supervisor!: Supervisor
  let turnStarts = 0
  const clientUserMessageId = reviewContinuationClientMessageId(
    "run-continuation-prepared",
    "root",
    "initial-turn",
  )
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/resume") return { thread: { id: "root" } }
      if (method === "thread/read") return { thread: { id: "root", turns: [
        { id: "initial-turn", status: "completed", items: [] },
        ...(turnStarts ? [{
          id: "continuation-turn",
          status: "completed",
          items: [{ type: "userMessage", clientId: clientUserMessageId }],
        }] : []),
      ] } }
      if (method === "turn/start") {
        turnStarts++
        expect(params?.threadId).toBe("root")
        expect(params?.clientUserMessageId).toBe(clientUserMessageId)
        queueMicrotask(() => void supervisor.handleNotification({
          method: "turn/completed",
          params: { threadId: "root", turn: { id: "continuation-turn", status: "completed" } },
        }))
        return { turn: { id: "continuation-turn" } }
      }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  const startedAt = new Date(Date.now() - 1_000).toISOString()
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "pr_opened", runId: "run-continuation-prepared", prompt: "review",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 1_000,
    executionMode: "explicit_child", reviewRequired: true,
    resume: {
      state: "ROOT_DRAINING",
      executionMode: "explicit_child",
      rootThreadId: "root",
      rootTurnId: "initial-turn",
      restartAttempts: 1,
      startedAt,
      wholeRunDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
      lastSemanticProgressAt: startedAt,
      drainDeadlineAt: new Date(Date.now() + 2_000).toISOString(),
      reviewContinuation: {
        schemaVersion: 1,
        clientUserMessageId,
        phase: "prepared",
        initialTurnId: "initial-turn",
      },
    },
    deadlines: { wholeRunMs: 5_000, heartbeatMs: 100, reconcileMs: 10, parentResumeMs: 2_000 },
  })

  expect(await supervisor.run()).toMatchObject({
    state: "FAILED",
    terminalReason: "review finalization requires at least one admitted child task",
  })
  expect(turnStarts).toBe(1)
})

test("recovers an accepted dispatching continuation by client message id without replay", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-review-continuation-dispatching-"))
  const clientUserMessageId = reviewContinuationClientMessageId(
    "run-continuation-dispatching",
    "root",
    "initial-turn",
  )
  let turnStarts = 0
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/resume") return { thread: { id: params?.threadId } }
      if (method === "thread/read") return { thread: { id: "root", turns: [
        { id: "initial-turn", status: "completed", items: [] },
        {
          id: "continuation-turn",
          status: "inProgress",
          items: [{ type: "userMessage", clientId: clientUserMessageId }],
        },
      ] } }
      if (method === "turn/start") turnStarts++
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  const startedAt = new Date(Date.now() - 1_000).toISOString()
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "pr_opened", runId: "run-continuation-dispatching", prompt: "review",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 1_000,
    executionMode: "explicit_child", reviewRequired: true,
    resume: {
      state: "ROOT_DRAINING",
      executionMode: "explicit_child",
      rootThreadId: "root",
      rootTurnId: "initial-turn",
      restartAttempts: 1,
      startedAt,
      wholeRunDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
      lastSemanticProgressAt: startedAt,
      drainDeadlineAt: new Date(Date.now() + 2_000).toISOString(),
      reviewContinuation: {
        schemaVersion: 1,
        clientUserMessageId,
        phase: "dispatching",
        initialTurnId: "initial-turn",
      },
    },
    deadlines: { wholeRunMs: 5_000, heartbeatMs: 100, reconcileMs: 10, parentResumeMs: 2_000 },
  })
  const running = supervisor.run()
  await eventually(() => supervisor.currentState === "ROOT_RUNNING")
  expect(turnStarts).toBe(0)
  await supervisor.handleNotification({
    method: "turn/completed",
    params: { threadId: "root", turn: { id: "continuation-turn", status: "completed" } },
  })
  expect(await running).toMatchObject({
    state: "FAILED",
    terminalReason: "review finalization requires at least one admitted child task",
  })
  expect(turnStarts).toBe(0)
})

test("fails LOST instead of replaying an ambiguous dispatching continuation", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-review-continuation-missing-"))
  let turnStarts = 0
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/resume") return { thread: { id: params?.threadId } }
      if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "initial-turn", status: "completed", items: [] }] } }
      if (method === "turn/start") turnStarts++
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  const startedAt = new Date(Date.now() - 1_000).toISOString()
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "pr_opened", runId: "run-continuation-missing", prompt: "review",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 1_000,
    executionMode: "explicit_child", reviewRequired: true,
    resume: {
      state: "ROOT_DRAINING",
      executionMode: "explicit_child",
      rootThreadId: "root",
      rootTurnId: "initial-turn",
      restartAttempts: 1,
      startedAt,
      wholeRunDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
      lastSemanticProgressAt: startedAt,
      drainDeadlineAt: new Date(Date.now() + 2_000).toISOString(),
      reviewContinuation: {
        schemaVersion: 1,
        clientUserMessageId: reviewContinuationClientMessageId(
          "run-continuation-missing",
          "root",
          "initial-turn",
        ),
        phase: "dispatching",
        initialTurnId: "initial-turn",
      },
    },
    deadlines: { wholeRunMs: 5_000, heartbeatMs: 100, reconcileMs: 10, parentResumeMs: 2_000 },
  })

  expect(await supervisor.run()).toMatchObject({
    state: "LOST",
    terminalReason: expect.stringContaining("refusing ambiguous replay"),
  })
  expect(turnStarts).toBe(0)
})

test("rejects native collaboration events before graph mutation in explicit child mode", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-explicit-native-crossing-"))
  let supervisor!: Supervisor
  const empty: ExplicitChildSnapshot = { active: [], terminal: [], stale: [] }
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake, codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-explicit-native-crossing", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000, executionMode: "explicit_child",
    explicitChildren: { reconcile: () => empty, interruptActive: async () => undefined },
    deadlines: { wholeRunMs: 5_000, heartbeatMs: 1_000, reconcileMs: 1_000 },
  })
  const running = supervisor.run()
  await Bun.sleep(10)
  await supervisor.handleNotification({ method: "item/completed", params: {
    threadId: "root",
    item: {
      id: "spawn-native",
      type: "collabAgentToolCall",
      tool: "spawn_agent",
      senderThreadId: "root",
      receiverThreadIds: ["native-child"],
      agentsStates: { "native-child": { status: "running" } },
    },
  } })
  expect(await running).toMatchObject({
    state: "FAILED",
    terminalReason: "native collaboration event is forbidden in explicit child mode",
  })
  const graphPath = join(workdir, "ctx", "codex", "graph.jsonl")
  expect(existsSync(graphPath) ? readJsonl(graphPath) : []).toEqual([])
})

test("settles LOST and preserves cleanup failure when an explicit child cannot be stopped", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-explicit-cleanup-failure-"))
  let supervisor!: Supervisor
  const empty: ExplicitChildSnapshot = { active: [], terminal: [], stale: [] }
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") {
        queueMicrotask(() => void supervisor.handleNotification({
          method: "turn/completed",
          params: { threadId: "root", turn: { id: "turn", status: "failed" } },
        }))
        return { turn: { id: "turn" } }
      }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake, codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-explicit-cleanup-failure", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000, executionMode: "explicit_child",
    explicitChildren: {
      reconcile: () => empty,
      interruptActive: async () => { throw new Error("process group ownership drift") },
    },
    deadlines: { wholeRunMs: 5_000, heartbeatMs: 1_000, reconcileMs: 1_000 },
  })
  expect(await supervisor.run()).toMatchObject({
    state: "LOST",
    exitCode: 1,
    terminalReason: expect.stringContaining("terminal cleanup failed: process group ownership drift"),
  })
  expect(readJsonl(join(workdir, "ctx", "codex", "supervisor.jsonl"))).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: "explicit_child_interrupt_error" }),
    expect.objectContaining({ event: "terminal_cleanup_failed" }),
  ]))
})

test("imports root plan updates and publishes heartbeat progress without child interference", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-progress-"))
  const published: string[] = []
  let supervisor!: Supervisor
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "manual",
    runId: "run-progress",
    prompt: "status",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    totalTokenBudget: 1000,
    publishProgress: async (body) => { published.push(body) },
    deadlines: { wholeRunMs: 10_000, heartbeatMs: 20, noProgressWarningMs: 2_000, noProgressTerminalMs: 8_000 },
  })
  const run = supervisor.run()
  await Bun.sleep(10)
  await supervisor.handleNotification({ method: "turn/plan/updated", params: {
    threadId: "root",
    plan: [{ step: "inspect", status: "in_progress" }],
  } })
  await Bun.sleep(40)
  const todo = JSON.parse(readFileSync(join(workdir, "ctx", "codex", "todo.json"), "utf8")) as { todos: Array<{ content: string; status: string }> }
  expect(todo.todos).toEqual([{ content: "inspect", status: "in_progress" }])
  expect(published.join("\n")).toContain("inspect")
  expect(readJsonl(join(workdir, "ctx", "codex", "supervisor.jsonl"))).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: "FIRST_PLAN_RECEIVED", stepCount: 1 }),
    expect.objectContaining({ event: "FIRST_USABLE_PLAN_RECEIVED", stepCount: 1 }),
  ]))
  await supervisor.handleNotification({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "completed" } } })
  expect(await run).toMatchObject({ state: "SUCCEEDED" })
})

test("surfaces a missing canonical plan after root semantic work begins", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-plan-missing-"))
  const published: string[] = []
  let supervisor!: Supervisor
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "manual",
    runId: "run-plan-missing",
    prompt: "status",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    totalTokenBudget: 1_000,
    publishProgress: async (body) => { published.push(body) },
    deadlines: { wholeRunMs: 10_000, heartbeatMs: 10, reconcileMs: 1_000, noProgressWarningMs: 2_000, noProgressTerminalMs: 8_000 },
  })
  const run = supervisor.run()
  await Bun.sleep(10)
  await supervisor.handleNotification({
    method: "item/completed",
    params: { threadId: "root", item: { id: "message", type: "agentMessage", text: "Working" } },
  })
  await eventually(() => published.some((body) => body.includes("Canonical plan missing after semantic work began")))
  const events = readJsonl(join(workdir, "ctx", "codex", "supervisor.jsonl"))
  expect(events.filter((row) => row.event === "PLAN_MISSING_WARNING")).toHaveLength(1)
  expect(published.join("\n")).toContain("Plan: awaiting first update")
  await supervisor.handleNotification({
    method: "turn/completed",
    params: { threadId: "root", turn: { id: "turn", status: "completed" } },
  })
  expect(await run).toMatchObject({ state: "SUCCEEDED" })
})

test("drains an open child edge before finalizing the completed root", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-drain-"))
  let supervisor!: Supervisor
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      if (method === "thread/read") return { thread: { id: "child-1", status: { type: "active" } } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "manual",
    runId: "run-drain",
    prompt: "status",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    totalTokenBudget: 1000,
    deadlines: { wholeRunMs: 5000, heartbeatMs: 20, reconcileMs: 20, parentResumeMs: 2000, noProgressWarningMs: 1000, noProgressTerminalMs: 4000 },
  })
  const run = supervisor.run()
  await Bun.sleep(10)
  await supervisor.handleNotification({ method: "item/completed", params: {
    threadId: "root",
    item: {
      id: "spawn-1",
      type: "collabAgentToolCall",
      tool: "spawn_agent",
      senderThreadId: "root",
      receiverThreadIds: ["child-1"],
      agentsStates: { "child-1": { status: "running" } },
    },
  } })
  await supervisor.handleNotification({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "completed" } } })
  expect(supervisor.currentState).toBe("ROOT_DRAINING")
  await supervisor.handleNotification({ method: "item/completed", params: {
    threadId: "root",
    item: {
      id: "spawn-1",
      type: "collabAgentToolCall",
      tool: "spawn_agent",
      senderThreadId: "root",
      receiverThreadIds: ["child-1"],
      agentsStates: { "child-1": { status: "completed" } },
    },
  } })
  expect(await run).toMatchObject({ state: "SUCCEEDED" })
})

test("drains active explicit children before finalizing the completed root", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-explicit-drain-"))
  let supervisor!: Supervisor
  let explicitState: "active" | "terminal" = "active"
  let finalized = 0
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = []
  const empty: ExplicitChildSnapshot = { active: [], terminal: [], stale: [] }
  const lifecycle: ExplicitChildLifecycle = {
    reconcile: () => explicitState === "active"
      ? { ...empty, active: [{ childId: "child-1", parentId: "root", spawnItemId: "explicit:child-1", generation: 1, state: "running", deadlineAt: new Date(Date.now() + 1000).toISOString() } as never] }
      : { ...empty, terminal: [{ childId: "child-1", parentId: "root", spawnItemId: "explicit:child-1", generation: 1, state: "completed" } as never] },
    interruptActive: async () => undefined,
  }
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      requests.push({ method, params })
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "turn", status: "completed" }] } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake, codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-explicit-drain", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1000, executionMode: "explicit_child", explicitChildren: lifecycle,
    finalizer: (context) => { finalized++; return { valid: true, run_id: context.runId, idempotency_key: context.idempotencyKey, provenance_sha256: context.preterminalProvenanceSha256 } },
    deadlines: { wholeRunMs: 2000, heartbeatMs: 100, reconcileMs: 10, parentResumeMs: 500 },
  })
  const running = supervisor.run()
  await Bun.sleep(10)
  await supervisor.handleNotification({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "completed" } } })
  await Bun.sleep(30)
  expect(supervisor.currentState).toBe("ROOT_DRAINING")
  expect(finalized).toBe(0)
  explicitState = "terminal"
  expect(await running).toMatchObject({ state: "SUCCEEDED" })
  expect(finalized).toBe(1)
  expect(requests.some((request) => request.method === "thread/read" && request.params?.threadId === "child-1")).toBe(false)
  const graphRows = readJsonl(join(workdir, "ctx", "codex", "graph.jsonl"))
  expect(graphRows).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: "edge_opened", childId: "child-1", transport: "explicit_child", generation: 1 }),
    expect.objectContaining({ event: "edge_closed", childId: "child-1", terminalState: "completed" }),
    expect.objectContaining({ event: "parent_resume_delivered", childId: "child-1" }),
  ]))
})

test("maps explicit Codex session usage to the logical child graph edge", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-explicit-session-"))
  let supervisor!: Supervisor
  let phase: "pending" | "terminal" = "pending"
  const lifecycle: ExplicitChildLifecycle = {
    reconcile: () => phase === "pending"
      ? { active: [], terminal: [], stale: [] }
      : {
          active: [],
          terminal: [{
            childId: "task-name", sessionId: "thread-uuid", parentId: "root", spawnItemId: "spawn-1",
            generation: 1, state: "completed", updatedAt: new Date().toISOString(),
          } as never],
          stale: [],
        },
    interruptActive: async () => undefined,
  }
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake, codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-explicit-session", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000, executionMode: "explicit_child", explicitChildren: lifecycle,
    deadlines: { wholeRunMs: 2_000, heartbeatMs: 100, reconcileMs: 10, parentResumeMs: 500 },
  })
  const usage = {
    responseId: "response-1", threadId: "thread-uuid", turnId: "child-turn", providerId: "provider", model: "model",
    inputTokens: 60, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 0, totalTokens: 100,
  }
  expect(await supervisor.recordProviderUsage(usage)).toMatchObject({ acceptedRaw: false, consumed: 0 })
  const run = supervisor.run()
  await Bun.sleep(10)
  phase = "terminal"
  await supervisor.handleNotification({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "completed" } } })
  expect(await run).toMatchObject({ state: "SUCCEEDED" })
  expect(supervisor.currentUsage).toMatchObject({ consumed: 100, blockingAnomalies: 0 })
})

test("treats an explicit interrupted child as closed work, matching native semantics", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-explicit-interrupted-"))
  const lifecycle: ExplicitChildLifecycle = {
    reconcile: () => ({
      active: [],
      terminal: [{ childId: "child-1", parentId: "root", spawnItemId: "spawn-1", generation: 1, state: "interrupted" } as never],
      stale: [],
    }),
    interruptActive: async () => undefined,
  }
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake, codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-explicit-interrupted", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000, executionMode: "explicit_child", explicitChildren: lifecycle,
    deadlines: { wholeRunMs: 2_000, heartbeatMs: 100, reconcileMs: 10, parentResumeMs: 500 },
  })
  const run = supervisor.run()
  await Bun.sleep(10)
  await supervisor.handleNotification({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "completed" } } })
  expect(await run).toMatchObject({ state: "SUCCEEDED" })
})

test("fails and interrupts when explicit child artifacts are terminal failures or outlive drain", async () => {
  for (const mode of ["terminal-failed", "drain-expired"] as const) {
    const workdir = mkdtempSync(join(tmpdir(), `cchp-supervisor-explicit-${mode}-`))
    let supervisor!: Supervisor
    let interrupts = 0
    const lifecycle: ExplicitChildLifecycle = {
      reconcile: () => mode === "terminal-failed"
        ? { active: [], terminal: [{ childId: "child-1", parentId: "root", spawnItemId: "explicit:child-1", generation: 1, state: "failed", error: "boom" } as never], stale: [] }
        : { active: [{ childId: "child-1", parentId: "root", spawnItemId: "explicit:child-1", generation: 1, state: "running", deadlineAt: new Date(Date.now() + 1000).toISOString() } as never], terminal: [], stale: [] },
      interruptActive: async () => { interrupts++ },
    }
    const fake = {
      start: async () => ({ userAgent: "fake" }),
      request: async (method: string) => {
        if (method === "thread/start") return { thread: { id: "root" } }
        if (method === "turn/start") return { turn: { id: "turn" } }
        if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "turn", status: "completed" }] } }
        return {}
      },
      stop: async () => 0,
    } as unknown as CodexAppServer
    supervisor = new Supervisor({
      appServer: fake, codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
      task: "manual", runId: `run-${mode}`, prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
      totalTokenBudget: 1000, executionMode: "explicit_child", explicitChildren: lifecycle,
      deadlines: { wholeRunMs: 1000, heartbeatMs: 100, reconcileMs: 10, parentResumeMs: mode === "drain-expired" ? 20 : 500 },
    })
    const running = supervisor.run()
    await Bun.sleep(5)
    await supervisor.handleNotification({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "completed" } } })
    expect(await running).toMatchObject({ state: mode === "terminal-failed" ? "FAILED" : "LOST" })
    expect(interrupts).toBeGreaterThanOrEqual(mode === "drain-expired" ? 1 : 0)
  }
})

test("reconciles a terminal child from thread/read when the collaboration completion notification is missing", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-reconcile-child-"))
  let supervisor!: Supervisor
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      if (method === "thread/read" && params?.threadId === "child-1") {
        return { thread: { id: "child-1", status: { type: "idle" }, turns: [{ id: "child-turn", status: "completed" }] } }
      }
      if (method === "thread/read") return { thread: { id: "root", status: { type: "idle" }, turns: [{ id: "turn", status: "completed" }] } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-reconcile-child", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1000,
    deadlines: { wholeRunMs: 5000, heartbeatMs: 20, reconcileMs: 20, parentResumeMs: 200, noProgressWarningMs: 1000, noProgressTerminalMs: 4000 },
  })
  const run = supervisor.run()
  await Bun.sleep(10)
  await supervisor.handleNotification({ method: "item/completed", params: {
    threadId: "root",
    item: { id: "spawn-1", type: "collabAgentToolCall", tool: "spawn_agent", senderThreadId: "root", receiverThreadIds: ["child-1"], agentsStates: { "child-1": { status: "running" } } },
  } })
  await supervisor.handleNotification({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "completed" } } })
  expect(await run).toMatchObject({ state: "SUCCEEDED" })
})

test("delivers one durable parent wake when reconciliation finds a terminal child while root is active", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-parent-wake-"))
  const steers: Record<string, unknown>[] = []
  let supervisor!: Supervisor
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      if (method === "thread/read" && params?.threadId === "child-1") return { thread: { id: "child-1", turns: [{ id: "child-turn", status: "completed" }] } }
      if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "turn", status: "inProgress" }] } }
      if (method === "turn/steer") { steers.push(params ?? {}); return { turnId: "turn" } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-parent-wake", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1000,
    deadlines: { wholeRunMs: 5000, heartbeatMs: 20, reconcileMs: 20, parentResumeMs: 1000, noProgressWarningMs: 1000, noProgressTerminalMs: 4000 },
  })
  const run = supervisor.run()
  await Bun.sleep(10)
  await supervisor.handleNotification({ method: "item/completed", params: {
    threadId: "root",
    item: { id: "spawn-1", type: "collabAgentToolCall", tool: "spawn_agent", senderThreadId: "root", receiverThreadIds: ["child-1"], agentsStates: { "child-1": { status: "running" } } },
  } })
  await Bun.sleep(80)
  expect(steers).toHaveLength(1)
  expect(steers[0]).toMatchObject({ threadId: "root", expectedTurnId: "turn" })
  expect(JSON.stringify(steers[0])).toContain("Idempotency key")
  await supervisor.handleNotification({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "completed" } } })
  expect(await run).toMatchObject({ state: "SUCCEEDED" })
})

test("settles LOST when authoritative child reconciliation reports not found", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-reconcile-lost-"))
  let supervisor!: Supervisor
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      if (method === "thread/read" && params?.threadId === "child-lost") throw new Error("thread not found")
      if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "turn", status: "completed" }] } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-reconcile-lost", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1000,
    deadlines: { wholeRunMs: 10_000, heartbeatMs: 20, reconcileMs: 20, parentResumeMs: 2_000, noProgressWarningMs: 2_000, noProgressTerminalMs: 8_000 },
  })
  const run = supervisor.run()
  await Bun.sleep(10)
  await supervisor.handleNotification({ method: "item/completed", params: {
    threadId: "root",
    item: { id: "spawn-lost", type: "collabAgentToolCall", tool: "spawn_agent", senderThreadId: "root", receiverThreadIds: ["child-lost"], agentsStates: { "child-lost": { status: "running" } } },
  } })
  await supervisor.handleNotification({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "completed" } } })
  expect(await run).toMatchObject({ state: "LOST" })
})

test("restarts the app-server and resumes the existing root thread after one crash", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-exit-"))
  const requests: string[] = []
  let starts = 0
  let stops = 0
  const fake = {
    start: async () => { starts++; return { userAgent: "fake" } },
    request: async (method: string, params?: Record<string, unknown>) => {
      requests.push(method)
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      if (method === "thread/resume") return { thread: { id: params?.threadId } }
      if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "turn", status: "inProgress" }] } }
      return {}
    },
    stop: async () => { stops++; return 0 },
  } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "manual",
    runId: "run-exit",
    prompt: "status",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    totalTokenBudget: 1000,
    deadlines: { wholeRunMs: 10_000, heartbeatMs: 20, reconcileMs: 50, noProgressWarningMs: 2_000, noProgressTerminalMs: 8_000 },
  })
  const run = supervisor.run()
  await Bun.sleep(10)
  await supervisor.handleAppServerExit({ expected: false, reason: "process_exit", exitCode: 23, signalCode: null })
  await eventually(() => requests.includes("thread/resume"))
  expect(starts).toBe(2)
  expect(stops).toBe(1)
  expect(requests.filter((method) => method === "thread/start")).toHaveLength(1)
  expect(requests.filter((method) => method === "turn/start")).toHaveLength(1)
  expect(requests.filter((method) => method === "thread/resume")).toHaveLength(1)
  await supervisor.handleNotification({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "completed" } } })
  expect(await run).toMatchObject({ state: "SUCCEEDED", rootThreadId: "root", rootTurnId: "turn" })
})

test("does not resume explicit graph ids as native Codex threads", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-explicit-resume-filter-"))
  const codexDir = join(workdir, "ctx", "codex")
  mkdirSync(codexDir, { recursive: true })
  const graph = new ChildGraph(join(codexDir, "graph.jsonl"))
  graph.open("root", "explicit-task", "explicit:explicit-task", "explicit_child")
  const resumed: string[] = []
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/resume") {
        resumed.push(String(params?.threadId))
        return { thread: { id: params?.threadId } }
      }
      if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "turn", status: "completed" }] } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  const explicitChildren: ExplicitChildLifecycle = {
    reconcile: () => ({
      active: [],
      terminal: [{
        childId: "explicit-task", parentId: "root", spawnItemId: "explicit:explicit-task",
        generation: 1, sessionId: "explicit-session", state: "completed",
      } as never],
      stale: [],
    }),
    interruptActive: async () => undefined,
  }
  const supervisor = new Supervisor({
    appServer: fake, codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-explicit-filter", prompt: "wait", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000, executionMode: "explicit_child", explicitChildren,
    resume: { state: "ROOT_DRAINING", rootThreadId: "root", rootTurnId: "turn", restartAttempts: 0 },
    deadlines: { wholeRunMs: 2_000, heartbeatMs: 100, reconcileMs: 10, parentResumeMs: 500 },
  })
  expect(await supervisor.run()).toMatchObject({ state: "SUCCEEDED" })
  expect(resumed).toEqual(["root"])
})

test("restarts immediately when app-server exits during root child draining", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-drain-exit-"))
  let starts = 0
  const resumed: string[] = []
  const fake = {
    start: async () => { starts++; return { userAgent: "fake" } },
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      if (method === "thread/resume") {
        resumed.push(String(params?.threadId))
        return { thread: { id: params?.threadId } }
      }
      if (method === "thread/read" && params?.threadId === "child") {
        return { thread: { id: "child", parentThreadId: "root", turns: [{ id: "child-turn", status: starts >= 2 ? "completed" : "inProgress" }] } }
      }
      if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "turn", status: "completed" }] } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake, codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-drain-exit", prompt: "wait", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000,
    deadlines: { wholeRunMs: 2_000, heartbeatMs: 100, reconcileMs: 20, parentResumeMs: 500 },
  })
  const run = supervisor.run()
  await Bun.sleep(10)
  await supervisor.handleNotification({ method: "item/completed", params: {
    threadId: "root",
    item: { id: "spawn", type: "collabAgentToolCall", tool: "spawn_agent", senderThreadId: "root", receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } } },
  } })
  await supervisor.handleNotification({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "completed" } } })
  expect(supervisor.currentState).toBe("ROOT_DRAINING")
  await supervisor.handleAppServerExit({ expected: false, reason: "process_exit", exitCode: 23, signalCode: null })
  expect(await run).toMatchObject({ state: "SUCCEEDED" })
  expect(starts).toBe(2)
  expect(resumed).toEqual(expect.arrayContaining(["root", "child"]))
})

test("settles LOST without restarting when the app-server restart budget is exhausted", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-exit-budget-"))
  const requests: string[] = []
  let starts = 0
  let stops = 0
  const fake = {
    start: async () => { starts++; return { userAgent: "fake" } },
    request: async (method: string, params?: Record<string, unknown>) => {
      requests.push(method)
      if (method === "thread/resume") return { thread: { id: params?.threadId } }
      if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "turn", status: "inProgress" }] } }
      return {}
    },
    stop: async () => { stops++; return 0 },
  } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "manual",
    runId: "run-exit-budget",
    prompt: "status",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    totalTokenBudget: 1000,
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "turn", restartAttempts: 1 },
    maxAppServerRestarts: 1,
    deadlines: { wholeRunMs: 10_000, heartbeatMs: 20, reconcileMs: 50, noProgressWarningMs: 2_000, noProgressTerminalMs: 8_000 },
  })
  const run = supervisor.run()
  await eventually(() => requests.includes("thread/resume"))
  await supervisor.handleAppServerExit({ expected: false, reason: "process_exit", exitCode: 23, signalCode: null })

  expect(await run).toMatchObject({
    state: "LOST",
    exitCode: 1,
    rootThreadId: "root",
    rootTurnId: "turn",
    terminalReason: expect.stringContaining("restart budget exhausted"),
  })
  expect(starts).toBe(1)
  expect(stops).toBe(1)
  expect(requests.filter((method) => method === "thread/resume")).toHaveLength(1)
  expect(requests).not.toContain("thread/start")
  expect(requests).not.toContain("turn/start")
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8"))).toMatchObject({
    state: "LOST",
    restartAttempts: 1,
    terminalReason: expect.stringContaining("restart budget exhausted"),
  })
})

test("resumes one durable run without duplicating graph, usage, TODO, or provenance sequence", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-process-resume-"))
  const unused = {
    start: async () => ({ userAgent: "unused" }),
    request: async () => ({}),
    stop: async () => 0,
  } as unknown as CodexAppServer
  const options = {
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "manual",
    runId: "run-process-resume",
    prompt: "status",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    totalTokenBudget: 1000,
    executionMode: "native_v2",
    deadlines: { wholeRunMs: 10_000, heartbeatMs: 100, reconcileMs: 5_000, noProgressWarningMs: 2_000, noProgressTerminalMs: 8_000 },
  } as const
  const first = new Supervisor({
    ...options,
    appServer: unused,
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "turn", restartAttempts: 0 },
  })
  const collaboration = {
    method: "item/completed",
    params: {
      threadId: "root",
      item: {
        id: "spawn-1",
        type: "collabAgentToolCall",
        tool: "spawn_agent",
        senderThreadId: "root",
        receiverThreadIds: ["child-1"],
        agentsStates: { "child-1": { status: "running" } },
      },
    },
  } as const
  const plan = {
    method: "turn/plan/updated",
    params: { threadId: "root", plan: [{ step: "inspect", status: "in_progress" }] },
  } as const
  const usage = {
    responseId: "resp-1",
    threadId: "root",
    turnId: "turn",
    providerId: "gpt-cchp",
    model: "gpt-5.6-sol",
    inputTokens: 70,
    cachedInputTokens: 10,
    cacheWriteInputTokens: 0,
    outputTokens: 30,
    reasoningOutputTokens: 5,
    totalTokens: 100,
    contextWindow: 372_000,
  }
  await first.handleNotification(collaboration)
  await first.handleNotification(plan)
  await first.recordProviderUsage(usage)

  const codexDir = join(workdir, "ctx", "codex")
  const graphPath = join(codexDir, "graph.jsonl")
  const usagePath = join(codexDir, "usage.jsonl")
  const todoPath = join(codexDir, "todo.json")
  const provenancePath = join(codexDir, "provenance.jsonl")
  const graphBefore = readFileSync(graphPath, "utf8")
  const usageBefore = readFileSync(usagePath, "utf8")
  const todoBefore = JSON.parse(readFileSync(todoPath, "utf8")) as { revision: number }
  const provenanceBefore = readJsonl(provenancePath)

  const recovery = resolveRuntimeRecovery(
    { BOT_RUN_ID: "run-process-resume" },
    workdir,
    "manual",
    "native_v2",
    () => "must-not-be-used",
  )
  expect(recovery).toMatchObject({
    runId: "run-process-resume",
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "turn", restartAttempts: 0 },
  })

  const requests: string[] = []
  const resumedAppServer = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      requests.push(method)
      if (method === "thread/resume") return { thread: { id: params?.threadId } }
      if (method === "thread/read" && params?.threadId === "child-1") {
        return { thread: { id: "child-1", turns: [{ id: "child-turn", status: "inProgress" }] } }
      }
      if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "turn", status: "inProgress" }] } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  const second = new Supervisor({ ...options, appServer: resumedAppServer, resume: recovery.resume })

  expect(readFileSync(graphPath, "utf8")).toBe(graphBefore)
  expect(readFileSync(usagePath, "utf8")).toBe(usageBefore)
  expect((JSON.parse(readFileSync(todoPath, "utf8")) as { revision: number }).revision).toBe(todoBefore.revision)
  const provenanceAfterConstruction = readJsonl(provenancePath)
  expect(provenanceAfterConstruction).toHaveLength(provenanceBefore.length + 1)
  expect(provenanceAfterConstruction.at(-1)).toMatchObject({
    sequence: provenanceBefore.length + 1,
    eventId: `run-process-resume:${provenanceBefore.length + 1}`,
    event: "supervisor_process_resumed",
  })

  const run = second.run()
  await eventually(() => requests.includes("thread/resume"))
  await second.handleNotification(collaboration)
  await second.handleNotification(plan)
  expect(await second.recordProviderUsage(usage)).toMatchObject({ acceptedRaw: false, consumed: 100 })
  expect(readFileSync(graphPath, "utf8")).toBe(graphBefore)
  expect(readFileSync(usagePath, "utf8")).toBe(usageBefore)
  expect((JSON.parse(readFileSync(todoPath, "utf8")) as { revision: number }).revision).toBe(todoBefore.revision)
  expect(second.currentUsage).toMatchObject({ consumed: 100 })

  await second.handleNotification({
    ...collaboration,
    params: {
      ...collaboration.params,
      item: { ...collaboration.params.item, agentsStates: { "child-1": { status: "completed" } } },
    },
  })
  await second.handleNotification({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "completed" } } })
  expect(await run).toMatchObject({ state: "SUCCEEDED", rootThreadId: "root", rootTurnId: "turn" })

  const provenance = readJsonl(provenancePath)
  expect(provenance.map((row) => row.sequence)).toEqual(
    Array.from({ length: provenance.length }, (_, index) => index + 1),
  )
  expect(new Set(provenance.map((row) => row.eventId)).size).toBe(provenance.length)
})

test("attributes native raw response usage to the owning root and child turns without double billing", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-native-usage-"))
  const unused = {
    start: async () => ({ userAgent: "unused" }),
    request: async () => ({}),
    stop: async () => 0,
  } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: unused,
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "pr_opened",
    runId: "run-native-usage",
    prompt: "review",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    executionMode: "native_v2",
    totalTokenBudget: 10_000,
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "root-turn", restartAttempts: 0 },
  })
  await supervisor.handleNotification({
    method: "item/completed",
    params: {
      threadId: "root",
      turnId: "root-turn",
      item: {
        id: "spawn-usage-child",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        senderThreadId: "root",
        receiverThreadIds: ["child"],
        prompt: 'CCHP_REVIEW_TASK_V1 {"task_id":"native-usage-1","pass_kind":"review_shard"}\nattribute child usage',
        agentType: "reviewer",
        agentsStates: { child: { status: "running", message: null } },
      },
    },
  })

  const rootBridge = {
    responseId: "resp-root",
    threadId: "root",
    turnId: "root-turn",
    providerId: "gpt-cchp",
    model: "gpt-5.6-sol",
    inputTokens: 60,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 40,
    reasoningOutputTokens: 0,
    totalTokens: 100,
  }
  const childBridge = {
    responseId: "resp-child",
    threadId: "child",
    turnId: "child-turn",
    providerId: "gpt-cchp",
    model: "gpt-5.6-sol",
    inputTokens: 120,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 80,
    reasoningOutputTokens: 0,
    totalTokens: 200,
  }
  expect(await supervisor.recordProviderUsage(rootBridge)).toMatchObject({ acceptedRaw: true, consumed: 100 })
  expect(await supervisor.recordProviderUsage(childBridge)).toMatchObject({ acceptedRaw: true, consumed: 300 })

  await supervisor.handleNotification({
    method: "rawResponse/completed",
    params: {
      threadId: "root",
      turnId: "root-turn",
      responseId: "resp-root",
      usage: { inputTokens: 60, outputTokens: 40, totalTokens: 100 },
    },
  })
  await supervisor.handleNotification({
    method: "rawResponse/completed",
    params: {
      threadId: "child",
      turnId: "child-turn",
      responseId: "resp-child",
      usage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 },
    },
  })

  expect(supervisor.currentUsage).toMatchObject({ consumed: 300, blockingAnomalies: 0 })
  const raw = readJsonl(join(workdir, "ctx", "codex", "usage.jsonl"))
    .filter((row) => row.kind === "raw_completion_usage")
  expect(raw).toHaveLength(2)
  expect(raw).toContainEqual(expect.objectContaining({
    threadId: "root",
    turnId: "root-turn",
    responseId: "resp-root",
    provider: "gpt-cchp",
    model: "gpt-5.6-sol",
    totalTokens: 100,
  }))
  expect(raw).toContainEqual(expect.objectContaining({
    threadId: "child",
    turnId: "child-turn",
    responseId: "resp-child",
    parentThreadId: "root",
    provider: "gpt-cchp",
    model: "gpt-5.6-sol",
    totalTokens: 200,
  }))

  expect(await supervisor.recordProviderUsage(childBridge)).toMatchObject({ acceptedRaw: false, consumed: 300 })
  expect(readJsonl(join(workdir, "ctx", "codex", "usage.jsonl")).filter((row) => row.kind === "raw_completion_usage")).toHaveLength(2)
})

test("bills distinct provider responses in one Codex tool-loop turn exactly once", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-native-tool-loop-"))
  const fake = { stop: async () => 0 } as unknown as CodexAppServer
  const options = {
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-native-tool-loop", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 10_000,
    executionMode: "native_v2" as const,
    resume: { state: "ROOT_RUNNING" as const, rootThreadId: "root", rootTurnId: "turn", restartAttempts: 0 },
  }
  const supervisor = new Supervisor(options)
  const usage = {
    providerId: "provider",
    model: "model",
    threadId: "root",
    turnId: "turn",
    inputTokens: 14,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: 15,
  }
  expect(await supervisor.recordProviderUsage({ ...usage, responseId: "response-1" }))
    .toMatchObject({ acceptedRaw: true, consumed: 15, blockingAnomalies: 0 })
  expect(await supervisor.recordProviderUsage({ ...usage, responseId: "response-2" }))
    .toMatchObject({ acceptedRaw: true, consumed: 30, blockingAnomalies: 0 })
  expect(await supervisor.recordProviderUsage({ ...usage, responseId: "response-2" }))
    .toMatchObject({ acceptedRaw: false, consumed: 30, blockingAnomalies: 0 })
  expect(readJsonl(join(workdir, "ctx", "codex", "usage.jsonl")).filter((row) => row.kind === "raw_completion_usage")).toHaveLength(2)

  const restored = new Supervisor(options)
  expect(restored.currentUsage).toMatchObject({ consumed: 30, responses: 2, turns: 1, blockingAnomalies: 0 })
})

test("waits for the native child graph before billing early provider and raw observations", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-native-early-child-"))
  const fake = {
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/read" && params?.threadId === "root") {
        return { thread: { id: "root", turns: [{ id: "root-turn", status: "completed" }] } }
      }
      if (method === "thread/read" && params?.threadId === "child") {
        return { thread: { id: "child", parentThreadId: "root", turns: [{ id: "child-turn", status: "inProgress" }] } }
      }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-native-early-child", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000,
    executionMode: "native_v2",
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "root-turn", restartAttempts: 0 },
  })
  const provider = {
    providerId: "provider", model: "model", responseId: "child-response",
    threadId: "child", turnId: "child-turn",
    inputTokens: 8, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 11,
  }
  await supervisor.handleNotification({
    method: "rawResponse/completed",
    params: { threadId: "child", turnId: "child-turn", responseId: "child-response", usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } },
  })
  expect(await supervisor.recordProviderUsage(provider)).toMatchObject({ acceptedRaw: false, consumed: 0 })

  await supervisor.handleNotification({
    method: "item/completed",
    params: {
      threadId: "root",
      turnId: "root-turn",
      item: {
        id: "spawn-child",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        senderThreadId: "root",
        receiverThreadIds: ["child"],
        prompt: "inspect",
        agentType: "explorer",
        agentsStates: { child: { status: "running" } },
      },
    },
  })
  await supervisor.handleNotification({
    method: "turn/completed",
    params: { threadId: "root", turn: { id: "root-turn", status: "completed" } },
  })

  expect(supervisor.currentUsage).toMatchObject({ consumed: 11, blockingAnomalies: 0 })
  expect(readJsonl(join(workdir, "ctx", "codex", "usage.jsonl")).filter((row) => row.kind === "raw_completion_usage")).toContainEqual(expect.objectContaining({
    threadId: "child",
    turnId: "child-turn",
    parentThreadId: "root",
    lineage: ["root", "child"],
    responseId: "child-response",
  }))
})

test("binds a native review completion to a durable result artifact from thread/read", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-native-result-"))
  const reviewPrompt = 'CCHP_REVIEW_TASK_V1 {"task_id":"native-result-1","pass_kind":"review_shard"}\nreview the patch'
  const appServer = {
    start: async () => ({ userAgent: "unused" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      if (method === "thread/read" && params?.threadId === "child-1") {
        return { thread: {
          id: "child-1",
          parentThreadId: "root",
          sessionId: "session-1",
          turns: [{
            id: "child-turn",
            status: "completed",
            items: [{ id: "message-1", type: "agentMessage", text: '{"findings":[]}' }],
          }],
        } }
      }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer,
    codexHome: join(workdir, "codex-home"),
    repoDir: workdir,
    workdir,
    task: "pr_opened",
    runId: "run-native-result",
    prompt: "review",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    executionMode: "native_v2",
    totalTokenBudget: 10_000,
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "root-turn", restartAttempts: 0 },
  })
  await supervisor.handleNotification({ method: "item/completed", params: {
    threadId: "root",
    item: {
      id: "spawn-1",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      senderThreadId: "root",
      receiverThreadIds: ["child-1"],
      prompt: reviewPrompt,
      agentType: "reviewer",
      agentsStates: { "child-1": { status: "running" } },
    },
  } })
  await supervisor.handleNotification({ method: "item/completed", params: {
    threadId: "root",
    item: {
      id: "spawn-1",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      senderThreadId: "root",
      receiverThreadIds: ["child-1"],
      prompt: reviewPrompt,
      agentType: "reviewer",
      agentsStates: { "child-1": { status: "completed" } },
    },
  } })
  const admission = readJsonl(join(workdir, "ctx", "codex", "review-admission.jsonl")).at(-1)!
  expect(admission).toMatchObject({
    event: "review_terminal",
    taskId: "native-result-1",
    state: "completed",
    result: {
      schemaVersion: 1,
      artifactSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      outputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      outputBytes: 15,
    },
  })
  const artifactPath = (admission.result as { artifactPath: string }).artifactPath
  const originalArtifact = readFileSync(artifactPath, "utf8")
  expect(JSON.parse(originalArtifact)).toMatchObject({
    schemaVersion: 2,
    runId: "run-native-result",
    taskId: "native-result-1",
    mode: "native_v2",
    passKind: "review_shard",
    spawnItemId: "spawn-1",
    childThreadId: "child-1",
    childSessionId: "session-1",
    turnId: "child-turn",
    output: '{"findings":[]}',
  })
  await Bun.sleep(2)
  await supervisor.handleNotification({ method: "item/completed", params: {
    threadId: "root",
    item: {
      id: "spawn-1",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      senderThreadId: "root",
      receiverThreadIds: ["child-1"],
      prompt: reviewPrompt,
      agentType: "reviewer",
      agentsStates: { "child-1": { status: "completed" } },
    },
  } })
  expect(readFileSync(artifactPath, "utf8")).toBe(originalArtifact)
  expect(readJsonl(join(workdir, "ctx", "codex", "review-admission.jsonl")).filter((row) => row.event === "review_terminal")).toHaveLength(1)
  expect(supervisor.currentState).toBe("ROOT_RUNNING")
})

test("accepts non-spawn collaboration events and cancels a terminal child's provider stream", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-native-nonspawn-"))
  const appServer = { start: async () => ({ userAgent: "fake" }), request: async () => ({}), stop: async () => 0 } as unknown as CodexAppServer
  const cancelledThreads: string[] = []
  const supervisor = new Supervisor({
    appServer,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-native-nonspawn", prompt: "status",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 10_000,
    cancelProviderThread: async (threadId) => { cancelledThreads.push(threadId) },
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "root-turn", restartAttempts: 0 },
  })
  await supervisor.handleNotification({ method: "item/completed", params: { threadId: "root", item: {
    id: "spawn-1", type: "collabAgentToolCall", tool: "spawnAgent", senderThreadId: "root",
    receiverThreadIds: ["child-1"], agentsStates: { "child-1": { status: "running" } },
  } } })
  await supervisor.handleNotification({ method: "item/completed", params: { threadId: "root", item: {
    id: "wait-1", type: "collabAgentToolCall", tool: "wait", senderThreadId: "root",
    receiverThreadIds: ["child-1"], agentsStates: { "child-1": { status: "completed" } },
  } } })
  expect(supervisor.currentState).toBe("ROOT_RUNNING")
  expect(cancelledThreads).toEqual(["child-1"])
  expect(readJsonl(join(workdir, "ctx", "codex", "graph.jsonl")).at(-1)).toMatchObject({
    event: "edge_closed",
    childId: "child-1",
    terminalState: "completed",
  })
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8"))).toMatchObject({ state: "ROOT_RUNNING" })
})

test("closes native collaboration children reported as cancelled or canceled", async () => {
  for (const status of ["cancelled", "canceled"] as const) {
    const workdir = mkdtempSync(join(tmpdir(), `cchp-supervisor-native-${status}-`))
    const appServer = { start: async () => ({ userAgent: "fake" }), request: async () => ({}), stop: async () => 0 } as unknown as CodexAppServer
    const supervisor = new Supervisor({
      appServer,
      codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
      task: "manual", runId: `run-native-${status}`, prompt: "status",
      model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 10_000,
      resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "root-turn", restartAttempts: 0 },
    })
    await supervisor.handleNotification({ method: "item/completed", params: { threadId: "root", item: {
      id: "spawn-1", type: "collabAgentToolCall", tool: "spawnAgent", senderThreadId: "root",
      receiverThreadIds: ["child-1"], agentsStates: { "child-1": { status } },
    } } })

    expect(readJsonl(join(workdir, "ctx", "codex", "graph.jsonl")).at(-1)).toMatchObject({
      event: "edge_closed",
      childId: "child-1",
      state: "closed",
      terminalState: "interrupted",
    })
  }
})

test("fails closed before admission or graph mutation when a native child tries to spawn", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-native-depth-"))
  const appServer = { start: async () => ({ userAgent: "fake" }), request: async () => ({}), stop: async () => 0 } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "pr_opened", runId: "run-native-depth", prompt: "review",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 10_000,
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "root-turn", restartAttempts: 0 },
  })
  await supervisor.handleNotification({ method: "item/completed", params: { threadId: "child-1", item: {
    id: "spawn-grandchild", type: "collabAgentToolCall", tool: "spawnAgent", senderThreadId: "child-1",
    receiverThreadIds: ["grandchild-1"],
    prompt: 'CCHP_REVIEW_TASK_V1 {"task_id":"nested-task-1","pass_kind":"correctness"}\nreview',
    agentType: "reviewer",
    agentsStates: { "grandchild-1": { status: "running" } },
  } } })

  expect(supervisor.currentState).toBe("FAILED")
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8"))).toMatchObject({
    terminalReason: expect.stringContaining("native child delegation is forbidden"),
  })
  expect(existsSync(join(workdir, "ctx", "codex", "graph.jsonl"))).toBe(false)
  expect(existsSync(join(workdir, "ctx", "codex", "review-admission.jsonl"))).toBe(false)
})

test("fails closed when a non-spawn collaboration event references an unknown child", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-native-nonspawn-unknown-"))
  const appServer = { start: async () => ({ userAgent: "fake" }), request: async () => ({}), stop: async () => 0 } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-native-nonspawn-unknown", prompt: "status",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 10_000,
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "root-turn", restartAttempts: 0 },
  })
  await supervisor.handleNotification({ method: "item/completed", params: { threadId: "root", item: {
    id: "wait-1", type: "collabAgentToolCall", tool: "wait", senderThreadId: "root",
    receiverThreadIds: ["unknown-child"], agentsStates: { "unknown-child": { status: "completed" } },
  } } })
  expect(supervisor.currentState).toBe("FAILED")
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8"))).toMatchObject({
    terminalReason: expect.stringContaining("references unknown children: unknown-child"),
  })
})

test("fails closed when a pr_opened native spawn omits structured review identity", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-native-identity-missing-"))
  const appServer = { start: async () => ({ userAgent: "fake" }), request: async () => ({}), stop: async () => 0 } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "pr_opened", runId: "run-native-identity-missing", prompt: "review",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 10_000,
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "root-turn", restartAttempts: 0 },
  })
  await supervisor.handleNotification({ method: "item/completed", params: { threadId: "root", item: {
    id: "spawn-1", type: "collabAgentToolCall", tool: "spawnAgent", senderThreadId: "root",
    receiverThreadIds: ["child-1"], prompt: "review the patch", agentType: "reviewer",
    agentsStates: { "child-1": { status: "running" } },
  } } })
  expect(supervisor.currentState).toBe("FAILED")
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8"))).toMatchObject({
    terminalReason: expect.stringContaining("CCHP_REVIEW_TASK_V1 identity"),
  })
})

test("fails closed when a native review task changes pass kind after admission", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-native-identity-drift-"))
  const appServer = { start: async () => ({ userAgent: "fake" }), request: async () => ({}), stop: async () => 0 } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "pr_opened", runId: "run-native-identity-drift", prompt: "review",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 10_000,
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "root-turn", restartAttempts: 0 },
  })
  for (const passKind of ["review_shard", "correctness"]) {
    await supervisor.handleNotification({ method: "item/completed", params: { threadId: "root", item: {
      id: "spawn-1", type: "collabAgentToolCall", tool: "spawnAgent", senderThreadId: "root",
      receiverThreadIds: ["child-1"],
      prompt: `CCHP_REVIEW_TASK_V1 {"task_id":"stable-task-1","pass_kind":"${passKind}"}\nreview`,
      agentType: "reviewer",
      agentsStates: { "child-1": { status: "running" } },
    } } })
  }
  expect(supervisor.currentState).toBe("FAILED")
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8"))).toMatchObject({
    terminalReason: expect.stringContaining("identity drift"),
  })
})

test("fails closed when a duplicate native spawn drifts to a new spawn item", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-native-duplicate-"))
  const appServer = { start: async () => ({ userAgent: "fake" }), request: async () => ({}), stop: async () => 0 } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-native-duplicate", prompt: "status",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 10_000,
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "root-turn", restartAttempts: 0 },
  })
  for (const itemId of ["spawn-1", "spawn-2"]) {
    await supervisor.handleNotification({ method: "item/completed", params: { threadId: "root", item: {
      id: itemId, type: "collabAgentToolCall", tool: "spawnAgent", senderThreadId: "root",
      receiverThreadIds: ["child-1"], agentsStates: { "child-1": { status: "running" } },
    } } })
  }
  expect(supervisor.currentState).toBe("FAILED")
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8"))).toMatchObject({
    terminalReason: expect.stringContaining("already has spawn item spawn-1"),
  })
})

test("resumes one durable run in a second OS process without duplicating durable state", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-os-process-resume-"))
  const codexDir = join(workdir, "ctx", "codex")
  const graphPath = join(codexDir, "graph.jsonl")
  const usagePath = join(codexDir, "usage.jsonl")
  const todoPath = join(codexDir, "todo.json")
  const provenancePath = join(codexDir, "provenance.jsonl")
  const manifestPath = join(codexDir, "run-manifest.json")
  const terminalPath = join(codexDir, "terminal.json")

  const first = await runProcessResumePhase("seed", workdir)
  expect(first.exitCode).toBe(0)
  expect(first.stderr).toBe("")
  const phase1 = JSON.parse(readFileSync(join(workdir, "phase-1.json"), "utf8")) as {
    pid: number
    requests: string[]
    usage: Record<string, unknown>
  }
  expect(phase1.pid).toBe(first.pid)
  expect(phase1.requests.filter((method) => method === "thread/start")).toHaveLength(1)
  expect(phase1.requests.filter((method) => method === "turn/start")).toHaveLength(1)
  expect(phase1.requests).not.toContain("thread/resume")
  expect(phase1.usage).toMatchObject({ acceptedRaw: true, consumed: 100 })
  expect(existsSync(terminalPath)).toBe(false)
  expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
    runId: "run-process-resume",
    task: "manual",
    state: "ROOT_RUNNING",
    rootThreadId: "root",
    rootTurnId: "turn",
    restartAttempts: 0,
    usage: { consumed: 100 },
  })

  const graphBefore = readFileSync(graphPath, "utf8")
  const usageBefore = readFileSync(usagePath, "utf8")
  const todoBefore = readFileSync(todoPath, "utf8")
  const provenanceBeforeText = readFileSync(provenancePath, "utf8")
  const provenanceBefore = readJsonl(provenancePath)
  expect(readJsonl(graphPath).filter((row) => row.event === "edge_opened")).toHaveLength(1)
  expect(readJsonl(usagePath).filter((row) => row.kind === "raw_completion_usage")).toHaveLength(1)
  expect(JSON.parse(todoBefore)).toMatchObject({ revision: 1, rootThreadId: "root" })

  const second = await runProcessResumePhase("resume", workdir)
  expect(second.exitCode).toBe(0)
  expect(second.stderr).toBe("")
  expect(second.pid).not.toBe(first.pid)
  const phase2 = JSON.parse(second.stdout) as {
    pid: number
    recovery: Record<string, unknown>
    requests: Array<{ method: string; params?: Record<string, unknown> }>
    repeatedUsage: Record<string, unknown>
    result: Record<string, unknown>
  }
  expect(phase2.pid).toBe(second.pid)
  expect(phase2.recovery).toMatchObject({
    runId: "run-process-resume",
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "turn", restartAttempts: 0 },
  })
  const methods = phase2.requests.map(({ method }) => method)
  expect(methods.filter((method) => method === "thread/resume")).toHaveLength(2)
  expect(methods).not.toContain("thread/start")
  expect(methods).not.toContain("turn/start")
  expect(phase2.requests.find(({ method, params }) => method === "thread/resume" && params?.threadId === "root")?.params).toMatchObject({
    threadId: "root",
    model: "gpt-5.6-sol",
    modelProvider: "cchp",
    cwd: workdir,
    approvalPolicy: "never",
    sandbox: "read-only",
  })
  expect(phase2.requests).toContainEqual({ method: "thread/resume", params: { threadId: "child-1" } })
  expect(phase2.repeatedUsage).toMatchObject({ acceptedRaw: false, consumed: 100, blockingAnomalies: 0 })
  expect(phase2.result).toMatchObject({
    state: "SUCCEEDED",
    exitCode: 0,
    rootThreadId: "root",
    rootTurnId: "turn",
    usage: { consumed: 100, blockingAnomalies: 0 },
  })

  const graphAfter = readJsonl(graphPath)
  expect(readFileSync(graphPath, "utf8").startsWith(graphBefore)).toBe(true)
  expect(graphAfter.filter((row) => row.event === "edge_opened")).toHaveLength(1)
  expect(graphAfter.filter((row) => row.event === "edge_closed")).toHaveLength(1)
  expect(readFileSync(usagePath, "utf8")).toBe(usageBefore)
  expect(readFileSync(todoPath, "utf8")).toBe(todoBefore)

  const provenanceAfterText = readFileSync(provenancePath, "utf8")
  const provenanceAfter = readJsonl(provenancePath)
  expect(provenanceAfterText.startsWith(provenanceBeforeText)).toBe(true)
  expect(provenanceAfter[provenanceBefore.length]).toMatchObject({
    sequence: provenanceBefore.length + 1,
    eventId: `run-process-resume:${provenanceBefore.length + 1}`,
    event: "supervisor_process_resumed",
  })
  expect(provenanceAfter.map((row) => row.sequence)).toEqual(
    Array.from({ length: provenanceAfter.length }, (_, index) => index + 1),
  )
  expect(provenanceAfter.map((row) => row.eventId)).toEqual(
    provenanceAfter.map((row) => `run-process-resume:${row.sequence}`),
  )
  expect(new Set(provenanceAfter.map((row) => row.eventId)).size).toBe(provenanceAfter.length)
  expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
    runId: "run-process-resume",
    state: "SUCCEEDED",
    rootThreadId: "root",
    rootTurnId: "turn",
    usage: { consumed: 100, blockingAnomalies: 0 },
  })
  expect(existsSync(terminalPath)).toBe(true)
})

test("hydrates a nonterminal supervisor and resumes without starting a second root", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-resume-"))
  const requests: string[] = []
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string, params?: Record<string, unknown>) => {
      requests.push(method)
      if (method === "thread/resume") return { thread: { id: params?.threadId } }
      if (method === "thread/read") return { thread: { id: "root", turns: [{ id: "turn", status: "completed" }] } }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-resume", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1000,
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "turn", restartAttempts: 0 },
    deadlines: { wholeRunMs: 10_000, heartbeatMs: 20, reconcileMs: 20, noProgressWarningMs: 2_000, noProgressTerminalMs: 8_000 },
  })
  expect(await supervisor.run()).toMatchObject({ state: "SUCCEEDED", rootThreadId: "root", rootTurnId: "turn" })
  expect(requests).toContain("thread/resume")
  expect(requests).not.toContain("thread/start")
  expect(requests).not.toContain("turn/start")
})

test("restores raw response attribution so replayed provider usage does not become pending", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-usage-owner-"))
  const fake = { stop: async () => 0 } as unknown as CodexAppServer
  const base = {
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-usage-owner", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000,
    executionMode: "native_v2" as const,
  }
  const first = new Supervisor(base)
  await first.handleNotification({
    method: "rawResponse/completed",
    params: { threadId: "root", turnId: "turn", responseId: "response", usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } },
  })
  expect(first.currentUsage).toMatchObject({ consumed: 11, blockingAnomalies: 0 })

  const resumed = new Supervisor({
    ...base,
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "turn", restartAttempts: 0 },
  })
  await resumed.recordProviderUsage({
    providerId: "provider", model: "model", responseId: "response",
    inputTokens: 8, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 11,
  })

  expect(resumed.currentUsage).toMatchObject({ consumed: 11, blockingAnomalies: 0 })
  expect(JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-manifest.json"), "utf8")))
    .not.toHaveProperty("pendingProviderUsage")
})

test("fails closed when pending provider terminal usage changes before attribution", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-pending-usage-"))
  const fake = { stop: async () => 0 } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-pending-usage", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000,
    executionMode: "native_v2",
  })
  const observed = {
    providerId: "provider", model: "model", responseId: "response",
    inputTokens: 8, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 11,
  }
  await supervisor.recordProviderUsage(observed)
  await supervisor.recordProviderUsage({ ...observed, inputTokens: 96, totalTokens: 99 })

  expect(supervisor.currentState).toBe("FAILED")
  expect(supervisor.currentUsage).toMatchObject({ consumed: 0, blockingAnomalies: 1 })
  expect(readJsonl(join(workdir, "ctx", "codex", "usage.jsonl")).at(-1)).toMatchObject({
    kind: "token_anomaly",
    type: "terminal_usage_changed",
    responseId: "response",
  })
})

test("releases a duplicate pending provider observation's extra reservation", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-pending-duplicate-"))
  const fake = { stop: async () => 0 } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-pending-duplicate", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000,
    executionMode: "native_v2",
  })
  const firstAdmission = await supervisor.authorizeProviderRequest({ providerId: "provider", model: "model", contextWindow: 10 })
  const secondAdmission = await supervisor.authorizeProviderRequest({ providerId: "provider", model: "model", contextWindow: 10 })
  expect(firstAdmission.reservation).toBeDefined()
  expect(secondAdmission.reservation).toBeDefined()
  const observed = {
    providerId: "provider", model: "model", responseId: "pending-response",
    inputTokens: 8, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 11,
  }
  await supervisor.recordProviderUsage({ ...observed, reservation: firstAdmission.reservation })
  await supervisor.recordProviderUsage({ ...observed, reservation: secondAdmission.reservation })

  const rows = readJsonl(join(workdir, "ctx", "codex", "usage.jsonl"))
  expect(rows.filter((row) => row.kind === "reservation_released" && row.reservationId === secondAdmission.reservation?.reservationId)).toHaveLength(1)
  expect(rows.filter((row) => row.kind === "reservation_released" && row.reservationId === firstAdmission.reservation?.reservationId)).toHaveLength(0)
})

test("fences delayed provider callbacks from a prior writer generation", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-reservation-generation-"))
  const fake = { stop: async () => 0 } as unknown as CodexAppServer
  const base = {
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-reservation-generation", prompt: "status",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 1_000,
    executionMode: "native_v2" as const,
    resume: { state: "ROOT_RUNNING" as const, rootThreadId: "root", rootTurnId: "turn", restartAttempts: 0 },
  }
  const first = new Supervisor({
    ...base,
    writerFence: { writerId: "writer", generation: 1 },
  })
  const staleAdmission = await first.authorizeProviderRequest({
    providerId: "provider", model: "model", threadId: "root", turnId: "turn-stale", contextWindow: 10,
  })
  expect(staleAdmission.reservation).toBeDefined()

  const resumed = new Supervisor({
    ...base,
    writerFence: { writerId: "writer", generation: 2 },
  })
  expect(resumed.currentUsage).toMatchObject({ consumed: 10 })
  const currentAdmission = await resumed.authorizeProviderRequest({
    providerId: "provider", model: "model", threadId: "root", turnId: "turn-current", contextWindow: 20,
  })
  expect(currentAdmission.reservation).toBeDefined()

  await resumed.releaseProviderReservation(staleAdmission.reservation!, "delayed_generation_one_release")
  await resumed.recordProviderUsage({
    providerId: "provider", model: "model", responseId: "generation-one-response",
    threadId: "root", turnId: "turn-stale", reservation: staleAdmission.reservation,
    inputTokens: 4, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 6,
  })
  expect(resumed.currentUsage).toMatchObject({ consumed: 6 })

  const nextAdmission = await resumed.authorizeProviderRequest({
    providerId: "provider", model: "model", threadId: "root", turnId: "turn-current", contextWindow: 5,
  })
  expect(nextAdmission).toMatchObject({ allowed: true })
  expect(nextAdmission.reservation).toBeDefined()
  const rows = readJsonl(join(workdir, "ctx", "codex", "usage.jsonl"))
  expect(rows.filter((row) => row.kind === "reservation_recovered" && row.reservationId === staleAdmission.reservation?.reservationId)).toHaveLength(1)
  expect(rows.filter((row) => row.kind === "reservation_released" && row.reservationId === currentAdmission.reservation?.reservationId)).toHaveLength(0)
  expect(rows.filter((row) => row.kind === "reservation_released" && row.reservationId === nextAdmission.reservation?.reservationId)).toHaveLength(0)
  expect(rows.filter((row) => row.kind === "raw_completion_usage" && row.responseId === "generation-one-response")).toHaveLength(1)
})

test("fails closed when raw and provider terminal usage disagree in either arrival order", async () => {
  for (const providerFirst of [true, false]) {
    const workdir = mkdtempSync(join(tmpdir(), `cchp-supervisor-source-conflict-${providerFirst}-`))
    const fake = { stop: async () => 0 } as unknown as CodexAppServer
    const supervisor = new Supervisor({
      appServer: fake,
      codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
      task: "manual", runId: `run-source-conflict-${providerFirst}`, prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
      totalTokenBudget: 1_000,
      executionMode: "native_v2",
    })
    const provider = {
      providerId: "provider", model: "model", responseId: "response",
      inputTokens: 9, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 11,
    }
    const raw = {
      method: "rawResponse/completed",
      params: { threadId: "root", turnId: "turn", responseId: "response", usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } },
    }
    if (providerFirst) {
      await supervisor.recordProviderUsage(provider)
      await supervisor.handleNotification(raw)
    } else {
      await supervisor.handleNotification(raw)
      await supervisor.recordProviderUsage(provider)
    }
    expect(supervisor.currentState).toBe("FAILED")
    expect(supervisor.currentUsage.blockingAnomalies).toBe(1)
    expect(readJsonl(join(workdir, "ctx", "codex", "usage.jsonl")).at(-1)).toMatchObject({
      kind: "token_anomaly",
      type: "terminal_usage_changed",
      responseId: "response",
    })
  }
})

test("fails closed when provider metadata and raw event claim different response owners", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-owner-conflict-"))
  const fake = { stop: async () => 0 } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-owner-conflict", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000,
    executionMode: "native_v2",
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "turn", restartAttempts: 0 },
  })
  expect(await supervisor.recordProviderUsage({
    providerId: "provider", model: "model", responseId: "response",
    threadId: "root", turnId: "turn",
    inputTokens: 8, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 11,
  })).toMatchObject({ acceptedRaw: true, consumed: 11 })

  await supervisor.handleNotification({
    method: "rawResponse/completed",
    params: { threadId: "other", turnId: "other-turn", responseId: "response", usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } },
  })

  expect(supervisor.currentState).toBe("FAILED")
  expect(supervisor.currentUsage).toMatchObject({ consumed: 11, blockingAnomalies: 1 })
  expect(readJsonl(join(workdir, "ctx", "codex", "usage.jsonl")).at(-1)).toMatchObject({
    kind: "token_anomaly",
    type: "terminal_usage_changed",
    responseId: "response",
  })
})

test("durably enriches raw-first usage with provider provenance", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-usage-enrich-"))
  const fake = { stop: async () => 0 } as unknown as CodexAppServer
  const options = {
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-usage-enrich", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000,
    executionMode: "native_v2" as const,
  }
  const supervisor = new Supervisor(options)
  await supervisor.handleNotification({
    method: "rawResponse/completed",
    params: { threadId: "root", turnId: "turn", responseId: "response", usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } },
  })
  await supervisor.recordProviderUsage({
    providerId: "provider", model: "model", responseId: "response",
    inputTokens: 8, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 11,
  })
  expect(supervisor.currentUsage).toMatchObject({ consumed: 11, blockingAnomalies: 0 })
  const replayed = new Supervisor(options)
  expect(replayed.currentUsage).toMatchObject({ consumed: 11, blockingAnomalies: 0 })
  expect(readJsonl(join(workdir, "ctx", "codex", "usage.jsonl")).filter((row) => row.kind === "raw_completion_usage").at(-1))
    .toMatchObject({ responseId: "response", provider: "provider", model: "model" })
})

test("denies the next provider request before a projected token-budget overshoot", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-admission-"))
  let stops = 0
  const fake = { stop: async () => { stops++; return 0 } } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "ci_fix", runId: "run-admission", prompt: "fix", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000,
    tokenAdmissionFraction: 0.85,
    executionMode: "explicit_child",
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "turn", restartAttempts: 0 },
  })
  for (const [index, responseId] of ["first", "second"].entries()) {
    await supervisor.recordProviderUsage({
      providerId: "provider", model: "model", responseId,
      threadId: "root", turnId: `turn-${index + 1}`, inputTokens: 350,
      cachedInputTokens: 0, cacheWriteInputTokens: 0,
      outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 400,
    })
  }

  expect(await supervisor.authorizeProviderRequest({
    providerId: "provider", model: "model", threadId: "root", turnId: "turn-3", contextWindow: 372_000,
  })).toMatchObject({ allowed: false, reason: expect.stringContaining("projected_budget") })
  expect(supervisor.currentState).toBe("TOKEN_BUDGET_EXCEEDED")
  expect(supervisor.currentUsage).toMatchObject({ consumed: 800, responses: 2, turns: 2, admissionDenials: 1 })
  expect(stops).toBe(1)
  expect(readJsonl(join(workdir, "ctx", "codex", "supervisor.jsonl")).some((row) =>
    row.event === "provider_request_admission" && row.allowed === false && row.reason === "projected_budget",
  )).toBe(true)
})

test("backpressures projected admission while another provider request still owns a reservation", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-admission-backpressure-"))
  let stops = 0
  const fake = { stop: async () => { stops++; return 0 } } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "ci_fix", runId: "run-admission-backpressure", prompt: "fix",
    model: "gpt-5.6-sol", modelProvider: "cchp", totalTokenBudget: 1_000,
    tokenAdmissionFraction: 0.85,
    executionMode: "native_v2",
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "turn", restartAttempts: 0 },
  })
  const first = await supervisor.authorizeProviderRequest({
    providerId: "provider", model: "model", threadId: "root", turnId: "turn", contextWindow: 600,
  })
  expect(first.reservation).toBeDefined()

  let settled = false
  const queued = supervisor.authorizeProviderRequest({
    providerId: "provider", model: "model", threadId: "root", turnId: "turn", contextWindow: 300,
  }).finally(() => { settled = true })
  await Bun.sleep(10)
  expect(settled).toBeFalse()
  expect(supervisor.currentState).toBe("ROOT_RUNNING")

  await supervisor.releaseProviderReservation(first.reservation!, "first_request_completed")
  expect(await queued).toMatchObject({ allowed: true, reservation: expect.any(Object) })
  expect(supervisor.currentState).toBe("ROOT_RUNNING")
  expect(stops).toBe(0)
  expect(readJsonl(join(workdir, "ctx", "codex", "supervisor.jsonl")).some((row) =>
    row.event === "provider_request_backpressured" && row.reservedTokens === 600,
  )).toBeTrue()
})

test("whole-run timeout stops app-server even when turn interrupt never settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-interrupt-timeout-"))
  let stopped = 0
  let stopOptions: Record<string, number> | undefined
  const fake = {
    start: async () => ({}),
    request: async (method: string) => {
      if (method === "thread/start") return { thread: { id: "root" } }
      if (method === "turn/start") return { turn: { id: "turn" } }
      if (method === "turn/interrupt") return new Promise(() => {})
      return {}
    },
    stop: async (options?: Record<string, number>) => { stopped++; stopOptions = options; return 0 },
  } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-interrupt-timeout", prompt: "wait", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1_000,
    deadlines: {
      wholeRunMs: 20,
      interruptGraceMs: 30,
      heartbeatMs: 1_000,
      reconcileMs: 1_000,
      noProgressWarningMs: 1_000,
      noProgressTerminalMs: 2_000,
    },
  })

  const started = Date.now()
  expect(await supervisor.run()).toMatchObject({ state: "TIMED_OUT", exitCode: 124 })
  expect(Date.now() - started).toBeLessThan(500)
  expect(stopped).toBe(1)
  expect(stopOptions).toMatchObject({ interruptGraceMs: 0 })
  expect(stopOptions?.termGraceMs).toBeLessThanOrEqual(15_000)
  expect(stopOptions?.killGraceMs).toBeLessThanOrEqual(5_000)
})

test("settles LOST when a persisted root thread cannot be resumed", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-supervisor-resume-lost-"))
  const fake = {
    start: async () => ({ userAgent: "fake" }),
    request: async (method: string) => {
      if (method === "thread/resume") throw new Error("thread not found")
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  const supervisor = new Supervisor({
    appServer: fake,
    codexHome: join(workdir, "codex-home"), repoDir: workdir, workdir,
    task: "manual", runId: "run-resume-lost", prompt: "status", model: "gpt-5.6-sol", modelProvider: "cchp",
    totalTokenBudget: 1000,
    resume: { state: "ROOT_RUNNING", rootThreadId: "root", rootTurnId: "turn", restartAttempts: 0 },
    deadlines: { wholeRunMs: 10_000, heartbeatMs: 20, noProgressWarningMs: 2_000, noProgressTerminalMs: 8_000 },
  })
  expect(await supervisor.run()).toMatchObject({ state: "LOST", exitCode: 1, rootThreadId: "root", rootTurnId: "turn" })
})
