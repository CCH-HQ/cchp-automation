import { afterEach, describe, expect, test } from "bun:test"
import { linkSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ChildGraph } from "./graph"
import { verifyLifecycleArtifact, writeLifecycleArtifact } from "./lifecycle-artifact"
import { openRegularFileSnapshot } from "./file-snapshot"
import { readProgressPublicationSnapshot, recordProgressPublication } from "./progress-publication"
import { writeWorkflowFinalization } from "./workflow-finalization"
import { readWorkflowRuntimeSnapshot, writeWorkflowRuntimeSnapshot } from "./workflow-runtime-snapshot"

const temporary: string[] = []

function workdir(): string {
  const path = mkdtempSync(join(tmpdir(), "cchp-lifecycle-"))
  temporary.push(path)
  mkdirSync(join(path, "ctx", "codex"), { recursive: true })
  return path
}

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true })
})

describe("actions lifecycle artifact", () => {
  test("projects terminal, todo, child, progress and usage state without raw content", () => {
    const root = workdir()
    const codex = join(root, "ctx", "codex")
    const artifacts = join(root, "artifacts")
    const secret = "super-secret-provider-key"
    writeFileSync(join(codex, "terminal.json"), `${JSON.stringify({
      state: "SUCCEEDED",
      exitCode: 0,
      rootThreadId: "root-thread-sensitive",
      rootTurnId: "root-turn-sensitive",
      terminalReason: `Authorization: Bearer ${secret}`,
      finalMessage: "Inspection complete.",
      runtime: { codexVersion: "0.146.0", executionMode: "native_v2" },
      usage: {
        acceptedRaw: true,
        consumed: 1234,
        limit: 5000,
        fraction: 0.2468,
        state: "normal",
        blockingAnomalies: 0,
        responses: 7,
        turns: 3,
        admissionDenials: 1,
        reservedTokens: 0,
        responsesInFlight: 0,
        responseLimit: 6,
        inputTokens: 900,
        contextInputTokens: 1_100,
        cachedInputTokens: 400,
        outputTokens: 334,
        reasoningOutputTokens: 120,
        maxResponseTokens: 300,
        maxContextInputTokens: 220,
      },
    })}\n`)
    writeFileSync(join(codex, "todo.json"), `${JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      rootThreadId: "root-thread-sensitive",
      updatedAt: new Date().toISOString(),
      todos: [
        { content: `never publish ${secret}`, status: "completed" },
        { content: "private prompt text", status: "in_progress" },
      ],
    })}\n`)
    const graph = new ChildGraph(join(codex, "graph.jsonl"))
    graph.open("root", "child-native", "spawn-native", "native_v2")
    graph.close("child-native", "completed")
    graph.open("root", "child-explicit", "spawn-explicit", "explicit_child")
    graph.close("child-explicit", "failed")
    const env = { BOT_WORKDIR: root }
    recordProgressPublication(env, "cchp-bot:progress:ci_fix", {
      action: "created",
      id: 42,
      htmlUrl: "https://example.invalid/42",
    }, false)
    recordProgressPublication(env, "cchp-bot:progress:ci_fix", {
      action: "updated",
      id: 42,
      htmlUrl: "https://example.invalid/42",
    }, true)
    const finalizationPath = join(artifacts, "workflow-finalization.json")
    writeWorkflowFinalization(finalizationPath, {
      schemaVersion: 1,
      terminalSha256: openRegularFileSnapshot(join(codex, "terminal.json")).sha256,
      resolvedState: "SUCCEEDED",
      reasonCode: "supervisor_succeeded",
      publication: "published",
      progressPublicationSha256: readProgressPublicationSnapshot(
        join(codex, "progress-publication.json"),
        "cchp-bot:progress:ci_fix",
      )!.sha256,
      commentId: 42,
      action: "updated",
      recordedAt: new Date().toISOString(),
    })

    const path = writeLifecycleArtifact({
      BOT_WORKDIR: root,
      CCHP_LIFECYCLE_ARTIFACT_DIR: artifacts,
      GITHUB_RUN_ID: "9001",
      GITHUB_RUN_ATTEMPT: "2",
      BOT_RUN_ID: "run-9001",
      BOT_TASK: "ci_fix",
      BOT_REPO: "CCH-HQ/example",
      BOT_PR_NUMBER: "17",
      CCHP_WORKFLOW_FINALIZATION_PATH: finalizationPath,
      CCHP_INSTALL_OUTCOME: "success",
      CCHP_PREPARE_OUTCOME: "success",
      CCHP_SCAN_OUTCOME: "success",
      CCHP_CAPABILITY_OUTCOME: "success",
      CCHP_SUPERVISOR_OUTCOME: "success",
    })
    const report = JSON.parse(readFileSync(path, "utf8"))
    expect(report).toMatchObject({
      schema_version: 2,
      artifact_kind: "cchp_actions_lifecycle",
      artifact_phase: "primary",
      authority: "provisional",
      run: { github_run_id: "9001", github_run_attempt: 2, engine_run_id: "run-9001", task: "ci_fix" },
      subject: { repository: "CCH-HQ/example", kind: "pull_request", number: 17 },
      progress_comment: { ledger: "valid", comment_id: 42, created_count: 1, updated_count: 1, finalized: true, publication: "published" },
      todo: { ledger: "valid", revision: 4, total: 2, completed: 1, in_progress: 1 },
      root: { state: "SUCCEEDED", exit_code: 0, thread_present: true, turn_present: true, reason_code: "supervisor_succeeded" },
      children: {
        ledger: "valid",
        total: 2,
        open: 0,
        closed: 2,
        by_transport: { native_v2: 1, explicit_child: 1 },
        by_terminal_state: { completed: 1, failed: 1, timed_out: 0, interrupted: 0, lost: 0 },
      },
      usage: {
        consumed: 1234, reserved: 0, in_flight: 0, limit: 5000, responses: 7, turns: 3,
        blocking_anomalies: 0, admission_denials: 1, response_limit: 6,
        input_tokens: 900, context_input_tokens: 1_100, cached_input_tokens: 400,
        output_tokens: 334, reasoning_output_tokens: 120,
        max_response_tokens: 300, max_context_input_tokens: 220,
      },
      runtime: { codex_version: "0.146.0", execution_mode: "native_v2" },
      workflow: { finalization_record: "published" },
    })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("private prompt text")
    expect(serialized).not.toContain("root-thread-sensitive")
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("still emits a fixed-code artifact when setup fails before the supervisor", () => {
    const root = workdir()
    const path = writeLifecycleArtifact({
      BOT_WORKDIR: root,
      CCHP_LIFECYCLE_ARTIFACT_DIR: join(root, "artifacts"),
      GITHUB_RUN_ID: "77",
      GITHUB_RUN_ATTEMPT: "1",
      BOT_TASK: "manual",
      BOT_REPO: "CCH-HQ/example",
      CCHP_INSTALL_OUTCOME: "failure",
    })
    const report = JSON.parse(readFileSync(path, "utf8"))
    expect(report.root).toEqual({
      state: "FAILED",
      exit_code: 1,
      thread_present: false,
      turn_present: false,
      reason_code: "codex_install_failed",
    })
    expect(report.progress_comment).toEqual({ ledger: "absent", publication: "unknown", finalized: false })
    expect(report.children).toMatchObject({ ledger: "absent", total: 0, open: 0, closed: 0 })
    expect(report.usage).toMatchObject({ consumed: 0, responses: 0, blocking_anomalies: 0 })
  })

  test("labels transport-time final evidence as a non-authoritative candidate", () => {
    const root = workdir()
    const path = writeLifecycleArtifact({
      BOT_WORKDIR: root,
      CCHP_LIFECYCLE_ARTIFACT_DIR: join(root, "artifacts"),
      CCHP_LIFECYCLE_ARTIFACT_PHASE: "final_candidate",
      GITHUB_RUN_ID: "88",
      GITHUB_RUN_ATTEMPT: "1",
      BOT_TASK: "manual",
      BOT_REPO: "CCH-HQ/example",
      CCHP_INSTALL_OUTCOME: "failure",
    })
    const report = JSON.parse(readFileSync(path, "utf8"))
    expect(report.artifact_phase).toBe("final_candidate")
    expect(report.authority).toBe("pre_transport_bound")
    expect(path).toContain("cchp-actions-lifecycle-final_candidate-")
    verifyLifecycleArtifact(path, openRegularFileSnapshot(path).sha256)
  })

  test("final candidate preserves primary artifact cleanup failures from pre-transport reconciliation", () => {
    for (const cleanup of [
      { token: "failure", deletion: "skipped", reason: "invalid_artifact_cleanup_token_failed" },
      { token: "success", deletion: "failure", reason: "invalid_primary_artifact_cleanup_failed" },
    ]) {
      const root = workdir()
      const terminalPath = join(root, "ctx", "codex", "terminal.json")
      writeFileSync(terminalPath, JSON.stringify({
        state: "SUCCEEDED",
        exitCode: 0,
        usage: { consumed: 1, limit: 10 },
      }))
      const finalizationPath = join(root, "workflow-finalization.json")
      writeWorkflowFinalization(finalizationPath, {
        schemaVersion: 1,
        terminalSha256: openRegularFileSnapshot(terminalPath).sha256,
        resolvedState: "FAILED",
        reasonCode: cleanup.reason as "invalid_artifact_cleanup_token_failed" | "invalid_primary_artifact_cleanup_failed",
        publication: "skipped",
        progressPublicationSha256: null,
        recordedAt: new Date().toISOString(),
      })
      const path = writeLifecycleArtifact({
        BOT_WORKDIR: root,
        CCHP_LIFECYCLE_ARTIFACT_DIR: join(root, "final-artifact"),
        CCHP_LIFECYCLE_ARTIFACT_PHASE: "final_candidate",
        CCHP_WORKFLOW_FINALIZATION_PATH: finalizationPath,
        CCHP_INSTALL_OUTCOME: "success",
        CCHP_PREPARE_OUTCOME: "success",
        CCHP_SCAN_OUTCOME: "success",
        CCHP_CAPABILITY_OUTCOME: "success",
        CCHP_SUPERVISOR_OUTCOME: "success",
        CCHP_PRIMARY_ARTIFACT_INVALID: "true",
        CCHP_INVALID_PRIMARY_ARTIFACT_CLEANUP_TOKEN_OUTCOME: cleanup.token,
        CCHP_INVALID_PRIMARY_ARTIFACT_CLEANUP_OUTCOME: cleanup.deletion,
      })
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        artifact_phase: "final_candidate",
        root: { state: "FAILED", reason_code: cleanup.reason },
        workflow: {
          lifecycle_invalid_primary_cleanup_token: cleanup.token,
          lifecycle_invalid_primary_cleanup: cleanup.deletion,
        },
      })
    }
  })

  test("projects terminal, todo, children and usage from the trusted snapshot after cleanup", () => {
    const root = workdir()
    const codex = join(root, "ctx", "codex")
    const staging = workdir()
    writeFileSync(join(codex, "terminal.json"), JSON.stringify({
      state: "SUCCEEDED",
      exitCode: 0,
      rootThreadId: "root-sensitive",
      rootTurnId: "turn-sensitive",
      usage: {
        consumed: 222,
        limit: 2_000,
        state: "normal",
        responses: 8,
        turns: 4,
        blockingAnomalies: 1,
        admissionDenials: 2,
      },
    }))
    writeFileSync(join(codex, "todo.json"), JSON.stringify({
      schemaVersion: 1,
      revision: 5,
      rootThreadId: "root-sensitive",
      updatedAt: new Date().toISOString(),
      todos: [{ content: "sensitive todo text", status: "completed" }],
    }))
    const graph = new ChildGraph(join(codex, "graph.jsonl"))
    graph.open("root-sensitive", "child-sensitive", "spawn-sensitive", "native_v2")
    graph.close("child-sensitive", "failed")
    recordProgressPublication({ BOT_WORKDIR: root }, "cchp-bot:progress:manual", {
      id: 71,
      action: "updated",
      htmlUrl: "https://example.invalid/71",
    }, true)
    const runtime = writeWorkflowRuntimeSnapshot({
      BOT_WORKDIR: root,
      BOT_TASK: "manual",
      BOT_RUN_ID: "engine-71",
      GITHUB_RUN_ID: "github-71",
      CCHP_RUNTIME_SNAPSHOT_PATH: join(staging, "runtime-snapshot.json"),
    })
    const snapshot = readWorkflowRuntimeSnapshot(runtime.path, runtime.sha256, {
      BOT_TASK: "manual",
      BOT_RUN_ID: "engine-71",
      GITHUB_RUN_ID: "github-71",
    })
    const finalizationPath = join(staging, "workflow-finalization.json")
    writeWorkflowFinalization(finalizationPath, {
      schemaVersion: 1,
      terminalSha256: snapshot.terminal.sha256,
      resolvedState: "SUCCEEDED",
      reasonCode: "supervisor_succeeded",
      publication: "published",
      progressPublicationSha256: snapshot.progress.sha256,
      commentId: 71,
      action: "updated",
      recordedAt: new Date().toISOString(),
    })
    rmSync(root, { recursive: true })

    const path = writeLifecycleArtifact({
      BOT_WORKDIR: root,
      BOT_TASK: "manual",
      BOT_RUN_ID: "engine-71",
      GITHUB_RUN_ID: "github-71",
      CCHP_RUNTIME_SNAPSHOT_PATH: runtime.path,
      CCHP_RUNTIME_SNAPSHOT_SHA256: runtime.sha256,
      CCHP_WORKFLOW_FINALIZATION_PATH: finalizationPath,
      CCHP_LIFECYCLE_ARTIFACT_DIR: join(staging, "final-artifact"),
      CCHP_INSTALL_OUTCOME: "success",
      CCHP_PREPARE_OUTCOME: "success",
      CCHP_SCAN_OUTCOME: "success",
      CCHP_CAPABILITY_OUTCOME: "success",
      CCHP_SUPERVISOR_OUTCOME: "success",
      CCHP_RUNTIME_SNAPSHOT_OUTCOME: "success",
    })
    const serialized = readFileSync(path, "utf8")
    const report = JSON.parse(serialized)
    expect(report).toMatchObject({
      root: { state: "SUCCEEDED", thread_present: true, turn_present: true },
      todo: { ledger: "valid", revision: 5, total: 1, completed: 1 },
      children: { ledger: "valid", total: 1, closed: 1, by_terminal_state: { failed: 1 } },
      usage: { consumed: 222, responses: 8, turns: 4, blocking_anomalies: 1, admission_denials: 2 },
      runtime_snapshot: { source: "trusted_staging", sha256: runtime.sha256 },
    })
    expect(serialized).not.toContain("sensitive todo text")
    expect(serialized).not.toContain("root-sensitive")
    expect(serialized).not.toContain("child-sensitive")
  })

  test("uses a lifecycle-specific reason code instead of misclassifying upload failure as supervisor failure", () => {
    const root = workdir()
    const artifacts = join(root, "artifacts")
    writeFileSync(join(root, "ctx", "codex", "terminal.json"), JSON.stringify({
      state: "SUCCEEDED",
      exitCode: 0,
      usage: { consumed: 1, limit: 10 },
    }))
    const path = writeLifecycleArtifact({
      BOT_WORKDIR: root,
      CCHP_LIFECYCLE_ARTIFACT_DIR: artifacts,
      CCHP_WRITE_OUTCOME: "skipped",
      CCHP_INSTALL_OUTCOME: "success",
      CCHP_PREPARE_OUTCOME: "success",
      CCHP_SCAN_OUTCOME: "success",
      CCHP_CAPABILITY_OUTCOME: "success",
      CCHP_SUPERVISOR_OUTCOME: "success",
      CCHP_LIFECYCLE_STAGING_OUTCOME: "success",
      CCHP_LIFECYCLE_EVIDENCE_OUTCOME: "success",
      CCHP_VERIFY_LIFECYCLE_OUTCOME: "success",
      CCHP_UPLOAD_LIFECYCLE_OUTCOME: "failure",
    })
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      root: { state: "FAILED", reason_code: "lifecycle_upload_failed" },
    })
  })

  test("preserves a supervisor-owned nonstandard exit code", () => {
    const root = workdir()
    writeFileSync(join(root, "ctx", "codex", "terminal.json"), JSON.stringify({
      state: "FAILED",
      exitCode: 42,
      usage: { consumed: 1, limit: 10 },
    }))
    const path = writeLifecycleArtifact({
      BOT_WORKDIR: root,
      CCHP_LIFECYCLE_ARTIFACT_DIR: join(root, "artifacts"),
      CCHP_INSTALL_OUTCOME: "success",
      CCHP_PREPARE_OUTCOME: "success",
      CCHP_SCAN_OUTCOME: "success",
      CCHP_CAPABILITY_OUTCOME: "success",
      CCHP_SUPERVISOR_OUTCOME: "failure",
    })
    expect(JSON.parse(readFileSync(path, "utf8")).root).toMatchObject({ state: "FAILED", exit_code: 42 })
  })

  test("projects the last nonterminal checkpoint after a native runtime crash", () => {
    const root = workdir()
    const codex = join(root, "ctx", "codex")
    writeFileSync(join(codex, "run-manifest.json"), JSON.stringify({
      schemaVersion: 1,
      runId: "run-crash",
      task: "engage",
      state: "ROOT_RUNNING",
      execution_mode: "native_v2",
      codexVersion: "codex-cli 0.146.0",
      rootThreadId: "root",
      rootTurnId: "turn",
      usage: {
        acceptedRaw: false,
        consumed: 392_592,
        limit: 2_000_000,
        fraction: 0.196296,
        state: "normal",
        blockingAnomalies: 0,
        responses: 8,
        turns: 1,
        admissionDenials: 0,
        reservedTokens: 24_000,
        responsesInFlight: 1,
      },
    }))
    const snapshot = writeWorkflowRuntimeSnapshot({
      BOT_WORKDIR: root,
      BOT_TASK: "engage",
      BOT_RUN_ID: "run-crash",
      GITHUB_RUN_ID: "31331605047",
      CCHP_RUNTIME_SNAPSHOT_PATH: join(root, "trusted", "runtime-snapshot.json"),
    })
    const path = writeLifecycleArtifact({
      BOT_WORKDIR: root,
      BOT_TASK: "engage",
      BOT_RUN_ID: "run-crash",
      GITHUB_RUN_ID: "31331605047",
      CCHP_RUNTIME_SNAPSHOT_PATH: snapshot.path,
      CCHP_RUNTIME_SNAPSHOT_SHA256: snapshot.sha256,
      CCHP_LIFECYCLE_ARTIFACT_DIR: join(root, "artifacts"),
      CCHP_INSTALL_OUTCOME: "success",
      CCHP_PREPARE_OUTCOME: "success",
      CCHP_SCAN_OUTCOME: "success",
      CCHP_CAPABILITY_OUTCOME: "success",
      CCHP_SUPERVISOR_OUTCOME: "failure",
    })
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      root: { state: "FAILED", thread_present: true, turn_present: true, reason_code: "supervisor_failed" },
      usage: { consumed: 392_592, reserved: 24_000, in_flight: 1, limit: 2_000_000, responses: 8, turns: 1 },
      runtime: { codex_version: "codex-cli 0.146.0", execution_mode: "native_v2" },
    })
  })

  test("rejects published finalization bound to skipped or unfinished progress semantics", () => {
    const root = workdir()
    const codex = join(root, "ctx", "codex")
    const terminalPath = join(codex, "terminal.json")
    writeFileSync(terminalPath, JSON.stringify({ state: "FAILED", exitCode: 1, usage: { consumed: 1, limit: 10 } }))
    recordProgressPublication({ BOT_WORKDIR: root }, "cchp-bot:progress:engage", {
      id: 5,
      action: "created",
      htmlUrl: "https://example.invalid/5",
    }, false, "skipped")
    const progress = readProgressPublicationSnapshot(join(codex, "progress-publication.json"), "cchp-bot:progress:engage")!
    const finalizationPath = join(root, "artifacts", "workflow-finalization.json")
    writeWorkflowFinalization(finalizationPath, {
      schemaVersion: 1,
      terminalSha256: openRegularFileSnapshot(terminalPath).sha256,
      resolvedState: "FAILED",
      reasonCode: "supervisor_failed",
      publication: "published",
      progressPublicationSha256: progress.sha256,
      commentId: 5,
      action: "created",
      recordedAt: new Date().toISOString(),
    })
    expect(() => writeLifecycleArtifact({
      BOT_WORKDIR: root,
      BOT_TASK: "engage",
      CCHP_LIFECYCLE_ARTIFACT_DIR: join(root, "final"),
      CCHP_WORKFLOW_FINALIZATION_PATH: finalizationPath,
      CCHP_INSTALL_OUTCOME: "success",
      CCHP_PREPARE_OUTCOME: "success",
      CCHP_SCAN_OUTCOME: "success",
      CCHP_CAPABILITY_OUTCOME: "success",
      CCHP_SUPERVISOR_OUTCOME: "failure",
    })).toThrow("publication semantics mismatch")
  })

  test("preserves a finalized skipped publication without a comment id", () => {
    const root = workdir()
    recordProgressPublication({ BOT_WORKDIR: root }, "cchp-bot:progress:pr_opened", undefined, true, "skipped")
    const path = writeLifecycleArtifact({
      BOT_WORKDIR: root,
      CCHP_LIFECYCLE_ARTIFACT_DIR: join(root, "artifacts"),
      BOT_TASK: "pr_opened",
      CCHP_INSTALL_OUTCOME: "failure",
    })
    const report = JSON.parse(readFileSync(path, "utf8"))
    expect(report.progress_comment).toEqual({
      ledger: "valid",
      created_count: 0,
      updated_count: 0,
      finalized: true,
      publication: "skipped",
    })
  })

  test("fails closed on forged progress markers and child transports without echoing raw content", () => {
    const root = workdir()
    const codex = join(root, "ctx", "codex")
    const secret = "Authorization: Bearer fixture-secret"
    writeFileSync(join(codex, "progress-publication.json"), JSON.stringify({
      schemaVersion: 1,
      marker: secret,
      commentId: 1,
      action: "created",
      publication: "published",
      createdCount: 1,
      updatedCount: 0,
      finalized: false,
      updatedAt: new Date().toISOString(),
    }))
    writeFileSync(join(codex, "graph.jsonl"), `${JSON.stringify({
      event: "edge_opened",
      parentId: "root",
      childId: "child",
      spawnItemId: "spawn",
      transport: "corrupt_transport",
      openedAt: new Date().toISOString(),
      generation: 1,
    })}\n`)

    const path = writeLifecycleArtifact({
      BOT_WORKDIR: root,
      CCHP_LIFECYCLE_ARTIFACT_DIR: join(root, "artifacts"),
      BOT_TASK: "ci_fix",
      CCHP_INSTALL_OUTCOME: "failure",
    })
    const serialized = readFileSync(path, "utf8")
    const report = JSON.parse(serialized)
    expect(report.progress_comment).toEqual({ ledger: "invalid", publication: "unknown", finalized: false })
    expect(report.children).toMatchObject({ ledger: "invalid", total: 0 })
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("corrupt_transport")
  })

  test("marks impossible progress and todo ledger shapes invalid", () => {
    const root = workdir()
    const codex = join(root, "ctx", "codex")
    writeFileSync(join(codex, "progress-publication.json"), JSON.stringify({
      schemaVersion: 1,
      marker: "cchp-bot:progress:ci_fix",
      commentId: 7,
      publication: "skipped",
      createdCount: 99,
      updatedCount: 88,
      finalized: true,
      updatedAt: "not-a-date",
    }))
    writeFileSync(join(codex, "todo.json"), JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      rootThreadId: "root",
      updatedAt: new Date().toISOString(),
      todos: [null, { content: "x", status: "bogus" }],
    }))
    const path = writeLifecycleArtifact({
      BOT_WORKDIR: root,
      CCHP_LIFECYCLE_ARTIFACT_DIR: join(root, "artifacts"),
      BOT_TASK: "ci_fix",
      CCHP_INSTALL_OUTCOME: "failure",
    })
    const report = JSON.parse(readFileSync(path, "utf8"))
    expect(report.progress_comment.ledger).toBe("invalid")
    expect(report.todo.ledger).toBe("invalid")
  })

  test("distinguishes an absent todo ledger from malformed and unsafe ledger paths", () => {
    for (const kind of ["malformed", "symlink"] as const) {
      const root = workdir()
      const todo = join(root, "ctx", "codex", "todo.json")
      if (kind === "malformed") writeFileSync(todo, "{broken")
      else {
        const target = join(root, "untrusted-todo.json")
        writeFileSync(target, "{}")
        symlinkSync(target, todo)
      }
      const path = writeLifecycleArtifact({
        BOT_WORKDIR: root,
        CCHP_LIFECYCLE_ARTIFACT_DIR: join(root, "artifacts"),
        BOT_TASK: "manual",
        CCHP_INSTALL_OUTCOME: "failure",
      })
      expect(JSON.parse(readFileSync(path, "utf8")).todo).toMatchObject({ ledger: "invalid" })
    }
  })

  test("job cancellation overrides a successful supervisor terminal", () => {
    const root = workdir()
    writeFileSync(join(root, "ctx", "codex", "terminal.json"), JSON.stringify({
      state: "SUCCEEDED",
      exitCode: 0,
      usage: { consumed: 100, limit: 1_000 },
    }))
    const path = writeLifecycleArtifact({
      BOT_WORKDIR: root,
      CCHP_LIFECYCLE_ARTIFACT_DIR: join(root, "artifacts"),
      BOT_TASK: "manual",
      CCHP_INSTALL_OUTCOME: "success",
      CCHP_PREPARE_OUTCOME: "success",
      CCHP_SCAN_OUTCOME: "success",
      CCHP_CAPABILITY_OUTCOME: "success",
      CCHP_SUPERVISOR_OUTCOME: "success",
      CCHP_JOB_CANCELLED: "true",
    })
    expect(JSON.parse(readFileSync(path, "utf8")).root).toMatchObject({
      state: "CANCELLED",
      exit_code: 130,
      reason_code: "workflow_cancelled",
    })
  })

  test("rejects lifecycle generation when terminal or progress snapshots drift from finalization", () => {
    const root = workdir()
    const codex = join(root, "ctx", "codex")
    const artifacts = join(root, "artifacts")
    const terminalPath = join(codex, "terminal.json")
    writeFileSync(terminalPath, JSON.stringify({ state: "FAILED", exitCode: 1, usage: { consumed: 1, limit: 10 } }))
    recordProgressPublication({ BOT_WORKDIR: root }, "cchp-bot:progress:engage", {
      action: "created",
      id: 3,
      htmlUrl: "https://example.invalid/3",
    }, true)
    const progress = readProgressPublicationSnapshot(join(codex, "progress-publication.json"), "cchp-bot:progress:engage")!
    const finalizationPath = join(artifacts, "workflow-finalization.json")
    writeWorkflowFinalization(finalizationPath, {
      schemaVersion: 1,
      terminalSha256: openRegularFileSnapshot(terminalPath).sha256,
      resolvedState: "FAILED",
      reasonCode: "supervisor_failed",
      publication: "published",
      progressPublicationSha256: progress.sha256,
      commentId: 3,
      action: "created",
      recordedAt: new Date().toISOString(),
    })
    writeFileSync(terminalPath, JSON.stringify({ state: "CANCELLED", exitCode: 130, usage: { consumed: 1, limit: 10 } }))

    expect(() => writeLifecycleArtifact({
      BOT_WORKDIR: root,
      CCHP_LIFECYCLE_ARTIFACT_DIR: artifacts,
      CCHP_WORKFLOW_FINALIZATION_PATH: finalizationPath,
      BOT_TASK: "engage",
      CCHP_INSTALL_OUTCOME: "success",
      CCHP_PREPARE_OUTCOME: "success",
      CCHP_SCAN_OUTCOME: "success",
      CCHP_CAPABILITY_OUTCOME: "success",
      CCHP_SUPERVISOR_OUTCOME: "failure",
    })).toThrow("terminal snapshot hash mismatch")
  })

  test("verifies the staged artifact hash and rejects hardlinks", () => {
    const root = workdir()
    const path = writeLifecycleArtifact({
      BOT_WORKDIR: root,
      CCHP_LIFECYCLE_ARTIFACT_DIR: join(root, "artifacts"),
      BOT_TASK: "manual",
      CCHP_INSTALL_OUTCOME: "failure",
    })
    const sha256 = openRegularFileSnapshot(path).sha256
    verifyLifecycleArtifact(path, sha256)
    expect(() => verifyLifecycleArtifact(path, "0".repeat(64))).toThrow("hash mismatch")
    const alias = join(root, "lifecycle-hardlink.json")
    linkSync(path, alias)
    expect(() => verifyLifecycleArtifact(path, sha256)).toThrow("single-link regular file")
  })

  test("binds the declared lifecycle hash to the serialized report instead of a later pathname replacement", () => {
    const root = workdir()
    const output = join(root, "github-output")
    const path = writeLifecycleArtifact({
      BOT_WORKDIR: root,
      CCHP_LIFECYCLE_ARTIFACT_DIR: join(root, "artifacts"),
      GITHUB_OUTPUT: output,
      BOT_TASK: "manual",
      CCHP_INSTALL_OUTCOME: "failure",
    })
    const declared = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => line.split("=", 2)))
    const originalSha256 = openRegularFileSnapshot(path).sha256
    expect(declared.sha256).toBe(originalSha256)
    expect(declared.filename).toBe(`cchp-actions-lifecycle-primary-unknown-1-${originalSha256}.json`)
    expect(path).toEndWith(declared.filename)

    const replacement = join(root, "replacement.json")
    writeFileSync(replacement, "{}\n", { mode: 0o600 })
    renameSync(replacement, path)
    expect(openRegularFileSnapshot(path).sha256).not.toBe(declared.sha256)
    expect(() => verifyLifecycleArtifact(path, declared.sha256)).toThrow("hash mismatch")
  })
})
