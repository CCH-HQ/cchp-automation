import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { StringEnum } from "@earendil-works/pi-ai"
import { Type } from "typebox"

const TodoParams = Type.Object({
  action: StringEnum(["replace", "list", "clear"] as const),
  items: Type.Optional(Type.Array(Type.Object({
    content: Type.String({ minLength: 1 }),
    status: StringEnum(["pending", "in_progress", "completed", "cancelled"] as const),
  }))),
})

type Todo = { content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }

function todoPath(): string {
  const workdir = process.env.BOT_WORKDIR
  if (!workdir) throw new Error("BOT_WORKDIR is required for the CCHP todo extension")
  return `${workdir}/ctx/pi/todo.json`
}

function persist(todos: Todo[], revision: number): void {
  const path = todoPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    revision,
    rootThreadId: process.env.BOT_RUN_ID ?? "pi",
    updatedAt: new Date().toISOString(),
    todos,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
}

export default function (pi: any) {
  let todos: Todo[] = []
  let revision = 0
  const load = () => {
    const path = todoPath()
    if (!existsSync(path)) return
    const value = JSON.parse(readFileSync(path, "utf8")) as { revision?: number; todos?: Todo[] }
    if (Array.isArray(value.todos)) todos = value.todos.slice(0, 200)
    if (typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0) revision = value.revision
  }
  const save = () => persist(todos, ++revision)

  pi.on("session_start", async () => load())

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Maintain the live CCHP task list. Use replace with the complete current list after every meaningful change.",
    parameters: TodoParams,
    async execute(_toolCallId: string, params: { action: "replace" | "list" | "clear"; items?: Todo[] }) {
      if (params.action === "replace") {
        todos = (params.items ?? []).slice(0, 200).map((item) => ({ content: item.content.trim(), status: item.status }))
        if (todos.some((item) => !item.content)) return { content: [{ type: "text", text: "Todo content must not be empty" }] }
        save()
        return { content: [{ type: "text", text: `Updated ${todos.length} todo item(s)` }], details: { todos, revision } }
      }
      if (params.action === "clear") {
        todos = []
        save()
        return { content: [{ type: "text", text: "Cleared the todo list" }], details: { todos, revision } }
      }
      return {
        content: [{ type: "text", text: todos.length ? todos.map((item) => `[${item.status}] ${item.content}`).join("\n") : "Todo list is empty" }],
        details: { todos, revision },
      }
    },
  })

  pi.registerCommand("todos", {
    description: "Show the current CCHP todo list",
    handler: async (_args: string, ctx: any) => {
      const text = todos.length ? todos.map((item) => `[${item.status}] ${item.content}`).join("\n") : "Todo list is empty"
      ctx.ui.notify(text, "info")
    },
  })
}
