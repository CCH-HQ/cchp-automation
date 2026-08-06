import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  CodexAppServer,
  type CodexAppServerExit,
  JsonRpcPeer,
  failClosedServerRequest,
} from "./app-server"
import { buildCodexEnvironment } from "./supervisor"

const fakeCodex = resolve(import.meta.dir, "../../scripts/fixtures/fake-codex-app-server.ts")

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
    runId: "run-app-server",
    writerFence: { writerId: "writer-1", generation: 3 },
    requestTimeoutMs: 1_000,
  })
  try {
    expect(await app.start()).toEqual({ userAgent: "fake-codex-app-server" })
    const processRecord = JSON.parse(readFileSync(processRecordPath, "utf8")) as Record<string, unknown>
    expect(processRecord).toMatchObject({ schemaVersion: 1, pid: app.pid, pgid: app.pid, runId: "run-app-server", writerId: "writer-1", writerGeneration: 3 })
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
