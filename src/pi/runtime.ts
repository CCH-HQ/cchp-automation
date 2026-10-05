#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { splitRepo } from "../context"
import { makeOctokit, type GitHubClient, type TokenSource } from "../github/client"
import { hideProcEnviron, startTokenRotation } from "../github/token-rotation"
import { startGitHubBroker } from "../mcp/github-broker"
import { reviewPublicationBundle } from "../mcp/server"
import { finalizeReview } from "../review/finalize"
import { writePreparedFinalizedReviewPublication } from "../publish/finalized-review"
import { progressMarkerKey, renderProgress, renderTerminalProgress, trustedBotLogin, upsertSticky } from "../publish/sticky"
import { recordProgressPublication, tryRecordProgressPublication } from "../codex/progress-publication"
import { cleanupRuntimeResources, configureGitRemote, createProgressPublisher, resolveRuntimeBrokerBindings, resolveRuntimePermission, settleRuntimeOutcome } from "../codex/runtime"
import { loadExtraInstructions, renderCallerOverlay, renderInstructionOverlay } from "../codex/instructions"
import { parseCallerContract } from "../codex/caller-contract"
import { startGitHttpProxy } from "../codex/git-http-proxy"
import { startProviderBridge } from "../codex/provider-bridge"
import { preparePiHome } from "./config"
import { parsePiProviders } from "./providers"
import { toPiBridgeRouting } from "./bridge"
import { runPiRpc, type PiRpcResult } from "./rpc"
import { ProvenanceLedger } from "../codex/provenance"

type RuntimeEnv = Record<string, string | undefined>

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function piModelReference(
  providerSet: ReturnType<typeof parsePiProviders>,
  reference: string,
  bridgeRouting: ReturnType<typeof toPiBridgeRouting>,
): string {
  const slash = reference.indexOf("/")
  if (slash <= 0) throw new Error(`invalid Pi model reference: ${reference}`)
  const providerId = reference.slice(0, slash)
  const modelId = reference.slice(slash + 1)
  const provider = providerSet.providers.find((candidate) => candidate.id === providerId)
  if (!provider) throw new Error(`unknown Pi model provider: ${providerId}`)
  const model = provider.models.find((candidate) => candidate.id === modelId || candidate.key === modelId)
  if (!model) throw new Error(`unknown Pi model: ${reference}`)
  return `${providerId}/${bridgeRouting?.providerIds.has(providerId) ? model.key : model.id}`
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.filter(Boolean).reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value)
}

function piVersion(piBin: string): string {
  const result = Bun.spawnSync([piBin, "--version"], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`pi --version failed: ${new TextDecoder().decode(result.stderr)}`)
  const version = new TextDecoder().decode(result.stdout).trim()
  if (!version) throw new Error("pi --version returned no output")
  return version
}

function terminalPath(workdir: string): string {
  return join(workdir, "ctx", "pi", "terminal.json")
}

