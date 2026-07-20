// cchp-automation - bounded independent review-session runner.
//
// OpenCode's built-in task tool has no global concurrency limit or per-task
// timeout. This plugin provides the review protocol with both guarantees while
// keeping each verifier in a fresh child session.
import { automaticReferenceQuery, referenceEnvelope, searchReferences, structuredReferenceEnvelope } from "./review-reference-catalog"
const MAX_PARALLEL = 10
const AGENT_TIMEOUT_MS = 30 * 60 * 1000
let availableSlots = MAX_PARALLEL
type SlotWaiter = { resolve: () => void; cancelled: boolean }
const slotWaiters: SlotWaiter[] = []

async function acquireSlot(signal?: AbortSignal): Promise<boolean> {
  if (availableSlots === 0) {
    let waiter!: SlotWaiter
    const granted = new Promise<void>((resolve) => {
      waiter = { resolve, cancelled: false }
      slotWaiters.push(waiter)
    })
    if (signal) {
      let abortHandler!: () => void
      const aborted = new Promise<void>((resolve) => {
        abortHandler = resolve
        signal.addEventListener("abort", abortHandler, { once: true })
      })
      await Promise.race([granted, aborted])
      signal.removeEventListener("abort", abortHandler)
      if (signal.aborted && slotWaiters.includes(waiter)) {
        waiter.cancelled = true
        slotWaiters.splice(slotWaiters.indexOf(waiter), 1)
        return false
      }
    } else {
      await granted
    }
    return true
  }
  availableSlots--
  return true
}

function releaseSlot(): void {
  while (slotWaiters.length > 0) {
    const next = slotWaiters.shift()!
    if (!next.cancelled) {
      next.resolve()
      return
    }
  }
  availableSlots++
}

type ReviewTask = {
  id: string
  role: string
  prompt: string
  agent?: string
}

type ReviewResult = {
  id: string
  role: string
  state: "completed" | "timed_out" | "failed"
  session_id?: string
  output?: string
  error?: string
}

function isReviewTask(value: unknown): value is ReviewTask {
  if (typeof value !== "object" || value === null) return false
  const task = value as Partial<ReviewTask>
  return typeof task.id === "string" && task.id.length > 0 && typeof task.role === "string" && task.role.length > 0 && typeof task.prompt === "string" && task.prompt.length > 0
}

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((part): part is { type: string; text?: string } => typeof part === "object" && part !== null)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim()
}

async function abortSession(client: any, sessionID: string, directory: string): Promise<void> {
  try {
    await Promise.race([
      client.session.abort({ path: { id: sessionID }, query: { directory } }),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ])
  } catch {
    // The parent timeout is already terminal; cancellation is best effort.
  }
}

function configuredModel(): { providerID: string; modelID: string } | undefined {
  const configured = process.env.CCHP_BOT_MODEL ?? ""
  const slash = configured.indexOf("/")
  if (slash <= 0 || slash === configured.length - 1) return undefined
  return { providerID: configured.slice(0, slash), modelID: configured.slice(slash + 1) }
}

