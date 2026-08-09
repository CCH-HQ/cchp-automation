import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const workflow = readFileSync(join(import.meta.dir, "../../.github/workflows/run.yml"), "utf8")
const ciWorkflow = readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8")

test("pre-cutover CI validates the cleanup phase and its current-run evidence", () => {
  expect(ciWorkflow).toContain('"cleanup.txt"')
  expect(ciWorkflow).toContain('cleanup: "passed"')
})

test("portable Codex contract CI does not depend on an unavailable ARC runner", () => {
  const contract = ciWorkflow.slice(ciWorkflow.indexOf("  codex-contract:"), ciWorkflow.indexOf("  pre-cutover-acceptance:"))
  expect(contract).toContain("runs-on: ubuntu-22.04")
  expect(workflow.slice(0, workflow.indexOf("jobs:")).length).toBeGreaterThan(0)
  expect(workflow).toContain("runs-on: [self-hosted, linux, x64]")
})

test("trusted lifecycle staging persists one job run id and commits controller state atomically", () => {
  const identity = workflow.indexOf("- name: Bot identity + isolated workdir")
  const staging = workflow.indexOf("id: lifecycle_staging")
  const route = workflow.indexOf("id: route")
  const cleanup = workflow.indexOf("id: environment_cleanup")
  expect(workflow.slice(identity, staging)).toContain("BOT_RUN_ID=${bot_run_id}")
  expect(workflow.slice(identity, staging)).toContain("CCHP_WORKFLOW_RUN_ID=${BOT_RUN_ID}")
  const stagingSection = workflow.slice(staging, route)
  expect(stagingSection).not.toContain("continue-on-error: true")
  expect(stagingSection).toContain("trap cleanup_uncommitted EXIT")
  expect(stagingSection.indexOf("mv -f -- \"$identity_tmp\" \"$identity\"")).toBeLessThan(stagingSection.indexOf("cat \"$env_commit\" >> \"$GITHUB_ENV\""))
  expect(stagingSection.indexOf("cat \"$env_commit\" >> \"$GITHUB_ENV\"")).toBeLessThan(stagingSection.indexOf("committed=1"))
  for (const section of [
    workflow.slice(workflow.indexOf("- name: Install Bun"), workflow.indexOf("- name: Install engine dependencies")),
    workflow.slice(workflow.indexOf("- name: Install engine dependencies"), workflow.indexOf("- name: Route event")),
    workflow.slice(workflow.indexOf("- name: Route event"), workflow.indexOf("- name: Mint App token (write")),
  ]) expect(section).toContain("steps.lifecycle_staging.outcome == 'success'")
  expect(workflow.slice(cleanup, workflow.indexOf("- name: Verify Actions lifecycle evidence"))).toContain("steps.lifecycle_staging.outcome == 'success'")
})

test("authoritative reconciliation follows final transport and the terminal gate never rereads a pathname", () => {
  const preTransport = workflow.indexOf("id: reconcile_terminal")
  const finalArtifact = workflow.indexOf("id: final_lifecycle_evidence")
  const finalCleanup = workflow.indexOf("id: delete_invalid_final_lifecycle_evidence")
  const terminal = workflow.indexOf("id: reconcile_final_transport")
  const enforce = workflow.indexOf("- name: Enforce terminal workflow and final artifact transport")
  expect(preTransport).toBeGreaterThan(workflow.indexOf("id: delete_invalid_lifecycle_evidence"))
  expect(preTransport).toBeLessThan(finalArtifact)
  expect(finalCleanup).toBeGreaterThan(finalArtifact)
  expect(terminal).toBeGreaterThan(finalCleanup)
  expect(enforce).toBeGreaterThan(terminal)
  expect(workflow.slice(enforce)).not.toContain("FINALIZATION_PATH")
  expect(workflow.slice(enforce)).not.toContain("readFileSync")
  expect(workflow.slice(enforce)).not.toContain("uses:")
})

test("runtime evidence is snapshotted before finalization and cleanup and consumed after cleanup", () => {
  const snapshot = workflow.indexOf("id: runtime_snapshot")
  const finalize = workflow.indexOf("id: finalize_progress")
  const cleanup = workflow.indexOf("id: environment_cleanup")
  const preTransport = workflow.indexOf("id: reconcile_terminal")
  const finalArtifact = workflow.indexOf("id: final_lifecycle_evidence")
  const terminal = workflow.indexOf("id: reconcile_final_transport")
  expect(snapshot).toBeLessThan(finalize)
  expect(finalize).toBeLessThan(cleanup)
  expect(cleanup).toBeLessThan(preTransport)
  expect(finalArtifact).toBeLessThan(terminal)
  for (const section of [
    workflow.slice(finalize, workflow.indexOf("id: lifecycle_evidence")),
    workflow.slice(preTransport, finalArtifact),
    workflow.slice(finalArtifact, workflow.indexOf("id: verify_final_lifecycle_evidence")),
    workflow.slice(terminal, workflow.indexOf("- name: Enforce terminal workflow and final artifact transport")),
  ]) {
    expect(section).toContain("CCHP_RUNTIME_SNAPSHOT_PATH:")
    expect(section).toContain("CCHP_RUNTIME_SNAPSHOT_SHA256:")
    expect(section).toContain("CCHP_PROGRESS_PUBLICATION_PATH:")
  }
})

