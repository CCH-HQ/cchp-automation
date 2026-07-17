// Live progress mirror: every todowrite from the ROOT session is rendered as a
// GitHub task-list checklist and upserted into ONE sticky comment on the issue
// or PR the bot is working on. Humans watch progress without polling; the
// comment is bot-authored, so its own edits never re-trigger route.sh.
//
// Fail-open by design: progress publication must never break the run.
// Activation: BOT_REPO + BOT_PROGRESS_TARGET (issue/PR number) + GH_TOKEN.
//
// ENGINE NOTE (cchp-automation): this gh-based sticky upsert duplicates
// `src/publish/sticky.ts` (renderProgress / upsertSticky / progressMarkerKey — the
// Octokit port of the renderTodos / upsert / marker logic below). Per DESIGN §6
// the agent runtime is the allowed raw-`gh` fallback, so the `gh` calls here are
// intentionally kept as-is; a later pass should migrate this to the MCP
// `upsert_sticky_comment` tool. Until then, do not diverge the marker string or
// checklist rendering from sticky.ts — `cchp-bot:progress:<task>` is the frozen
// contract (DESIGN §8).
import { spawnSync } from "node:child_process"

function sanitize(text: unknown): string {
  // Strip HTML comments so todo content can never spoof sticky/fingerprint/
  // action markers, and clamp length to keep the comment readable.
  let value = String(text ?? "")
  let previous: string
  do {
    previous = value
    value = value.replace(/<!--[\s\S]*?-->/g, "")
  } while (value !== previous)
  return value.replace(/\s+/g, " ").trim().slice(0, 200)
}

function renderTodos(todos: any[], task: string): string {
  const items = todos.slice(0, 50).map((t) => {
    const content = sanitize(t?.content) || "(untitled)"
    if (t?.status === "completed") return `- [x] ${content}`
    if (t?.status === "cancelled") return `- [x] ~~${content}~~ (cancelled)`
    if (t?.status === "in_progress") return `- [ ] **${content}** ⏳`
    return `- [ ] ${content}`
  })
  const done = todos.filter((t) => t?.status === "completed").length
  return [
    `### 🤖 Live progress — \`${task}\``,
    "",
    `> ${done}/${todos.length} steps completed`,
    "",
    ...items,
    "",
    "---",
    "<sub>Auto-updated from the agent's task list while it works. This comment is informational; findings and replies are posted separately.</sub>",
  ].join("\n")
}

export const ProgressComment = async () => {
  const repo = process.env.BOT_REPO
  const target = process.env.BOT_PROGRESS_TARGET
  if (!repo || !target || !/^[0-9]+$/.test(target)) return {}
  const task = (process.env.BOT_TASK || "task").replace(/[^a-z0-9_-]/gi, "")
  const marker = `<!-- cchp-bot:progress:${task} -->`
  let commentId: string | null = null
  let looked = false
  let rootSession: string | null = null
  let lastBody = ""

  const gh = (args: string[]): string | null => {
    // Bun resolves the executable from the env option's PATH; pass it
    // explicitly so runtime PATH changes (and test shims) are honored.
    const r = spawnSync("gh", args, { encoding: "utf8", env: process.env })
    if (r.status !== 0) {
      console.error(`[progress-comment] gh failed: ${(r.stderr || "").trim().slice(0, 300)}`)
      return null
    }
    return (r.stdout || "").trim()
  }

  const upsert = (body: string) => {
    const full = `${body}\n${marker}`
    if (full === lastBody) return
    if (!looked) {
      looked = true
      // gh rejects --slurp combined with --jq; flatten the page-of-pages here.
      const raw = gh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${target}/comments`])
      if (raw) {
        try {
          const existing = (JSON.parse(raw) || []).flat().find((c: any) => (c?.body || "").includes(marker))
          if (existing) commentId = String(existing.id)
        } catch { /* fail-open */ }
      }
    }
    const out = commentId
      ? gh(["api", "--method", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-f", `body=${full}`, "--jq", ".id"])
      : gh(["api", "--method", "POST", `repos/${repo}/issues/${target}/comments`, "-f", `body=${full}`, "--jq", ".id"])
    if (out) {
      commentId = commentId ?? out
      lastBody = full
    }
  }

  return {
    "tool.execute.after": async (input: { tool: string; sessionID: string; args: any }) => {
      try {
        if (input?.tool !== "todowrite") return
        // Mirror only the coordinator's list: the first session that writes
        // todos is the root; child reviewer sessions keep their own lists.
        if (rootSession == null) rootSession = input.sessionID
        if (input.sessionID !== rootSession) return
        const todos = input?.args?.todos
        if (!Array.isArray(todos) || todos.length === 0) return
        // Keep the author's plan order — checked boxes tell the story.
        upsert(renderTodos(todos, task))
      } catch (e) {
        console.error(`[progress-comment] ${e instanceof Error ? e.message : e}`)
      }
    },
  }
}
