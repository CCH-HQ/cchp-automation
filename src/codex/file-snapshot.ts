import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export interface FileSnapshot {
  path: string
  bytes: Buffer
  sha256: string
  nlink: number
}

export interface FileSnapshotOptions {
  afterOpen?: (path: string, descriptor: number) => void
  allowPathReplacement?: boolean
}

function openBoundFile(path: string): { descriptor: number; parents: number[] } {
  if (process.platform !== "linux") {
    return { descriptor: openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), parents: [] }
  }
  const resolved = resolve(path)
  const parts = resolved.split("/").filter(Boolean)
  if (parts.length === 0) throw new Error(`not a regular file: ${path}`)
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  const parents: number[] = []
  let parent = openSync("/", directoryFlags)
  parents.push(parent)
  try {
    for (const part of parts.slice(0, -1)) {
      const child = openSync(`/proc/self/fd/${parent}/${part}`, directoryFlags)
      parents.push(child)
      parent = child
    }
    const descriptor = openSync(`/proc/self/fd/${parent}/${parts.at(-1)!}`, constants.O_RDONLY | constants.O_NOFOLLOW)
    return { descriptor, parents }
  } catch (error) {
    for (const descriptor of parents.reverse()) closeSync(descriptor)
    throw error
  }
}

/** Open once without following the final symlink, validate the descriptor, and
 * derive both semantic bytes and hash from that same immutable snapshot. */
export function openRegularFileSnapshot(path: string, options: FileSnapshotOptions = {}): FileSnapshot {
  const opened = openBoundFile(path)
  const descriptor = opened.descriptor
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile()) throw new Error(`not a regular file: ${path}`)
    options.afterOpen?.(path, descriptor)
    const bytes = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    let pathnameStillBound = false
    try {
      const currentPath = lstatSync(path)
      pathnameStillBound = currentPath.dev === before.dev && currentPath.ino === before.ino
    } catch {
      // Treat an unreadable path as replaced unless the caller explicitly opts
      // into consuming the already-open descriptor as an immutable snapshot.
    }
    if (!pathnameStillBound && !options.allowPathReplacement) {
      throw new Error(`file changed while snapshotting: ${path}`)
    }
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode ||
      before.nlink !== after.nlink
    ) {
      const contentMetadataChanged =
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.mode !== after.mode ||
        before.nlink !== after.nlink
      if (contentMetadataChanged || (pathnameStillBound && before.ctimeMs !== after.ctimeMs)) {
        throw new Error(`file changed while snapshotting: ${path}`)
      }
    }
    return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), nlink: after.nlink }
  } finally {
    closeSync(descriptor)
    for (const parent of opened.parents.reverse()) closeSync(parent)
  }
}