function writeTerminal(workdir: string, runId: string, task: string, result: PiRpcResult, runtimeName: string): void {
  mkdirSync(join(workdir, "ctx", "pi"), { recursive: true, mode: 0o700 })
  const record = {
    schemaVersion: 1,
    state: result.state,
    runId,
    task,
    runtime: {
      name: "pi",
      version: runtimeName,
      mode: "rpc",
      codexVersion: `pi ${runtimeName}`,
      executionMode: "explicit_child",
    },
    sessionId: result.sessionId,
    finalMessage: result.finalMessage,
    usage: {
      consumed: result.usage.total,
      reservedTokens: 0,
      responsesInFlight: 0,
      limit: Number.MAX_SAFE_INTEGER,
      state: "normal",
      responses: result.events,
      turns: result.events,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cachedInputTokens: result.usage.cacheRead,
      cacheWriteInputTokens: result.usage.cacheWrite,
    },
    updatedAt: new Date().toISOString(),
  }
  writeFileSync(terminalPath(workdir), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  // Existing lifecycle finalizers consume this location until their generic Pi
  // projection is deployed with the next workflow cutover.
  mkdirSync(join(workdir, "ctx", "codex"), { recursive: true, mode: 0o700 })
  writeFileSync(join(workdir, "ctx", "codex", "terminal.json"), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
}

function finalizePiReview(env: RuntimeEnv, workdir: string, runId: string, result: PiRpcResult, secrets: readonly string[]): void {
  if (env.CCHP_PI_NATIVE_REVIEW === "1" || env.BOT_TASK !== "pr_opened" || env.BOT_SKIP_PR_INSPECT === "1" || result.state !== "SUCCEEDED") return
  const admissionLedgerPath = join(workdir, "ctx", "codex", "review-admission.jsonl")
  if (!existsSync(admissionLedgerPath)) return
  const provenance = new ProvenanceLedger(join(workdir, "ctx", "codex", "provenance.jsonl"), runId)
  const entry = provenance.record("pi.rpc.completed", { sessionId: result.sessionId, events: result.events, usage: result.usage })
  const markerPath = env.BOT_REVIEW_FINALIZED_MARKER ?? join(workdir, "ctx", "review-finalized.json")
  const marker = finalizeReview(
    join(workdir, "ctx", "review"),
    env.BOT_TRUSTED_REVIEW_MANIFEST ?? join(workdir, "ctx", "review-manifest.json"),
    markerPath,
    {
      repository: required("BOT_REPO"),
      prNumber: Number(required("BOT_PR_NUMBER")),
      runId,
      provenanceSha256: entry.sha256,
      admissionLedgerPath: join(workdir, "ctx", "codex", "review-admission.jsonl"),
    },
  )
  const bundle = reviewPublicationBundle(env, marker)
  const input = {
    repository: required("BOT_REPO"),
    prNumber: Number(required("BOT_PR_NUMBER")),
    marker,
    bundle,
    idempotencyKey: `pi:${runId}:${marker.head_sha}`,
    forbiddenValues: () => secrets,
  }
  writePreparedFinalizedReviewPublication(join(workdir, "ctx", "codex", "prepared-review-publication.json"), input)
  writePreparedFinalizedReviewPublication(join(workdir, "ctx", "pi", "prepared-review-publication.json"), input)
}

function childEnvironment(input: {
  workdir: string
  repoDir: string
  agentDir: string
  broker: { socketPath: string; token: string }
  providerSecrets: Record<string, string>
  runtimeEnv: RuntimeEnv
  agentModel: string
  piBin: string
}): Record<string, string> {
  const blocked = new Set([
    "GH_TOKEN", "CCHP_GH_TOKEN_FILE", "CCHP_APP_CLIENT_ID", "CCHP_APP_PRIVATE_KEY", "CCHP_BOT_PROVIDER_KEYS",
    "CCHP_BOT_PROVIDERS", "CCHP_CODEX_BRIDGE_TOKEN", "CCHP_GITHUB_BROKER_TOKEN", "CCHP_PI_BRIDGE_TOKEN",
    "SEE_API_KEY", "HEROUI_AUTH_TOKEN", "CCHP_SEE_API_KEY_STDIN",
  ])
  const inherited = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) =>
    blocked.has(key) || value === undefined ? [] : [[key, value]]))
  return {
    ...inherited,
    BOT_WORKDIR: input.workdir,
    REPO_DIR: input.repoDir,
    BOT_REPO: input.runtimeEnv.BOT_REPO ?? required("BOT_REPO"),
    BOT_TASK: input.runtimeEnv.BOT_TASK ?? required("BOT_TASK"),
    BOT_RUN_ID: input.runtimeEnv.BOT_RUN_ID ?? required("BOT_RUN_ID"),
    BOT_CAN_WRITE: input.runtimeEnv.BOT_CAN_WRITE ?? "0",
    PI_CODING_AGENT_DIR: input.agentDir,
    PI_BIN: input.piBin,
    CCHP_PI_AGENT_DEPTH: "0",
    CCHP_PI_AGENT_MODEL: input.agentModel,
    CCHP_PI_AGENT_ALLOW_SHELL: input.runtimeEnv.BOT_PR_IS_FORK !== "1" && (input.runtimeEnv.BOT_TASK === "pr_opened" || input.runtimeEnv.BOT_CAN_WRITE === "1") ? "1" : "0",
    CCHP_PI_AGENT_SESSION_DIR: join(input.workdir, "ctx", "pi", "child-sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    CCHP_GITHUB_BROKER_SOCKET: input.broker.socketPath,
    CCHP_GITHUB_BROKER_TOKEN: input.broker.token,
    ...input.providerSecrets,
  }
}

