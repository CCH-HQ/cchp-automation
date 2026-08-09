import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { renderProgress, type Todo } from "../publish/sticky"

export interface CodexPlanStep {
  step: string
  status: string
}

export interface ProgressTrackerOptions {
  path: string
  rootThreadId: string
  task: string
  runId: string
  publish?: (body: string, signal?: AbortSignal) => Promise<void>
}

export interface TodoLedger {
  schemaVersion: 1
  revision: number
  rootThreadId: string
  updatedAt: string
  todos: Todo[]
}

export function parseTodoLedger(value: unknown): TodoLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid todo ledger")
  const ledger = value as Partial<TodoLedger>
  if (
    ledger.schemaVersion !== 1 ||
    !Number.isSafeInteger(ledger.revision) || Number(ledger.revision) < 0 ||
    typeof ledger.rootThreadId !== "string" || !ledger.rootThreadId ||
    typeof ledger.updatedAt !== "string" || !ledger.updatedAt || Number.isNaN(Date.parse(ledger.updatedAt)) ||
    !Array.isArray(ledger.todos) ||
    !ledger.todos.every((todo) =>
      todo && typeof todo === "object" && !Array.isArray(todo) &&
      typeof todo.content === "string" &&
      ["pending", "in_progress", "completed", "cancelled"].includes(String(todo.status)),
    )
  ) throw new Error("invalid todo ledger")
  return {
    schemaVersion: 1,
    revision: Number(ledger.revision),
    rootThreadId: ledger.rootThreadId,
    updatedAt: ledger.updatedAt,
    todos: ledger.todos.map((todo) => ({ content: todo.content, status: todo.status })),
  }
}

function todoStatus(status: string): string {
  switch (status) {
    case "completed":
      return "completed"
    case "inProgress":
    case "in_progress":
      return "in_progress"
    case "cancelled":
      return "cancelled"
    default:
      return "pending"
  }
}

export class ProgressTracker {
  private revision = 0
  private todos: Todo[] = []
  private fingerprint = ""
  private lastBody = ""
  private publicationVersion = 0
  private completedPublicationVersion = 0
  private activePublication?: { version: number; body: string }
  private pendingPublication?: { version: number; body: string; signal?: AbortSignal }
  private publicationLoop?: Promise<void>
  private readonly publicationWaiters: Array<{ version: number; resolve: () => void }> = []
  publishError?: string

  get hasReceivedPlan(): boolean {
    return this.revision > 0
  }

  get hasUsablePlan(): boolean {
    return this.todos.length > 0
  }

  get stepCount(): number {
    return this.todos.length
  }

