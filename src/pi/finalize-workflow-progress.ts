import { finalizeWorkflowProgress } from "../codex/finalize-workflow-progress"

if (import.meta.main) {
  finalizeWorkflowProgress().catch((error) => {
    process.stderr.write(`[pi-finalizer] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
