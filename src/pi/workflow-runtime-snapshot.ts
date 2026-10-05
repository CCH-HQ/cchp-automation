import { writeWorkflowRuntimeSnapshot } from "../codex/workflow-runtime-snapshot"

if (import.meta.main) {
  try {
    const result = writeWorkflowRuntimeSnapshot()
    process.stdout.write(`[pi-runtime-snapshot] wrote ${result.path}\n`)
  } catch (error) {
    process.stderr.write(`[pi-runtime-snapshot] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
