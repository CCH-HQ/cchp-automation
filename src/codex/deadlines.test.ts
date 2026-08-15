import { expect, test } from "bun:test"
import { ProgressDeadline } from "./deadlines"

test("only semantic progress resets the warning and terminal clocks", () => {
  let now = 0
  const deadline = new ProgressDeadline({ now: () => now, warningMs: 300_000, terminalMs: 1_200_000 })

  now = 299_999
  deadline.transportEvent("token refresher")
  expect(deadline.check()).toEqual({ state: "healthy", semanticAgeMs: 299_999, modelAgeMs: 299_999 })
  now = 300_000
  expect(deadline.check()).toEqual({ state: "warning", semanticAgeMs: 300_000, modelAgeMs: 300_000 })
  now = 600_000
  deadline.semanticProgress("child completed")
  expect(deadline.check()).toEqual({ state: "healthy", semanticAgeMs: 0, modelAgeMs: 0 })
  now = 1_800_000
  expect(deadline.check()).toEqual({ state: "terminal", semanticAgeMs: 1_200_000, modelAgeMs: 1_200_000 })
})

test("completed model output postpones terminal without resetting the semantic warning", () => {
  let now = 0
  const deadline = new ProgressDeadline({ now: () => now, warningMs: 10, terminalMs: 20 })
  now = 9
  deadline.sidecarEvent()
  deadline.transportEvent("reconcile")
  expect(deadline.check()).toEqual({ state: "healthy", semanticAgeMs: 9, modelAgeMs: 9 })
  now = 20
  deadline.sidecarEvent()
  deadline.transportEvent("heartbeat")
  expect(deadline.check()).toEqual({ state: "terminal", semanticAgeMs: 20, modelAgeMs: 20 })
  deadline.modelEvent()
  expect(deadline.check()).toEqual({ state: "warning", semanticAgeMs: 20, modelAgeMs: 0 })
  now = 40
  expect(deadline.check()).toEqual({ state: "terminal", semanticAgeMs: 40, modelAgeMs: 20 })
})

test("does not emit the same warning repeatedly without a new progress epoch", () => {
  let now = 0
  const deadline = new ProgressDeadline({ now: () => now, warningMs: 10, terminalMs: 20 })
  now = 10
  expect(deadline.check().state).toBe("warning")
  now = 11
  expect(deadline.check().state).toBe("stale")
  now = 20
  expect(deadline.check().state).toBe("terminal")
})
