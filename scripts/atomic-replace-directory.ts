#!/usr/bin/env bun
import { dlopen, FFIType, ptr } from "bun:ffi"
import { dirname, resolve } from "node:path"
import { existsSync, lstatSync, renameSync, rmSync } from "node:fs"

const source = resolve(process.argv[2] ?? "")
const target = resolve(process.argv[3] ?? "")
if (!process.argv[2] || !process.argv[3]) throw new Error("source and target directories are required")
if (source === target || dirname(source) !== dirname(target)) {
  throw new Error("atomic directory replacement requires distinct paths in one parent directory")
}
const sourceStat = lstatSync(source)
if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("source must be a real directory")

if (!existsSync(target)) {
  renameSync(source, target)
  process.exit(0)
}
const targetStat = lstatSync(target)
if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error("target must be a real directory")
if (process.env.CCHP_ATOMIC_REPLACE_FAIL_BEFORE_EXCHANGE === "1") {
  throw new Error("injected failure before atomic exchange")
}

const libc = dlopen("libc.so.6", {
  renameat2: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
})
try {
  const AT_FDCWD = -100
  const RENAME_EXCHANGE = 2
  const sourcePath = Buffer.from(`${source}\0`)
  const targetPath = Buffer.from(`${target}\0`)
  const result = libc.symbols.renameat2(AT_FDCWD, ptr(sourcePath), AT_FDCWD, ptr(targetPath), RENAME_EXCHANGE)
  if (result !== 0) {
    throw new Error("renameat2(RENAME_EXCHANGE) failed; preserving the existing target")
  }
} finally {
  libc.close()
}

// After the exchange, target is already the new validated tree. A cleanup
// failure can leave only the old tree under the hidden staging name.
try {
  rmSync(source, { recursive: true, force: true })
} catch (error) {
  process.stderr.write(`[skills][warn] could not remove exchanged previous directory ${source}: ${String(error)}\n`)
}
