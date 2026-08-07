#!/usr/bin/env bun
import { readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"

const directory = resolve(process.argv[2] ?? "")
if (!process.argv[2]) throw new Error("skill directory is required")
const expectedName = process.argv[3] ?? basename(directory)
const path = join(directory, "SKILL.md")
const lines = readFileSync(path, "utf8").replaceAll("\r\n", "\n").split("\n")
if (lines[0] !== "---") throw new Error(`${path}: frontmatter must start with ---`)
const closing = lines.indexOf("---", 1)
if (closing < 2) throw new Error(`${path}: frontmatter must end with ---`)

const parsed = Bun.YAML.parse(lines.slice(1, closing).join("\n"))
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
  throw new Error(`${path}: frontmatter must be a YAML mapping`)
}
const frontmatter = parsed as Record<string, unknown>
if (typeof frontmatter.name !== "string" || !frontmatter.name.trim()) {
  throw new Error(`${path}: frontmatter.name must be a non-empty string`)
}
if (frontmatter.name !== expectedName) {
  throw new Error(`${path}: frontmatter.name must match the skill directory`)
}
if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
  throw new Error(`${path}: frontmatter.description must be a non-empty string`)
}
