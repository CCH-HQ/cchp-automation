// Review reference-library sync, ported from
// `.github/cchp-bot/sync-review-references.mjs` (curl → Octokit tarball download,
// ADR 0003). Fetches the pinned upstream review-prompt / rule libraries,
// normalizes them, deduplicates prompt/rule bodies by SHA-256, and emits a single
// runtime catalog. Everything but the tarball fetch is pure, deterministic text
// processing over trusted base-side files; the fetch step is injectable so the
// catalog build can be exercised offline. The default fetcher downloads the
// commit-pinned tarball via `repos.downloadTarballArchive` and extracts it with
// `tar` (Node has no builtin extractor), replacing the original `curl | tar`.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { splitRepo } from "../context"
import type { GitHubClient } from "../github/client"

// ── config + catalog shapes ──────────────────────────────────────────────────

export interface SourceConfig {
  id: string
  repository: string
  commit: string
  license: string
  expected_imported_files: number
  expected_catalog_origins: number
  include: string[]
  license_paths: string[]
}

interface Metadata {
  title: string
  description: string
  languages: string[]
  tags: string[]
  always_apply: boolean
}
interface Candidate {
  origin: string
  kind: string
  body: string
  metadata: Metadata
}
interface Origin {
  source: string
  repository: string
  commit: string
  path: string
  license: string
}
interface MergedEntry {
  id: string
  sha256: string
  content_path: string
  kinds: string[]
  titles: string[]
  descriptions: string[]
  languages: string[]
  tags: string[]
  always_apply: boolean
  origins: Origin[]
}
interface AssetEntry {
  source: string
  repository: string
  commit: string
  license: string
  path: string
  binary?: boolean
  sha256?: string
  kind?: string
}
interface SourceSummary {
  id: string
  repository: string
  commit: string
  license: string
  imported_files: number
  catalog_origins: number
}

/** Fetch + extract one source's commit-pinned tree, returning the extracted dir.
 *  Injectable so the catalog build runs offline in tests. */
export type FetchSource = (source: SourceConfig, tempRoot: string) => Promise<string>

// ── pure helpers (verbatim ports) ────────────────────────────────────────────

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

export function normalizeText(value: string): string {
  return (
    value
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n")
      .trimEnd() + "\n"
  )
}

export function stripFrontmatter(value: string): { frontmatter: string; body: string } {
  const match = value.match(/^---\n([\s\S]*?)\n---\n?/)
  return match ? { frontmatter: match[1]!, body: value.slice(match[0].length) } : { frontmatter: "", body: value }
}

type MetaValue = string | boolean | string[]

