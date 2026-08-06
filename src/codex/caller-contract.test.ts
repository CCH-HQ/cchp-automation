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
