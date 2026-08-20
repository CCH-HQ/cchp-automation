import { assembleReferenceContext } from "./references"
import { isReviewPassKind, type ReviewPassKind } from "./review-admission"

export const REVIEW_MAX_ACTIVE = 10
export const REVIEW_MAX_TASKS = 200
export const REVIEW_CHILD_TIMEOUT_MS = 30 * 60 * 1000

export interface ReviewTask {
  id: string
  role: string
  passKind: ReviewPassKind
  prompt: string
  admissionPrompt?: string
  agent?: string
}

export type ReviewResult = {
  id: string
  role: string
  state: "completed" | "timed_out" | "failed"
  sessionId?: string
  output?: string
  error?: string
}

export interface ReviewChildExecutor {
  run(input: { task: ReviewTask; prompt: string; signal: AbortSignal }): Promise<{ sessionId?: string; output: string }>
  interrupt?(sessionId: string): Promise<void>
}

function validTask(value: unknown): value is ReviewTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const task = value as Partial<ReviewTask>
  return typeof task.id === "string" && task.id.length > 0 && typeof task.role === "string" && task.role.length > 0 && isReviewPassKind(task.passKind) && typeof task.prompt === "string" && task.prompt.length > 0 && (task.admissionPrompt === undefined || typeof task.admissionPrompt === "string") && (task.agent === undefined || typeof task.agent === "string")
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number | undefined, onTimeout: () => Promise<void> | void): Promise<T> {
  if (timeoutMs === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      Promise.resolve(onTimeout()).finally(() => reject(new Error(`review child exceeded ${timeoutMs}ms`)))
    }, timeoutMs)
    promise.then((value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }, (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

export interface ReviewRunnerOptions {
  timeoutMs?: number
  maxActive?: number
  unlimited?: boolean
}

/** Bounded, cancellation-aware review scheduler. References are assembled before
 * child creation so an invalid catalog cannot leak a live child session. */
export class ReviewRunner {
  private readonly timeoutMs: number
  private readonly maxActive: number
  private readonly unlimited: boolean

  constructor(private readonly executor: ReviewChildExecutor, options: ReviewRunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? REVIEW_CHILD_TIMEOUT_MS
    this.unlimited = options.unlimited ?? false
    this.maxActive = this.unlimited ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.min(options.maxActive ?? REVIEW_MAX_ACTIVE, REVIEW_MAX_ACTIVE))
  }

  async run(tasks: readonly ReviewTask[], parentSignal?: AbortSignal): Promise<ReviewResult[]> {
    if (!Array.isArray(tasks) || tasks.length < 1 || (!this.unlimited && tasks.length > REVIEW_MAX_TASKS)) {
      throw new Error(`review tasks must contain 1..${REVIEW_MAX_TASKS} items`)
    }
    const results: ReviewResult[] = new Array(tasks.length)
    const valid: Array<{ index: number; task: ReviewTask }> = []
    tasks.forEach((candidate, index) => {
      if (validTask(candidate)) valid.push({ index, task: candidate })
      else results[index] = { id: `invalid-${index}`, role: "input-validation", state: "failed", error: "task must contain a valid id, role, passKind and prompt" }
    })
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (true) {
        if (parentSignal?.aborted) {
          while (cursor < valid.length) {
            const item = valid[cursor++]!
            results[item.index] = { id: item.task.id, role: item.task.role, state: "failed", error: "parent review task aborted" }
          }
          return
        }
        const item = valid[cursor++]
        if (!item) return
        const controller = new AbortController()
        const onParentAbort = () => controller.abort()
        parentSignal?.addEventListener("abort", onParentAbort, { once: true })
        let sessionId: string | undefined
        try {
          const references = assembleReferenceContext(item.task.role, item.task.prompt)
          const prompt = `${item.task.prompt}\n\n${references.text}\n\nYou are a read-only leaf reviewer. Do not delegate, edit, run shell commands, or publish GitHub content.`
          const response = await withDeadline(this.executor.run({ task: item.task, prompt, signal: controller.signal }), this.unlimited ? undefined : this.timeoutMs, async () => {
            controller.abort()
            if (sessionId && this.executor.interrupt) await this.executor.interrupt(sessionId)
          })
          sessionId = response.sessionId
          results[item.index] = { id: item.task.id, role: item.task.role, state: "completed", sessionId, output: response.output }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          results[item.index] = { id: item.task.id, role: item.task.role, state: message.startsWith("review child exceeded") ? "timed_out" : "failed", sessionId, error: message }
        } finally {
          parentSignal?.removeEventListener("abort", onParentAbort)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.maxActive, valid.length) }, () => worker()))
    return results
  }
}
