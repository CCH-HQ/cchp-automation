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
  publish?: (body: string) => Promise<void>
}

interface TodoLedger {
  schemaVersion: 1
  revision: number
  rootThreadId: string
  updatedAt: string
  todos: Todo[]
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
  publishError?: string

  constructor(private readonly options: ProgressTrackerOptions) {
    if (!existsSync(options.path)) return
    const stat = lstatSync(options.path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("todo ledger must be a regular file")
    const value = JSON.parse(readFileSync(options.path, "utf8")) as Partial<TodoLedger>
    if (
      value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
      typeof value.rootThreadId !== "string" || !value.rootThreadId ||
      !Array.isArray(value.todos) ||
      !value.todos.every((todo) => todo && typeof todo.content === "string" && typeof todo.status === "string")
    ) throw new Error("invalid todo ledger")
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
    await this.publish()
    return true
  }

  async heartbeat(details: {
    childStates?: Record<string, number>
    usage?: { consumed: number; limit: number; state: string }
    semanticAgeMs?: number
    warning?: string
  }): Promise<void> {
    await this.publish(details)
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
    } = {},
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
      details.warning ? `⚠️ ${details.warning}` : undefined,
    ].filter(Boolean)
    const body = `${renderProgress(this.todos, this.options.task)}\n\n${metadata.join(" · ")}`
    if (body === this.lastBody) return
    try {
      await this.options.publish(body)
      this.lastBody = body
      this.publishError = undefined
    } catch (error) {
      // GitHub is an external status surface. Local todo state remains canonical
      // and has already been durably written, so publication is intentionally
      // fail-open while the error stays observable to the supervisor.
      this.publishError = (error as Error).message
    }
  }
}
