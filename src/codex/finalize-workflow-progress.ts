#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { join } from "node:path"
import { makeOctokit, type GitHubClient } from "../github/client"
import { openRegularFileSnapshot } from "./file-snapshot"
import { createTerminalProgressPublisher, redactRuntimeDiagnostic } from "./runtime"
import type { SupervisorResult, SupervisorState } from "./supervisor"

type Env = Record<string, string | undefined>
type StepName = "write" | "install" | "prepare" | "scan" | "capability" | "supervisor"

const TERMINAL_STATES = new Set<SupervisorState>([
  "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "LOST", "TOKEN_BUDGET_EXCEEDED",
  "NO_PROGRESS_TIMEOUT",
])

const ZERO_USAGE: SupervisorResult["usage"] = {
  acceptedRaw: false,
  consumed: 0,
  limit: 0,
  fraction: 0,
  state: "normal",
  blockingAnomalies: 0,
  responses: 0,
  turns: 0,
  admissionDenials: 0,
}

export interface WorkflowStepOutcomes {
  write: string
  needsWrite: boolean
  install: string
  prepare: string
  scan: string
  capability: string
  supervisor: string
  cancelled: boolean
}

export function workflowStepOutcomes(env: Env): WorkflowStepOutcomes {
  return {
    write: env.CCHP_WRITE_OUTCOME ?? "",
    needsWrite: env.CCHP_NEEDS_WRITE === "true" || env.CCHP_NEEDS_WRITE === "1",
    install: env.CCHP_INSTALL_OUTCOME ?? "",
    prepare: env.CCHP_PREPARE_OUTCOME ?? "",
    scan: env.CCHP_SCAN_OUTCOME ?? "",
    capability: env.CCHP_CAPABILITY_OUTCOME ?? "",
    supervisor: env.CCHP_SUPERVISOR_OUTCOME ?? "",
    cancelled: env.CCHP_JOB_CANCELLED === "true",
  }
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function readSupervisorTerminal(
  path: string,
  redact: (value: string) => string = (value) => redactRuntimeDiagnostic(value, []),
): Pick<SupervisorResult, "state" | "terminalReason" | "usage"> | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(openRegularFileSnapshot(path).bytes.toString("utf8")) as Record<string, unknown>
    if (typeof parsed.state !== "string" || !TERMINAL_STATES.has(parsed.state as SupervisorState)) return undefined
    const state = parsed.state as SupervisorState
    const rawUsage = parsed.usage && typeof parsed.usage === "object" && !Array.isArray(parsed.usage)
      ? parsed.usage as Record<string, unknown>
      : {}
    const consumed = finiteNonNegative(rawUsage.consumed)
    const limit = finiteNonNegative(rawUsage.limit)
    if (consumed == null || limit == null) return undefined
    return {
      state,
      ...(typeof parsed.terminalReason === "string" ? { terminalReason: redact(parsed.terminalReason) } : {}),
      usage: {
        ...ZERO_USAGE,
        consumed,
        limit,
        fraction: limit > 0 ? consumed / limit : 0,
      },
    }
  } catch {
    return undefined
  }
}

export function resolveWorkflowTerminal(
  outcomes: WorkflowStepOutcomes,
  supervisorTerminal?: Pick<SupervisorResult, "state" | "terminalReason" | "usage">,
): Pick<SupervisorResult, "state" | "terminalReason" | "usage"> {
  if (outcomes.needsWrite && outcomes.write !== "success") {
    if (outcomes.cancelled || outcomes.write === "cancelled") {
      return { state: "CANCELLED", terminalReason: "workflow write credential step was cancelled", usage: ZERO_USAGE }
    }
    return {
      state: "FAILED",
      terminalReason: `write credential setup ${outcomes.write || "did not run"}`,
      usage: ZERO_USAGE,
    }
  }
  const steps: Array<[StepName, string, SupervisorState]> = [
    ["install", outcomes.install, "FAILED"],
    ["prepare", outcomes.prepare, "FAILED"],
    ["scan", outcomes.scan, "FAILED"],
    ["capability", outcomes.capability, "FAILED"],
  ]
  for (const [step, outcome, state] of steps) {
    if (outcome === "success") continue
    if (outcomes.cancelled || outcome === "cancelled") {
      return { state: "CANCELLED", terminalReason: `workflow ${step} step was cancelled`, usage: ZERO_USAGE }
    }
    const label = step === "install"
      ? "Codex setup"
      : step === "prepare"
        ? "environment preparation"
        : step === "scan"
          ? "external static analysis"
          : "Codex capability gate"
    return { state, terminalReason: `${label} ${outcome || "did not run"}`, usage: ZERO_USAGE }
  }

  if (outcomes.cancelled || outcomes.supervisor === "cancelled") {
    return { state: "CANCELLED", terminalReason: "Codex supervisor workflow step was cancelled", usage: ZERO_USAGE }
  }
  if (supervisorTerminal) {
    if (supervisorTerminal.state === "SUCCEEDED" && outcomes.supervisor !== "success") {
      return {
        state: "FAILED",
        terminalReason: "Codex supervisor wrapper failed after the runtime reported success",
        usage: supervisorTerminal.usage,
      }
    }
    return supervisorTerminal
  }
  return {
    state: "FAILED",
    terminalReason: outcomes.supervisor === "success"
      ? "Codex supervisor completed without a valid terminal artifact"
      : `Codex supervisor ${outcomes.supervisor || "did not run"}`,
    usage: ZERO_USAGE,
  }
}

export async function finalizeWorkflowProgress(
  env: Env = process.env,
  client?: GitHubClient,
): Promise<"published" | "skipped"> {
  const token = env.GH_TOKEN
  if (!token && !client) throw new Error("GH_TOKEN is required for workflow progress finalization")
  const workdir = env.BOT_WORKDIR
  if (!workdir) throw new Error("BOT_WORKDIR is required for workflow progress finalization")
  const redact = (value: string) => redactRuntimeDiagnostic(value, token ? [token] : [])
  const terminal = readSupervisorTerminal(join(workdir, "ctx", "codex", "terminal.json"), redact)
  const result = resolveWorkflowTerminal(workflowStepOutcomes(env), terminal)
  if (env.BOT_TASK === "pr_opened" && result.state === "SUCCEEDED") {
    process.stderr.write("[workflow-finalizer] finalized review already owns the successful PR summary\n")
    return "skipped"
  }
  const publish = createTerminalProgressPublisher(env, client ?? makeOctokit(token!), redact)
  if (!publish) {
    process.stderr.write("[workflow-finalizer] no trusted progress target; nothing to finalize\n")
    return "skipped"
  }
  const published = await publish(result)
  process.stderr.write(`[workflow-finalizer] ${published ? "published" : "skipped"} state=${result.state}\n`)
  return published ? "published" : "skipped"
}

if (import.meta.main) {
  finalizeWorkflowProgress().catch((error) => {
    process.stderr.write(`[workflow-finalizer] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
