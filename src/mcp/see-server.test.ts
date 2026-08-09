import { expect, test } from "bun:test"
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createSeeServer } from "./see-server"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cchp-see-mcp-"))
  const repoDir = join(root, "repo")
  const ctxDir = join(root, "work", "ctx")
  const keyFile = join(ctxDir, "see", "api-key")
  mkdirSync(repoDir, { recursive: true })
  mkdirSync(join(ctxDir, "see"), { recursive: true })
  writeFileSync(keyFile, "secret-key", { mode: 0o600 })
  const file = join(repoDir, "image.png")
  writeFileSync(file, "fixture")
  return { root, repoDir, ctxDir, keyFile, file }
}

test("uploads one validated file without exposing the SEE key in argv or parent env", async () => {
  const value = fixture()
  const calls: Array<{ argv: string[]; env: Record<string, string> }> = []
  const original = process.env.SEE_API_KEY
  delete process.env.SEE_API_KEY
  const created = createSeeServer({
    repoDir: value.repoDir,
    botWorkdir: join(value.root, "work"),
    keyFile: value.keyFile,
    seeBin: "/opt/see",
    env: { PATH: "/usr/bin" },
    run: async (argv, env) => {
      calls.push({ argv, env })
      const snapshot = argv[5]!
      expect(snapshot).not.toBe(value.file)
      expect(readFileSync(snapshot, "utf8")).toBe("fixture")
      expect(statSync(snapshot).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(snapshot)).mode & 0o777).toBe(0o700)
      return { exitCode: 0, stdout: '{"url":"https://s.ee/f/abc","page":"https://s.ee/abc","filename":"image.png","size":7}\n', stderr: "" }
    },
  })
  const result = await created.uploadFile(value.file, "proof.png", true)
  expect(result).toEqual({ url: "https://s.ee/f/abc", page: "https://s.ee/abc", filename: "image.png", size: 7 })
  expect(calls[0]!.argv.slice(0, 5)).toEqual(["/opt/see", "file", "upload", "--json", "--file"])
  expect(calls[0]!.argv.slice(6)).toEqual(["--name", "proof.png", "--private"])
  expect(existsSync(calls[0]!.argv[5]!)).toBe(false)
  expect(calls[0]!.argv.join(" ")).not.toContain("secret-key")
  expect(calls[0]!.env.SEE_API_KEY).toBe("secret-key")
  expect(process.env.SEE_API_KEY).toBeUndefined()
  if (original != null) process.env.SEE_API_KEY = original
})

test("keeps an in-memory SEE key out of the repository and run-context filesystem", async () => {
  const value = fixture()
  unlinkSync(value.keyFile)
  const calls: Array<Record<string, string>> = []
  const created = createSeeServer({
    repoDir: value.repoDir,
    botWorkdir: join(value.root, "work"),
    apiKey: "memory-only-key",
    seeBin: "/opt/see",
    env: { PATH: "/usr/bin" },
    run: async (_argv, env) => {
      calls.push(env)
      return { exitCode: 0, stdout: '{"url":"https://s.ee/f/memory"}', stderr: "" }
    },
  })
  await expect(created.uploadFile(value.file)).resolves.toMatchObject({ url: "https://s.ee/f/memory" })
  expect(calls[0]?.SEE_API_KEY).toBe("memory-only-key")
  expect(existsSync(value.keyFile)).toBe(false)
})

test("uses a capability-minimal environment when no explicit SEE environment is supplied", async () => {
  const value = fixture()
  const original = {
    PATH: process.env.PATH,
    CCHP_CODEX_BRIDGE_TOKEN: process.env.CCHP_CODEX_BRIDGE_TOKEN,
    CCHP_GITHUB_BROKER_TOKEN: process.env.CCHP_GITHUB_BROKER_TOKEN,
  }
  process.env.PATH = "/usr/bin"
  process.env.CCHP_CODEX_BRIDGE_TOKEN = "bridge-secret"
  process.env.CCHP_GITHUB_BROKER_TOKEN = "broker-secret"
  const calls: Array<Record<string, string>> = []
  try {
    const created = createSeeServer({
      repoDir: value.repoDir,
      botWorkdir: join(value.root, "work"),
      apiKey: "memory-only-key",
      seeBin: "/opt/see",
      run: async (_argv, env) => {
        calls.push(env)
        return { exitCode: 0, stdout: '{"url":"https://s.ee/f/minimal"}', stderr: "" }
      },
    })
    await created.uploadFile(value.file)
  } finally {
    for (const [name, valueToRestore] of Object.entries(original)) {
      if (valueToRestore == null) delete process.env[name]
      else process.env[name] = valueToRestore
    }
  }
  expect(calls[0]).not.toHaveProperty("CCHP_CODEX_BRIDGE_TOKEN")
  expect(calls[0]).not.toHaveProperty("CCHP_GITHUB_BROKER_TOKEN")
  expect(calls[0]?.HOME).toBe(join(value.root, "work", "ctx", "see", "home"))
  expect(calls[0]?.TMPDIR).toBe(join(value.root, "work", "ctx", "see", "tmp"))
})

