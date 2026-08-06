#!/usr/bin/env bun
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js"

export const SEE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024

interface SeeUploadResult {
  url: string
  page?: string
  filename?: string
  size?: number
}

interface SeeServerOptions {
  repoDir: string
  botWorkdir: string
  keyFile: string
  seeBin: string
  maxBytes?: number
  env?: Record<string, string | undefined>
  run?: (argv: string[], env: Record<string, string>) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function bounded(value: string, limit = 64 * 1024): string {
  return value.length <= limit ? value : value.slice(value.length - limit)
}

interface PreparedUpload {
  key: string
  originalPath: string
  snapshotPath: string
  cleanup(): void
}

function readKey(path: string): { key: string; dev: bigint; ino: bigint } {
  let fd: number
  try {
    fd = openSync(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw new Error("SEE API key must be a regular non-symlink file")
  }
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile()) throw new Error("SEE API key must be a regular non-symlink file")
    if ((stat.mode & 0o077n) !== 0n) throw new Error("SEE API key file must not be group or world accessible")
    const key = readFileSync(fd, "utf8").trim()
    if (!key) throw new Error("SEE API key file is empty")
    return { key, dev: stat.dev, ino: stat.ino }
  } finally {
    closeSync(fd)
  }
}

function prepareUpload(path: string, options: SeeServerOptions): PreparedUpload {
  const requested = resolve(path)
  const keyPath = resolve(options.keyFile)
  if (requested === keyPath) throw new Error("SEE API key file cannot be uploaded")
  const link = lstatSync(requested)
  if (link.isSymbolicLink() || !link.isFile()) throw new Error("SEE upload path must be a regular non-symlink file")
  const real = realpathSync(requested)
  if (real === realpathSync(keyPath)) throw new Error("SEE API key file cannot be uploaded")
  const repoRoot = realpathSync(options.repoDir)
  const ctxRoot = realpathSync(resolve(options.botWorkdir, "ctx"))
  if (!inside(real, repoRoot) && !inside(real, ctxRoot)) throw new Error("SEE upload path is outside the repository and run context")

  let fd: number
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw new Error("SEE upload path must be a regular non-symlink file")
  }
  let stageDir: string | undefined
  try {
    const source = fstatSync(fd, { bigint: true })
    if (!source.isFile()) throw new Error("SEE upload path must be a regular non-symlink file")

    // Bind containment to the opened inode, including parent-directory replacement races.
    const openedPath = realpathSync(`/proc/self/fd/${fd}`)
    if (!inside(openedPath, repoRoot) && !inside(openedPath, ctxRoot)) {
      throw new Error("SEE upload path is outside the repository and run context")
    }

    const key = readKey(keyPath)
    if (source.dev === key.dev && source.ino === key.ino) throw new Error("SEE API key file cannot be uploaded")
    if (source.nlink !== 1n) throw new Error("SEE upload path must not be a hard-linked file")
    const maxBytes = options.maxBytes ?? SEE_MAX_UPLOAD_BYTES
    if (source.size > BigInt(maxBytes)) throw new Error(`SEE upload exceeds ${maxBytes} bytes`)
    const bytes = readFileSync(fd)
    if (bytes.byteLength > maxBytes) throw new Error(`SEE upload exceeds ${maxBytes} bytes`)

    const stagingRoot = resolve(options.botWorkdir, "ctx", "see", "staging")
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 })
    if (lstatSync(stagingRoot).isSymbolicLink()) throw new Error("SEE staging directory must not be a symlink")
    chmodSync(stagingRoot, 0o700)
    stageDir = mkdtempSync(join(stagingRoot, "upload-"))
    chmodSync(stageDir, 0o700)
    const snapshotPath = join(stageDir, basename(real))
    writeFileSync(snapshotPath, bytes, { flag: "wx", mode: 0o600 })
    return {
      key: key.key,
      originalPath: real,
      snapshotPath,
      cleanup: () => rmSync(stageDir!, { recursive: true, force: true }),
    }
  } catch (error) {
    if (stageDir) rmSync(stageDir, { recursive: true, force: true })
    throw error
  } finally {
    closeSync(fd)
  }
}

