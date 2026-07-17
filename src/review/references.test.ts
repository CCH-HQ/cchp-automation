import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildLibrary,
  classify,
  frontmatterMetadata,
  matchesGlob,
  normalizeText,
  promptEntriesFromJson,
  stripFrontmatter,
  type FetchSource,
  type SourceConfig,
} from "./references"

// ── pure helpers ─────────────────────────────────────────────────────────────

test("normalizeText: CRLF→LF, strips trailing whitespace, single trailing newline", () => {
  expect(normalizeText("a  \r\nb\t\r\n\r\n")).toBe("a\nb\n")
  expect(normalizeText("no-newline")).toBe("no-newline\n")
})

test("stripFrontmatter: splits YAML frontmatter from the body", () => {
  expect(stripFrontmatter("---\nname: Foo\n---\n# Body\n")).toEqual({ frontmatter: "name: Foo", body: "# Body\n" })
  expect(stripFrontmatter("# No frontmatter\n")).toEqual({ frontmatter: "", body: "# No frontmatter\n" })
})

test("frontmatterMetadata: scalars, inline lists, and block scalars", () => {
  const md = frontmatterMetadata("name: Foo\ntags: [a, b]\nalwaysApply: true\ndescription: |\n  line1\n  line2")
  expect(md.name).toBe("Foo")
  expect(md.tags).toEqual(["a", "b"])
  expect(md.alwaysApply).toBe(true)
  expect(md.description).toBe("line1\nline2")
})

test("frontmatterMetadata: block folded scalar joins with spaces", () => {
  const md = frontmatterMetadata("summary: >\n  one\n  two")
  expect(md.summary).toBe("one two")
})

test("matchesGlob: *, **, and literal semantics", () => {
  expect(matchesGlob("skills/foo/SKILL.md", "skills/*/SKILL.md")).toBe(true)
  expect(matchesGlob("skills/a/b/SKILL.md", "skills/*/SKILL.md")).toBe(false)
  expect(matchesGlob("sources/skills/security-review/a/b.md", "sources/skills/security-review/**")).toBe(true)
  expect(matchesGlob("packages/agents/commands/review.md", "packages/agents/commands/*.md")).toBe(true)
  expect(matchesGlob("LICENSE", "LICENSE")).toBe(true)
  expect(matchesGlob("LICENSE.md", "LICENSE")).toBe(false)
})

test("classify: buckets paths by review role", () => {
  const cg = { id: "project-codeguard" } as SourceConfig
  expect(classify(cg, "LICENSE")).toBe("asset")
  expect(classify(cg, "sources/rules/core/x.md")).toBe("rule")
  expect(classify(cg, "sources/rules/owasp/y.md")).toBe("rule")
  expect(classify(cg, "skills/codeguard/SKILL.md")).toBe("skill")
  expect(classify(cg, "sources/agents/codeguard-reviewer/AGENT.md")).toBe("agent")
  expect(classify(cg, "notes/general.md")).toBe("security-guidance")
  expect(classify({ id: "other" } as SourceConfig, "notes/general.md")).toBe("asset")
})

test("promptEntriesFromJson: only scan_template.json yields per-message prompts", () => {
  expect(promptEntriesFromJson({ id: "s" } as SourceConfig, "other.json", "{}")).toEqual([])
  const json = JSON.stringify({ Review: { messages: [{ role: "system", content: "You are a reviewer" }, { role: "user", content: 42 }] } })
  const entries = promptEntriesFromJson({ id: "s" } as SourceConfig, "internal/config/template/scan_template.json", json)
  expect(entries.length).toBe(1) // the non-string content is skipped
  expect(entries[0]!.origin).toBe("internal/config/template/scan_template.json#Review.messages[0]")
  expect(entries[0]!.body).toBe("You are a reviewer\n")
  expect(entries[0]!.metadata.tags).toEqual(["scan", "review"])
})

// ── buildLibrary end-to-end (offline, injected fetch) ─────────────────────────

test("buildLibrary: dedups identical bodies by SHA-256 and records assets", async () => {
  // project-codeguard so generic `.md` files classify as prompt bodies, not assets.
  const fetchSource: FetchSource = async (source, tempRoot) => {
    const dir = join(tempRoot, source.id)
    mkdirSync(join(dir, "docs"), { recursive: true })
    writeFileSync(join(dir, "docs", "a.md"), "Same body\n")
    writeFileSync(join(dir, "docs", "b.md"), "Same body\n") // identical → deduped, two origins
    writeFileSync(join(dir, "LICENSE"), "license text\n") // asset, not a prompt
    return dir
  }
  const configDir = mkdtempSync(join(tmpdir(), "cchp-ref-cfg-"))
  const configPath = join(configDir, "reference-sources.json")
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      sources: [
        {
          id: "project-codeguard",
          repository: "cosai-oasis/project-codeguard",
          commit: "deadbeef",
          license: "CC-BY-4.0",
          expected_imported_files: 3,
          expected_catalog_origins: 2,
          include: ["docs/*.md"],
          license_paths: ["LICENSE"],
        },
      ],
    }),
  )
  const targetRoot = mkdtempSync(join(tmpdir(), "cchp-ref-out-"))

  await buildLibrary(targetRoot, { configPath, fetchSource })

  const catalog = JSON.parse(readFileSync(join(targetRoot, "catalog.json"), "utf8"))
  expect(catalog.schema_version).toBe(1)
  expect(catalog.statistics.unique_entries).toBe(1)
  expect(catalog.entries[0].origins.length).toBe(2) // both docs deduped into one entry
  expect(catalog.statistics.deduplicated_origins).toBe(1)
  expect(catalog.statistics.assets).toBe(1) // LICENSE
  expect(existsSync(join(targetRoot, catalog.entries[0].content_path))).toBe(true)
  expect(existsSync(join(targetRoot, "README.md"))).toBe(true)
})

test("buildLibrary: an inventory mismatch is a hard failure", async () => {
  const fetchSource: FetchSource = async (source, tempRoot) => {
    const dir = join(tempRoot, source.id)
    mkdirSync(join(dir, "docs"), { recursive: true })
    writeFileSync(join(dir, "docs", "a.md"), "body\n")
    return dir
  }
  const configDir = mkdtempSync(join(tmpdir(), "cchp-ref-cfg2-"))
  const configPath = join(configDir, "reference-sources.json")
  writeFileSync(
    configPath,
    JSON.stringify({
      schema_version: 1,
      sources: [
        {
          id: "project-codeguard",
          repository: "cosai-oasis/project-codeguard",
          commit: "deadbeef",
          license: "CC-BY-4.0",
          expected_imported_files: 99, // wrong on purpose
          expected_catalog_origins: 1,
          include: ["docs/*.md"],
          license_paths: [],
        },
      ],
    }),
  )
  const targetRoot = mkdtempSync(join(tmpdir(), "cchp-ref-out2-"))
  await expect(buildLibrary(targetRoot, { configPath, fetchSource })).rejects.toThrow(/inventory mismatch/)
})
