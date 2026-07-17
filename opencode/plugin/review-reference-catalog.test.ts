import { describe, expect, test } from "bun:test"
import { automaticReferenceQuery, searchReferences } from "./review-reference-catalog"

describe("review reference catalog", () => {
  test("selects security and Go references for a Go authorization verifier", () => {
    const entries = searchReferences(automaticReferenceQuery(
      "authorization security verifier",
      "Review Go tenant authorization, hardcoded credentials, JWT validation, and access-control failures.",
    ))
    expect(entries.length).toBeGreaterThan(4)
    expect(entries.some((entry) => entry.tags.includes("security") || entry.tags.includes("auth") || entry.titles.some((title) => /authorization|credential|security/i.test(title)))).toBeTrue()
    expect(entries.some((entry) => entry.languages.includes("go") || entry.always_apply)).toBeTrue()
    expect(entries.some((entry) => entry.titles.some((title) => /additional cryptography/i.test(title)))).toBeTrue()
    expect(entries.every((entry) => entry.content.length > 0)).toBeTrue()
  })

  test("does not infer C from ordinary words", () => {
    expect(automaticReferenceQuery("finder", "Find all bugs in the complete pull request.").languages).toEqual([])
    expect(automaticReferenceQuery("C parser verifier", "Review the C parser boundary.").languages).toContain("c")
  })

  test("uses the full catalog language vocabulary", () => {
    const query = automaticReferenceQuery("security verifier", "Review PHP, Ruby, Swift, SQL, Docker, and HCL changes.")
    expect(query.languages).toEqual(expect.arrayContaining(["php", "ruby", "swift", "sql", "docker", "hcl"]))
  })

  test("preserves exact dedup provenance from multiple upstream origins", () => {
    const entries = searchReferences({ query: "relocate existing code suggestion diff", limit: 100 })
    const duplicate = entries.find((entry) => entry.origins.length > 1)
    expect(duplicate).toBeDefined()
    expect(new Set(duplicate!.origins.map((origin) => origin.repository)).size).toBeGreaterThanOrEqual(1)
    expect(duplicate!.origins.every((origin) => /^[0-9a-f]{40}$/.test(origin.commit))).toBeTrue()
  })

  test("honors kind filters instead of returning unrelated always-apply rules", () => {
    const entries = searchReferences({ kinds: ["reviewer-persona"], limit: 50 })
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((entry) => entry.kinds.includes("reviewer-persona"))).toBeTrue()
  })

  test("keeps all language applicability matches even when supplementary results are capped", () => {
    const entries = searchReferences({ query: "security verifier", languages: ["ruby"], kinds: ["rule"], limit: 1 })
    expect(entries.filter((entry) => entry.languages.includes("ruby")).length).toBeGreaterThan(1)
  })
})
