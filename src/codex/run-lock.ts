import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readFileSync as read, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { durableWriteFile } from "./durable-file"

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
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
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
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let current: RunFence
      try {
        current = readOwner(path)
      } catch (ownerError) {
        // A live contender may have created the directory but not published
        // owner.json yet. Never delete an unproven owner; retry briefly and
        // fail closed if it remains malformed.
        if ((ownerError as NodeJS.ErrnoException).code === "ENOENT") continue
        throw ownerError
      }
      if (ownerLive(current.owner)) throw new Error(`run ${runId ?? "<unknown>"} is already owned by writer ${current.writerId}`)
      // Reclaim only after winning an atomic rename. A competing reclaimer
      // cannot subsequently delete a newly-created run.lock path.
      const quarantine = `${path}.reclaim.${process.pid}.${randomUUID()}`
      try {
        renameSync(path, quarantine)
      } catch (renameError) {
        const code = (renameError as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "EEXIST") continue
        throw renameError
      }
      rmSync(quarantine, { recursive: true, force: true })
    }
  }
  throw new Error("could not acquire run lease")
}
