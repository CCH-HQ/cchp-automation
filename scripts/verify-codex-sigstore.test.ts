import { expect, test } from "bun:test"
import type { Bundle, VerifyOptions } from "sigstore"
import { verifyCodexSigstoreDocuments } from "./verify-codex-sigstore"

const workflowIdentity = "https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/rust-v0.147.0"

test("verifies every provenance bundle with Fulcio, CT log and Rekor thresholds", async () => {
  const bundles = [{ mediaType: "wrapper" }, { mediaType: "platform" }] as unknown as Bundle[]
  const calls: Array<{ bundle: Bundle; options?: VerifyOptions }> = []
  await verifyCodexSigstoreDocuments(
    bundles.map((bundle) => ({ attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle }] })),
    { workflowIdentity, tufCachePath: "/tmp/cchp-test-tuf" },
    async (bundle, options) => { calls.push({ bundle, options }) },
  )

  expect(calls.map((call) => call.bundle)).toEqual(bundles)
  for (const call of calls) {
    expect(call.options).toMatchObject({
      certificateIssuer: "https://token.actions.githubusercontent.com",
      certificateIdentityURI: workflowIdentity,
      ctLogThreshold: 1,
      tlogThreshold: 1,
      tufCachePath: "/tmp/cchp-test-tuf",
    })
  }
})

test("fails closed for missing provenance and verifier rejection", async () => {
  await expect(verifyCodexSigstoreDocuments(
    [{ attestations: [] }],
    { workflowIdentity, tufCachePath: "/tmp/cchp-test-tuf" },
    async () => undefined,
  )).rejects.toThrow("provenance bundle 1 is missing")

  await expect(verifyCodexSigstoreDocuments(
    [{ attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { mediaType: "fixture" } as Bundle }] }],
    { workflowIdentity, tufCachePath: "/tmp/cchp-test-tuf" },
    async () => { throw new Error("untrusted Fulcio chain") },
  )).rejects.toThrow("untrusted Fulcio chain")
})

test("rejects a workflow identity outside the pinned Codex repository", async () => {
  await expect(verifyCodexSigstoreDocuments(
    [],
    { workflowIdentity: "https://github.com/attacker/repo/.github/workflows/release.yml@refs/tags/v1", tufCachePath: "/tmp/cchp-test-tuf" },
    async () => undefined,
  )).rejects.toThrow("outside the pinned repository")
})
