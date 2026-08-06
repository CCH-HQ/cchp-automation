import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireRunLease } from "./run-lock"

test("run lease fences concurrent writers and advances generation after stale takeover", () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-run-lock-"))
  const first = acquireRunLease(workdir, "run-1")
  expect(() => acquireRunLease(workdir, "run-1")).toThrow("already owned")
  first.assertOwned()
  first.release()
  const second = acquireRunLease(workdir, "run-1")
  expect(second.fence.generation).toBe(first.fence.generation + 1)
  expect(() => first.assertOwned()).toThrow("released")
  second.assertOwned()
  second.release()
})

test("run lease reclaims only a dead owner and rejects malformed lock state", () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-run-lock-stale-"))
  const first = acquireRunLease(workdir, "run-2")
  const lock = join(workdir, "ctx", "codex", "run.lock", "owner.json")
  const owner = JSON.parse(readFileSync(lock, "utf8")) as Record<string, unknown>
  owner.owner = { pid: 999_999_999, bootId: "dead", startTicks: "dead" }
  writeFileSync(lock, `${JSON.stringify(owner)}\n`)
  // Drop the kernel lease while preserving the intentionally drifted stale
  // owner directory so the next writer exercises the recovery path.
  first.release()
  const second = acquireRunLease(workdir, "run-2")
  expect(second.fence.generation).toBe(first.fence.generation + 1)
  expect(() => first.assertOwned()).toThrow("released")
  second.assertOwned()
  second.release()
})

test("concurrent stale reclaim elects exactly one live writer", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-run-lock-race-"))
  const first = acquireRunLease(workdir, "run-race")
  const ownerPath = join(workdir, "ctx", "codex", "run.lock", "owner.json")
  const stale = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>
  stale.owner = { pid: 999_999_999, bootId: "dead", startTicks: "dead" }
  writeFileSync(ownerPath, `${JSON.stringify(stale)}\n`)
  first.release()

  const moduleUrl = new URL("./run-lock.ts", import.meta.url).href
  const program = `
    import { acquireRunLease } from ${JSON.stringify(moduleUrl)};
    try {
      const lease = acquireRunLease(${JSON.stringify(workdir)}, "run-race");
      process.stdout.write(JSON.stringify({ ok: true, writerId: lease.fence.writerId, generation: lease.fence.generation }) + "\\n");
      await Bun.sleep(500);
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + "\\n");
    }
  `
  const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", program], { stdout: "pipe", stderr: "pipe" }))
  const outputs = await Promise.all(children.map(async (child) => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    return JSON.parse(stdout.trim()) as { ok: boolean; writerId?: string; generation?: number }
  }))
  expect(outputs.filter((output) => output.ok)).toHaveLength(1)
  expect(outputs.filter((output) => !output.ok)).toHaveLength(1)

  const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { writerId: string; generation: number }
  const fence = JSON.parse(readFileSync(join(workdir, "ctx", "codex", "run-fence.json"), "utf8")) as { writerId: string; generation: number }
  expect(owner).toMatchObject(fence)
  expect(owner.generation).toBe(first.fence.generation + 1)
})

test("run lease guard rejects a replaced global fence", () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-run-lock-fence-"))
  const lease = acquireRunLease(workdir, "run-fence")
  const fencePath = join(workdir, "ctx", "codex", "run-fence.json")
  const fence = JSON.parse(readFileSync(fencePath, "utf8")) as Record<string, unknown>
  fence.writerId = "replacement-writer"
  writeFileSync(fencePath, `${JSON.stringify(fence)}\n`)
  expect(() => lease.assertOwned()).toThrow("no longer owned")
  lease.release()
})
