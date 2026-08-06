import type { SupervisorState } from "./supervisor"

export function exitCodeFor(state: SupervisorState, codexExit = 0): number {
  if (state === "SUCCEEDED" && codexExit === 0) return 0
  if (state === "TIMED_OUT" || state === "NO_PROGRESS_TIMEOUT") return 124
  if (state === "CANCELLED") return 130
  if (state === "TOKEN_BUDGET_EXCEEDED") return 125
  if (state === "SUCCEEDED") return 1
  return codexExit === 0 ? 1 : codexExit
}
