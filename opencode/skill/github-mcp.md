---
name: github-mcp
description: "GitHub write discipline for the cchp-automation bot. Read this before touching GitHub state — posting comments or reviews, updating a Check Run, labelling, merging, or moving roadmap items. The engine's Octokit MCP server is the ONLY sanctioned GitHub write path (26 tools); raw `gh`/`git push` writes are forbidden. Covers the sticky-comment marker upsert rule, verified/anchored inline findings, the COMMENT/APPROVE verdict convention, fork auto-merge safety, and the CCHP_DISABLE_AUTO_APPROVE kill-switch. Use whenever you are about to change anything on GitHub."
user-invocable: true
license: MIT
compatibility: cchp-automation engine (OpenCode agent + custom Octokit MCP server). GitHub App auth, self-hosted runner.
---

# GitHub MCP write discipline

You publish to GitHub through **one** surface: the engine's custom **Octokit MCP
server**. It authenticates once with the run's GitHub App token, pins the API
version, and enforces the frozen contracts (markers, fingerprints, fork safety).
Do not reach around it.

## The one rule: MCP is the only write path

- **Every GitHub write goes through an MCP tool below.** Comments, reviews, check
  runs, labels, milestones, merges, workflow re-runs, roadmap mutations — all of it.
- **Never hand-roll a GitHub write.** No `gh api -X POST/PATCH/PUT/DELETE`, no
  `gh pr create|edit|review|merge|comment`, no `gh issue …`, no `gh workflow run`,
  no `curl` against `api.github.com`, no hand-written GraphQL mutation, and **no
  `git push` to any GitHub remote** (branch pushes are the engine harness's job via
  its native git transport — not something you invent).
- **Reads are fine.** `gh` / `git` for read-only inspection (`gh pr view`,
  `git log/diff/show`, local clone/fetch/checkout) is allowed when a typed read
  tool doesn't cover it. Prefer the MCP read tools when they do.
- **Uncovered write ops → `roadmap_graphql`** (roadmap only) or report the gap.
  Raw `gh` is a last-resort read fallback, never the primary implementation
  (ADR 0003). If a needed write isn't in the table, say so — don't improvise.

## The 26 tools

**Publish**
- `upsert_sticky_comment` — upsert one bot Sticky/Progress comment by `sticky_key`.
- `post_structured_comment` — top-level structured comment (TL;DR + table +
  collapsible sections + action checklist); optional `sticky_key` to upsert.
- `update_structured_comment` — re-render/replace an existing bot comment by id.
- `post_inline_review` — post verified inline Findings as ONE review (event=COMMENT).
- `submit_pr_review` — the formal Verdict (COMMENT / REQUEST_CHANGES / APPROVE).
- `create_check_run` — open a queued Check Run (`external_id` = run id).
- `update_check_run` — advance/complete a Check Run (+ up to 3 action buttons:
  `applyFixes` / `deepReReview` / `dismiss`).

**Meta**
- `set_pr_title` — set PR title (≤256 chars, single line).
- `post_comment` — one-line top-level comment (≤4096 chars).
- `comment_file` — multi-line top-level comment (1..65536 bytes).
- `close` — closing comment then close the PR/issue.
- `lock` — lock conversation (spam / off_topic / resolved / too_heated).
- `add_triage_label` — managed triage label (spam / invalid).
- `add_lgtm_label` — add the LGTM label only (does NOT merge).
- `merge_pr` — merge a **same-repo** PR (squash default); forks never auto-merge.

**Reads** (return text/JSON; never write files)
- `get_pr_diff` — unified diff for a PR.
- `get_failed_logs` — a workflow run's metadata + logs of only its failed jobs.
- `get_pr_context` — PR metadata + changed files + submitted reviews.

**Mutations**
- `add_label` — add existing label(s) (use the managed tools for triage/LGTM).
- `remove_label` — remove a single label.
- `set_milestone` — set (by id) or clear (null) a milestone.
- `rerun_workflow_run` — re-run all jobs, or `failed_only`.
- `cancel_workflow_run` — cancel an in-progress run.

