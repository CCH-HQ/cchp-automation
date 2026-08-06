#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { CodexAppServer } from "../../src/codex/app-server"
import { resolveRuntimeRecovery } from "../../src/codex/runtime"
import { Supervisor } from "../../src/codex/supervisor"

const phase = process.env.SUPERVISOR_FIXTURE_PHASE
const workdir = process.env.SUPERVISOR_FIXTURE_WORKDIR
if (!workdir) throw new Error("SUPERVISOR_FIXTURE_WORKDIR is required")
if (phase !== "seed" && phase !== "resume") throw new Error("SUPERVISOR_FIXTURE_PHASE must be seed or resume")

const runId = "run-process-resume"
const rootThreadId = "root"
const rootTurnId = "turn"
const childThreadId = "child-1"

const options = {
  codexHome: join(workdir, "codex-home"),
  repoDir: workdir,
  workdir,
  task: "manual",
  runId,
  prompt: "status",
  model: "gpt-5.6-sol",
  modelProvider: "cchp",
  totalTokenBudget: 1_000,
  deadlines: {
    wholeRunMs: 10_000,
    heartbeatMs: 1_000,
    reconcileMs: 5_000,
    noProgressWarningMs: 5_000,
    noProgressTerminalMs: 9_000,
  },
} as const

const collaboration = {
  method: "item/completed",
  params: {
    threadId: rootThreadId,
    item: {
      id: "spawn-1",
      type: "collabAgentToolCall",
      tool: "spawn_agent",
      senderThreadId: rootThreadId,
      receiverThreadIds: [childThreadId],
      agentsStates: { [childThreadId]: { status: "running" } },
    },
  },
} as const

const plan = {
  method: "turn/plan/updated",
  params: {
    threadId: rootThreadId,
    plan: [{ step: "inspect", status: "in_progress" }],
  },
} as const

const usage = {
  responseId: "resp-1",
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

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`)
    await Bun.sleep(10)
  }
}

if (phase === "seed") {
  const requests: string[] = []
  const fake = {
    start: async () => ({ userAgent: "seed-fake", pid: process.pid }),
    request: async (method: string, params?: Record<string, unknown>) => {
      requests.push(method)
      if (method === "thread/start") return { thread: { id: rootThreadId } }
      if (method === "turn/start") return { turn: { id: rootTurnId } }
      if (method === "thread/read") {
        return { thread: { id: params?.threadId, turns: [{ id: params?.threadId === rootThreadId ? rootTurnId : "child-turn", status: "inProgress" }] } }
      }
      return {}
    },
    stop: async () => 0,
  } as unknown as CodexAppServer
  const supervisor = new Supervisor({ ...options, appServer: fake })
  void supervisor.run()
  const manifestPath = join(workdir, "ctx", "codex", "run-manifest.json")
  await eventually(() => {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
      return manifest.state === "ROOT_RUNNING" && manifest.rootThreadId === rootThreadId && manifest.rootTurnId === rootTurnId
    } catch {
      return false
    }
  })
  await supervisor.handleNotification(collaboration)
  await supervisor.handleNotification(plan)
  const firstUsage = await supervisor.recordProviderUsage(usage)
  writeFileSync(join(workdir, "phase-1.json"), `${JSON.stringify({ pid: process.pid, requests, usage: firstUsage })}\n`, "utf8")
  process.exit(0)
}

const recovery = resolveRuntimeRecovery({ BOT_RUN_ID: runId }, workdir, "manual", () => "must-not-be-used")
if (!recovery.resume) throw new Error("expected a nonterminal durable run")
const requests: Array<{ method: string; params?: Record<string, unknown> }> = []
const fake = {
  start: async () => ({ userAgent: "resume-fake", pid: process.pid }),
  request: async (method: string, params?: Record<string, unknown>) => {
    requests.push({ method, params })
    if (method === "thread/resume") return { thread: { id: params?.threadId } }
    if (method === "thread/read" && params?.threadId === childThreadId) {
      return { thread: { id: childThreadId, turns: [{ id: "child-turn", status: "inProgress" }] } }
    }
    if (method === "thread/read") {
      return { thread: { id: rootThreadId, turns: [{ id: rootTurnId, status: "inProgress" }] } }
    }
    return {}
  },
  stop: async () => 0,
} as unknown as CodexAppServer
const supervisor = new Supervisor({ ...options, appServer: fake, resume: recovery.resume })
const run = supervisor.run()
await eventually(() => requests.some(({ method }) => method === "thread/resume"))
await supervisor.handleNotification(collaboration)
await supervisor.handleNotification(plan)
const repeatedUsage = await supervisor.recordProviderUsage(usage)
await supervisor.handleNotification({
  ...collaboration,
  params: {
    ...collaboration.params,
    item: { ...collaboration.params.item, agentsStates: { [childThreadId]: { status: "completed" } } },
  },
})
await supervisor.handleNotification({
  method: "turn/completed",
  params: { threadId: rootThreadId, turn: { id: rootTurnId, status: "completed" } },
})
const result = await run
process.stdout.write(`${JSON.stringify({ pid: process.pid, recovery, requests, repeatedUsage, result })}\n`)
