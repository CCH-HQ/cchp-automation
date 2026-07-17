import { expect, test } from "bun:test"
import type { GitHubClient } from "../github/client"
import {
  addLgtmLabel,
  addTriageLabel,
  closePrOrIssue,
  commentFile,
  lock,
  postComment,
  requireText,
  setPrTitle,
} from "./meta"

function fake(opts: { getLabelThrows?: boolean } = {}) {
  const calls = {
    pullsUpdate: [] as Record<string, unknown>[],
    createComment: [] as Record<string, unknown>[],
    issuesUpdate: [] as Record<string, unknown>[],
    lock: [] as Record<string, unknown>[],
    getLabel: [] as Record<string, unknown>[],
    createLabel: [] as Record<string, unknown>[],
    addLabels: [] as Record<string, unknown>[],
  }
  const octokit = {
    rest: {
      pulls: {
        update: async (p: Record<string, unknown>) => {
          calls.pullsUpdate.push(p)
          return { data: {} }
        },
      },
      issues: {
        createComment: async (p: Record<string, unknown>) => {
          calls.createComment.push(p)
          return { data: { id: 11, html_url: "https://gh/c/11" } }
        },
        update: async (p: Record<string, unknown>) => {
          calls.issuesUpdate.push(p)
          return { data: {} }
        },
        lock: async (p: Record<string, unknown>) => {
          calls.lock.push(p)
          return { data: {} }
        },
        getLabel: async (p: Record<string, unknown>) => {
          calls.getLabel.push(p)
          if (opts.getLabelThrows) throw new Error("404 label not found")
          return { data: { name: p.name } }
        },
        createLabel: async (p: Record<string, unknown>) => {
          calls.createLabel.push(p)
          return { data: {} }
        },
        addLabels: async (p: Record<string, unknown>) => {
          calls.addLabels.push(p)
          return { data: [] }
        },
      },
    },
  } as unknown as GitHubClient
  return { octokit, calls }
}

const REPO = "CCH-HQ/repo"

// ── requireText (ported validation) ────────────────────────────────────────────
test("requireText: rejects empty, over-length, multiline, and shell-metachar input", () => {
  expect(() => requireText("", 10, "x")).toThrow("invalid x length")
  expect(() => requireText("a".repeat(11), 10, "x")).toThrow("invalid x length")
  expect(() => requireText("a\nb", 10, "x")).toThrow("must be one line")
  expect(() => requireText("a & b", 10, "x")).toThrow("forbidden shell character")
  expect(() => requireText("plain ok", 10, "x")).not.toThrow()
})

// ── setPrTitle (pr-title) ──────────────────────────────────────────────────────
test("setPrTitle: updates the PR title via pulls.update", async () => {
  const { octokit, calls } = fake()
  await setPrTitle(octokit, REPO, 5, "feat: normalize title")
  expect(calls.pullsUpdate[0]).toMatchObject({ owner: "CCH-HQ", repo: "repo", pull_number: 5, title: "feat: normalize title" })
})

test("setPrTitle: enforces the title constraints (length) and the number guard", async () => {
  const { octokit } = fake()
  await expect(setPrTitle(octokit, REPO, 5, "a".repeat(257))).rejects.toThrow("invalid title length")
  await expect(setPrTitle(octokit, REPO, 0, "ok")).rejects.toThrow("invalid number")
})

// ── postComment (pr-comment) ───────────────────────────────────────────────────
test("postComment: posts a one-line top-level comment (≤4096)", async () => {
  const { octokit, calls } = fake()
  const res = await postComment(octokit, REPO, 5, "Title normalized to match the conventional-commit rule.")
  expect(res).toEqual({ id: 11, url: "https://gh/c/11" })
  expect(calls.createComment[0]).toMatchObject({ issue_number: 5, body: "Title normalized to match the conventional-commit rule." })
})

test("postComment: rejects multiline / over-length bodies", async () => {
  const { octokit } = fake()
  await expect(postComment(octokit, REPO, 5, "line1\nline2")).rejects.toThrow("must be one line")
  await expect(postComment(octokit, REPO, 5, "a".repeat(4097))).rejects.toThrow("invalid comment length")
})