async function publishPiTerminal(env: RuntimeEnv, octokit: GitHubClient, result: PiRpcResult, secrets: readonly string[]): Promise<void> {
  const repo = env.BOT_REPO
  const target = env.BOT_PROGRESS_TARGET ?? env.BOT_PR_NUMBER ?? env.BOT_ISSUE_NUMBER
  if (!repo || !target || !/^[1-9][0-9]*$/.test(target)) return
  const issueNumber = Number(target)
  const task = env.BOT_TASK ?? "task"
  const runId = env.BOT_RUN_ID ?? env.GITHUB_RUN_ID ?? "unknown"
  const body = `${renderTerminalProgress(task, {
    state: result.state,
    runId,
    finalMessage: result.finalMessage ? redact(result.finalMessage, secrets).slice(-16_000) : undefined,
  })}\n<!-- ${progressMarkerKey(task)} -->`
  const prNumber = env.BOT_PR_NUMBER
  const guard = async (): Promise<boolean> => {
    if (!prNumber) return true
    const { owner, name } = splitRepo(repo)
    const { data } = await octokit.rest.pulls.get({ owner, repo: name, pull_number: Number(prNumber) })
    return data.state === "open" && !data.merged && (!env.BOT_HEAD_SHA || data.head.sha === env.BOT_HEAD_SHA)
  }
  const published = await upsertSticky(octokit, repo, issueNumber, progressMarkerKey(task), body, guard, undefined, trustedBotLogin(env))
  tryRecordProgressPublication(env, progressMarkerKey(task), published, true)
  if (published) recordProgressPublication(env, progressMarkerKey(task), published, true)
}

async function publishTodo(env: RuntimeEnv, octokit: GitHubClient, workdir: string, previous: string, secrets: readonly string[]): Promise<string> {
  const path = join(workdir, "ctx", "pi", "todo.json")
  if (!existsSync(path)) return previous
  const content = readFileSync(path, "utf8")
  if (content === previous) return previous
  try {
    const ledger = JSON.parse(content) as { todos?: Array<{ content?: string; status?: string }> }
    const todos = Array.isArray(ledger.todos) ? ledger.todos.map((todo) => ({
      content: typeof todo.content === "string" ? todo.content : "",
      status: todo.status === "in_progress" || todo.status === "completed" || todo.status === "cancelled" ? todo.status : "pending",
    })) : []
    const repo = env.BOT_REPO
    const target = env.BOT_PROGRESS_TARGET ?? env.BOT_PR_NUMBER ?? env.BOT_ISSUE_NUMBER
    if (repo && target && /^[1-9][0-9]*$/.test(target)) {
      const body = `${renderProgress(todos, env.BOT_TASK ?? "task")}\n\nPi run: \`${env.BOT_RUN_ID ?? "unknown"}\``
      const published = await upsertSticky(octokit, repo, Number(target), progressMarkerKey(env.BOT_TASK ?? "task"), body, undefined, trustedBotLogin(env))
      tryRecordProgressPublication(env, progressMarkerKey(env.BOT_TASK ?? "task"), published, false)
    }
  } catch (error) {
    process.stderr.write(`[run-pi] todo publication failed: ${redact(error instanceof Error ? error.message : String(error), secrets)}\n`)
  }
  return content
}