async function runSee(argv: string[], env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout: bounded(stdout), stderr: bounded(stderr) }
}

function parseResult(stdout: string, path: string): SeeUploadResult {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error("SEE CLI returned malformed JSON")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SEE CLI returned an invalid JSON object")
  const record = value as Record<string, unknown>
  if (typeof record.url !== "string" || !/^https:\/\//.test(record.url)) throw new Error("SEE CLI response has no HTTPS URL")
  if (record.page != null && (typeof record.page !== "string" || !/^https:\/\//.test(record.page))) throw new Error("SEE CLI response has an invalid page URL")
  return {
    url: record.url,
    ...(typeof record.page === "string" ? { page: record.page } : {}),
    filename: typeof record.filename === "string" && record.filename ? record.filename : basename(path),
    ...(typeof record.size === "number" && Number.isSafeInteger(record.size) && record.size >= 0 ? { size: record.size } : {}),
  }
}

export function createSeeServer(options: SeeServerOptions): { server: Server; tools: Tool[]; uploadFile(path: string, name?: string, isPrivate?: boolean): Promise<SeeUploadResult> } {
  const tools: Tool[] = [{
    name: "upload_file",
    description: "Upload one validated repository or run-context file to S.EE.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        name: { type: "string", minLength: 1, maxLength: 255 },
        is_private: { type: "boolean" },
      },
      required: ["path"],
    },
  }]
  const uploadFile = async (path: string, name?: string, isPrivate = false): Promise<SeeUploadResult> => {
    if (!path.trim()) throw new Error("path must be a non-empty string")
    if (name != null && (!name.trim() || name.includes("/") || name.includes("\\"))) throw new Error("name must be a plain filename")
    const prepared = prepareUpload(path, options)
    try {
      const argv = [options.seeBin, "file", "upload", "--json", "--file", prepared.snapshotPath]
      if (name) argv.push("--name", name)
      if (isPrivate) argv.push("--private")
      const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      env.SEE_API_KEY = prepared.key
      const result = await (options.run ?? runSee)(argv, env)
      if (result.exitCode !== 0) {
        const stderr = bounded(result.stderr).replaceAll(prepared.key, "[REDACTED]").trim()
        throw new Error(`SEE CLI failed with exit ${result.exitCode}: ${stderr || "unknown error"}`)
      }
      return parseResult(result.stdout, prepared.originalPath)
    } finally {
      prepared.cleanup()
    }
  }
  const server = new Server({ name: "see_upload", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    try {
      if (request.params.name !== "upload_file") throw new Error(`unknown tool: ${request.params.name}`)
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      const result = await uploadFile(String(args.path ?? ""), typeof args.name === "string" ? args.name : undefined, args.is_private === true)
      return { content: [{ type: "text", text: JSON.stringify(result) }] }
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `error: ${error instanceof Error ? error.message : String(error)}` }] }
    }
  })
  return { server, tools, uploadFile }
}

async function main(): Promise<void> {
  const botWorkdir = process.env.BOT_WORKDIR
  const repoDir = process.env.REPO_DIR
  if (!botWorkdir || !repoDir) throw new Error("BOT_WORKDIR and REPO_DIR are required")
  const created = createSeeServer({
    repoDir,
    botWorkdir,
    keyFile: process.env.SEE_API_KEY_FILE ?? resolve(botWorkdir, "ctx", "see", "api-key"),
    seeBin: process.env.SEE_CLI_BIN ?? resolve(process.env.HOME ?? "", ".local", "lib", "see-cli", "see"),
  })
  await created.server.connect(new StdioServerTransport())
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`[see-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
