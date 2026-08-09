import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { dlopen, FFIType } from "bun:ffi"
import { durableWriteFile } from "./durable-file"

const LOCK_SH = 1
const LOCK_EX = 2
const LOCK_UN = 8

const libc = process.platform === "linux"
  ? dlopen("libc.so.6", {
      flock: {
        args: [FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
    })
  : undefined

export interface CollaborationAdmissionIdentity {
  runId: string
  writerId: string
  generation: number
}

interface CollaborationAdmissionState extends CollaborationAdmissionIdentity {
  schemaVersion: 1
  state: "open" | "sealed"
  updatedAt: string
}

function directory(workdir: string): string {
  return join(workdir, "ctx", "codex")
}

function statePath(workdir: string): string {
  return join(directory(workdir), "collaboration-admission.json")
}

function lockPath(workdir: string): string {
  return join(directory(workdir), "collaboration-admission.flock")
}

function acquire(workdir: string, operation: number): number {
  if (!libc) throw new Error("collaboration admission requires Linux libc flock support")
  const descriptor = openSync(lockPath(workdir), "a+", 0o600)
  if (libc.symbols.flock(descriptor, operation) !== 0) {
    closeSync(descriptor)
    throw new Error("failed to acquire collaboration admission lock")
  }
  return descriptor
}

function release(descriptor: number): void {
  try { libc?.symbols.flock(descriptor, LOCK_UN) } finally { closeSync(descriptor) }
}

function readState(workdir: string): CollaborationAdmissionState {
  const value = JSON.parse(readFileSync(statePath(workdir), "utf8")) as Partial<CollaborationAdmissionState>
  if (
    value.schemaVersion !== 1 ||
    typeof value.runId !== "string" || !value.runId ||
    typeof value.writerId !== "string" || !value.writerId ||
    !Number.isSafeInteger(value.generation) ||
    !["open", "sealed"].includes(value.state ?? "") ||
    typeof value.updatedAt !== "string" || !value.updatedAt
  ) throw new Error("invalid collaboration admission state")
  return value as CollaborationAdmissionState
}

function assertIdentity(actual: CollaborationAdmissionState, expected: CollaborationAdmissionIdentity): void {
  if (
    actual.runId !== expected.runId ||
    actual.writerId !== expected.writerId ||
    actual.generation !== expected.generation
  ) throw new Error("collaboration admission fence identity drift")
}

function writeState(workdir: string, identity: CollaborationAdmissionIdentity, state: "open" | "sealed"): void {
  durableWriteFile(statePath(workdir), `${JSON.stringify({
    schemaVersion: 1,
    ...identity,
    state,
    updatedAt: new Date().toISOString(),
  } satisfies CollaborationAdmissionState, null, 2)}\n`)
}

export function initializeCollaborationAdmission(
  workdir: string,
  identity: CollaborationAdmissionIdentity,
): void {
  mkdirSync(directory(workdir), { recursive: true, mode: 0o700 })
  const descriptor = acquire(workdir, LOCK_EX)
  try {
    writeState(workdir, identity, "open")
  } finally {
    release(descriptor)
  }
}

export async function withCollaborationAdmission<T>(
  workdir: string,
  identity: CollaborationAdmissionIdentity,
  operation: () => T | Promise<T>,
): Promise<T> {
  const descriptor = acquire(workdir, LOCK_SH)
  try {
    const current = readState(workdir)
    assertIdentity(current, identity)
    if (current.state !== "open") throw new Error("collaboration admission is sealed")
    return await operation()
  } finally {
    release(descriptor)
  }
}

export function sealCollaborationAdmission(
  workdir: string,
  identity: CollaborationAdmissionIdentity,
): void {
  const descriptor = acquire(workdir, LOCK_EX)
  try {
    const current = readState(workdir)
    assertIdentity(current, identity)
    if (current.state === "open") writeState(workdir, identity, "sealed")
  } finally {
    release(descriptor)
  }
}
