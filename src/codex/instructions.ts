import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import type { CallerContract } from "./caller-contract"

export interface InstructionSource {
  source: string
  content: string
  sha256: string
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel !== "" && rel !== ".." && !rel.startsWith("..") && !isAbsolute(rel)
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

function localFiles(repoDir: string, pattern: string): string[] {
  const candidate = resolve(repoDir, pattern)
  if (!inside(repoDir, candidate)) throw new Error(`extra instruction path escapes trusted clone: ${pattern}`)
  if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("[")) {
    try {
      const stat = statSync(candidate)
      return stat.isFile() ? [candidate] : []
    } catch {
      return []
    }
  }
  const glob = new Bun.Glob(pattern)
  return [...glob.scanSync({ cwd: repoDir, absolute: true })]
    .filter((file) => inside(repoDir, file))
    .sort()
}

/** Resolve the frozen JSON-array caller variable in order. Local sources are
 * repo-relative and HTTPS sources are fetched with a bounded timeout. Missing
 * local paths are ignored for compatibility. Malformed JSON preserves the old
 * jq fallback to an empty list; valid JSON with the wrong shape is rejected. */
export async function loadExtraInstructions(raw: string | undefined, repoDir: string, timeoutMs = 10_000): Promise<InstructionSource[]> {
  if (!raw?.trim()) return []
  let values: unknown
  try {
    values = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string" && value.trim())) {
    throw new Error("CCHP_BOT_EXTRA_INSTRUCTIONS must be a JSON string array")
  }
  const result: InstructionSource[] = []
  for (const value of values as string[]) {
    const source = value.trim()
    if (/^https:\/\//i.test(source)) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(source, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const content = await response.text()
        result.push({ source, content, sha256: digest(content) })
      } finally {
        clearTimeout(timer)
      }
      continue
    }
    const files = localFiles(repoDir, source)
    for (const file of files) {
      const content = readFileSync(file, "utf8")
      result.push({ source: relative(repoDir, file), content, sha256: digest(content) })
    }
  }
  return result
}

export function renderInstructionOverlay(sources: readonly InstructionSource[]): string {
  return sources.map((entry) => `\n# Additional trusted instruction: ${entry.source}\n${entry.content.trim()}\n# End additional instruction`).join("\n")
}

const CALLER_OVERLAY_KEYS: Record<keyof CallerContract["overlay"], string> = {
  defaultBranch: "default_branch",
  roadmapProject: "roadmap_project",
  roadmapPolicy: "roadmap_policy",
  semverWorkflow: "semver_workflow",
  semverMarker: "semver_marker",
  techStack: "tech_stack",
  languages: "languages",
}

export function renderCallerOverlay(template: string, overlay: CallerContract["overlay"]): string {
  let rendered = template
  for (const [property, placeholder] of Object.entries(CALLER_OVERLAY_KEYS) as Array<[keyof CallerContract["overlay"], string]>) {
    rendered = rendered.replaceAll(`{{OVERLAY.${placeholder}}}`, overlay[property])
  }
  const unresolved = rendered.match(/\{\{OVERLAY\.[^}]+\}\}/)?.[0]
  if (unresolved) throw new Error(`unresolved caller overlay placeholder: ${unresolved}`)
  return rendered
}
