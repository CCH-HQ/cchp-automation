import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startCodexExec } from "./exec-adapter"

const fakeCodex = resolve(import.meta.dir, "../../scripts/fixtures/fake-codex-exec.ts")
chmodSync(fakeCodex, 0o755)

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`)
    await Bun.sleep(10)
  }
}

test("starts a resumable Codex exec turn and drains ordered JSONL before completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-exec-"))
  const trace = join(root, "trace.jsonl")
  const observed: string[] = []
  try {
    const run = startCodexExec({
      codexBin: fakeCodex,
      cwd: root,
      env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_TRACE: trace },
      prompt: "inspect the fixture",
      sandbox: "read-only",
      profile: "explorer",
      strictConfig: true,
      ignoreUserConfig: true,
      onEvent: async (event) => {
        await Bun.sleep(1)
        observed.push(event.source)
      },
    })

    expect(run.pid).toBeGreaterThan(0)
    expect(await run.started).toEqual({ sessionId: "thread-fixture" })
    expect(await run.completed).toMatchObject({
      exitCode: 0,
      signal: null,
      sessionId: "thread-fixture",
      terminal: "completed",
      lastMessage: "completed:inspect the fixture",
    })
    expect(observed).toEqual(["thread.started", "turn.started", "item.completed", "turn.completed"])

    const invocation = JSON.parse(readFileSync(trace, "utf8").trim()) as {
      argv: string[]
      prompt: string
      cwd: string
    }
    expect(invocation.argv).toEqual([
      "exec",
      "--json",
      "--strict-config",
      "--ignore-user-config",
      "--profile",
      "explorer",
      "--sandbox",
      "read-only",
      "-",
    ])
    expect(invocation.prompt).toBe("inspect the fixture\n")
    expect(invocation.cwd).toBe(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("resumes the same Codex session without passing a new sandbox flag", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-exec-resume-"))
  const trace = join(root, "trace.jsonl")
  try {
    const result = await startCodexExec({
      codexBin: fakeCodex,
      cwd: root,
      env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_TRACE: trace },
      prompt: "continue",
      resumeSessionId: "thread-existing",
      sandbox: "workspace-write",
    }).completed

    expect(result).toMatchObject({ sessionId: "thread-existing", terminal: "completed" })
    const invocation = JSON.parse(readFileSync(trace, "utf8").trim()) as { argv: string[] }
    expect(invocation.argv).toEqual([
      "exec",
      "--json",
      "--strict-config",
      "resume",
      "thread-existing",
      "-",
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("fails closed on malformed, unknown and missing-terminal JSONL", async () => {
  for (const scenario of ["malformed", "unknown", "missing_terminal"] as const) {
    const root = mkdtempSync(join(tmpdir(), `cchp-exec-${scenario}-`))
    try {
      const run = startCodexExec({
        codexBin: fakeCodex,
        cwd: root,
        env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_SCENARIO: scenario },
        prompt: "fixture",
        interruptGraceMs: 20,
        termGraceMs: 20,
        killGraceMs: 500,
      })
      await expect(run.completed).rejects.toThrow(
        scenario === "malformed" ? "malformed JSONL" : scenario === "unknown" ? "unexpected codex exec event" : "without a terminal turn event",
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test("preserves a failed terminal result without exposing its partial message", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-exec-failed-"))
  try {
    const result = await startCodexExec({
      codexBin: fakeCodex,
      cwd: root,
      env: { PATH: process.env.PATH ?? "", FAKE_CODEX_EXEC_SCENARIO: "failed" },
      prompt: "fixture",
    }).completed
    expect(result).toMatchObject({ exitCode: 1, terminal: "failed", sessionId: "thread-fixture" })
    expect(result.lastMessage).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("times out with bounded process-group escalation and removes descendants", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-exec-timeout-"))
  const trace = join(root, "trace.jsonl")
  const descendantPath = join(root, "descendant.pid")
  try {
    const run = startCodexExec({
      codexBin: fakeCodex,
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        FAKE_CODEX_EXEC_SCENARIO: "hang",
        FAKE_CODEX_EXEC_TRACE: trace,
        FAKE_CODEX_EXEC_DESCENDANT_PID: descendantPath,
      },
      prompt: "fixture",
      timeoutMs: 80,
      interruptGraceMs: 40,
      termGraceMs: 40,
      killGraceMs: 1_000,
    })
    const completion = expect(run.completed).rejects.toThrow("codex exec exceeded 80ms")
    await run.started
    await eventually(() => existsSync(descendantPath))
    const descendantPid = Number(readFileSync(descendantPath, "utf8").trim())
    await completion
    const traceText = readFileSync(trace, "utf8")
    expect(traceText).toContain("SIGINT")
    expect(traceText).toContain("SIGTERM")
    await eventually(() => {
      try {
        process.kill(descendantPid, 0)
        return false
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
      }
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("consumes asynchronous spawn errors when the Codex executable is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-exec-missing-"))
  try {
    expect(() => startCodexExec({
      codexBin: join(root, "missing-codex"),
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      prompt: "fixture",
    })).toThrow("did not return a process id")
    await Bun.sleep(50)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("consumes asynchronous spawn errors when the Codex executable is not executable", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-exec-eacces-"))
  const binary = join(root, "codex")
  try {
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o644 })
    expect(() => startCodexExec({
      codexBin: binary,
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      prompt: "fixture",
    })).toThrow("did not return a process id")
    await Bun.sleep(50)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("rejects a closed stdin EPIPE through completed without an uncaught process error", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-exec-epipe-"))
  try {
    const run = startCodexExec({
      codexBin: "/bin/true",
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      prompt: "x".repeat(8 * 1024 * 1024),
    })
    await expect(run.completed).rejects.toMatchObject({ code: "EPIPE" })
    await Bun.sleep(20)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
