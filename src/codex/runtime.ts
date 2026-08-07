#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { splitRepo } from "../context"
import { makeOctokit, type GitHubClient, type TokenSource } from "../github/client"
import { hideProcEnviron, startTokenRotation } from "../github/token-rotation"
import { startGitHubBroker } from "../mcp/github-broker"
import { reviewPublicationBundle } from "../mcp/server"
import { publishFinalizedReview } from "../publish/finalized-review"
import { progressMarkerKey, renderTerminalProgress, upsertSticky } from "../publish/sticky"
import { finalizeReview, selectFinalizerProvenance } from "../review/finalize"
import { TASKS, type Task } from "../types"
import { parseCallerContract } from "./caller-contract"
import { decideCollaborationMode, writeCapabilityDecision } from "./capability"
import { prepareCodexHome } from "./config"
import { exitCodeFor } from "./exit"
import { loadExtraInstructions, renderCallerOverlay, renderInstructionOverlay } from "./instructions"
import { permissionForTask, type TaskPermissionProfile } from "./permissions"
import { ProvenanceLedger } from "./provenance"
import { parseProviders } from "./providers"
import { startGitHttpProxy } from "./git-http-proxy"
import { startProviderBridge } from "./provider-bridge"
import { hasDurableRunState, readRunManifest, resumeStateFromManifest, type SupervisorResumeState } from "./run-manifest"
import { acquireRunLease, type RunLease } from "./run-lock"
import { createSupervisor, type Supervisor, type SupervisorResult } from "./supervisor"

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

type RuntimeEnv = Record<string, string | undefined>

export function redactRuntimeDiagnostic(message: string, secrets: readonly string[]): string {
  let redacted = message.replace(
    /((?:["']?(?:authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|[a-z0-9_-]*(?:token|secret|private[-_]?key|api[-_]?key)[a-z0-9_-]*)["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer|Basic)\s+[^\s,;}\]]+|[^\s,;}\]]+)/gi,
    (_match, prefix: string, value: string) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : ""
      return `${prefix}${quote}[REDACTED]${quote}`
    },
  )
  for (const secret of secrets) {
    if (secret.length < 4) continue
    const escaped = JSON.stringify(secret).slice(1, -1)
    for (const variant of new Set([secret, escaped])) {
      redacted = redacted.split(variant).join("[REDACTED]")
    }
  }
  return redacted
}

export interface RuntimeDiagnosticBuffer {
  push(message: string): void
  drain(prefix: string): string
}

export function createRuntimeDiagnosticBuffer(
  secrets: () => readonly string[],
  limits: { maxBytes?: number; maxLines?: number; maxLineChars?: number } = {},
): RuntimeDiagnosticBuffer {
  const maxBytes = limits.maxBytes ?? 64 * 1024
  const maxLines = limits.maxLines ?? 200
  const maxLineChars = limits.maxLineChars ?? 4_096
  if (maxBytes < 1 || maxLines < 1 || maxLineChars < 1) throw new Error("runtime diagnostic limits must be positive")

  const lines: Array<{ message: string; bytes: number }> = []
  let bytes = 0
  let dropped = 0

  return {
    push(message) {
      const safe = redactRuntimeDiagnostic(message, secrets())
      const bounded = safe.length > maxLineChars
        ? `${safe.slice(0, maxLineChars)} [line truncated]`
        : safe
      const entry = { message: bounded, bytes: Buffer.byteLength(bounded) }
      while (lines.length && (lines.length >= maxLines || bytes + entry.bytes > maxBytes)) {
        bytes -= lines.shift()!.bytes
        dropped++
      }
      if (entry.bytes > maxBytes) {
        dropped++
        return
      }
      lines.push(entry)
      bytes += entry.bytes
    },
    drain(prefix) {
      const output = [
        ...(dropped ? [`${prefix}[${dropped} earlier diagnostic line(s) omitted]\n`] : []),
        ...lines.map((entry) => `${prefix}${entry.message}\n`),
      ].join("")
      lines.length = 0
      bytes = 0
      dropped = 0
      return output
    },
  }
}

