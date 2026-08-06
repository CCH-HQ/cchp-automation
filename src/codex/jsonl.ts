import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs"

/** Read an append-only JSONL ledger. A crash may leave only the final line
 * incomplete; every earlier malformed line is treated as durable corruption. */
export function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return []
  return parseJsonl(readFileSync(path), path)
}

export function parseJsonl(value: string | Buffer, sourceName: string): unknown[] {
  const body = typeof value === "string" ? value : value.toString("utf8")
  if (!body) return []
  const terminated = body.endsWith("\n")
  const lines = body.split("\n")
  if (terminated) lines.pop()
  const rows: unknown[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (!line) throw new Error(`invalid blank JSONL row ${index + 1} in ${sourceName}`)
    try {
      rows.push(JSON.parse(line))
    } catch (error) {
      if (!terminated && index === lines.length - 1) break
      throw new Error(`invalid JSONL row ${index + 1} in ${sourceName}: ${(error as Error).message}`)
    }
  }
  return rows
}

export function appendJsonl(path: string, value: unknown): void {
  repairJsonlTail(path)
  const descriptor = openSync(path, "a", 0o600)
  try {
    writeSync(descriptor, `${JSON.stringify(value)}\n`, undefined, "utf8")
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function repairJsonlTail(path: string): void {
  if (!existsSync(path)) return
  const body = readFileSync(path)
  if (!body.length || body.at(-1) === 0x0a) return
  const lastNewline = body.lastIndexOf(0x0a)
  const tail = body.subarray(lastNewline + 1).toString("utf8")
  const descriptor = openSync(path, "r+")
  try {
    try {
      JSON.parse(tail)
      writeSync(descriptor, "\n", body.length, "utf8")
    } catch {
      ftruncateSync(descriptor, lastNewline + 1)
    }
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}
