import { mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import {
  readChildResultArtifact,
  readChildRunningArtifact,
  type ChildResultArtifact,
  type ChildRunningArtifact,
} from "./child-adapter"
import { processIdentity } from "./run-lock"

export interface ExplicitChildSnapshot {
  active: ChildRunningArtifact[]
  terminal: ChildResultArtifact[]
  stale: Array<{ childId: string; generation: number; ignored: "running" | "terminal" }>
}

export interface ExplicitChildLifecycle {
  reconcile(): ExplicitChildSnapshot
  interruptActive(reason: string, childIds?: readonly string[]): Promise<void>
}

export interface ArtifactExplicitChildLifecycleOptions {
  resultRoot: string
  runId: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void
}

function safeChildId(childId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(childId)) throw new Error(`invalid child id ${childId}`)
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`explicit child artifact has invalid updatedAt ${value}`)
  return parsed
}

/** Read-only supervisor view of explicit children. The MCP adapter remains the
 * sole writer and recovery owner; this class only gates parent terminal state. */
export class ArtifactExplicitChildLifecycle implements ExplicitChildLifecycle {
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly kill: (pid: number, signal: NodeJS.Signals | 0) => void

  constructor(private readonly options: ArtifactExplicitChildLifecycleOptions) {
    mkdirSync(options.resultRoot, { recursive: true, mode: 0o700 })
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)))
    this.kill = options.kill ?? ((pid, signal) => process.kill(pid, signal))
  }

  reconcile(): ExplicitChildSnapshot {
    const active = new Map<string, ChildRunningArtifact>()
    const terminal = new Map<string, ChildResultArtifact>()
    for (const entry of readdirSync(this.options.resultRoot, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = resolve(this.options.resultRoot, entry.name)
      if (entry.name.endsWith(".running.json")) {
        const artifact = readChildRunningArtifact(path)
        this.assertOwned(artifact.runId, artifact.parentRunId, artifact.childId, entry.name)
        const expected = resolve(this.options.resultRoot, `${artifact.childId}.json`)
        if (resolve(artifact.resultPath) !== expected) throw new Error(`child running artifact ${entry.name} has an unsafe result path`)
        active.set(artifact.childId, artifact)
      } else if (entry.name.endsWith(".json") && !entry.name.endsWith(".native.json")) {
        const artifact = readChildResultArtifact(path)
        this.assertOwned(artifact.runId, artifact.parentRunId, artifact.childId, entry.name)
        if (path !== resolve(this.options.resultRoot, `${artifact.childId}.json`)) {
          throw new Error(`child artifact ${entry.name} has an unsafe result path`)
        }
        terminal.set(artifact.childId, artifact)
      }
    }

    const stale: ExplicitChildSnapshot["stale"] = []
    for (const [childId, running] of active) {
      const completed = terminal.get(childId)
      if (!completed) continue
      if (running.spawnItemId !== completed.spawnItemId || running.parentId !== completed.parentId) {
        throw new Error(`explicit child ${childId} artifact identity drift`)
      }
      if (running.generation > completed.generation ||
        running.generation === completed.generation && timestamp(running.updatedAt) > timestamp(completed.updatedAt)) {
        terminal.delete(childId)
        stale.push({ childId, generation: completed.generation, ignored: "terminal" })
      } else {
        active.delete(childId)
        stale.push({ childId, generation: running.generation, ignored: "running" })
      }
    }
    return {
      active: [...active.values()].sort((a, b) => a.childId.localeCompare(b.childId)),
      terminal: [...terminal.values()].sort((a, b) => a.childId.localeCompare(b.childId)),
      stale,
    }
  }

  async interruptActive(_reason: string, childIds?: readonly string[]): Promise<void> {
    const selected = childIds ? new Set(childIds) : undefined
    const active = this.reconcile().active.filter((artifact) => !selected || selected.has(artifact.childId))
    for (const artifact of active) await this.interrupt(artifact)
  }

  private assertOwned(runId: string, parentRunId: string, childId: string, filename: string): void {
    safeChildId(childId)
    if (runId !== this.options.runId || parentRunId !== this.options.runId) {
      throw new Error(`explicit child artifact ${filename} belongs to another run`)
    }
  }

  private live(pid: number): boolean {
    try {
      this.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH"
    }
  }

  private async interrupt(artifact: ChildRunningArtifact): Promise<void> {
    const identity = artifact.processIdentity
    if (!identity) throw new Error(`explicit child ${artifact.childId} has no proven process identity`)
    if (!this.live(identity.pid)) return
    const current = processIdentity(identity.pid)
    if (current.bootId !== identity.bootId || current.startTicks !== identity.startTicks) {
      throw new Error(`explicit child ${artifact.childId} process identity drift`)
    }
    for (const [signal, graceMs] of [["SIGINT", 1_000], ["SIGTERM", 1_000], ["SIGKILL", 5_000]] as const) {
      try {
        this.kill(process.platform === "win32" ? identity.pid : -identity.pid, signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return
        throw error
      }
      const deadline = this.now() + graceMs
      while (this.now() < deadline) {
        if (!this.live(identity.pid)) return
        await this.sleep(20)
      }
    }
    if (this.live(identity.pid)) throw new Error(`explicit child ${artifact.childId} process group did not stop`)
  }
}