export const RUNTIME_ENV_KEYS = [
  "BOT_RUN_ID",
  "CCHP_BOT_PROVIDER_KEYS",
  "CCHP_BOT_PROVIDERS",
  "CCHP_CODEX_BRIDGE_TOKEN",
  "CCHP_GITHUB_BROKER_SOCKET",
  "CCHP_GITHUB_BROKER_TOKEN",
  "CCHP_GITHUB_BROKER_FINALIZER",
  "GH_TOKEN",
  "CCHP_GH_TOKEN_FILE",
  "CCHP_APP_CLIENT_ID",
  "CCHP_APP_PRIVATE_KEY",
  "CCHP_NEEDS_WRITE",
  "CCHP_TOKEN_REFRESH_SECONDS",
  "SEE_API_KEY",
  "HEROUI_AUTH_TOKEN",
  "CODEX_HOME",
] as const

export type RuntimeEnvSnapshot = Record<(typeof RUNTIME_ENV_KEYS)[number], string | undefined>

export function snapshotRuntimeEnv(env: RuntimeEnv = process.env): RuntimeEnvSnapshot {
  return Object.fromEntries(RUNTIME_ENV_KEYS.map((key) => [key, env[key]])) as RuntimeEnvSnapshot
}

export function restoreRuntimeEnv(snapshot: RuntimeEnvSnapshot, env: RuntimeEnv = process.env): void {
  for (const key of RUNTIME_ENV_KEYS) {
    const value = snapshot[key]
    if (value == null) delete env[key]
    else env[key] = value
  }
}

export interface RuntimeCleanupError {
  name: string
  error: unknown
}

export async function cleanupRuntimeResources(
  resources: Array<{ name: string; close(): Promise<void> }>,
  timeoutMs = 5_000,
): Promise<RuntimeCleanupError[]> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("runtime cleanup timeout must be positive")
  const results = await Promise.all(resources.map(async (resource): Promise<RuntimeCleanupError | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(() => resource.close()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${resource.name} cleanup timed out after ${timeoutMs}ms`)), timeoutMs)
        }),
      ])
      return undefined
    } catch (error) {
      return { name: resource.name, error }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }))
  return results.filter((entry): entry is RuntimeCleanupError => !!entry)
}

export function settleRuntimeOutcome(
  primaryExitCode: number | undefined,
  primaryError: unknown,
  cleanupErrors: RuntimeCleanupError[],
): number {
  if (primaryError !== undefined) throw primaryError
  if (primaryExitCode == null) {
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors.map((entry) => entry.error), "Codex runtime resource cleanup failed")
    throw new Error("Codex runtime completed without a primary outcome")
  }
  if (primaryExitCode === 0 && cleanupErrors.length) {
    throw new AggregateError(cleanupErrors.map((entry) => entry.error), "Codex runtime resource cleanup failed")
  }
  return primaryExitCode
}

export interface RuntimeBrokerBindings {
  target?: number
  targetKind?: "pr" | "issue" | "discussion"
  trustedCommentId?: number
  roadmapProject?: number
  workflowRunId?: number
  releaseTag?: string
}

function optionalPositiveInt(env: RuntimeEnv, name: string): number | undefined {
  const value = env[name]
  if (!value) return undefined
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer`)
  return Number(value)
}

export function resolveRuntimeBrokerBindings(env: RuntimeEnv): RuntimeBrokerBindings {
  const targets = [
    ["pr", optionalPositiveInt(env, "BOT_PR_NUMBER")],
    ["issue", optionalPositiveInt(env, "BOT_ISSUE_NUMBER")],
    ["discussion", optionalPositiveInt(env, "BOT_DISCUSSION_NUMBER")],
  ].filter((entry): entry is ["pr" | "issue" | "discussion", number] => entry[1] != null)
  if (targets.length > 1) throw new Error("GitHub broker accepts exactly one trusted PR, issue, or discussion target")
  const [targetKind, target] = targets[0] ?? []
  return {
    target,
    targetKind,
    trustedCommentId: optionalPositiveInt(env, "BOT_PLAN_COMMENT_ID"),
    roadmapProject: optionalPositiveInt(env, "BOT_ROADMAP_PROJECT"),
    workflowRunId: env.BOT_TASK === "ci_fix" ? optionalPositiveInt(env, "BOT_RUN_ID") : undefined,
    releaseTag: env.BOT_RELEASE_TAG || undefined,
  }
}

export function resolveRuntimePermission(env: RuntimeEnv = process.env): TaskPermissionProfile {
  const task = env.BOT_TASK
  if (!task || !(TASKS as readonly string[]).includes(task)) {
    throw new Error(`unsupported BOT_TASK: ${task || "<empty>"}`)
  }
  return permissionForTask({
    task: task as Task,
    canWrite: env.BOT_CAN_WRITE === "1",
    isFork: env.BOT_PR_IS_FORK === "1",
  })
}

export function createProgressPublisher(
  env: RuntimeEnv,
  octokit: GitHubClient,
): ((body: string) => Promise<void>) | undefined {
  const repo = env.BOT_REPO
  if (repo && env.GH_REPO && env.GH_REPO !== repo) {
    throw new Error(`progress repository mismatch: BOT_REPO=${repo}, GH_REPO=${env.GH_REPO}`)
  }
  const target = env.BOT_PROGRESS_TARGET
  if (!repo || !target || !/^[1-9][0-9]*$/.test(target)) return undefined
  const issueNumber = Number(target)
  const trustedTarget = env.BOT_PR_NUMBER ?? env.BOT_ISSUE_NUMBER
  if (env.BOT_TASK === "pr_opened" && !env.BOT_PR_NUMBER) {
    throw new Error("pr_opened progress requires BOT_PR_NUMBER")
  }
  if (trustedTarget && target !== trustedTarget) {
    throw new Error(`progress target mismatch: expected ${trustedTarget}, got ${target}`)
  }
  const marker = progressMarkerKey(env.BOT_TASK ?? "task")
  // Progress is the sole supervisor-owned pre-finalization GitHub mutation. It
  // uses an already constructed Octokit client and never exposes its token to
  // Codex or MCP children.
  return async (body) => { await upsertSticky(octokit, repo, issueNumber, marker, body) }
}

export function createTerminalProgressPublisher(
  env: RuntimeEnv,
  octokit: GitHubClient,
  redact: (value: string) => string = (value) => value,
): ((result: Pick<SupervisorResult, "state" | "terminalReason" | "usage">) => Promise<boolean>) | undefined {
  const publish = createProgressPublisher(env, octokit)
  if (!publish) return undefined
  const task = env.BOT_TASK ?? "task"
  const runId = env.GITHUB_RUN_ID ?? env.BOT_RUN_ID ?? "unknown"
  const prNumber = optionalPositiveInt(env, "BOT_PR_NUMBER")
  const repo = env.BOT_REPO
  return async (result) => {
    if (prNumber && repo) {
      const { owner, name } = splitRepo(repo)
      const { data } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: prNumber })
      if (data.state !== "open" || data.merged || data.merged_at) return false
      if (env.BOT_HEAD_SHA && data.head.sha !== env.BOT_HEAD_SHA) return false
    }
    await publish(renderTerminalProgress(task, {
      state: result.state,
      runId,
      terminalReason: result.terminalReason ? redact(result.terminalReason) : undefined,
      consumedTokens: result.usage.consumed,
      tokenLimit: result.usage.limit,
    }))
    return true
  }
}

