import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openRegularFileSnapshot } from "./file-snapshot"

test("reads and hashes one immutable fd even when its pathname is replaced", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-file-snapshot-"))
  const path = join(root, "evidence.json")
  const original = Buffer.from('{"valid":true}\n')
  writeFileSync(path, original)
  const snapshot = openRegularFileSnapshot(path, {
    afterOpen: () => {
      renameSync(path, join(root, "evidence.original.json"))
      writeFileSync(path, '{"valid":false}\n')
    },
  })
  expect(snapshot.bytes).toEqual(original)
  expect(snapshot.bytes).not.toEqual(readFileSync(path))
  expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/)
})

test("rejects a symlink instead of following it", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-file-snapshot-link-"))
  const target = join(root, "target")
  const link = join(root, "link")
  writeFileSync(target, "secret")
  symlinkSync(target, link)
  expect(() => openRegularFileSnapshot(link)).toThrow()
})

test("rejects a symlinked parent directory component", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-file-snapshot-parent-link-"))
  const real = join(root, "real")
  mkdirSync(real)
  writeFileSync(join(real, "evidence.json"), "secret")
  symlinkSync(real, join(root, "linked-dir"))
  expect(() => openRegularFileSnapshot(join(root, "linked-dir", "evidence.json"))).toThrow()
})
