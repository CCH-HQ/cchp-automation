import type { Task } from "../types"
import type { CodexSandboxMode } from "./config"

const WORKSPACE_TASKS = new Set<Task>([
  "engage",
  "lgtm_merge",
  "ci_fix",
  "reaction_execute",
  "manual",
  "dispatch",
])

export interface TaskPermissionInput {
  task: Task
  canWrite: boolean
  isFork: boolean
}

export interface TaskPermissionProfile {
  task: Task
  sandboxMode: CodexSandboxMode
  approvalPolicy: "never"
  allowRepositoryMutation: boolean
  hasWriteToken: boolean
  allowShell: boolean
  reviewOnly: boolean
}

export function permissionForTask(input: TaskPermissionInput): TaskPermissionProfile {
  const trustedWrite = input.canWrite && !input.isFork
  const allowRepositoryMutation = trustedWrite && WORKSPACE_TASKS.has(input.task)
  const reviewOnly = input.task === "pr_opened"
  return {
    task: input.task,
    sandboxMode: allowRepositoryMutation ? "workspace-write" : "read-only",
    approvalPolicy: "never",
    allowRepositoryMutation,
    hasWriteToken: trustedWrite,
    // Fork and review-only tasks never receive a generic shell surface.
    allowShell: allowRepositoryMutation,
    reviewOnly,
  }
}