export function resolveRuntimeRecovery(
  env: RuntimeEnv,
  workdir: string,
  task: string,
  createRunId: () => string = () => `${Date.now()}`,
): { runId: string; resume?: SupervisorResumeState } {
  const requestedRunId = env.BOT_RUN_ID || undefined
  const manifest = readRunManifest(workdir, { runId: requestedRunId, task })
  if (manifest) {
    return { runId: manifest.runId, resume: resumeStateFromManifest(manifest) }
  }
  if (hasDurableRunState(workdir)) {
    throw new Error("orphaned durable Codex state exists without a run manifest")
  }
  const runId = requestedRunId ?? createRunId()
  if (!runId) throw new Error("generated BOT_RUN_ID is empty")
  return { runId }
}

export function composeRuntimePrompt(input: {
  task: string
  instructionOverlay: string
  taskPrompt: string
  reviewProtocol?: string
}): string {
  const review = input.task === "pr_opened"
    ? `\n# Injected Ultra Code Review Protocol\n${input.reviewProtocol?.trim() || ""}\n# End Injected Ultra Code Review Protocol\n`
    : ""
  if (input.task === "pr_opened" && !input.reviewProtocol?.trim()) {
    throw new Error("pr_opened requires the Codex Ultra Code Review Protocol")
  }
  return `${review}${input.instructionOverlay}\n${input.taskPrompt}`
}

export function configureGitRemote(repoDir: string, repoUrl: string): void {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(repoUrl)) {
    throw new Error(`refusing untrusted Git proxy URL: ${repoUrl}`)
  }
  const result = spawnSync("git", ["remote", "set-url", "origin", repoUrl], {
    cwd: repoDir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? repoDir,
      LANG: process.env.LANG ?? "C.UTF-8",
    },
  })
  if (result.status !== 0) {
    throw new Error(`could not configure the run-scoped Git proxy: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`)
  }
}

