import { createHash } from "node:crypto"
import { appendJsonl, readJsonl } from "./jsonl"

export interface ProvenanceEntry {
  schemaVersion: 1
  sequence: number
  runId: string
  eventId: string
  event: string
  at: string
  previousSha256: string | null
  payloadSha256: string
  sha256: string
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function entryHash(entry: Omit<ProvenanceEntry, "sha256">): string {
  return sha256(stable(entry))
}

export class ProvenanceLedger {
  private sequence = 0
  private headSha256: string | null = null
  private readonly hashes = new Set<string>()

  constructor(private readonly path: string, private readonly runId: string, private readonly assertWriterOwnership?: () => void) {
    for (const value of readJsonl(path)) this.replay(value)
  }

  get head(): string | null { return this.headSha256 }
  get length(): number { return this.sequence }
  has(sha256: string): boolean { return this.hashes.has(sha256) }

  record(event: string, payload: unknown): ProvenanceEntry {
    this.assertWriterOwnership?.()
    if (!event) throw new Error("provenance event must be non-empty")
    const core: Omit<ProvenanceEntry, "sha256"> = {
      schemaVersion: 1,
      sequence: this.sequence + 1,
      runId: this.runId,
      eventId: `${this.runId}:${this.sequence + 1}`,
      event,
      at: new Date().toISOString(),
      previousSha256: this.headSha256,
      payloadSha256: sha256(stable(payload)),
    }
    const entry: ProvenanceEntry = { ...core, sha256: entryHash(core) }
    appendJsonl(this.path, entry)
    this.sequence = entry.sequence
    this.headSha256 = entry.sha256
    this.hashes.add(entry.sha256)
    return entry
  }

  private replay(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("provenance row must be an object")
    const entry = value as ProvenanceEntry
    if (
      entry.schemaVersion !== 1 || entry.runId !== this.runId ||
      entry.sequence !== this.sequence + 1 || entry.eventId !== `${this.runId}:${entry.sequence}` ||
      typeof entry.event !== "string" || !entry.event || typeof entry.at !== "string" ||
      typeof entry.payloadSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.payloadSha256) ||
      entry.previousSha256 !== this.headSha256 || typeof entry.sha256 !== "string"
    ) throw new Error(`invalid provenance row at sequence ${this.sequence + 1}`)
    const { sha256: stored, ...core } = entry
    if (entryHash(core) !== stored) throw new Error(`provenance hash mismatch at sequence ${entry.sequence}`)
    this.sequence = entry.sequence
    this.headSha256 = entry.sha256
    this.hashes.add(entry.sha256)
  }
}
