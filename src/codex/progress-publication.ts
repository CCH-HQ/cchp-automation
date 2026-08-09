import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import type { StickyResult } from "../publish/sticky"
import { directoryIdentity, durableCreateFile, durableWriteFile } from "./durable-file"
import { openRegularFileSnapshot } from "./file-snapshot"

type Env = Record<string, string | undefined>

export interface ProgressPublicationRecord {
  schemaVersion: 1
  marker: string
  commentId?: number
  action?: "created" | "updated"
  publication: "published" | "skipped" | "failed"
  createdCount: number
  updatedCount: number
  finalized: boolean
  updatedAt: string
}

export function parseProgressPublication(value: unknown, marker: string): ProgressPublicationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("progress publication record must be an object")
  const record = value as Partial<ProgressPublicationRecord>
  if (record.schemaVersion !== 1) throw new Error("unsupported progress publication schema")
  if (record.marker !== marker) throw new Error("progress publication marker mismatch")
  if (record.publication !== "published" && record.publication !== "skipped" && record.publication !== "failed") {
    throw new Error("invalid progress publication state")
  }
  if (!Number.isSafeInteger(record.createdCount) || Number(record.createdCount) < 0) throw new Error("invalid progress created count")
  if (!Number.isSafeInteger(record.updatedCount) || Number(record.updatedCount) < 0) throw new Error("invalid progress updated count")
  if (typeof record.finalized !== "boolean") throw new Error("invalid progress finalized flag")
  if (typeof record.updatedAt !== "string" || !record.updatedAt || Number.isNaN(Date.parse(record.updatedAt))) {
    throw new Error("invalid progress update time")
  }
  const commentId = Number.isSafeInteger(record.commentId) && Number(record.commentId) > 0 ? Number(record.commentId) : undefined
  const action = record.action === "created" || record.action === "updated" ? record.action : undefined
  if (record.action !== undefined && !action) throw new Error("invalid progress action")
  if (record.commentId !== undefined && !commentId) throw new Error("invalid progress comment id")
  if (Boolean(commentId) !== Boolean(action)) throw new Error("progress comment id and action must be paired")
  if (record.publication === "published" && (!commentId || !action)) throw new Error("published progress record is incomplete")
  const createdCount = Number(record.createdCount)
  const updatedCount = Number(record.updatedCount)
  if (!action && (createdCount !== 0 || updatedCount !== 0)) throw new Error("progress counts require a comment action")
  if (action === "created" && createdCount === 0) throw new Error("created progress action requires a created count")
  if (action === "updated" && updatedCount === 0) throw new Error("updated progress action requires an updated count")
  return {
    schemaVersion: 1,
    marker,
    ...(commentId ? { commentId } : {}),
    ...(action ? { action } : {}),
    publication: record.publication,
    createdCount,
    updatedCount,
    finalized: record.finalized,
    updatedAt: record.updatedAt,
  }
}

export function readProgressPublicationSnapshot(
  path: string,
  marker: string,
): { record: ProgressPublicationRecord; sha256: string } | undefined {
  if (!existsSync(path)) return undefined
  const snapshot = openRegularFileSnapshot(path)
  return {
    record: parseProgressPublication(JSON.parse(snapshot.bytes.toString("utf8")), marker),
    sha256: snapshot.sha256,
  }
}

export function readProgressPublication(path: string, marker: string): ProgressPublicationRecord | undefined {
  return readProgressPublicationSnapshot(path, marker)?.record
}

export function seedProgressPublication(
  path: string,
  record: ProgressPublicationRecord,
  expectedSha256: string,
): void {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("progress publication seed hash is invalid")
  if (existsSync(path)) {
    const existing = readProgressPublicationSnapshot(path, record.marker)
    if (!existing || existing.sha256 !== expectedSha256) throw new Error("progress publication seed conflicts with existing evidence")
    return
  }
  const content = `${JSON.stringify(parseProgressPublication(record, record.marker), null, 2)}\n`
  if (createHash("sha256").update(content).digest("hex") !== expectedSha256) {
    throw new Error("progress publication seed does not match the runtime snapshot")
  }
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    durableCreateFile(path, content, 0o600, directoryIdentity(directory))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const existing = readProgressPublicationSnapshot(path, record.marker)
    if (!existing || existing.sha256 !== expectedSha256) throw new Error("progress publication seed raced with different evidence")
  }
}

function readPrevious(path: string, marker: string): ProgressPublicationRecord | undefined {
  if (!existsSync(path)) return undefined
  try {
    return readProgressPublication(path, marker)
  } catch {
    return undefined
  }
}

export function recordProgressPublication(
  env: Env,
  marker: string,
  result: StickyResult | undefined,
  finalized: boolean,
  publication: ProgressPublicationRecord["publication"] = result ? "published" : "skipped",
): void {
  const explicitPath = env.CCHP_PROGRESS_PUBLICATION_PATH
  const workdir = env.BOT_WORKDIR
  if (!explicitPath && !workdir) return
  const path = explicitPath || join(workdir!, "ctx", "codex", "progress-publication.json")
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const previous = readPrevious(path, marker)
  if (
    finalized && previous?.finalized && result && previous.publication === publication &&
    previous.commentId === result.id && previous.action === result.action
  ) return
  const record: ProgressPublicationRecord = {
    schemaVersion: 1,
    marker,
    ...(result?.id ? { commentId: result.id } : previous?.commentId ? { commentId: previous.commentId } : {}),
    ...(result?.action ? { action: result.action } : previous?.action ? { action: previous.action } : {}),
    publication,
    createdCount: (previous?.createdCount ?? 0) + (result?.action === "created" ? 1 : 0),
    updatedCount: (previous?.updatedCount ?? 0) + (result?.action === "updated" ? 1 : 0),
    finalized: finalized || previous?.finalized === true,
    updatedAt: new Date().toISOString(),
  }
  durableWriteFile(path, `${JSON.stringify(record, null, 2)}\n`)
}

export function tryRecordProgressPublication(
  env: Env,
  marker: string,
  result: StickyResult | undefined,
  finalized: boolean,
  publication: ProgressPublicationRecord["publication"] = result ? "published" : "skipped",
): boolean {
  try {
    recordProgressPublication(env, marker, result, finalized, publication)
    return true
  } catch (error) {
    process.stderr.write(`[progress-publication] evidence write failed: ${error instanceof Error ? error.message : String(error)}\n`)
    return false
  }
}
