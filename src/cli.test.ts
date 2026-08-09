import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { persistRouteAck, readRouteAck } from "./cli"

const workdirs: string[] = []

function workdir(): string {
  const path = mkdtempSync(join(tmpdir(), "cchp-route-ack-"))
  workdirs.push(path)
  return path
}

afterEach(() => {
  for (const path of workdirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

test("route ack is persisted as a private strict record", () => {
  const root = workdir()
  const path = persistRouteAck(root, { kind: "rest", target: "issues/comments/42" })
  expect(path).toBe(join(root, "ctx", "route-ack.json"))
  expect(readRouteAck(root)).toEqual({ kind: "rest", target: "issues/comments/42" })
})

test("missing route ack is a no-op", () => {
  expect(readRouteAck(workdir())).toBeUndefined()
})

test("route ack rejects extra fields and non-private files", () => {
  const root = workdir()
  const ctx = join(root, "ctx")
  const path = join(ctx, "route-ack.json")
  mkdirSync(ctx, { recursive: true })
  writeFileSync(path, JSON.stringify({ kind: "rest", target: "issues/7", extra: true }), { mode: 0o600 })
  expect(() => readRouteAck(root)).toThrow("invalid route ack record")
  writeFileSync(path, JSON.stringify({ kind: "node", target: "node-id" }), { mode: 0o600 })
  chmodSync(path, 0o644)
  expect(() => readRouteAck(root)).toThrow("private regular file")
})
