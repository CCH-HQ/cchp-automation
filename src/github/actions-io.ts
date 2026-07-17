// GitHub Actions runner I/O: read the event payload in, write step outputs + job
// env out. The bash `setenv`/`out` helpers from route.sh, in TS.
import { appendFileSync, readFileSync } from "node:fs"

/** The webhook payload for this run (`github.event`). */
export function readEvent(): Record<string, unknown> {
  const path = process.env.GITHUB_EVENT_PATH
  if (!path) throw new Error("GITHUB_EVENT_PATH is not set")
  return JSON.parse(readFileSync(path, "utf8"))
}

function appendKV(file: string | undefined, kind: string, name: string, value: string): void {
  if (!file) throw new Error(`${kind} file (Actions) is not set`)
  if (value.includes("\n")) {
    // GitHub Actions multiline delimiter syntax.
    const delim = `__cchp_${name}_${process.pid}_${appendKV.n++}__`
    appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`)
  } else {
    appendFileSync(file, `${name}=${value}\n`)
  }
}
appendKV.n = 0

/** Emit a step output (`$GITHUB_OUTPUT`). */
export const setOutput = (name: string, value: string): void =>
  appendKV(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT", name, value)

/** Export a job-level env var (`$GITHUB_ENV`) for later steps. */
export const setEnv = (name: string, value: string): void =>
  appendKV(process.env.GITHUB_ENV, "GITHUB_ENV", name, value)
