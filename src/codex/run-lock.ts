import { randomUUID } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readFileSync as read, rmSync } from "node:fs"
import { join } from "node:path"
import { dlopen, FFIType } from "bun:ffi"
import { durableWriteFile } from "./durable-file"

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8
const libc = process.platform === "linux"
  ? dlopen("libc.so.6", {
      flock: {
        args: [FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
    })
  : undefined

export interface ProcessIdentity {
  pid: number
  bootId: string
  startTicks: string
}

export interface RunFence {
  schemaVersion: 1
  runId?: string
  writerId: string
  generation: number
  owner: ProcessIdentity
  acquiredAt: string
}

export interface RunLease {
  readonly fence: RunFence
  assertOwned(): void
  release(): void
}

function bootId(): string {
  try { return read("/proc/sys/kernel/random/boot_id", "utf8").trim() || "unknown" } catch { return "unknown" }
}

export function processIdentity(pid = process.pid): ProcessIdentity {
  let startTicks = "unknown"
  try {
    const stat = read(`/proc/${pid}/stat`, "utf8")
    const suffix = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)
    startTicks = suffix[19] ?? "unknown"
  } catch { /* non-Linux runners have no /proc identity */ }
  return { pid, bootId: bootId(), startTicks }
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.bootId === right.bootId && left.startTicks === right.startTicks
}

function sameFence(left: RunFence, right: RunFence): boolean {
  return left.writerId === right.writerId
    && left.generation === right.generation
    && sameIdentity(left.owner, right.owner)
}

function lockPath(workdir: string): string {
  return join(workdir, "ctx", "codex", "run.lock")
}

function fencePath(workdir: string): string {
  return join(workdir, "ctx", "codex", "run-fence.json")
}

function kernelLockPath(workdir: string): string {
  return join(workdir, "ctx", "codex", "run.flock")
}

function acquireKernelLock(workdir: string): number {
  if (!libc) throw new Error("run lease requires Linux libc flock support")
  const fd = openSync(kernelLockPath(workdir), "a+", 0o600)
  if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd)
    throw new Error("run lease is already owned")
  }
  return fd
}

function releaseKernelLock(fd: number): void {
  try { libc?.symbols.flock(fd, LOCK_UN) } catch { /* the descriptor is closed below */ }
  closeSync(fd)
}

function readFence(path: string): RunFence | undefined {
  if (!existsSync(path)) return undefined
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<RunFence>
  if (value.schemaVersion !== 1 || typeof value.writerId !== "string" || !Number.isSafeInteger(value.generation)) {
    throw new Error("invalid run fence")
  }
  return value as RunFence
}

function readOwner(path: string): RunFence {
  const value = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as Partial<RunFence>
  if (value.schemaVersion !== 1 || typeof value.writerId !== "string" || !Number.isSafeInteger(value.generation)) {
    throw new Error("invalid run lock owner")
  }
  if (!value.owner || typeof value.owner !== "object") throw new Error("run lock owner has no process identity")
  return value as RunFence
}

function ownerLive(owner: ProcessIdentity): boolean {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
  return sameIdentity(owner, processIdentity(owner.pid))
}

export function acquireRunLease(workdir: string, runId?: string): RunLease {
  const path = lockPath(workdir)
  mkdirSync(join(workdir, "ctx", "codex"), { recursive: true, mode: 0o700 })
  const kernelFd = acquireKernelLock(workdir)
  try {
    let current: RunFence | undefined
    if (existsSync(path)) {
      try {
        current = readOwner(path)
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code !== "ENOENT") throw ownerError
        // No well-formed owner can be writing while the kernel lock is held.
        // Remove only this incomplete stale directory before rebuilding it.
        rmSync(path, { recursive: true, force: true })
      }
      if (current && ownerLive(current.owner)) {
        throw new Error(`run ${runId ?? "<unknown>"} is already owned by writer ${current.writerId}`)
      }
      if (current) rmSync(path, { recursive: true, force: true })
    }

    mkdirSync(path, { mode: 0o700 })
    const previous = readFence(fencePath(workdir))
    const fence: RunFence = {
      schemaVersion: 1,
      ...(runId ? { runId } : {}),
      writerId: randomUUID(),
      generation: (previous?.generation ?? 0) + 1,
      owner: processIdentity(),
      acquiredAt: new Date().toISOString(),
    }
    durableWriteFile(join(path, "owner.json"), `${JSON.stringify(fence, null, 2)}\n`)
    // Publish the global fence only after the lock directory has a complete
    // owner record. Readers can therefore never observe a fence for a
    // partially initialized lock.
    durableWriteFile(fencePath(workdir), `${JSON.stringify(fence, null, 2)}\n`)
    let released = false
    return {
      fence,
      assertOwned() {
        if (released) throw new Error("run lease is released")
        const current = readOwner(path)
        const global = readFence(fencePath(workdir))
        if (!global || !sameFence(current, fence) || !sameFence(global, fence) || !sameIdentity(current.owner, processIdentity())) {
          throw new Error("run lease fencing token is no longer owned")
        }
      },
      release() {
        if (released) return
        released = true
        try {
          const current = readOwner(path)
          const global = readFence(fencePath(workdir))
          if (global && sameFence(current, fence) && sameFence(global, fence)) rmSync(path, { recursive: true, force: true })
        } catch { /* cleanup must not remove a newer owner's lock */ }
        releaseKernelLock(kernelFd)
      },
    }
  } catch (error) {
    releaseKernelLock(kernelFd)
    throw error
  }
}
