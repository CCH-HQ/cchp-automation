import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ArtifactStore, assertArtifactWritePath } from "./artifacts"

test("allows only review artifacts and the fixed reply file", () => {
  const workdir = mkdtempSync(join(tmpdir(), "artifacts-"))
  mkdirSync(join(workdir, "ctx", "review"), { recursive: true })
  expect(assertArtifactWritePath(workdir, join(workdir, "ctx", "review", "coverage.json"))).toBe(
    join(workdir, "ctx", "review", "coverage.json"),
  )
  expect(assertArtifactWritePath(workdir, join(workdir, "ctx", "reply.md"))).toBe(
    join(workdir, "ctx", "reply.md"),
  )
  expect(() => assertArtifactWritePath(workdir, join(workdir, "repo", "source.ts"))).toThrow("outside")
  expect(() => assertArtifactWritePath(workdir, join(workdir, "ctx", "review"))).toThrow("file")

  const store = new ArtifactStore(workdir)
  expect(store.writeReview("coverage.json", "{}\n")).toBe(join(workdir, "ctx", "review", "coverage.json"))
  expect(() => store.writeReview("../escape", "bad")).toThrow("outside")
})

test("rejects symlink escape from the review directory", () => {
  const workdir = mkdtempSync(join(tmpdir(), "artifacts-link-"))
  const outside = mkdtempSync(join(tmpdir(), "artifacts-outside-"))
  mkdirSync(join(workdir, "ctx", "review"), { recursive: true })
  symlinkSync(outside, join(workdir, "ctx", "review", "link"), "dir")
  expect(() => assertArtifactWritePath(workdir, join(workdir, "ctx", "review", "link", "leak"))).toThrow(
    "symlink",
  )
})
