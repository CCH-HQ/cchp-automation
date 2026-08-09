import { expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  initializeCollaborationAdmission,
  sealCollaborationAdmission,
  withCollaborationAdmission,
} from "./collaboration-admission"

test("collaboration admission rejects mutations after a matching fence is sealed", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-collaboration-admission-"))
  const identity = { runId: "run", writerId: "writer", generation: 1 }
  initializeCollaborationAdmission(workdir, identity)
  expect(await withCollaborationAdmission(workdir, identity, () => "accepted")).toBe("accepted")
  sealCollaborationAdmission(workdir, identity)
  await expect(withCollaborationAdmission(workdir, identity, () => "late"))
    .rejects.toThrow("collaboration admission is sealed")
  await expect(withCollaborationAdmission(workdir, { ...identity, generation: 2 }, () => "drift"))
    .rejects.toThrow("identity drift")
})

test("sealing waits for an admitted mutation to publish its durable state", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-collaboration-lock-"))
  const identity = { runId: "run-lock", writerId: "writer-lock", generation: 1 }
  const enteredPath = join(workdir, "entered")
  initializeCollaborationAdmission(workdir, identity)
  const modulePath = join(import.meta.dir, "collaboration-admission.ts")
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", [
      `import { writeFileSync } from ${JSON.stringify("node:fs")}`,
      `import { withCollaborationAdmission } from ${JSON.stringify(modulePath)}`,
      `await withCollaborationAdmission(${JSON.stringify(workdir)}, ${JSON.stringify(identity)}, async () => {`,
      `  writeFileSync(${JSON.stringify(enteredPath)}, "entered")`,
      "  await Bun.sleep(120)",
      "})",
    ].join("\n")],
    stdout: "pipe",
    stderr: "pipe",
  })
  const deadline = Date.now() + 2_000
  while (!existsSync(enteredPath) && Date.now() < deadline) await Bun.sleep(5)
  expect(existsSync(enteredPath)).toBe(true)
  const started = Date.now()
  sealCollaborationAdmission(workdir, identity)
  expect(Date.now() - started).toBeGreaterThanOrEqual(50)
  expect(await child.exited).toBe(0)
  await expect(withCollaborationAdmission(workdir, identity, () => undefined))
    .rejects.toThrow("collaboration admission is sealed")
})
