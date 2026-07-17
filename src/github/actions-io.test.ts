import { expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readEvent, setEnv, setOutput } from "./actions-io"

function tmpFile(name: string): string {
  return join(tmpdir(), `cchp-io-${process.pid}-${Date.now()}-${name}`)
}

test("setOutput / setEnv write scalar key=value lines", () => {
  const out = tmpFile("out")
  const env = tmpFile("env")
  writeFileSync(out, "")
  writeFileSync(env, "")
  process.env.GITHUB_OUTPUT = out
  process.env.GITHUB_ENV = env
  setOutput("act", "true")
  setOutput("needs_write", "false")
  setEnv("BOT_TASK", "pr_opened")
  expect(readFileSync(out, "utf8")).toBe("act=true\nneeds_write=false\n")
  expect(readFileSync(env, "utf8")).toBe("BOT_TASK=pr_opened\n")
})

test("multiline values use the Actions delimiter heredoc", () => {
  const env = tmpFile("multi")
  writeFileSync(env, "")
  process.env.GITHUB_ENV = env
  setEnv("BODY", "line1\nline2")
  const written = readFileSync(env, "utf8")
  expect(written).toMatch(/^BODY<<__cchp_BODY_\d+_\d+__\nline1\nline2\n__cchp_BODY_\d+_\d+__\n$/)
})

test("readEvent parses the payload at GITHUB_EVENT_PATH", () => {
  const evt = tmpFile("event.json")
  writeFileSync(evt, JSON.stringify({ action: "opened", number: 7 }))
  process.env.GITHUB_EVENT_PATH = evt
  expect(readEvent()).toEqual({ action: "opened", number: 7 })
})
