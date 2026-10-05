import { verifyLifecycleArtifact, writeLifecycleArtifact } from "../codex/lifecycle-artifact"

if (import.meta.main) {
  try {
    if (process.argv[2] === "--verify") {
      const path = process.env.CCHP_LIFECYCLE_ARTIFACT_PATH
      const sha256 = process.env.CCHP_LIFECYCLE_ARTIFACT_SHA256
      if (!path || !sha256) throw new Error("lifecycle verification path and sha256 are required")
      verifyLifecycleArtifact(path, sha256)
      process.stdout.write(`[pi-lifecycle] verified ${path}\n`)
    } else {
      writeLifecycleArtifact()
    }
  } catch (error) {
    process.stderr.write(`[pi-lifecycle] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
