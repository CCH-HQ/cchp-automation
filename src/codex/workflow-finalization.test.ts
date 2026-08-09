import { expect, test } from "bun:test"
import { parseWorkflowFinalization } from "./workflow-finalization"

const valid = {
  schemaVersion: 1 as const,
  terminalSha256: null,
  resolvedState: "SUCCEEDED" as const,
  reasonCode: "supervisor_succeeded" as const,
  publication: "skipped" as const,
  progressPublicationSha256: null,
  recordedAt: "2026-08-07T00:00:00.000Z",
}

test("workflow finalization round-trips a stable reason code", () => {
  expect(parseWorkflowFinalization(valid)).toEqual(valid)
})

test("workflow finalization rejects unknown or state-inconsistent reason codes", () => {
  expect(() => parseWorkflowFinalization({ ...valid, reasonCode: "dynamic_message_code" }))
    .toThrow("reason code is invalid")
  expect(() => parseWorkflowFinalization({ ...valid, reasonCode: "lifecycle_upload_failed" }))
    .toThrow("state and reason code are inconsistent")
  expect(() => parseWorkflowFinalization({
    ...valid,
    resolvedState: "FAILED",
    reasonCode: "supervisor_succeeded",
  })).toThrow("state and reason code are inconsistent")
})
