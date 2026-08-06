import { expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProvenanceLedger } from "./provenance"

test("replays a hash-chained provenance ledger and continues its sequence", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cchp-provenance-")), "provenance.jsonl")
  const first = new ProvenanceLedger(path, "run")
  const one = first.record("state", { to: "RUNNING" })
  const two = first.record("usage", { responseId: "response", totalTokens: 10 })
  expect(two.previousSha256).toBe(one.sha256)

  const restored = new ProvenanceLedger(path, "run")
  expect(restored).toMatchObject({ length: 2, head: two.sha256 })
  expect(restored.has(one.sha256)).toBe(true)
  expect(restored.has(two.sha256)).toBe(true)
  expect(restored.has("f".repeat(64))).toBe(false)
  expect(restored.record("terminal", { state: "SUCCEEDED" })).toMatchObject({ sequence: 3, previousSha256: two.sha256 })
})

test("detects tampering while tolerating only a torn final append", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-provenance-tamper-"))
  const path = join(root, "provenance.jsonl")
  const ledger = new ProvenanceLedger(path, "run")
  ledger.record("state", { value: 1 })
  appendFileSync(path, '{"schemaVersion":1')
  expect(new ProvenanceLedger(path, "run").length).toBe(1)

  const lines = readFileSync(path, "utf8").split("\n")
  const first = JSON.parse(lines[0]!)
  first.event = "tampered"
  writeFileSync(join(root, "tampered.jsonl"), `${JSON.stringify(first)}\n`)
  expect(() => new ProvenanceLedger(join(root, "tampered.jsonl"), "run")).toThrow("hash mismatch")
})