export async function main(): Promise<number> {
  const envSnapshot = snapshotRuntimeEnv()
  let supervisor: Supervisor | undefined
  let bridge: ReturnType<typeof startProviderBridge> | undefined
  let broker: Awaited<ReturnType<typeof startGitHubBroker>> | undefined
  let gitProxy: Awaited<ReturnType<typeof startGitHttpProxy>> | undefined
  let tokenRotation: Awaited<ReturnType<typeof startTokenRotation>> | undefined
  let primaryExitCode: number | undefined
  let primaryError: unknown
  let cleanupErrors: RuntimeCleanupError[] = []
  let lease: RunLease | undefined
  let publishTerminalProgress: ReturnType<typeof createTerminalProgressPublisher>
  const diagnosticSecrets = new Set<string>([
    process.env.GH_TOKEN,
    process.env.CCHP_GH_TOKEN_FILE,
    process.env.CCHP_APP_CLIENT_ID,
    process.env.CCHP_APP_PRIVATE_KEY,
    process.env.SEE_API_KEY,
    process.env.HEROUI_AUTH_TOKEN,
  ].filter((value): value is string => Boolean(value)))
  const appServerDiagnostics = createRuntimeDiagnosticBuffer(() => [...diagnosticSecrets])
  const flushAppServerDiagnostics = () => {
    const output = appServerDiagnostics.drain("[codex-app-server] ")
    if (output) process.stderr.write(output)
  }
  const bridgeEnv = "CCHP_CODEX_BRIDGE_TOKEN"
  try {
    const workdir = required("BOT_WORKDIR")
    const engineDir = required("ENGINE_DIR")
    const repoDir = required("REPO_DIR")
    lease = acquireRunLease(workdir, process.env.BOT_RUN_ID)
    const contract = parseCallerContract(process.env)
    const permission = resolveRuntimePermission(process.env)
    const recovery = resolveRuntimeRecovery(process.env, workdir, permission.task)
    const runId = recovery.runId
    process.env.BOT_RUN_ID = runId
    const providerSet = parseProviders({
      providerJson: contract.providerJson,
      providerKeysJson: contract.providerKeysJson,
      model: contract.model,
      smallModel: contract.smallModel,
    })
    for (const provider of providerSet.providers) {
      if (provider.apiKey) diagnosticSecrets.add(provider.apiKey)
      for (const value of Object.values(provider.headers)) diagnosticSecrets.add(value)
    }
    // Provider credentials remain in this process only for the bridge. The Codex
    // child and every MCP child are started after these variables are removed.
    delete process.env.CCHP_BOT_PROVIDER_KEYS
    delete process.env.CCHP_BOT_PROVIDERS
    bridge = startProviderBridge(providerSet, {
      onUsage: async (usage) => { await supervisor?.recordProviderUsage(usage) },
      onBeforeRequest: async (request) => supervisor
        ? supervisor.authorizeProviderRequest(request)
        : { allowed: true },
      onRequestFinished: async (reservationId, outcome, reason) => {
        if (outcome === "released") await supervisor?.releaseProviderReservation(reservationId, reason)
      },
    })
    diagnosticSecrets.add(bridge.token)
    process.env[bridgeEnv] = bridge.token
    const decision = decideCollaborationMode({ env: process.env })
    writeCapabilityDecision(join(workdir, "ctx", "codex", "capability.json"), decision)
    const repo = required("BOT_REPO")
    tokenRotation = await startTokenRotation({
      clientId: process.env.CCHP_APP_CLIENT_ID,
      privateKey: process.env.CCHP_APP_PRIVATE_KEY,
      repo,
      scope: process.env.CCHP_NEEDS_WRITE === "true" || process.env.CCHP_NEEDS_WRITE === "1" ? "write" : "base",
      fallback: process.env.GH_TOKEN,
      refreshMs: Math.max(60, Number(process.env.CCHP_TOKEN_REFRESH_SECONDS ?? "") || 2700) * 1000,
      log: (message) => process.stderr.write(`[github-token] ${message}\n`),
    })
    delete process.env.CCHP_APP_CLIENT_ID
    delete process.env.CCHP_APP_PRIVATE_KEY
    delete process.env.CCHP_GH_TOKEN_FILE
    hideProcEnviron((message) => process.stderr.write(`[github-token] ${message}\n`))
    const tokenSource: TokenSource = () => {
      const token = tokenRotation!.token()
      diagnosticSecrets.add(token)
      return token
    }
    const githubClient = makeOctokit(tokenSource)
    const herouiAuthToken = process.env.HEROUI_AUTH_TOKEN
    const finalizerMarker = process.env.BOT_REVIEW_FINALIZED_MARKER || join(workdir, "ctx", "review-finalized.json")
    const brokerBindings = resolveRuntimeBrokerBindings(process.env)
    broker = await startGitHubBroker({
      socketPath: join(workdir, "ctx", "codex", "github-broker.sock"),
      repo,
      task: permission.task,
      ...brokerBindings,
      finalizerMarker,
      expectedHeadSha: process.env.BOT_HEAD_SHA,
      expectedRunId: runId,
      octokit: githubClient,
      repoDir,
      allowRepositoryMutation: permission.allowRepositoryMutation,
      herouiAuthToken,
    })
    gitProxy = await startGitHttpProxy({
      repo,
      token: tokenSource,
      allowPush: permission.allowRepositoryMutation,
    })
    configureGitRemote(repoDir, gitProxy.repoUrl)
    process.env.CCHP_GITHUB_BROKER_SOCKET = broker.socketPath
    process.env.CCHP_GITHUB_BROKER_TOKEN = broker.token
    diagnosticSecrets.add(broker.token)
    process.env.CCHP_GITHUB_BROKER_FINALIZER = finalizerMarker
    const publishProgress = createProgressPublisher(process.env, githubClient)
    publishTerminalProgress = createTerminalProgressPublisher(
      process.env,
      githubClient,
      (value) => redactRuntimeDiagnostic(value, [...diagnosticSecrets]),
    )
    delete process.env.GH_TOKEN
    delete process.env.CCHP_GH_TOKEN_FILE
    delete process.env.SEE_API_KEY
    delete process.env.HEROUI_AUTH_TOKEN
    const extra = await loadExtraInstructions(contract.extraInstructionsJson, repoDir)
    const systemPath = process.env.BOT_SYSTEM_PROMPT || join(engineDir, "codex", "system-prompt.md")
    const system = renderCallerOverlay(existsSync(systemPath) ? readFileSync(systemPath, "utf8") : "", contract.overlay)
    const promptPath = process.env.BOT_PROMPT_FILE || join(workdir, "prompt.md")
    const reviewProtocolPath = join(engineDir, "codex", "prompts-ultra-protocol.md")
    const prompt = composeRuntimePrompt({
      task: permission.task,
      instructionOverlay: renderInstructionOverlay(extra),
      taskPrompt: existsSync(promptPath) ? readFileSync(promptPath, "utf8") : "",
      reviewProtocol: existsSync(reviewProtocolPath) ? readFileSync(reviewProtocolPath, "utf8") : undefined,
    })
    const prepared = prepareCodexHome({
      botWorkdir: workdir,
      engineDir,
      repoDir,
      bridgeBaseUrl: bridge.baseUrl,
      bridgeTokenEnv: bridgeEnv,
      providerSet,
      sandboxMode: permission.sandboxMode,
      allowShell: permission.allowShell,
      collaborationMode: decision.collaborationMode,
      fffCommand: process.env.BOT_HAVE_FFF === "1" ? "fff-mcp" : undefined,
      serenaCommand: process.env.BOT_HAVE_SERENA === "1" ? "serena" : undefined,
      seeServer: process.env.BOT_HAVE_SEE === "1" ? join(engineDir, "src", "mcp", "see-server.ts") : undefined,
      seeCliBin: process.env.BOT_HAVE_SEE === "1" ? join(process.env.HOME ?? "", ".local", "lib", "see-cli", "see") : undefined,
      baseInstructions: system,
    })
    process.env.CODEX_HOME = prepared.codexHome
    supervisor = createSupervisor({
      codexHome: prepared.codexHome,
      repoDir,
      workdir,
      task: permission.task,
      runId,
      prompt,
      model: providerSet.main.modelKey,
      modelProvider: providerSet.providers.find((provider) => provider.id === providerSet.main.providerId)!.codexId,
      contextWindow: providerSet.main.context,
      totalTokenBudget: Number(process.env.CCHP_TOKEN_BUDGET || 2_000_000),
      tokenAdmissionFraction: 0.85,
      maxResponsesPerTurn: 16,
      drainUsage: () => bridge!.drain(),
      approvalPolicy: permission.approvalPolicy,
      sandboxMode: permission.sandboxMode,
      publishProgress,
      codexVersion: decision.codexVersion,
      codexV2Gate: decision.codexV2Gate,
      executionMode: decision.executionMode,
      capabilityReason: decision.reason,
      assertWriterOwnership: () => lease!.assertOwned(),
      processRecordPath: process.env.CCHP_CODEX_PID_FILE,
      writerFence: lease!.fence,
      resume: recovery.resume,
      onAppServerStderr: (line) => {
        appServerDiagnostics.push(line)
      },
      finalizer: process.env.BOT_TASK === "pr_opened" ? async (context) => {
        const provenance = new ProvenanceLedger(join(workdir, "ctx", "codex", "provenance.jsonl"), context.runId)
        const evidenceProvenanceSha256 = selectFinalizerProvenance(
          finalizerMarker,
          provenance,
          context.preterminalProvenanceSha256,
        )
        const marker = finalizeReview(
          join(workdir, "ctx", "review"),
          process.env.BOT_TRUSTED_REVIEW_MANIFEST || join(workdir, "ctx", "review-manifest.json"),
          finalizerMarker,
          {
            repository: required("BOT_REPO"),
            prNumber: Number(required("BOT_PR_NUMBER")),
            runId: context.runId,
            provenanceSha256: evidenceProvenanceSha256,
            admissionLedgerPath: join(workdir, "ctx", "codex", "review-admission.jsonl"),
          },
        )
        const bundle = reviewPublicationBundle(process.env, marker)
        await publishFinalizedReview({
          octokit: githubClient,
          repository: repo,
          prNumber: marker.pr_number,
          marker,
          bundle,
          idempotencyKey: context.idempotencyKey,
          statePath: join(workdir, "ctx", "codex", "review-publication.json"),
          env: process.env,
        })
        return {
          ...marker,
          preterminal_provenance_sha256: context.preterminalProvenanceSha256,
          idempotency_key: context.idempotencyKey,
        }
      } : undefined,
    })
    const result = await supervisor.run()
    if (!(permission.task === "pr_opened" && result.state === "SUCCEEDED") && publishTerminalProgress) {
      try {
        await publishTerminalProgress(result)
      } catch (error) {
        appServerDiagnostics.push(`terminal progress publication failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    flushAppServerDiagnostics()
    process.stderr.write(`[run-codex] supervisor result: ${redactRuntimeDiagnostic(JSON.stringify(result), [...diagnosticSecrets])}\n`)
    primaryExitCode = exitCodeFor(result.state, result.exitCode)
  } catch (error) {
    primaryError = error
    if (publishTerminalProgress) {
      try {
        await publishTerminalProgress({
          state: "FAILED",
          terminalReason: error instanceof Error ? error.message : String(error),
          usage: {
            acceptedRaw: false, consumed: 0, limit: 0, fraction: 0, state: "normal",
            blockingAnomalies: 0, responses: 0, turns: 0, admissionDenials: 0,
          },
        })
      } catch (publishError) {
        appServerDiagnostics.push(`terminal progress publication failed: ${publishError instanceof Error ? publishError.message : String(publishError)}`)
      }
    }
    flushAppServerDiagnostics()
    process.stderr.write(`[run-codex] supervisor error: ${redactRuntimeDiagnostic(error instanceof Error ? error.stack ?? error.message : String(error), [...diagnosticSecrets])}\n`)
  } finally {
    cleanupErrors = await cleanupRuntimeResources([
      ...(gitProxy ? [{ name: "git proxy", close: () => gitProxy!.close() }] : []),
      ...(broker ? [{ name: "GitHub broker", close: () => broker!.close() }] : []),
      ...(bridge ? [{ name: "provider bridge", close: () => bridge!.close() }] : []),
      ...(tokenRotation ? [{ name: "GitHub token rotation", close: () => tokenRotation!.close() }] : []),
    ])
    lease?.release()
    restoreRuntimeEnv(envSnapshot)
  }
  if (cleanupErrors.length && (primaryError !== undefined || (primaryExitCode != null && primaryExitCode !== 0))) {
    process.stderr.write(`[run-codex] cleanup warning: ${cleanupErrors.map((entry) => `${entry.name}: ${String(entry.error)}`).join("; ")}\n`)
  }
  return settleRuntimeOutcome(primaryExitCode, primaryError, cleanupErrors)
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`[run-codex] fatal: ${(error as Error).message}\n`)
    process.exit(2)
  })
}