export async function main(): Promise<number> {
  const workdir = required("BOT_WORKDIR")
  const engineDir = required("ENGINE_DIR")
  const repoDir = required("REPO_DIR")
  const env = process.env
  env.CCHP_PI_NATIVE_REVIEW = "1"
  const permission = resolveRuntimePermission(env)
  const contract = parseCallerContract(env)
  const providerSet = parsePiProviders({
    providerJson: contract.providerJson,
    providerKeysJson: contract.providerKeysJson,
    model: contract.model,
    smallModel: contract.smallModel,
  })
  const bridgeRouting = toPiBridgeRouting(providerSet)
  const runId = env.BOT_RUN_ID ?? `${Date.now()}-${process.pid}`
  env.BOT_RUN_ID = runId
  const secrets = new Set<string>()
  const providerSecrets = providerSet.secretEnv
  for (const value of Object.values(providerSecrets)) secrets.add(value)
  const githubToken = env.GH_TOKEN ?? ""
  const appClientId = env.CCHP_APP_CLIENT_ID
  const appPrivateKey = env.CCHP_APP_PRIVATE_KEY
  const tokenRotation = await startTokenRotation({
    clientId: appClientId,
    privateKey: appPrivateKey,
    repo: required("BOT_REPO"),
    scope: env.CCHP_NEEDS_WRITE === "true" || env.CCHP_NEEDS_WRITE === "1" ? "write" : "interaction",
    fallback: githubToken,
    refreshMs: Math.max(60, Number(env.CCHP_TOKEN_REFRESH_SECONDS ?? "") || 2700) * 1000,
    log: (message) => process.stderr.write(`[github-token] ${message}\n`),
  })
  const tokenSource: TokenSource = () => tokenRotation.token()
  const octokit = makeOctokit(tokenSource)
  const brokerBindings = resolveRuntimeBrokerBindings(env)
  const broker = await startGitHubBroker({
    socketPath: join(workdir, "ctx", "pi", "github-broker.sock"),
    repo: required("BOT_REPO"),
    task: permission.task,
    ...brokerBindings,
    expectedHeadSha: env.BOT_HEAD_SHA,
    expectedRunId: runId,
    octokit,
    repoDir,
    allowRepositoryMutation: permission.allowRepositoryMutation,
    finalizerMarker: env.BOT_REVIEW_FINALIZED_MARKER,
    herouiAuthToken: env.HEROUI_AUTH_TOKEN,
    forbiddenValues: () => [...secrets],
  })
  secrets.add(broker.token)
  const gitProxy = await startGitHttpProxy({ repo: required("BOT_REPO"), token: tokenSource, allowPush: permission.allowRepositoryMutation })
  const providerBridge = bridgeRouting ? startProviderBridge(bridgeRouting.providerSet) : undefined
  if (providerBridge) secrets.add(providerBridge.token)
  configureGitRemote(repoDir, gitProxy.repoUrl)
  env.CCHP_GITHUB_BROKER_SOCKET = broker.socketPath
  env.CCHP_GITHUB_BROKER_TOKEN = broker.token
  const extra = await loadExtraInstructions(contract.extraInstructionsJson, repoDir)
  const systemPath = env.BOT_SYSTEM_PROMPT || join(engineDir, "pi", "system-prompt.md")
  const system = renderCallerOverlay(existsSync(systemPath) ? readFileSync(systemPath, "utf8") : "", contract.overlay)
  const promptPath = env.BOT_PROMPT_FILE || join(workdir, "prompt.md")
  const taskPrompt = existsSync(promptPath) ? readFileSync(promptPath, "utf8") : ""
  const prompt = `${system}\n${renderInstructionOverlay(extra)}\n${taskPrompt}`
  const piBin = required("PI_BIN")
  const version = piVersion(piBin)
  const childModel = piModelReference(
    providerSet,
    permission.reviewOnly && providerSet.smallModel ? providerSet.smallModel : providerSet.mainModel,
    bridgeRouting,
  )
  const prepared = preparePiHome({
    botWorkdir: workdir,
    engineDir,
    repoDir,
    providerSet,
    systemPrompt: prompt,
    task: permission.task,
    runId,
    brokerSocket: broker.socketPath,
    brokerTokenEnv: "CCHP_GITHUB_BROKER_TOKEN",
    brokerFinalizer: env.BOT_REVIEW_FINALIZED_MARKER ?? join(workdir, "ctx", "review-finalized.json"),
    runtimeEnv: env,
    bunCommand: process.execPath,
    agentModel: childModel,
    agentAllowShell: permission.allowShell,
    seeServer: env.BOT_HAVE_SEE === "1" ? join(engineDir, "src", "mcp", "see-server.ts") : undefined,
    ...(providerBridge && bridgeRouting
      ? { bridge: { baseUrl: providerBridge.baseUrl, tokenEnv: "CCHP_PI_BRIDGE_TOKEN", providerIds: bridgeRouting.providerIds } }
      : {}),
  })
  mkdirSync(join(workdir, "ctx", "codex"), { recursive: true, mode: 0o700 })
  const bridgedSecretNames = new Set<string>()
  for (const provider of providerSet.providers) {
    if (!bridgeRouting?.providerIds.has(provider.id)) continue
    if (provider.apiKeyEnv) bridgedSecretNames.add(provider.apiKeyEnv)
    for (const value of Object.values(provider.headers)) {
      const match = /^\$\{([^}]+)\}$/.exec(value)
      if (match) bridgedSecretNames.add(match[1]!)
    }
  }
  const directProviderSecrets = Object.fromEntries(Object.entries(providerSecrets).filter(([name]) => !bridgedSecretNames.has(name)))
  const childEnv = childEnvironment({
    workdir,
    repoDir,
    agentDir: prepared.agentDir,
    broker,
    providerSecrets: directProviderSecrets,
    runtimeEnv: env,
    agentModel: childModel,
    piBin,
  })
  if (providerBridge) childEnv.CCHP_PI_BRIDGE_TOKEN = providerBridge.token
  delete process.env.GH_TOKEN
  delete process.env.CCHP_APP_CLIENT_ID
  delete process.env.CCHP_APP_PRIVATE_KEY
  delete process.env.CCHP_BOT_PROVIDER_KEYS
  delete process.env.CCHP_BOT_PROVIDERS
  hideProcEnviron((message) => process.stderr.write(`[run-pi] ${message}\n`))
  const fence = { capture: () => 0, isCurrent: () => true, seal: () => undefined, repairIfStale: async () => undefined }
  const publishProgress = createProgressPublisher(env, octokit, fence)
  let todoSnapshot = ""
  const todoTimer = setInterval(() => {
    void publishTodo(env, octokit, workdir, todoSnapshot, [...secrets]).then((next) => { todoSnapshot = next }).catch((error) => {
      process.stderr.write(`[run-pi] todo watcher failed: ${redact(error instanceof Error ? error.message : String(error), [...secrets])}\n`)
    })
  }, 500)
  let primaryError: unknown
  let exitCode = 1
  let result: PiRpcResult | undefined
  try {
    result = await runPiRpc({
      piBin,
      cwd: repoDir,
      env: childEnv,
      prompt,
      model: piModelReference(
        providerSet,
        permission.reviewOnly && providerSet.smallModel ? providerSet.smallModel : providerSet.mainModel,
        bridgeRouting,
      ),
      thinking: permission.reviewOnly ? "low" : "high",
      extensionPath: prepared.extensionPath,
      sessionDir: prepared.sessionDir,
      sessionName: `cchp-${runId}`,
      sessionId: `cchp-${runId}`,
      eventLogPath: join(workdir, "ctx", "pi", "events.jsonl"),
      allowShell: permission.allowShell,
      onEvent: (event) => {
        if (event.type === "agent_settled") process.stderr.write(`[run-pi] agent_settled\n`)
      },
    })
    exitCode = result.exitCode
    if (result.state !== "SUCCEEDED") {
      process.stderr.write(`[run-pi] Pi RPC failed state=${result.state} exit=${result.exitCode} message=${redact(result.finalMessage ?? "unknown Pi failure", [...secrets])}\n`)
    }
    if (result.state === "SUCCEEDED") {
      const provenance = new ProvenanceLedger(join(workdir, "ctx", "codex", "provenance.jsonl"), runId)
      provenance.record("pi.rpc.completed", { sessionId: result.sessionId, events: result.events, usage: result.usage })
    }
    writeTerminal(workdir, runId, permission.task, result, version)
    finalizePiReview(env, workdir, runId, result, [...secrets])
    if (publishProgress) await publishProgress(`${renderProgress([], permission.task)}\n\nPi ${version} run ${runId}`)
    await publishPiTerminal(env, octokit, result, [...secrets])
  } catch (error) {
    primaryError = error
    process.stderr.write(`[run-pi] error: ${redact(error instanceof Error ? error.stack ?? error.message : String(error), [...secrets])}\n`)
  } finally {
    clearInterval(todoTimer)
    await publishTodo(env, octokit, workdir, todoSnapshot, [...secrets]).catch(() => undefined)
    await cleanupRuntimeResources([
      ...(providerBridge ? [{ name: "Pi provider bridge", close: async () => { await providerBridge.sealAndDrain(); await providerBridge.close() } }] : []),
      { name: "Pi Git proxy", close: () => gitProxy.close() },
      { name: "Pi GitHub broker", close: () => broker.close() },
      { name: "Pi GitHub token rotation", close: () => tokenRotation.close() },
    ])
  }
  if (primaryError !== undefined) return settleRuntimeOutcome(undefined, primaryError, [])
  return exitCode === 0 && result?.state === "SUCCEEDED" ? 0 : exitCode || 1
}

if (import.meta.main) main().then((code) => process.exit(code)).catch((error) => {
  process.stderr.write(`[run-pi] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