  constructor(private readonly options: ProgressTrackerOptions) {
    if (!existsSync(options.path)) return
    const stat = lstatSync(options.path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("todo ledger must be a regular file")
    const value = parseTodoLedger(JSON.parse(readFileSync(options.path, "utf8")))
    if (options.rootThreadId !== "pending" && options.rootThreadId !== value.rootThreadId) {
      throw new Error(`todo ledger root thread mismatch: expected ${options.rootThreadId}, got ${value.rootThreadId}`)
    }
    this.options.rootThreadId = value.rootThreadId
    this.revision = Number(value.revision)
    this.todos = value.todos.map((todo) => ({ ...todo }))
    this.fingerprint = JSON.stringify(this.todos)
  }

  setRootThreadId(threadId: string): void {
    if (this.options.rootThreadId === threadId) return
    this.options.rootThreadId = threadId
  }

  async applyPlan(threadId: string, plan: readonly CodexPlanStep[]): Promise<boolean> {
    if (threadId !== this.options.rootThreadId) return false
    const todos = plan.slice(0, 200).map((item) => ({
      content: String(item.step ?? ""),
      status: todoStatus(String(item.status ?? "pending")),
    }))
    const fingerprint = JSON.stringify(todos)
    if (fingerprint === this.fingerprint) return false
    this.todos = todos
    this.fingerprint = fingerprint
    this.revision++
    this.persist()
    // The durable ledger and semantic deadline are local invariants. GitHub is
    // an external mirror and must not block JSON-RPC event processing.
    void this.publish()
    return true
  }

  async heartbeat(details: {
    childStates?: Record<string, number>
    usage?: { consumed: number; limit: number; state: string }
    semanticAgeMs?: number
    warning?: string
    planState?: "awaiting_first_update" | "empty_update"
  }, signal?: AbortSignal): Promise<void> {
    await this.publish(details, signal)
  }

  snapshot(): TodoLedger {
    return {
      schemaVersion: 1,
      revision: this.revision,
      rootThreadId: this.options.rootThreadId,
      updatedAt: new Date().toISOString(),
      todos: this.todos,
    }
  }

  private persist(): void {
    const tmp = `${this.options.path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.snapshot(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    renameSync(tmp, this.options.path)
  }

  private async publish(
    details: {
      childStates?: Record<string, number>
      usage?: { consumed: number; limit: number; state: string }
      semanticAgeMs?: number
      warning?: string
      planState?: "awaiting_first_update" | "empty_update"
    } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.options.publish) return
    const metadata = [
      `Run: \`${this.options.runId}\``,
      details.childStates
        ? `Children: ${Object.entries(details.childStates)
            .map(([state, count]) => `${state}=${count}`)
            .join(", ")}`
        : undefined,
      details.usage
        ? `Tokens: ${details.usage.consumed}/${details.usage.limit} (${details.usage.state})`
        : undefined,
      details.semanticAgeMs === undefined
        ? undefined
        : `Last semantic progress: ${Math.floor(details.semanticAgeMs / 1000)}s ago`,
      details.planState === "awaiting_first_update"
        ? "Plan: awaiting first update"
        : details.planState === "empty_update"
          ? "Plan: empty update received"
          : undefined,
      details.warning ? `⚠️ ${details.warning}` : undefined,
    ].filter(Boolean)
    const body = `${renderProgress(this.todos, this.options.task)}\n\n${metadata.join(" · ")}`
    if (body === this.lastBody && !this.activePublication && !this.pendingPublication) return

    let targetVersion: number
    if (this.pendingPublication?.body === body) {
      targetVersion = this.pendingPublication.version
    } else if (this.activePublication?.body === body && !this.pendingPublication) {
      targetVersion = this.activePublication.version
    } else {
      targetVersion = ++this.publicationVersion
      this.pendingPublication = { version: targetVersion, body, ...(signal ? { signal } : {}) }
    }

    const completed = new Promise<void>((resolve) => {
      if (targetVersion <= this.completedPublicationVersion) resolve()
      else this.publicationWaiters.push({ version: targetVersion, resolve })
    })
    this.ensurePublicationLoop()
    await completed
  }

  private ensurePublicationLoop(): void {
    if (this.publicationLoop) return
    const loop = this.drainPublications().finally(() => {
      if (this.publicationLoop === loop) this.publicationLoop = undefined
      // A publication can arrive after drainPublications observes an empty
      // queue but before this finally callback clears the settled loop.
      if (this.pendingPublication) this.ensurePublicationLoop()
    })
    this.publicationLoop = loop
  }

  private async drainPublications(): Promise<void> {
    while (this.pendingPublication) {
      const publication = this.pendingPublication
      this.pendingPublication = undefined
      this.activePublication = { version: publication.version, body: publication.body }
      if (publication.body !== this.lastBody) {
        try {
          await this.options.publish!(publication.body, publication.signal)
          this.lastBody = publication.body
          this.publishError = undefined
        } catch (error) {
          // GitHub is an external status surface. Local todo state remains canonical
          // and has already been durably written, so publication is intentionally
          // fail-open while the error stays observable to the supervisor.
          this.publishError = (error as Error).message
        }
      }
      this.activePublication = undefined
      this.completedPublicationVersion = publication.version
      for (let index = this.publicationWaiters.length - 1; index >= 0; index--) {
        if (this.publicationWaiters[index]!.version > publication.version) continue
        this.publicationWaiters.splice(index, 1)[0]!.resolve()
      }
    }
  }
}
