import { expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChildGraph } from "./graph"

test("keeps one parent per child, stable BFS descendants and idempotent closure", () => {
  const graph = new ChildGraph()
  graph.open("root", "child-a", "spawn-1")
  graph.open("root", "child-b", "spawn-2")
  graph.open("child-a", "grandchild", "spawn-3")
  graph.open("root", "child-a", "spawn-1")

  expect(graph.descendants("root")).toEqual(["child-a", "child-b", "grandchild"])
  expect(() => graph.open("other", "child-a", "spawn-4")).toThrow("already has parent")
  expect(graph.close("child-a", "completed")).toBe(true)
  expect(graph.close("child-a", "completed")).toBe(false)
  expect(graph.openEdges().map((edge) => edge.childId)).toEqual(["child-b", "grandchild"])
})

test("replays durable graph state without duplicating history", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-graph-"))
  const path = join(root, "graph.jsonl")
  const first = new ChildGraph(path)
  first.open("root", "child-a", "spawn-1")
  first.open("root", "child-b", "spawn-2")
  first.close("child-a", "completed")
  expect(first.pendingResumes()).toHaveLength(1)
  first.markResumeAttempt("child-a")
  first.markResumeDelivered("child-a")
  expect(first.pendingResumes()).toHaveLength(0)
  const before = readFileSync(path, "utf8")

  const restored = new ChildGraph(path)
  expect(restored.edges()).toEqual(first.edges())
  expect(restored.descendants("root")).toEqual(["child-a", "child-b"])
  restored.open("root", "child-a", "spawn-1")
  expect(readFileSync(path, "utf8")).toBe(before)
})

test("ignores only a torn final row and fails closed on durable corruption", () => {
  const root = mkdtempSync(join(tmpdir(), "cchp-graph-torn-"))
  const path = join(root, "graph.jsonl")
  const graph = new ChildGraph(path)
  graph.open("root", "child", "spawn")
  appendFileSync(path, '{"event":"edge_closed"')
  const restored = new ChildGraph(path)
  expect(restored.openEdges().map((edge) => edge.childId)).toEqual(["child"])
  restored.close("child", "completed")
  expect(new ChildGraph(path).edge("child")).toMatchObject({ state: "closed", terminalState: "completed" })

  const validWithoutNewline = join(root, "valid-without-newline.jsonl")
  writeFileSync(validWithoutNewline, JSON.stringify({ event: "edge_opened", parentId: "root", childId: "b", spawnItemId: "s2", state: "open", openedAt: "now" }))
  const valid = new ChildGraph(validWithoutNewline)
  valid.close("b", "completed")
  expect(new ChildGraph(validWithoutNewline).edge("b")).toMatchObject({ state: "closed" })

  const corrupt = join(root, "corrupt.jsonl")
  writeFileSync(corrupt, `${JSON.stringify({ event: "edge_opened", parentId: "root", childId: "a", spawnItemId: "s", state: "open", openedAt: "now" })}\nnot-json\n`)
  expect(() => new ChildGraph(corrupt)).toThrow("invalid JSONL row 2")
})