async function runOne(
  client: any,
  task: ReviewTask,
  parentID: string,
  directory: string,
  parentAbort?: AbortSignal,
): Promise<ReviewResult> {
  let sessionID: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  let assembledReferences = ""

  try {
    // Assemble all local reference content before creating a remote child
    // session. A corrupt or incomplete vendored library must not leak a session.
    assembledReferences = referenceEnvelope(searchReferences(automaticReferenceQuery(task.role, task.prompt))) + "\n" + structuredReferenceEnvelope()
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`review task exceeded ${AGENT_TIMEOUT_MS}ms`)), AGENT_TIMEOUT_MS)
    })
    const parentCancellation = new Promise<never>((_, reject) => {
      if (!parentAbort) return
      abortListener = () => reject(new Error("parent review task aborted"))
      if (parentAbort.aborted) abortListener()
      else parentAbort.addEventListener("abort", abortListener, { once: true })
    })
    const created = await Promise.race([
      client.session.create({
        body: { parentID, title: `Ultra review ${task.id}` },
        query: { directory },
      }),
      timeout,
      parentCancellation,
    ])
    if (created.error || !created.data?.id) {
      throw new Error(`session create failed: ${JSON.stringify(created.error ?? created.data)}`)
    }
    sessionID = created.data.id

    const prompt = client.session.prompt({
      path: { id: sessionID },
      query: { directory },
      body: {
        agent: "review",
        ...(configuredModel() ? { model: configuredModel() } : {}),
        tools: {
          task: false,
          ultra_review_task: false,
          // Leaf reviewers never publish or mutate GitHub — disable the whole
          // curated MCP surface (wildcard covers every github_inline_comment_* tool).
          "github_inline_comment*": false,
        },
        parts: [{ type: "text", text: `${task.prompt}\n\n${assembledReferences}` }],
      },
    })
    const response = await Promise.race([prompt, timeout, parentCancellation])
    if (response.error || !response.data) {
      throw new Error(`session prompt failed: ${JSON.stringify(response.error ?? response.data)}`)
    }
    return {
      id: task.id,
      role: task.role,
      state: "completed",
      session_id: sessionID,
      output: textFromParts(response.data.parts),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const timedOut = message.startsWith("review task exceeded ")
    const cancelled = timedOut || message === "parent review task aborted"
    if (cancelled && sessionID) await abortSession(client, sessionID, directory)
    return {
      id: task.id,
      role: task.role,
      state: timedOut ? "timed_out" : "failed",
      session_id: sessionID,
      error: message,
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (abortListener && parentAbort) parentAbort.removeEventListener("abort", abortListener)
  }
}

type PluginInput = { client: any }
type ToolContext = { sessionID: string; directory: string; abort?: AbortSignal }

export const UltraReviewRunner = async (input: PluginInput) => ({
  tool: {
    ultra_review_task: {
      description:
        "Run independent Ultra Code Review child sessions with a hard limit of 10 concurrent tasks and a 30 minute timeout per task. Use for finder, verifier, refuter, reproducer, adjudicator, and completeness roles.",
      // Keep this plugin self-contained. OpenCode supports legacy JSON Schema
      // plugin tools, so the standalone runner does not need an npm dependency.
      args: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            required: ["id", "role", "prompt"],
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1 },
              role: { type: "string", minLength: 1 },
              prompt: { type: "string", minLength: 1 },
              agent: { type: "string", minLength: 1 },
            },
          },
        },
      },
      async execute(args: { tasks: ReviewTask[] }, context: ToolContext) {
        if (!Array.isArray(args?.tasks) || args.tasks.length < 1 || args.tasks.length > 200) {
          return {
            title: "Ultra review batch rejected",
            output: "tasks must contain 1..200 independent review tasks",
          }
        }
        const rawTasks = args.tasks as unknown[]
        const results: ReviewResult[] = new Array(rawTasks.length)
        const tasks: Array<{ index: number; task: ReviewTask }> = []
        rawTasks.forEach((candidate, index) => {
          if (isReviewTask(candidate)) {
            tasks.push({ index, task: candidate })
          } else {
            results[index] = {
              id: `invalid-${index}`,
              role: "input-validation",
              state: "failed",
              error: "task must contain non-empty string id, role, and prompt",
            }
          }
        })
        const markPendingCancelled = () => {
          for (const item of tasks) {
            if (!results[item.index]) {
              results[item.index] = {
                id: item.task.id,
                role: item.task.role,
                state: "failed",
                error: "parent review task aborted",
              }
            }
          }
        }
        let next = 0
        const workers = Array.from({ length: Math.min(MAX_PARALLEL, tasks.length) }, async () => {
          while (true) {
            const index = next++
            if (index >= tasks.length) return
            if (context.abort?.aborted) {
              markPendingCancelled()
              return
            }
            const acquired = await acquireSlot(context.abort)
            if (!acquired) {
              markPendingCancelled()
              return
            }
            if (context.abort?.aborted) {
              releaseSlot()
              markPendingCancelled()
              return
            }
            try {
              const item = tasks[index]
              results[item.index] = await runOne(input.client, item.task, context.sessionID, context.directory, context.abort)
            } finally {
              releaseSlot()
            }
          }
        })
        await Promise.all(workers)
        return {
          title: `Ultra review batch: ${tasks.length} tasks`,
          output: JSON.stringify(
            {
              max_parallel: MAX_PARALLEL,
              timeout_ms: AGENT_TIMEOUT_MS,
              results,
            },
            null,
            2,
          ),
        }
      },
    },
  },
})
