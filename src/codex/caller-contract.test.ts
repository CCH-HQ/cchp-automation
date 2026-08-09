import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  CALLER_VARIABLES,
  parseCallerContract,
  REUSABLE_SECRETS,
  WORKFLOW_INPUTS,
} from "./caller-contract"

test("freezes the existing reusable workflow ABI without Codex-specific caller fields", () => {
  expect(WORKFLOW_INPUTS).toEqual({
    default_branch: "main",
    roadmap_project: "",
    roadmap_policy: ".github/cchp-automation/roadmap-policy.md",
    semver_workflow: "",
    semver_marker: "",
    tech_stack: "",
    languages: "",
  })
  expect(REUSABLE_SECRETS).toEqual([
    "app-client-id",
    "app-private-key",
    "provider-keys",
    "heroui-token",
    "see-api-key",
  ])
  expect(CALLER_VARIABLES).toEqual([
    "CCHP_BOT_PROVIDERS",
    "CCHP_BOT_MODEL",
    "CCHP_BOT_SMALL_MODEL",
    "CCHP_BOT_EXTRA_INSTRUCTIONS",
    "CCHP_DISABLE_AUTO_APPROVE",
    "CCHP_BOT_OPENCODE_VERSION",
  ])
})

test("freezes the serialized reusable workflow boundary and direct caller mappings", () => {
  const workflow = readFileSync(resolve(import.meta.dir, "../../.github/workflows/run.yml"), "utf8")
  const parsed = Bun.YAML.parse(workflow) as {
    on: { workflow_call: { inputs: Record<string, unknown>; secrets: Record<string, unknown> } }
  }
  expect(Object.keys(parsed.on.workflow_call.inputs)).toEqual(Object.keys(WORKFLOW_INPUTS))
  expect(Object.keys(parsed.on.workflow_call.secrets)).toEqual([...REUSABLE_SECRETS])
  const inputLines = workflow.match(/^ {6}(default_branch|roadmap_project|roadmap_policy|semver_workflow|semver_marker|tech_stack|languages):.*$/gm) ?? []
  expect(inputLines).toEqual([
    '      default_branch:  { type: string, required: false, default: "main" }',
    '      roadmap_project: { type: string, required: false, default: "" }',
    '      roadmap_policy:  { type: string, required: false, default: ".github/cchp-automation/roadmap-policy.md" }',
    '      semver_workflow: { type: string, required: false, default: "" }',
    '      semver_marker:   { type: string, required: false, default: "" }',
    '      tech_stack:      { type: string, required: false, default: "" }',
    '      languages:       { type: string, required: false, default: "" }',
  ])
  const secretLines = workflow.match(/^ {6}(app-client-id|app-private-key|provider-keys|heroui-token|see-api-key):.*$/gm) ?? []
  expect(secretLines).toEqual([
    "      app-client-id:   { required: true }",
    "      app-private-key: { required: true }",
    "      provider-keys:   { required: false }",
    "      heroui-token:    { required: false }",
    "      see-api-key:     { required: false }",
  ])
  for (const mapping of [
    "CCHP_BOT_PROVIDERS: ${{ vars.CCHP_BOT_PROVIDERS }}",
    "CCHP_BOT_MODEL: ${{ vars.CCHP_BOT_MODEL }}",
    "CCHP_BOT_SMALL_MODEL: ${{ vars.CCHP_BOT_SMALL_MODEL }}",
    "CCHP_BOT_EXTRA_INSTRUCTIONS: ${{ vars.CCHP_BOT_EXTRA_INSTRUCTIONS }}",
    "CCHP_DISABLE_AUTO_APPROVE: ${{ vars.CCHP_DISABLE_AUTO_APPROVE }}",
    "CCHP_BOT_PROVIDER_KEYS: ${{ secrets.provider-keys }}",
    "SEE_API_KEY: ${{ secrets.see-api-key }}",
    "HEROUI_AUTH_TOKEN: ${{ secrets.heroui-token }}",
  ]) expect(workflow).toContain(mapping)
  expect(workflow).not.toContain("${{ vars.CCHP_BOT_OPENCODE_VERSION }}")
  expect(workflow).not.toContain("OPENAI_API_KEY:")
  expect(workflow).not.toContain("CODEX_API_KEY:")
})

