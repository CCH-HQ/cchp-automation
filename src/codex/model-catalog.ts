import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"

export interface BundledModelCatalog {
  models: Array<Record<string, unknown>>
}

export function parseBundledModelCatalog(raw: string): BundledModelCatalog {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("codex debug models --bundled did not emit a JSON object")
  const catalog = JSON.parse(raw.slice(start, end + 1)) as BundledModelCatalog
  if (!Array.isArray(catalog.models) || catalog.models.length !== 8) {
    throw new Error(`codex debug models --bundled must contain exactly 8 models, got ${catalog.models?.length ?? 0}`)
  }
  if (catalog.models.some((model) => typeof model.slug !== "string" || !model.slug)) {
    throw new Error("codex debug models --bundled catalog is missing model slugs")
  }
  return catalog
}

export function exportBundledModelCatalog(input: { codexBin: string; exportHome: string }): BundledModelCatalog {
  mkdirSync(input.exportHome, { recursive: true, mode: 0o700 })
  const result = spawnSync(input.codexBin, ["debug", "models", "--bundled"], {
    cwd: input.exportHome,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: input.exportHome,
      CODEX_HOME: input.exportHome,
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`codex debug models --bundled failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`)
  }
  return parseBundledModelCatalog(result.stdout)
}

export function patchBundledModelWindows(
  catalog: BundledModelCatalog,
  slug: string,
  context: number,
): BundledModelCatalog {
  const patched = JSON.parse(JSON.stringify(catalog)) as BundledModelCatalog
  const model = patched.models.find((entry) => entry.slug === slug)
  if (!model) throw new Error(`bundled Codex catalog is missing ${slug}`)
  model.context_window = context
  model.max_context_window = context
  if (patched.models.length !== 8) {
    throw new Error("patched Codex catalog must still contain exactly 8 models")
  }
  return patched
}

export function autoCompactTokenLimit(context: number, compactThreshold?: number): number {
  return Math.round(context * (compactThreshold ?? 0.9))
}

export function modelWindowOverrides(main: { context?: number; compactThreshold?: number }): {
  modelContextWindow?: number
  modelAutoCompactTokenLimit?: number
} {
  if (main.context === undefined) return {}
  return {
    modelContextWindow: main.context,
    modelAutoCompactTokenLimit: autoCompactTokenLimit(main.context, main.compactThreshold),
  }
}

export function buildAppServerArgs(input: {
  modelContextWindow?: number
  modelAutoCompactTokenLimit?: number
}): string[] {
  const args = ["app-server", "--stdio", "--strict-config"]
  if (input.modelContextWindow !== undefined) {
    args.push("-c", `model_context_window=${input.modelContextWindow}`)
  }
  if (input.modelAutoCompactTokenLimit !== undefined) {
    args.push("-c", `model_auto_compact_token_limit=${input.modelAutoCompactTokenLimit}`)
  }
  return args
}

export function threadStartConfigOverrides(input: {
  modelContextWindow?: number
  modelAutoCompactTokenLimit?: number
}): Record<string, number> | undefined {
  const config: Record<string, number> = {}
  if (input.modelContextWindow !== undefined) config.model_context_window = input.modelContextWindow
  if (input.modelAutoCompactTokenLimit !== undefined) {
    config.model_auto_compact_token_limit = input.modelAutoCompactTokenLimit
  }
  return Object.keys(config).length ? config : undefined
}
