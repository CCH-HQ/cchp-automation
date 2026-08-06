#!/usr/bin/env bun
import { readFileSync } from "node:fs"
import { verify, type Bundle, type VerifyOptions } from "sigstore"

type VerifyBundle = (bundle: Bundle, options?: VerifyOptions) => Promise<unknown>

interface AttestationDocument {
  attestations?: Array<{
    predicateType?: string
    bundle?: Bundle
  }>
}

export interface CodexSigstoreVerificationOptions {
  workflowIdentity: string
  tufCachePath: string
}

const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1"
const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com"

export async function verifyCodexSigstoreDocuments(
  documents: readonly AttestationDocument[],
  options: CodexSigstoreVerificationOptions,
  verifyBundle: VerifyBundle = verify,
): Promise<void> {
  if (!options.workflowIdentity.startsWith("https://github.com/openai/codex/.github/workflows/")) {
    throw new Error("Codex Sigstore workflow identity is outside the pinned repository")
  }
  if (!options.tufCachePath) throw new Error("Codex Sigstore TUF cache path is empty")
  for (const [index, document] of documents.entries()) {
    const provenance = document.attestations?.find((entry) => entry.predicateType === SLSA_PROVENANCE_V1)
    if (!provenance?.bundle) throw new Error(`Codex Sigstore provenance bundle ${index + 1} is missing`)
    await verifyBundle(provenance.bundle, {
      certificateIssuer: GITHUB_ACTIONS_ISSUER,
      certificateIdentityURI: options.workflowIdentity,
      ctLogThreshold: 1,
      tlogThreshold: 1,
      tufCachePath: options.tufCachePath,
      timeout: 10_000,
    })
  }
}

async function main(): Promise<void> {
  const [wrapperPath, platformPath, workflowIdentity, tufCachePath] = process.argv.slice(2)
  if (!wrapperPath || !platformPath || !workflowIdentity || !tufCachePath) {
    throw new Error("usage: verify-codex-sigstore.ts <wrapper-attestation> <platform-attestation> <workflow-identity> <tuf-cache-path>")
  }
  const documents = [wrapperPath, platformPath].map((path) => JSON.parse(readFileSync(path, "utf8")) as AttestationDocument)
  await verifyCodexSigstoreDocuments(documents, { workflowIdentity, tufCachePath })
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`[codex-sigstore] verification failed: ${error instanceof Error ? error.name : "Error"}\n`)
    process.exit(1)
  })
}