test("checks out the called workflow at GitHub's resolved engine commit", () => {
  const workflow = readFileSync(resolve(import.meta.dir, "../../.github/workflows/run.yml"), "utf8")
  const checkout = workflow.indexOf("- name: Checkout engine (pinned, trusted)")
  const nextStep = workflow.indexOf("- name: Bot identity + isolated workdir", checkout)
  expect(checkout).toBeGreaterThan(0)
  expect(nextStep).toBeGreaterThan(checkout)
  const block = workflow.slice(checkout, nextStep)
  expect(block).toContain("repository: ${{ fromJSON(toJSON(job)).workflow_repository }}")
  expect(block).toContain("ref: ${{ fromJSON(toJSON(job)).workflow_sha }}")
  expect(block).not.toContain("repository: ${{ github.repository }}")
  expect(block).not.toContain("ref: ${{ github.sha }}")

  const ciWorkflow = readFileSync(resolve(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8")
  expect(ciWorkflow).not.toContain("workflow_(repository|sha)")
})

test("parses the production caller variables without changing provider or secret JSON", () => {
  const providerJson = JSON.stringify({
    "gpt-cchp": {
      format: "openai-responses",
      base_url: "https://cc.autobits.cc/v1",
      models: { "gpt-5.6-sol": { context: 372000, output: 131072, vision: true } },
    },
  })
  const keyJson = JSON.stringify({ "gpt-cchp": "secret-key" })

  expect(
    parseCallerContract({
      BOT_DEFAULT_BRANCH: " dev ",
      BOT_ROADMAP_PROJECT: " 1 ",
      BOT_ROADMAP_POLICY: " .github/custom-roadmap.md ",
      BOT_SEMVER_WORKFLOW: " ",
      BOT_SEMVER_MARKER: " marker ",
      BOT_TECH_STACK: " go,typescript ",
      BOT_LANGUAGES: " zh-CN,en ",
      CCHP_BOT_PROVIDERS: providerJson,
      CCHP_BOT_MODEL: " gpt-cchp/gpt-5.6-sol ",
      CCHP_BOT_SMALL_MODEL: " ",
      CCHP_BOT_EXTRA_INSTRUCTIONS: '["docs/AGENTS.md"]',
      CCHP_DISABLE_AUTO_APPROVE: " true ",
      CCHP_BOT_PROVIDER_KEYS: keyJson,
      CCHP_BOT_OPENCODE_VERSION: "1.18.13",
    }),
  ).toEqual({
    overlay: {
      defaultBranch: "dev",
      roadmapProject: "1",
      roadmapPolicy: ".github/custom-roadmap.md",
      semverWorkflow: "semver-guard",
      semverMarker: "marker",
      techStack: "go,typescript",
      languages: "zh-CN,en",
    },
    providerJson,
    providerKeysJson: keyJson,
    model: "gpt-cchp/gpt-5.6-sol",
    smallModel: undefined,
    extraInstructionsJson: '["docs/AGENTS.md"]',
    disableAutoApprove: true,
  })
})

test("finalizes progress for every acted workflow before cleanup", () => {
  const workflow = readFileSync(resolve(import.meta.dir, "../../.github/workflows/run.yml"), "utf8")
  const finalizer = workflow.indexOf("- name: Finalize progress comment")
  const freshToken = workflow.indexOf("- name: Mint App token (progress finalizer)")
  const cleanup = workflow.indexOf("- name: Cleanup isolated environment")
  expect(finalizer).toBeGreaterThan(workflow.indexOf("- name: Run Codex supervisor"))
  expect(finalizer).toBeGreaterThan(freshToken)
  expect(cleanup).toBeGreaterThan(finalizer)
  const block = workflow.slice(freshToken, cleanup)
  expect(block).toContain("if: always() && steps.route.outputs.act == 'true'")
  expect(block).toContain("GH_TOKEN: ${{ steps.finalizer_token.outputs.token || steps.base.outputs.token }}")
  expect(block).toContain("CCHP_WRITE_OUTCOME: ${{ steps.write.outcome }}")
  expect(block).toContain("CCHP_NEEDS_WRITE: ${{ steps.route.outputs.needs_write }}")
  expect(block).toContain("CCHP_INSTALL_OUTCOME: ${{ steps.install_codex.outcome }}")
  expect(block).toContain("CCHP_PREPARE_OUTCOME: ${{ steps.prepare_codex.outcome }}")
  expect(block).toContain("CCHP_SCAN_OUTCOME: ${{ steps.external_scan.outcome }}")
  expect(block).toContain("CCHP_CAPABILITY_OUTCOME: ${{ steps.capability_gate.outcome }}")
  expect(block).toContain("CCHP_SUPERVISOR_OUTCOME: ${{ steps.codex_supervisor.outcome }}")
  expect(block).toContain("src/codex/finalize-workflow-progress.ts")
})

test("round-trips lifecycle evidence from the exact uploaded artifact id", () => {
  const workflow = readFileSync(resolve(import.meta.dir, "../../.github/workflows/run.yml"), "utf8")
  const stagedVerify = workflow.indexOf("- name: Verify Actions lifecycle evidence")
  const upload = workflow.indexOf("- name: Upload Actions lifecycle evidence")
  const download = workflow.indexOf("- name: Download uploaded Actions lifecycle evidence")
  const downloadedVerify = workflow.indexOf("- name: Verify downloaded Actions lifecycle evidence")
  expect(stagedVerify).toBeGreaterThan(0)
  expect(upload).toBeGreaterThan(stagedVerify)
  expect(download).toBeGreaterThan(upload)
  expect(downloadedVerify).toBeGreaterThan(download)
  const block = workflow.slice(upload)
  expect(block).toContain("id: upload_lifecycle_evidence")
  expect(block).toContain("artifact-ids: ${{ steps.upload_lifecycle_evidence.outputs.artifact-id }}")
  expect(block).toContain("archive: false")
  expect(block).toContain("UPLOADED_SHA256: ${{ steps.upload_lifecycle_evidence.outputs.artifact-digest }}")
  expect(block).toContain('[[ "$UPLOADED_SHA256" == "$EXPECTED_SHA256" ]]')
  expect(block).toContain("permission-actions: write")
  expect(block).toContain("actions/artifacts/${ARTIFACT_ID}")
  expect(block).toContain("CCHP_LIFECYCLE_ARTIFACT_PATH: ${{ steps.lifecycle_roundtrip_staging.outputs.dir }}/${{ steps.lifecycle_evidence.outputs.filename }}")
  expect(block).toContain("CCHP_LIFECYCLE_ARTIFACT_SHA256: ${{ steps.lifecycle_evidence.outputs.sha256 }}")
  expect(block).toContain("steps.download_lifecycle_evidence.outcome == 'success'")
})
