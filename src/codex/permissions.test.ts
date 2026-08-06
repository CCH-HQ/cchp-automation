import { expect, test } from "bun:test"
import { TASKS } from "../types"
import { permissionForTask } from "./permissions"

test("defines a fail-closed Codex permission profile for every frozen task", () => {
  const profiles = Object.fromEntries(
    TASKS.map((task) => [task, permissionForTask({ task, canWrite: true, isFork: false })]),
  )
  expect(Object.keys(profiles)).toEqual([...TASKS])
  expect(
    Object.entries(profiles)
      .filter(([, profile]) => profile.sandboxMode === "workspace-write")
      .map(([task]) => task),
  ).toEqual(["engage", "lgtm_merge", "ci_fix", "reaction_execute", "manual", "dispatch"])
  expect(profiles.pr_opened).toMatchObject({
    sandboxMode: "read-only",
    allowRepositoryMutation: false,
    approvalPolicy: "never",
  })
  expect(profiles.lgtm_merge).toMatchObject({
    sandboxMode: "workspace-write",
    allowRepositoryMutation: true,
    allowShell: true,
    hasWriteToken: true,
  })
  expect(profiles.release_notes.sandboxMode).toBe("read-only")
})

test("fork or BOT_CAN_WRITE=0 always removes repository mutation and workspace writes", () => {
  for (const task of TASKS) {
    expect(permissionForTask({ task, canWrite: true, isFork: true })).toMatchObject({
      sandboxMode: "read-only",
      allowRepositoryMutation: false,
      allowShell: false,
    })
    expect(permissionForTask({ task, canWrite: false, isFork: false })).toMatchObject({
      sandboxMode: "read-only",
      allowRepositoryMutation: false,
      allowShell: false,
    })
  }
})
