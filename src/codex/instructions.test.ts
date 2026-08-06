import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadExtraInstructions, renderCallerOverlay, renderInstructionOverlay } from "./instructions"

test("loads ordered local files and glob entries without leaving the trusted clone", async () => {
  const repo = mkdtempSync("/tmp/cchp-instructions-")
  mkdirSync(join(repo, "docs"), { recursive: true })
  writeFileSync(join(repo, "docs", "a.md"), "A\n")
  writeFileSync(join(repo, "docs", "b.md"), "B\n")
  const result = await loadExtraInstructions(JSON.stringify(["docs/a.md", "docs/*.md"]), repo)
  expect(result.map((item) => item.content.trim())).toEqual(["A", "A", "B"])
  expect(renderInstructionOverlay(result)).toContain("Additional trusted instruction")
  await expect(loadExtraInstructions(JSON.stringify(["../escape.md"]), repo)).rejects.toThrow("escapes")
  expect(await loadExtraInstructions("not-json", repo)).toEqual([])
  await expect(loadExtraInstructions('{"path":"docs/a.md"}', repo)).rejects.toThrow("JSON string array")
})

test("renders every frozen caller overlay field and rejects unresolved placeholders", () => {
  const template = [
    "{{OVERLAY.default_branch}}",
    "{{OVERLAY.roadmap_project}}",
    "{{OVERLAY.roadmap_policy}}",
    "{{OVERLAY.semver_workflow}}",
    "{{OVERLAY.semver_marker}}",
    "{{OVERLAY.tech_stack}}",
    "{{OVERLAY.languages}}",
  ].join("|")
  expect(renderCallerOverlay(template, {
    defaultBranch: "dev",
    roadmapProject: "1",
    roadmapPolicy: ".github/roadmap.md",
    semverWorkflow: "semver-check",
    semverMarker: "semver-marker",
    techStack: "Go,TypeScript",
    languages: "zh-CN,en",
  })).toBe("dev|1|.github/roadmap.md|semver-check|semver-marker|Go,TypeScript|zh-CN,en")

  expect(() => renderCallerOverlay("{{OVERLAY.unknown}}", {
    defaultBranch: "main",
    roadmapProject: "",
    roadmapPolicy: "policy.md",
    semverWorkflow: "semver-guard",
    semverMarker: "marker",
    techStack: "",
    languages: "",
  })).toThrow("unresolved caller overlay placeholder")
})