test("pre-transport reconciliation records failures without terminating before final transport", () => {
  const terminal = workflow.slice(workflow.indexOf("id: reconcile_terminal"), workflow.indexOf("id: final_lifecycle_staging"))
  for (const field of [
    "CCHP_LIFECYCLE_STAGING_OUTCOME",
    "CCHP_LIFECYCLE_EVIDENCE_OUTCOME",
    "CCHP_VERIFY_LIFECYCLE_OUTCOME",
    "CCHP_UPLOAD_LIFECYCLE_OUTCOME",
    "CCHP_VERIFY_UPLOADED_LIFECYCLE_OUTCOME",
    "CCHP_LIFECYCLE_ROUNDTRIP_STAGING_OUTCOME",
    "CCHP_DOWNLOAD_LIFECYCLE_OUTCOME",
    "CCHP_VERIFY_DOWNLOADED_LIFECYCLE_OUTCOME",
    "CCHP_RUNTIME_SNAPSHOT_OUTCOME",
    "CCHP_ENVIRONMENT_CLEANUP_OUTCOME",
    "CCHP_INVALID_PRIMARY_ARTIFACT_CLEANUP_TOKEN_OUTCOME",
    "CCHP_INVALID_PRIMARY_ARTIFACT_CLEANUP_OUTCOME",
  ]) expect(terminal).toContain(field)
  expect(terminal).not.toContain("CCHP_ENFORCE_RESOLVED_STATE")
})

test("each invalid uploaded artifact is deleted after any incomplete round-trip", () => {
  const primaryToken = workflow.slice(
    workflow.indexOf("id: invalid_primary_artifact_cleanup_token"),
    workflow.indexOf("id: reconcile_terminal"),
  )
  const finalToken = workflow.slice(
    workflow.indexOf("id: invalid_artifact_cleanup_token"),
    workflow.indexOf("- name: Enforce terminal workflow and final artifact transport"),
  )
  for (const condition of [
    "steps.verify_uploaded_lifecycle_evidence.outcome != 'success'",
    "steps.lifecycle_roundtrip_staging.outcome != 'success'",
    "steps.download_lifecycle_evidence.outcome != 'success'",
    "steps.verify_downloaded_lifecycle_evidence.outcome != 'success'",
  ]) expect(primaryToken).toContain(condition)
  expect(primaryToken).toContain("steps.upload_lifecycle_evidence.outputs.artifact-id")
  for (const condition of [
    "steps.verify_uploaded_final_lifecycle_evidence.outcome != 'success'",
    "steps.final_lifecycle_roundtrip_staging.outcome != 'success'",
    "steps.download_final_lifecycle_evidence.outcome != 'success'",
    "steps.verify_downloaded_final_lifecycle_evidence.outcome != 'success'",
  ]) expect(finalToken).toContain(condition)
  expect(finalToken).toContain("steps.upload_final_lifecycle_evidence.outputs.artifact-id")
})

test("the final reconciliation receives every final artifact phase and the shell gate trusts only reconciler outcomes", () => {
  const reconciliation = workflow.slice(
    workflow.indexOf("id: reconcile_final_transport"),
    workflow.indexOf("- name: Enforce terminal workflow and final artifact transport"),
  )
  for (const field of [
    "CCHP_FINAL_LIFECYCLE_STAGING_OUTCOME",
    "CCHP_FINAL_LIFECYCLE_EVIDENCE_OUTCOME",
    "CCHP_VERIFY_FINAL_LIFECYCLE_OUTCOME",
    "CCHP_UPLOAD_FINAL_LIFECYCLE_OUTCOME",
    "CCHP_VERIFY_UPLOADED_FINAL_LIFECYCLE_OUTCOME",
    "CCHP_FINAL_LIFECYCLE_ROUNDTRIP_STAGING_OUTCOME",
    "CCHP_DOWNLOAD_FINAL_LIFECYCLE_OUTCOME",
    "CCHP_VERIFY_DOWNLOADED_FINAL_LIFECYCLE_OUTCOME",
    "CCHP_FINAL_ARTIFACT_INVALID",
    "CCHP_INVALID_PRIMARY_ARTIFACT_CLEANUP_TOKEN_OUTCOME",
    "CCHP_INVALID_FINAL_ARTIFACT_CLEANUP_TOKEN_OUTCOME",
    "CCHP_INVALID_FINAL_ARTIFACT_CLEANUP_OUTCOME",
    "CCHP_FINALIZER_OUTCOME",
    "CCHP_FINAL_CANDIDATE_REQUIRED",
    "CCHP_ENFORCE_RESOLVED_STATE: \"true\"",
  ]) expect(reconciliation).toContain(field)
  expect(reconciliation.slice(0, reconciliation.indexOf("continue-on-error"))).not.toContain("steps.reconcile_terminal.outcome == 'success'")

  const gate = workflow.slice(workflow.indexOf("- name: Enforce terminal workflow and final artifact transport"))
  expect(gate).toContain("FINAL_RECONCILE_OUTCOME")
  expect(gate).not.toContain("PRE_TRANSPORT_RECONCILE_OUTCOME")
  expect(gate).not.toContain("CCHP_FINAL_LIFECYCLE_STAGING_OUTCOME")
  expect(gate).not.toContain("CCHP_INVALID_FINAL_ARTIFACT_CLEANUP_OUTCOME")
})

test("transported final lifecycle evidence is explicitly a non-authoritative candidate", () => {
  const candidate = workflow.slice(
    workflow.indexOf("id: final_lifecycle_evidence"),
    workflow.indexOf("id: verify_final_lifecycle_evidence"),
  )
  expect(candidate).toContain("CCHP_LIFECYCLE_ARTIFACT_PHASE: final_candidate")
  expect(candidate).not.toContain("workflow_conclusion_bound")
  for (const field of [
    "CCHP_PRIMARY_ARTIFACT_INVALID",
    "CCHP_INVALID_PRIMARY_ARTIFACT_CLEANUP_TOKEN_OUTCOME",
    "CCHP_INVALID_PRIMARY_ARTIFACT_CLEANUP_OUTCOME",
  ]) expect(candidate).toContain(field)
})