**Roadmap (Projects v2)**
- `roadmap_add_item` — add issue/PR (content node id) to a board.
- `roadmap_move_item` — set an item's Status single-select (the column).
- `roadmap_graphql` — thin GraphQL passthrough for low-frequency roadmap ops
  (resolve project / field / option node ids; full reconcile per roadmap-policy).

## Sticky comments: marker-upsert, one per key

A Sticky Comment is kept unique by a **hidden marker** `cchp-bot:<sticky_key>`
(wrapped as `<!-- cchp-bot:<sticky_key> -->`). The tool appends the marker for
you and does **find-by-marker → edit-in-place, else create**.

- **One sticky per key per PR/issue.** To update your overview/progress, call
  `upsert_sticky_comment` (or `post_structured_comment` with the same
  `sticky_key`) again — it edits the existing one. Never `post_comment` a second
  copy of something that has a sticky key.
- `sticky_key` must match `^[a-z0-9][a-z0-9:._-]{0,63}$`.
- The Progress Comment is the reserved sticky `cchp-bot:progress:<task>` (the live
  todo mirror) — distinct from your review summary sticky. Don't collide with it.
- Frozen marker namespace (do not invent new ones): `cchp-bot:<key>`,
  `cchp-bot:progress:<task>`, `cchp-bot:plan:<id>`, `cchp-bot:executed:<id>`,
  `cchp-action:<id>`, `cchp-review-fingerprint:<sha256>`.

## Inline findings: verified only, anchored to current head

- Post inline comments **only for findings you have verified** — one comment per
  real issue. `post_inline_review` batches them into a single PR review.
- Every finding is **anchored to a line/side that provably exists in the trusted
  current PR patch**. Use `line`/`side` (+ `start_line`/`start_side` for ranges);
  never the deprecated `position`. Unanchorable findings are dropped.
- The **PR number, head SHA, and trusted patch are bound from the run environment**
  (`BOT_PR_NUMBER` / `BOT_HEAD_SHA`), **not from your arguments** — so findings
  always target the current head, and stale anchors can't be smuggled in.
- Cross-run **fingerprint dedup**: each finding carries a
  `cchp-review-fingerprint:<sha256>` marker; already-posted fingerprints are
  skipped, so re-runs don't duplicate comments. Keep finding text stable so the
  fingerprint stays stable.

## Verdict convention (`submit_pr_review`)

- Verdicts: **COMMENT** (default / safe), **REQUEST_CHANGES**, **APPROVE**.
- You choose the verdict autonomously **on any PR, including forks** — the fork
  boundary gates *merging*, not the review. APPROVE is allowed when the change is
  genuinely good.
- **Kill-switch:** the org/repo variable **`CCHP_DISABLE_AUTO_APPROVE`** (`1` or
  `true`) downgrades an APPROVE to a COMMENT automatically (with a note appended).
  Treat APPROVE as best-effort: the engine may soften it.

## Fork safety (never auto-merge a fork)

- `merge_pr` **never merges a fork PR** — when `head_repo_full_name` differs from
  this repo (or is null), it refuses and a maintainer merges manually (ADR 0004).
  Same-repo PRs merge (squash by default). Pass the real
  `head_repo_full_name` from `get_pr_context`; don't spoof it.
- `add_lgtm_label` only labels — it does not merge. LGTM-driven auto-merge is
  enabled for internal PRs and **off for forks**.
- Never push to a fork remote and never execute untrusted fork head code; you read
  the trusted diff/context only.

## Do / Don't

- **Do** resolve the PR/issue number and node ids from a read tool
  (`get_pr_context`, `roadmap_graphql`) before mutating.
- **Do** re-use `upsert_sticky_comment` to update, not re-post.
- **Don't** write to GitHub with `gh`/`curl`/`git push`.
- **Don't** post unverified or unanchored inline findings.
- **Don't** invent markers, spoof `head_repo_full_name`, or override the
  auto-approve kill-switch.