// ── commentFile (pr-comment-file) ──────────────────────────────────────────────
test("commentFile: posts a multi-line body and enforces the 1..65536 byte size", async () => {
  const { octokit, calls } = fake()
  const res = await commentFile(octokit, REPO, 5, "## Reply\n\nmultiple\nlines are fine here")
  expect(res).toEqual({ id: 11, url: "https://gh/c/11" })
  expect(calls.createComment[0]!.body).toContain("\n")
  await expect(commentFile(octokit, REPO, 5, "")).rejects.toThrow("1..65536 bytes")
  await expect(commentFile(octokit, REPO, 5, "a".repeat(65537))).rejects.toThrow("1..65536 bytes")
})

// ── closePrOrIssue (pr-close) ──────────────────────────────────────────────────
test("closePrOrIssue: posts the reason then closes", async () => {
  const { octokit, calls } = fake()
  await closePrOrIssue(octokit, REPO, 5, "closing as spam")
  expect(calls.createComment[0]).toMatchObject({ issue_number: 5, body: "closing as spam" })
  expect(calls.issuesUpdate[0]).toMatchObject({ issue_number: 5, state: "closed" })
})

test("closePrOrIssue: enforces the reason constraints", async () => {
  const { octokit } = fake()
  await expect(closePrOrIssue(octokit, REPO, 5, "a".repeat(513))).rejects.toThrow("invalid reason length")
})

// ── lock (pr-lock) ─────────────────────────────────────────────────────────────
test("lock: maps the script's reason vocabulary to the REST lock_reason", async () => {
  const { octokit, calls } = fake()
  await lock(octokit, REPO, 5, "off_topic")
  expect(calls.lock[0]).toMatchObject({ issue_number: 5, lock_reason: "off-topic" })
  await lock(octokit, REPO, 5, "too_heated")
  expect(calls.lock[1]!.lock_reason).toBe("too heated")
  await lock(octokit, REPO, 5, "spam")
  expect(calls.lock[2]!.lock_reason).toBe("spam")
})

test("lock: rejects an unknown reason", async () => {
  const { octokit } = fake()
  await expect(lock(octokit, REPO, 5, "nonsense")).rejects.toThrow("invalid lock reason")
})

// ── addTriageLabel (pr-triage-label) ───────────────────────────────────────────
test("addTriageLabel: creates the label when missing, then adds it", async () => {
  const { octokit, calls } = fake({ getLabelThrows: true })
  await addTriageLabel(octokit, REPO, 5, "spam")
  expect(calls.getLabel[0]).toMatchObject({ name: "spam" })
  expect(calls.createLabel[0]).toMatchObject({ name: "spam", color: "b60205" })
  expect(calls.addLabels[0]).toMatchObject({ issue_number: 5, labels: ["spam"] })
})

test("addTriageLabel: skips creation when the label already exists", async () => {
  const { octokit, calls } = fake() // getLabel succeeds
  await addTriageLabel(octokit, REPO, 5, "invalid")
  expect(calls.createLabel.length).toBe(0)
  expect(calls.addLabels[0]).toMatchObject({ labels: ["invalid"] })
})

test("addTriageLabel: rejects a non-triage label without any API call", async () => {
  const { octokit, calls } = fake()
  await expect(addTriageLabel(octokit, REPO, 5, "wip")).rejects.toThrow("invalid triage label")
  expect(calls.getLabel.length).toBe(0)
  expect(calls.addLabels.length).toBe(0)
})

// ── addLgtmLabel (pr-lgtm-label) ───────────────────────────────────────────────
test("addLgtmLabel: ensures the LGTM label (green) and adds it — no merge", async () => {
  const { octokit, calls } = fake({ getLabelThrows: true })
  await addLgtmLabel(octokit, REPO, 5)
  expect(calls.createLabel[0]).toMatchObject({ name: "LGTM", color: "0e8a16" })
  expect(calls.addLabels[0]).toMatchObject({ issue_number: 5, labels: ["LGTM"] })
})

test("addLgtmLabel: existing LGTM label is reused", async () => {
  const { octokit, calls } = fake()
  await addLgtmLabel(octokit, REPO, 5)
  expect(calls.createLabel.length).toBe(0)
  expect(calls.addLabels[0]).toMatchObject({ labels: ["LGTM"] })
})