test("rejects forbidden credential bytes from an otherwise allowed upload", async () => {
  const value = fixture()
  writeFileSync(value.file, "safe prefix\nembedded-secret\nsafe suffix")
  const created = createSeeServer({
    repoDir: value.repoDir,
    botWorkdir: join(value.root, "work"),
    apiKey: "memory-only-key",
    seeBin: "/opt/see",
    forbiddenValues: () => ["embedded-secret"],
    run: async () => { throw new Error("must not run") },
  })
  await expect(created.uploadFile(value.file)).rejects.toThrow("credential material")
})

test("rejects a run-scoped SEE binary whose content no longer matches provenance", async () => {
  const value = fixture()
  const seeBin = join(value.root, "work", "ctx", "tools", "see")
  mkdirSync(dirname(seeBin), { recursive: true })
  writeFileSync(seeBin, "tampered", { mode: 0o700 })
  const created = createSeeServer({
    repoDir: value.repoDir,
    botWorkdir: join(value.root, "work"),
    apiKey: "memory-only-key",
    seeBin,
    seeSha256: "ab".repeat(32),
    run: async () => { throw new Error("must not run an unverified SEE binary") },
  })
  await expect(created.uploadFile(value.file)).rejects.toThrow("provenance verification failed")
})

test("uploads an immutable private snapshot when the original pathname is replaced", async () => {
  const value = fixture()
  let snapshot = ""
  const created = createSeeServer({
    repoDir: value.repoDir,
    botWorkdir: join(value.root, "work"),
    keyFile: value.keyFile,
    seeBin: "/opt/see",
    run: async (argv) => {
      snapshot = argv[5]!
      unlinkSync(value.file)
      writeFileSync(value.file, "attacker replacement")
      expect(readFileSync(snapshot, "utf8")).toBe("fixture")
      return { exitCode: 0, stdout: '{"url":"https://s.ee/f/abc"}', stderr: "" }
    },
  })

  expect(await created.uploadFile(value.file)).toEqual({ url: "https://s.ee/f/abc", filename: "image.png" })
  expect(readFileSync(value.file, "utf8")).toBe("attacker replacement")
  expect(existsSync(snapshot)).toBe(false)
})

test("rejects paths outside the allowed roots, symlinks, key files, and oversized files", async () => {
  const value = fixture()
  const outside = join(value.root, "outside.txt")
  const link = join(value.repoDir, "link.txt")
  const large = join(value.repoDir, "large.bin")
  writeFileSync(outside, "outside")
  symlinkSync(outside, link)
  writeFileSync(large, "12345")
  const created = createSeeServer({
    repoDir: value.repoDir,
    botWorkdir: join(value.root, "work"),
    keyFile: value.keyFile,
    seeBin: "/opt/see",
    maxBytes: 4,
    run: async () => { throw new Error("must not run") },
  })
  await expect(created.uploadFile(outside)).rejects.toThrow("outside")
  await expect(created.uploadFile(link)).rejects.toThrow("regular non-symlink")
  await expect(created.uploadFile(value.keyFile)).rejects.toThrow("key file")
  await expect(created.uploadFile(large)).rejects.toThrow("exceeds 4 bytes")
})

test("rejects hard-linked uploads, including a hard link to the SEE key", async () => {
  const value = fixture()
  const ordinaryLink = join(value.repoDir, "ordinary-link.txt")
  linkSync(value.file, ordinaryLink)
  const created = createSeeServer({
    repoDir: value.repoDir,
    botWorkdir: join(value.root, "work"),
    keyFile: value.keyFile,
    seeBin: "/opt/see",
    run: async () => { throw new Error("must not run") },
  })
  await expect(created.uploadFile(ordinaryLink)).rejects.toThrow("hard-linked")

  unlinkSync(ordinaryLink)
  const keyLink = join(value.repoDir, "key-link")
  linkSync(value.keyFile, keyLink)
  await expect(created.uploadFile(keyLink)).rejects.toThrow("key file")
})

test("rejects unsafe key permissions and malformed SEE JSON output", async () => {
  const value = fixture()
  chmodSync(value.keyFile, 0o644)
  const unsafeKey = createSeeServer({
    repoDir: value.repoDir,
    botWorkdir: join(value.root, "work"),
    keyFile: value.keyFile,
    seeBin: "/opt/see",
    run: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
  })
  await expect(unsafeKey.uploadFile(value.file)).rejects.toThrow("group or world")
  chmodSync(value.keyFile, 0o600)
  for (const stdout of ["not-json", "{}", '{"url":"http://insecure.example"}']) {
    const malformed = createSeeServer({
      repoDir: value.repoDir,
      botWorkdir: join(value.root, "work"),
      keyFile: value.keyFile,
      seeBin: "/opt/see",
      run: async () => ({ exitCode: 0, stdout, stderr: "" }),
    })
    await expect(malformed.uploadFile(value.file)).rejects.toThrow(/malformed JSON|HTTPS URL/)
  }
})