export function frontmatterMetadata(frontmatter: string): Record<string, MetaValue> {
  const metadata: Record<string, MetaValue> = {}
  let active: string | null = null
  let blockStyle: string | null = null
  for (const line of frontmatter.split("\n")) {
    if (blockStyle && active && (/^\s/.test(line) || line.trim() === "")) {
      const content = line.trim()
      if (content) {
        const cur = typeof metadata[active] === "string" ? (metadata[active] as string) : ""
        metadata[active] = cur + (cur ? (blockStyle.startsWith(">") ? " " : "\n") : "") + content
      }
      continue
    }
    blockStyle = null
    const key = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)
    if (key) {
      active = key[1]!
      const raw = key[2]!.trim()
      if (raw === "|" || raw === "|-" || raw === "|+" || raw === ">" || raw === ">-" || raw === ">+") {
        metadata[active] = ""
        blockStyle = raw
        continue
      }
      if (raw === "[]") metadata[active] = []
      else if (raw.startsWith("[") && raw.endsWith("]")) {
        metadata[active] = raw
          .slice(1, -1)
          .split(",")
          .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean)
      } else {
        const value = raw.replace(/^['"]|['"]$/g, "")
        metadata[active] = value === "true" ? true : value === "false" ? false : value
      }
      continue
    }
    const item = line.match(/^\s*-\s+(.+)$/)
    if (item && active) {
      if (!Array.isArray(metadata[active])) metadata[active] = metadata[active] ? [metadata[active] as string] : []
      ;(metadata[active] as string[]).push(item[1]!.replace(/^['"]|['"]$/g, ""))
    }
  }
  return metadata
}

export function walk(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

/** Minimal glob matcher for the `include` / `license_paths` patterns (replaces
 *  the experimental `path.matchesGlob`): `**` spans path separators, `*` and `?`
 *  do not, everything else is literal. */
export function matchesGlob(pathStr: string, pattern: string): boolean {
  let re = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++
        if (pattern[i + 1] === "/") {
          i++
          re += "(?:.*/)?"
        } else {
          re += ".*"
        }
      } else {
        re += "[^/]*"
      }
    } else if (c === "?") {
      re += "[^/]"
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${re}$`).test(pathStr)
}

export function classify(source: SourceConfig, relativePath: string): string {
  if (/^(license|license\.md)$/i.test(relativePath)) return "asset"
  if (
    relativePath.includes("rule_docs/") ||
    relativePath.includes("sources/rules/core/") ||
    relativePath.includes("sources/rules/owasp/")
  ) {
    return "rule"
  }
  if (relativePath.includes("references/reviewers/")) return "reviewer-persona"
  if (relativePath.includes("map-personas/")) return "mapping-persona"
  if (relativePath.includes("/commands/") || relativePath.startsWith("packages/agents/commands/")) return "command"
  if (relativePath.endsWith("SKILL.md")) return "skill"
  if (relativePath.endsWith("AGENT.md")) return "agent"
  if (relativePath.includes("template") || relativePath.includes("references/")) return "workflow-template"
  return source.id === "project-codeguard" && relativePath.endsWith(".md") ? "security-guidance" : "asset"
}

const LANGUAGE_TOKENS = new Set([
  "go", "java", "kotlin", "python", "rust", "c", "cpp", "typescript",
  "javascript", "json", "yaml", "astro", "arkts",
])
const TAG_TOKENS = new Set([
  "security", "performance", "testing", "frontend", "backend", "architecture",
  "reliability", "accessibility", "devops", "data", "auth", "crypto", "privacy",
])

export function inferMetadata(
  source: SourceConfig,
  relativePath: string,
  text: string,
  frontmatter: string,
): Metadata {
  const metadata = frontmatterMetadata(frontmatter)
  const stem = basename(relativePath).replace(/\.(md|example|template)$/i, "")
  const asList = (v: MetaValue | undefined): string[] =>
    Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []
  const tags = new Set<string>(asList(metadata.tags))
  const languages = new Set<string>(asList(metadata.languages))
  for (const token of relativePath.toLowerCase().split(/[^a-z0-9+#.-]+/)) {
    if (LANGUAGE_TOKENS.has(token)) languages.add(token)
    if (TAG_TOKENS.has(token)) tags.add(token)
  }
  const str = (v: MetaValue | undefined): string => (typeof v === "string" ? v : "")
  return {
    title: str(metadata.name) || str(metadata.description) || text.match(/^#\s+(.+)$/m)?.[1] || stem,
    description: str(metadata.description),
    languages: [...languages].sort(),
    tags: [...tags].sort(),
    always_apply:
      metadata.alwaysApply === true || relativePath.includes("codeguard-1-") || relativePath.endsWith("default.md"),
  }
}

export function promptEntriesFromJson(source: SourceConfig, relativePath: string, normalized: string): Candidate[] {
  if (!relativePath.endsWith("scan_template.json")) return []
  const parsed = JSON.parse(normalized) as Record<string, { messages?: { role?: string; content?: unknown }[] }>
  const entries: Candidate[] = []
  for (const [conversation, value] of Object.entries(parsed)) {
    if (!value || !Array.isArray(value.messages)) continue
    value.messages.forEach((message, index) => {
      if (typeof message.content !== "string") return
      entries.push({
        origin: `${relativePath}#${conversation}.messages[${index}]`,
        kind: "prompt",
        body: normalizeText(message.content),
        metadata: {
          title: `${conversation} ${message.role} prompt`,
          description: "",
          languages: [],
          tags: ["scan", conversation.toLowerCase()],
          always_apply: false,
        },
      })
    })
  }
  return entries
}

// ── default (Octokit) fetch ──────────────────────────────────────────────────

/** curl → Octokit: download the commit-pinned tarball and extract it. */
export function octokitFetchSource(octokit: GitHubClient): FetchSource {
  return async (source, tempRoot) => {
    const archive = join(tempRoot, `${source.id}.tar.gz`)
    const extract = join(tempRoot, source.id)
    mkdirSync(extract)
    const { owner, name } = splitRepo(source.repository)
    const res = await octokit.rest.repos.downloadTarballArchive({ owner, repo: name, ref: source.commit })
    writeFileSync(archive, Buffer.from(res.data as ArrayBuffer))
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", extract], { stdio: "inherit" })
    return extract
  }
}

// ── catalog build (verbatim port of buildLibrary) ────────────────────────────

/** Build the reference library under `targetRoot`: vendor normalized copies,
 *  dedupe prompt/rule bodies by SHA-256 into `merged/`, and write `catalog.json`
 *  + `README.md`. Enforces each source's expected file/origin inventory. */
