import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  CodexAppServer,
  type CodexAppServerExit,
  JsonRpcPeer,
  failClosedServerRequest,
} from "./app-server"
import { buildCodexEnvironment } from "./supervisor"
import { processIdentity, type ProcessIdentity } from "./run-lock"

const fakeCodex = resolve(import.meta.dir, "../../scripts/fixtures/fake-codex-app-server.ts")
const processRecordHmacKey = "ab".repeat(32)

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`)
    await Bun.sleep(10)
  }
}

test("correlates concurrent JSON-RPC responses and records notifications", async () => {
  const writes: string[] = []
  const notifications: Array<{ method: string; params: unknown }> = []
  const peer = new JsonRpcPeer({
    write: (line) => {
      writes.push(line)
    },
    onNotification: (notification) => {
      notifications.push(notification)
    },
    onServerRequest: failClosedServerRequest,
  })

  const first = peer.request("thread/start", { cwd: "/repo" })
  const second = peer.request("turn/start", { threadId: "thread_1", input: [] })
  const [firstWire, secondWire] = writes.map((line) => JSON.parse(line))
  await peer.accept({ jsonrpc: "2.0", id: secondWire.id, result: { turn: { id: "turn_1" } } })
  await peer.accept({ jsonrpc: "2.0", id: firstWire.id, result: { thread: { id: "thread_1" } } })
  await peer.accept({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread_1" } })

  expect(await first).toEqual({ thread: { id: "thread_1" } })
  expect(await second).toEqual({ turn: { id: "turn_1" } })
  expect(notifications).toEqual([{ method: "turn/started", params: { threadId: "thread_1" } }])
})

test("answers app-server approval requests fail-closed instead of leaving a turn hung", async () => {
  const writes: string[] = []
  const peer = new JsonRpcPeer({
    write: (line) => {
      writes.push(line)
    },
    onServerRequest: failClosedServerRequest,
  })

  await peer.accept({
    jsonrpc: "2.0",
    id: 77,
    method: "item/commandExecution/requestApproval",
    params: { command: "danger" },
  })
  expect(JSON.parse(writes[0]!)).toEqual({ jsonrpc: "2.0", id: 77, result: { decision: "decline" } })
})

test("drives typed app-server thread lifecycle requests through a real stdio process", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-app-server-"))
  const processRecordPath = join(root, "app-server-process.json")
  const notifications: string[] = []
  const exits: CodexAppServerExit[] = []
  const app = new CodexAppServer({
    codexBin: fakeCodex,
    codexHome: root,
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    onNotification: ({ method }) => {
      notifications.push(method)
    },
    onExit: (event) => {
      exits.push(event)
    },
    processRecordPath,
    processRecordHmacKey,
    runId: "run-app-server",
    writerFence: { writerId: "writer-1", generation: 3 },
    requestTimeoutMs: 1_000,
  })
  try {
    expect(await app.start()).toEqual({ userAgent: "fake-codex-app-server" })
    const processRecord = JSON.parse(readFileSync(processRecordPath, "utf8")) as Record<string, unknown>
    expect(processRecord).toMatchObject({ schemaVersion: 3, pid: app.pid, pgid: app.pid, runId: "run-app-server", writerId: "writer-1", writerGeneration: 3 })
    expect(processRecord.mac).toMatch(/^[a-f0-9]{64}$/)
    expect(processRecord.sessionToken).toMatch(/^[a-f0-9]{64}$/)
    expect(typeof processRecord.startTicks).toBe("string")
    expect(typeof processRecord.bootId).toBe("string")
    expect(await app.threadRead("thread-1", true)).toEqual({
      thread: { id: "thread-1", status: "idle" },
    })
    expect(await app.threadResume({
      threadId: "thread-1",
      model: "gpt-5.6-sol",
      modelProvider: "cchp",
      cwd: root,
      approvalPolicy: "never",
      sandbox: "read-only",
    })).toEqual({
      thread: { id: "thread-1", status: "idle" },
      model: "gpt-5.6-sol",
      modelProvider: "cchp",
      cwd: root,
    })
    expect(await app.interruptTurn("thread-1", "turn-1")).toEqual({})
    expect(await app.threadDelete("thread-1")).toEqual({})
    await eventually(() => notifications.includes("thread/deleted"))
    await app.stop({ interruptGraceMs: 100, termGraceMs: 100, killGraceMs: 1_000 })
    await eventually(() => exits.length === 1)
    expect(exits[0]).toMatchObject({ expected: true, reason: "process_exit" })
  } finally {
    await app.stop({ interruptGraceMs: 10, termGraceMs: 10, killGraceMs: 100 }).catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test("launches the real app-server subprocess without caller credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-app-server-env-"))
  const app = new CodexAppServer({
    codexBin: fakeCodex,
    codexHome: root,
    cwd: root,
    env: buildCodexEnvironment({
      PATH: process.env.PATH ?? "",
      HOME: root,
      BOT_REPO: "CCH-HQ/fixture",
      CCHP_CODEX_BRIDGE_TOKEN: "bridge-sentinel",
      GH_TOKEN: "github-sentinel",
      CCHP_GH_TOKEN_FILE: "/secret/token",
      CCHP_BOT_PROVIDER_KEYS: "provider-sentinel",
      CCHP_BOT_PROVIDERS: "provider-config-sentinel",
      CCHP_PK_GPT_CCHP: "provider-key-sentinel",
      CCHP_APP_CLIENT_ID: "app-client-sentinel",
      CCHP_APP_PRIVATE_KEY: "app-private-sentinel",
      SEE_API_KEY: "see-sentinel",
      HEROUI_AUTH_TOKEN: "heroui-sentinel",
      CCHP_PROCESS_RECORD_HMAC_KEY: processRecordHmacKey,
      UNRELATED_SECRET: "unrelated-sentinel",
    }),
    onNotification: () => undefined,
  })
  try {
    await app.start()
    const environ = readFileSync(`/proc/${app.pid}/environ`, "utf8").split("\0")
    expect(environ).toContain("CCHP_CODEX_BRIDGE_TOKEN=bridge-sentinel")
    expect(environ).toContain("BOT_REPO=CCH-HQ/fixture")
    const joined = environ.join("\n")
    for (const forbidden of [
      "GH_TOKEN", "CCHP_GH_TOKEN_FILE", "CCHP_BOT_PROVIDER_KEYS", "CCHP_BOT_PROVIDERS",
      "CCHP_PK_GPT_CCHP", "CCHP_APP_CLIENT_ID", "CCHP_APP_PRIVATE_KEY", "SEE_API_KEY",
      "HEROUI_AUTH_TOKEN", "UNRELATED_SECRET", "github-sentinel", "provider-sentinel",
      "CCHP_PROCESS_RECORD_HMAC_KEY", processRecordHmacKey,
      "provider-config-sentinel", "provider-key-sentinel", "app-client-sentinel",
      "app-private-sentinel", "see-sentinel", "heroui-sentinel", "unrelated-sentinel",
    ]) expect(joined).not.toContain(forbidden)
  } finally {
    await app.stop({ interruptGraceMs: 100, termGraceMs: 100, killGraceMs: 1_000 }).catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test("reports crash, malformed protocol and exit without hanging pending RPC", async () => {
  for (const scenario of ["crash", "malformed", "exit_pending"] as const) {
    const root = mkdtempSync(join(tmpdir(), `cchp-app-server-${scenario}-`))
    const exits: CodexAppServerExit[] = []
    const app = new CodexAppServer({
      codexBin: fakeCodex,
      codexHome: root,
      cwd: root,
      env: { PATH: process.env.PATH ?? "", FAKE_CODEX_SCENARIO: scenario },
      onNotification: () => undefined,
      onExit: (event) => {
        exits.push(event)
      },
      requestTimeoutMs: 1_000,
    })
    try {
      await app.start()
      if (scenario === "exit_pending") {
        await expect(app.threadRead("thread-1")).rejects.toThrow(/stdout closed|process exited/)
      }
      await eventually(() => exits.length === 1)
      expect(exits).toHaveLength(1)
      if (scenario === "crash") {
        expect(exits[0]).toMatchObject({ expected: false, reason: "process_exit", exitCode: 23 })
      } else if (scenario === "malformed") {
        expect(exits[0]).toMatchObject({ expected: false, reason: "protocol_error" })
      } else {
        expect(exits[0]).toMatchObject({ expected: false, reason: "process_exit", exitCode: 0 })
      }
    } finally {
      await app.stop({ interruptGraceMs: 10, termGraceMs: 10, killGraceMs: 1_000 }).catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test("escalates from INT to TERM to KILL for the whole detached process group", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-app-server-kill-"))
  const trace = join(root, "signals.log")
  const descendantPath = join(root, "descendant.pid")
  const app = new CodexAppServer({
    codexBin: fakeCodex,
    codexHome: root,
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      FAKE_CODEX_SCENARIO: "ignore_signals",
      FAKE_CODEX_TRACE: trace,
      FAKE_CODEX_DESCENDANT_PID: descendantPath,
    },
    onNotification: () => undefined,
    requestTimeoutMs: 1_000,
  })
  try {
    await app.start()
    await eventually(() => existsSync(descendantPath))
    const descendantPid = Number(readFileSync(descendantPath, "utf8").trim())
    await app.stop({ interruptGraceMs: 50, termGraceMs: 50, killGraceMs: 1_000 })
    const signals = readFileSync(trace, "utf8")
    expect(signals).toContain("SIGINT")
    expect(signals).toContain("SIGTERM")
    await eventually(() => {
      try {
        process.kill(descendantPid, 0)
        return false
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
      }
    })
  } finally {
    await app.stop({ interruptGraceMs: 10, termGraceMs: 10, killGraceMs: 100 }).catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test("stops an MCP-like descendant moved to another process group in the owned session", async () => {
  if (process.platform !== "linux") return
  const root = mkdtempSync(join(tmpdir(), "cchp-app-server-session-"))
  const descendantPath = join(root, "descendant.pid")
  let descendantPid: number | undefined
  const app = new CodexAppServer({
    codexBin: fakeCodex,
    codexHome: root,
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      FAKE_CODEX_SCENARIO: "separate_process_group",
      FAKE_CODEX_DESCENDANT_PID: descendantPath,
    },
    onNotification: () => undefined,
    requestTimeoutMs: 1_000,
  })
  try {
    await app.start()
    await eventually(() => existsSync(descendantPath))
    descendantPid = Number(readFileSync(descendantPath, "utf8").trim())
    await eventually(() => {
      const stat = readFileSync(`/proc/${descendantPid}/stat`, "utf8")
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)
      return Number(fields[2]) === descendantPid && Number(fields[3]) === app.pid
    })
    await app.stop({ interruptGraceMs: 100, termGraceMs: 100, killGraceMs: 1_000 })
    await eventually(() => {
      try {
        process.kill(descendantPid!, 0)
        return false
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
      }
    })
  } finally {
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL") } catch { /* already stopped */ }
    }
    await app.stop({ interruptGraceMs: 10, termGraceMs: 10, killGraceMs: 100 }).catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test("refuses to signal an app-server process after its recorded identity drifts", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-app-server-identity-drift-"))
  const processRecordPath = join(root, "app-server-process.json")
  const app = new CodexAppServer({
    codexBin: fakeCodex,
    codexHome: root,
    cwd: root,
    env: { PATH: process.env.PATH ?? "", FAKE_CODEX_SCENARIO: "ignore_signals" },
    onNotification: () => undefined,
    processRecordPath,
    processRecordHmacKey,
    runId: "run-identity-drift",
    requestTimeoutMs: 1_000,
  })
  const internals = app as unknown as { launchedIdentity?: ProcessIdentity }
  try {
    await app.start()
    const pid = app.pid!
    internals.launchedIdentity = { ...internals.launchedIdentity!, startTicks: "reused" }
    await expect(app.stop({ interruptGraceMs: 10, termGraceMs: 10, killGraceMs: 10 }))
      .rejects.toThrow("unproven Codex app-server process group")
    expect(existsSync(processRecordPath)).toBeTrue()
    expect(() => process.kill(pid, 0)).not.toThrow()
    internals.launchedIdentity = processIdentity(pid)
    await app.stop({ interruptGraceMs: 50, termGraceMs: 50, killGraceMs: 1_000 })
    expect(existsSync(processRecordPath)).toBeFalse()
  } finally {
    if (app.pid) {
      internals.launchedIdentity = processIdentity(app.pid)
      await app.stop({ interruptGraceMs: 10, termGraceMs: 10, killGraceMs: 1_000 }).catch(() => undefined)
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test("does not synthesize an owned process group for an absent Linux session", () => {
  if (process.platform !== "linux") return
  const app = new CodexAppServer({
    codexBin: fakeCodex,
    codexHome: tmpdir(),
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "" },
    onNotification: () => undefined,
  })
  const missingSession = 2_147_483_646
  const internals = app as unknown as {
    launchedIdentity?: ProcessIdentity
    sessionToken?: string
    processGroupOwnership(pgid: number): "live" | "absent" | "unproven"
  }
  internals.launchedIdentity = { pid: missingSession, startTicks: "missing", bootId: "missing" }
  internals.sessionToken = "ef".repeat(32)
  expect(internals.processGroupOwnership(missingSession)).toBe("absent")
})

test("cleans up descendants and the process record after the app-server leader exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-app-server-leader-exit-"))
  const processRecordPath = join(root, "app-server-process.json")
  const descendantPath = join(root, "descendant.pid")
  let descendantPid: number | undefined
  const app = new CodexAppServer({
    codexBin: fakeCodex,
    codexHome: root,
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      FAKE_CODEX_SCENARIO: "leader_exits",
      FAKE_CODEX_DESCENDANT_PID: descendantPath,
    },
    onNotification: () => undefined,
    processRecordPath,
    processRecordHmacKey,
    runId: "run-leader-exit",
    requestTimeoutMs: 1_000,
  })
  try {
    await app.start().catch(() => undefined)
    await eventually(() => existsSync(descendantPath))
    await eventually(() => existsSync(processRecordPath))
    const leaderPid = app.pid!
    descendantPid = Number(readFileSync(descendantPath, "utf8").trim())
    await eventually(() => {
      try {
        const stat = readFileSync(`/proc/${leaderPid}/stat`, "utf8")
        return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[0] === "Z"
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
      }
    })
    await app.stop({ interruptGraceMs: 25, termGraceMs: 25, killGraceMs: 1_000 })
    expect(existsSync(processRecordPath)).toBeFalse()
    await eventually(() => {
      try {
        process.kill(descendantPid!, 0)
        return false
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
      }
    })
  } finally {
    if (app.pid) try { process.kill(-app.pid, "SIGKILL") } catch { /* the test group may already be gone */ }
    await eventually(() => {
      if (!descendantPid) return true
      try {
        process.kill(descendantPid, 0)
        return false
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
      }
    }).catch(() => undefined)
    await app.stop({ interruptGraceMs: 10, termGraceMs: 10, killGraceMs: 100 }).catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test("refuses a second app-server without replacing the first process record", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-app-server-exclusive-record-"))
  const processRecordPath = join(root, "app-server-process.json")
  const options = {
    codexBin: fakeCodex,
    codexHome: root,
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    onNotification: () => undefined,
    processRecordPath,
    processRecordHmacKey,
    runId: "run-exclusive-record",
    requestTimeoutMs: 1_000,
  }
  const first = new CodexAppServer(options)
  const second = new CodexAppServer(options)
  try {
    await first.start()
    const originalRecord = readFileSync(processRecordPath, "utf8")
    await expect(second.start()).rejects.toThrow()
    expect(readFileSync(processRecordPath, "utf8")).toBe(originalRecord)
    expect(first.pid).toBeNumber()
    expect(() => process.kill(first.pid!, 0)).not.toThrow()
  } finally {
    await second.stop({ interruptGraceMs: 10, termGraceMs: 10, killGraceMs: 100 }).catch(() => undefined)
    await first.stop({ interruptGraceMs: 100, termGraceMs: 100, killGraceMs: 1_000 }).catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test("retains a failed shutdown handle and process record so stop can be retried", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-app-server-retry-stop-"))
  const processRecordPath = join(root, "app-server-process.json")
  const app = new CodexAppServer({
    codexBin: fakeCodex,
    codexHome: root,
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    onNotification: () => undefined,
    processRecordPath,
    processRecordHmacKey,
    runId: "run-retry-stop",
    requestTimeoutMs: 1_000,
  })
  const internals = app as unknown as {
    signalProcessGroup: (child: unknown, signal: NodeJS.Signals) => void
    waitForProcessGroupExit: (pgid: number, timeoutMs: number) => Promise<boolean>
  }
  try {
    await app.start()
    const pid = app.pid!
    const signalProcessGroup = internals.signalProcessGroup.bind(app)
    const waitForProcessGroupExit = internals.waitForProcessGroupExit.bind(app)
    internals.signalProcessGroup = () => undefined
    internals.waitForProcessGroupExit = async () => false
    await expect(app.stop({ interruptGraceMs: 1, termGraceMs: 1, killGraceMs: 1 })).rejects.toThrow("did not exit after SIGKILL")
    expect(app.pid).toBe(pid)
    expect(existsSync(processRecordPath)).toBeTrue()
    await expect(app.start()).rejects.toThrow("already started")
    internals.signalProcessGroup = signalProcessGroup
    internals.waitForProcessGroupExit = waitForProcessGroupExit
    await app.stop({ interruptGraceMs: 100, termGraceMs: 100, killGraceMs: 1_000 })
    expect(app.pid).toBeUndefined()
    expect(existsSync(processRecordPath)).toBeFalse()
  } finally {
    await app.stop({ interruptGraceMs: 10, termGraceMs: 10, killGraceMs: 1_000 }).catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test("preserves a replacement process record swapped in before conditional removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-app-server-record-swap-"))
  const processRecordPath = join(root, "app-server-process.json")
  const originalRecordPath = join(root, "app-server-process.original.json")
  const replacement = '{"schemaVersion":2,"runId":"new-owner","mac":"' + "cd".repeat(32) + '"}\n'
  let swapped = false
  const app = new CodexAppServer({
    codexBin: fakeCodex,
    codexHome: root,
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    onNotification: () => undefined,
    processRecordPath,
    processRecordHmacKey,
    runId: "run-record-swap",
    requestTimeoutMs: 1_000,
    beforeProcessRecordRemoval: () => {
      if (swapped) return
      swapped = true
      renameSync(processRecordPath, originalRecordPath)
      writeFileSync(processRecordPath, replacement)
    },
  })
  try {
    await app.start()
    await expect(app.stop({ interruptGraceMs: 100, termGraceMs: 100, killGraceMs: 1_000 })).rejects.toThrow("changed before removal")
    expect(readFileSync(processRecordPath, "utf8")).toBe(replacement)
    expect(existsSync(originalRecordPath)).toBeTrue()
  } finally {
    await app.stop({ interruptGraceMs: 10, termGraceMs: 10, killGraceMs: 100 }).catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})
