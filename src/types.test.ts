import { expect, test } from "bun:test"
import {
  checkedActionIds,
  findByMarker,
  fingerprint,
  hidden,
  isForkPr,
  MARKER,
  newlyCheckedActionIds,
  TASKS,
} from "./types"

test("task enum is frozen and complete", () => {
  expect(TASKS).toEqual([
    "engage", "pr_opened", "lgtm_merge", "ci_fix", "release_notes",
    "roadmap_item", "roadmap_sync", "reaction_execute", "manual", "dispatch",
  ])
})

test("markers render in the frozen namespace", () => {
  expect(MARKER.sticky("cifix")).toBe("cchp-bot:cifix")
  expect(MARKER.progress("pr_opened")).toBe("cchp-bot:progress:pr_opened")
  expect(MARKER.plan("42")).toBe("cchp-bot:plan:42")
  expect(MARKER.executed("42")).toBe("cchp-bot:executed:42")
  expect(MARKER.action("rerun-review")).toBe("cchp-action:rerun-review")
  expect(hidden(MARKER.sticky("cifix"))).toBe("<!-- cchp-bot:cifix -->")
})

test("findByMarker matches on the hidden prefix (sticky upsert probe)", () => {
  const comments = [
    { id: 1, body: "unrelated" },
    { id: 2, body: `progress\n${hidden(MARKER.progress("pr_opened"))}` },
  ]
  expect(findByMarker(comments, MARKER.progress("pr_opened"))?.id).toBe(2)
  expect(findByMarker(comments, MARKER.sticky("cifix"))).toBeUndefined()
})

test("fingerprint is a stable sha256 hex", () => {
  const fp = fingerprint("some finding body")
  expect(fp).toMatch(/^[0-9a-f]{64}$/)
  expect(fingerprint("some finding body")).toBe(fp)
  expect(fingerprint("other")).not.toBe(fp)
})

test("isForkPr: head repo differs from base = fork (untrusted)", () => {
  expect(isForkPr("CCH-HQ/claude-code-hub-plus", "CCH-HQ/claude-code-hub-plus")).toBe(false)
  expect(isForkPr("attacker/claude-code-hub-plus", "CCH-HQ/claude-code-hub-plus")).toBe(true)
  expect(isForkPr(null, "CCH-HQ/claude-code-hub-plus")).toBe(true)
  expect(isForkPr(undefined, "CCH-HQ/claude-code-hub-plus")).toBe(true)
})

test("action-menu checkbox parse + newly-checked diff (security path)", () => {
  const prev = "- [ ] Apply fixes <!-- cchp-action:apply -->\n- [x] Re-review <!-- cchp-action:rerun -->"
  const next = "- [x] Apply fixes <!-- cchp-action:apply -->\n- [x] Re-review <!-- cchp-action:rerun -->"
  expect(checkedActionIds(prev)).toEqual(["rerun"])
  expect(checkedActionIds(next)).toEqual(["apply", "rerun"])
  // Only apply flipped unchecked→checked; rerun was already checked.
  expect(newlyCheckedActionIds(prev, next)).toEqual(["apply"])
  // No new checks when nothing flips.
  expect(newlyCheckedActionIds(next, next)).toEqual([])
})
