import { expect, test } from "bun:test"
import { assembleReferenceContext, getAsset, searchReferences } from "./references"

test("uses the copied catalog and preserves provenance-bound reference assets", () => {
  const entries = searchReferences({ query: "security Go authorization", languages: ["Go"], tags: ["security"], limit: 10 })
  expect(entries.length).toBeGreaterThan(0)
  expect(entries[0]!.content).toBeTruthy()
  const assets = entries[0]!.origins
  expect(assets[0]!.commit).toBeTruthy()
  const catalogAsset = getAsset("alibaba-open-code-review", "plugins/open-code-review/.codex-plugin/plugin.json")
  expect(catalogAsset.content).toContain("open-code-review")
})

test("enforces deterministic shared count and UTF-8 byte budgets for references and assets", () => {
  const query = { query: "security Go authorization", languages: ["Go"], tags: ["security"], limit: 3 }
  expect(searchReferences(query)).toHaveLength(3)
  const first = assembleReferenceContext("security reviewer", query.query, {
    maxBytes: 4_096,
    maxEntries: 12,
    maxAssets: 4,
    maxSingleBytes: 2_048,
  })
  const second = assembleReferenceContext("security reviewer", query.query, {
    maxBytes: 4_096,
    maxEntries: 12,
    maxAssets: 4,
    maxSingleBytes: 2_048,
  })
  expect(Buffer.byteLength(first.text, "utf8")).toBeLessThanOrEqual(4_096)
  expect(first).toEqual(second)
  expect(first.selectedEntryIds.length).toBeLessThanOrEqual(12)
  expect(first.selectedAssetIds.length).toBeLessThanOrEqual(4)
  expect(first.omittedCount).toBeGreaterThan(0)
})
