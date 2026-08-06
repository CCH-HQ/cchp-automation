import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { directoryIdentity, durableCreateFile } from "./durable-file"

test("durably creates a file without replacing an existing entry", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-durable-create-"))
  const path = join(root, "marker.json")
  const identity = directoryIdentity(root)

  durableCreateFile(path, "first\n", 0o600, identity)
  expect(readFileSync(path, "utf8")).toBe("first\n")
  expect(() => durableCreateFile(path, "second\n", 0o600, identity)).toThrow()
  expect(readFileSync(path, "utf8")).toBe("first\n")
})

test("fails closed when the bound parent directory is replaced", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-durable-parent-"))
  const parent = join(root, "ctx")
  const moved = join(root, "ctx.original")
  mkdirSync(parent)
  const identity = directoryIdentity(parent)
  renameSync(parent, moved)
  mkdirSync(parent)

  expect(() => durableCreateFile(join(parent, "marker.json"), "marker\n", 0o600, identity))
    .toThrow("parent directory identity changed")
  expect(existsSync(join(parent, "marker.json"))).toBe(false)
  expect(existsSync(join(moved, "marker.json"))).toBe(false)
})
