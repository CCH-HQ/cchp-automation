/**
 * 调用仓库的公开 ABI. 这些字段属于 reusable workflow 的调用方,不是 Codex
 * 配置面;迁移只能在 engine 内部转换它们,不能要求 caller 改名或新增字段.
 */
export const WORKFLOW_INPUTS = {
  default_branch: "main",
  roadmap_project: "",
  roadmap_policy: ".github/cchp-automation/roadmap-policy.md",
  semver_workflow: "",
  semver_marker: "",
  tech_stack: "",
  languages: "",
} as const

export const REUSABLE_SECRETS = [
  "app-client-id",
  "app-private-key",
  "provider-keys",
  "heroui-token",
  "see-api-key",
] as const

export const CALLER_VARIABLES = [
  "CCHP_BOT_PROVIDERS",
  "CCHP_BOT_MODEL",
  "CCHP_BOT_SMALL_MODEL",
  "CCHP_BOT_EXTRA_INSTRUCTIONS",
  "CCHP_DISABLE_AUTO_APPROVE",
  // Legacy no-op:保留名称,但绝不复用为 Codex version/config 开关.
  "CCHP_BOT_OPENCODE_VERSION",
] as const

type Env = Record<string, string | undefined>

export interface CallerContract {
  overlay: {
    defaultBranch: string
    roadmapProject: string
    roadmapPolicy: string
    semverWorkflow: string
    semverMarker: string
    techStack: string
    languages: string
  }
  providerJson: string
  providerKeysJson: string
  model: string
  smallModel?: string
  extraInstructionsJson?: string
  disableAutoApprove: boolean
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function valueOr(value: string | undefined, fallback: string): string {
  return optional(value) ?? fallback
}

export function parseCallerContract(env: Env = process.env): CallerContract {
  return {
    overlay: {
      defaultBranch: valueOr(env.BOT_DEFAULT_BRANCH, WORKFLOW_INPUTS.default_branch),
      roadmapProject: valueOr(env.BOT_ROADMAP_PROJECT, WORKFLOW_INPUTS.roadmap_project),
      roadmapPolicy: valueOr(env.BOT_ROADMAP_POLICY, WORKFLOW_INPUTS.roadmap_policy),
      semverWorkflow: valueOr(env.BOT_SEMVER_WORKFLOW, "semver-guard"),
      semverMarker: valueOr(env.BOT_SEMVER_MARKER, "cchp-semver-guard"),
      techStack: optional(env.BOT_TECH_STACK) ?? "the stack documented in the repository CLAUDE.md files",
      languages: optional(env.BOT_LANGUAGES) ?? "the language the user used",
    },
    providerJson: valueOr(env.CCHP_BOT_PROVIDERS, "{}"),
    providerKeysJson: valueOr(env.CCHP_BOT_PROVIDER_KEYS, "{}"),
    model: valueOr(env.CCHP_BOT_MODEL, ""),
    smallModel: optional(env.CCHP_BOT_SMALL_MODEL),
    extraInstructionsJson: optional(env.CCHP_BOT_EXTRA_INSTRUCTIONS),
    disableAutoApprove: Boolean(env.CCHP_DISABLE_AUTO_APPROVE?.trim()),
  }
}