export async function buildLibrary(
  targetRoot: string,
  opts: { configPath: string; fetchSource: FetchSource },
): Promise<void> {
  const config = JSON.parse(readFileSync(opts.configPath, "utf8")) as { sources: SourceConfig[] }
  const tempRoot = mkdtempSync(join(tmpdir(), "cchp-review-references-"))
  const vendorRoot = join(targetRoot, "vendor")
  const mergedRoot = join(targetRoot, "merged")
  mkdirSync(vendorRoot, { recursive: true })
  mkdirSync(mergedRoot, { recursive: true })
  const merged = new Map<string, MergedEntry>()
  const assets: AssetEntry[] = []
  const sourceSummary: SourceSummary[] = []

  try {
    for (const source of config.sources) {
      const extracted = await opts.fetchSource(source, tempRoot)
      const patterns = [...source.include, ...source.license_paths]
      const selected = walk(extracted)
        .map((file) => ({ file, relative: relative(extracted, file).split(sep).join("/") }))
        .filter(({ relative: rel }) => patterns.some((pattern) => matchesGlob(rel, pattern)))
        .sort((a, b) => a.relative.localeCompare(b.relative))
      const sourceVendor = join(vendorRoot, source.id)
      let promptCount = 0
      for (const { file, relative: rel } of selected) {
        const destination = join(sourceVendor, rel)
        mkdirSync(dirname(destination), { recursive: true })
        const raw = readFileSync(file)
        const textual = !raw.includes(0)
        if (!textual) {
          copyFileSync(file, destination)
          assets.push({
            source: source.id,
            repository: source.repository,
            commit: source.commit,
            license: source.license,
            path: rel,
            binary: true,
          })
          continue
        }
        const normalized = normalizeText(raw.toString("utf8"))
        writeFileSync(destination, normalized)
        const kind = classify(source, rel)
        if (kind === "asset" || !/\.(md|example|template|json)$/i.test(rel)) {
          assets.push({
            source: source.id,
            repository: source.repository,
            commit: source.commit,
            license: source.license,
            path: rel,
            sha256: sha256(normalized),
            kind,
          })
          continue
        }
        const stripped = stripFrontmatter(normalized)
        const candidates = promptEntriesFromJson(source, rel, normalized)
        if (candidates.length === 0 && rel.endsWith(".json")) {
          assets.push({
            source: source.id,
            repository: source.repository,
            commit: source.commit,
            license: source.license,
            path: rel,
            sha256: sha256(normalized),
            kind,
          })
          continue
        }
        if (candidates.length === 0) {
          candidates.push({
            origin: rel,
            kind,
            body: normalizeText(stripped.body),
            metadata: inferMetadata(source, rel, stripped.body, stripped.frontmatter),
          })
        }
        for (const candidate of candidates) {
          const hash = sha256(candidate.body)
          let entry = merged.get(hash)
          if (!entry) {
            const contentPath = `merged/${hash}.md`
            writeFileSync(join(targetRoot, contentPath), candidate.body)
            entry = {
              id: hash,
              sha256: hash,
              content_path: contentPath,
              kinds: [],
              titles: [],
              descriptions: [],
              languages: [],
              tags: [],
              always_apply: false,
              origins: [],
            }
            merged.set(hash, entry)
          }
          entry.kinds.push(candidate.kind)
          entry.titles.push(candidate.metadata.title)
          if (candidate.metadata.description) entry.descriptions.push(candidate.metadata.description)
          entry.languages.push(...candidate.metadata.languages)
          entry.tags.push(...candidate.metadata.tags)
          entry.always_apply ||= candidate.metadata.always_apply
          entry.origins.push({
            source: source.id,
            repository: source.repository,
            commit: source.commit,
            path: candidate.origin,
            license: source.license,
          })
          promptCount++
        }
      }
      sourceSummary.push({
        id: source.id,
        repository: source.repository,
        commit: source.commit,
        license: source.license,
        imported_files: selected.length,
        catalog_origins: promptCount,
      })
      if (selected.length !== source.expected_imported_files || promptCount !== source.expected_catalog_origins) {
        throw new Error(
          `${source.id} inventory mismatch: files=${selected.length}/${source.expected_imported_files} origins=${promptCount}/${source.expected_catalog_origins}`,
        )
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }

  const entries = [...merged.values()]
    .map((entry) => ({
      ...entry,
      kinds: [...new Set(entry.kinds)].sort(),
      titles: [...new Set(entry.titles)].sort(),
      descriptions: [...new Set(entry.descriptions)].sort(),
      languages: [...new Set(entry.languages)].sort(),
      tags: [...new Set(entry.tags)].sort(),
      origins: entry.origins.sort((a, b) => `${a.source}:${a.path}`.localeCompare(`${b.source}:${b.path}`)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const catalog = {
    schema_version: 1,
    sources: sourceSummary,
    entries,
    assets: assets.sort((a, b) => `${a.source}:${a.path}`.localeCompare(`${b.source}:${b.path}`)),
    statistics: {
      unique_entries: entries.length,
      total_origins: entries.reduce((sum, entry) => sum + entry.origins.length, 0),
      deduplicated_origins: entries.reduce((sum, entry) => sum + Math.max(0, entry.origins.length - 1), 0),
      assets: assets.length,
    },
  }
  writeFileSync(join(targetRoot, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n")
  writeFileSync(
    join(targetRoot, "README.md"),
    `# Review Reference Library\n\nGenerated by \`.github/cchp-bot/sync-review-references.mjs\` from pinned upstream commits. Files under \`vendor/\` are normalized source copies; \`merged/\` strips YAML frontmatter and deduplicates exact normalized prompt/rule bodies by SHA-256. Runtime selection uses \`catalog.json\`. Do not edit generated files manually.\n\nThe catalog records repository, pinned commit, original path, and license for every merged origin. Vendored license texts remain under each source tree. Normalization and frontmatter stripping are local modifications; original normalized copies are preserved under \`vendor/\`.\n\n- Unique catalog entries: ${catalog.statistics.unique_entries}\n- Imported origins: ${catalog.statistics.total_origins}\n- Exact duplicates removed: ${catalog.statistics.deduplicated_origins}\n- Structured/non-prompt assets: ${catalog.statistics.assets}\n`,
  )
}

// ── sync entrypoint (verbatim port of the CLI check / build+swap paths) ──────

const moduleDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(moduleDir, "..", "..")
const DEFAULT_CONFIG = join(repoRoot, "opencode", "review", "reference-sources.json")
const DEFAULT_OUTPUT = join(repoRoot, "opencode", "review", "reference-library")

export interface SyncOptions {
  /** Client for the default tarball fetcher; unused when `fetchSource` is given. */
  octokit?: GitHubClient
  configPath?: string
  outputRoot?: string
  /** Verify the on-disk library matches a fresh rebuild (the `--check` mode). */
  check?: boolean
  fetchSource?: FetchSource
}

/** Sync the review reference library. Without `check`, builds into a staging dir
 *  and atomically swaps it in (restoring the previous copy on failure); with
 *  `check`, rebuilds into a temp dir and fails if the on-disk library differs —
 *  the exact semantics of the source script's two modes. */
export async function syncReviewReferences(opts: SyncOptions = {}): Promise<void> {
  const configPath = opts.configPath ?? DEFAULT_CONFIG
  const outputRoot = opts.outputRoot ?? DEFAULT_OUTPUT
  const fetchSource =
    opts.fetchSource ??
    (() => {
      if (!opts.octokit) throw new Error("syncReviewReferences requires an octokit or an injected fetchSource")
      return octokitFetchSource(opts.octokit)
    })()

  if (opts.check) {
    if (!existsSync(join(outputRoot, "catalog.json"))) {
      throw new Error("reference library is missing; run syncReviewReferences")
    }
    const temp = mkdtempSync(join(tmpdir(), "cchp-review-reference-check-"))
    try {
      await buildLibrary(temp, { configPath, fetchSource })
      const describe = (root: string): string =>
        walk(root)
          .map((file) => `${sha256(readFileSync(file))}  ${relative(root, file).split(sep).join("/")}`)
          .sort()
          .join("\n")
      if (describe(outputRoot) !== describe(temp)) {
        throw new Error("reference library is stale or locally modified; run syncReviewReferences")
      }
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
    return
  }

  const stagingRoot = mkdtempSync(join(dirname(outputRoot), ".reference-library-build-"))
  const backupRoot = `${outputRoot}.previous-${process.pid}`
  try {
    await buildLibrary(stagingRoot, { configPath, fetchSource })
    rmSync(backupRoot, { recursive: true, force: true })
    if (existsSync(outputRoot)) renameSync(outputRoot, backupRoot)
    renameSync(stagingRoot, outputRoot)
    rmSync(backupRoot, { recursive: true, force: true })
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true })
    if (!existsSync(outputRoot) && existsSync(backupRoot)) renameSync(backupRoot, outputRoot)
    throw error
  }
}
