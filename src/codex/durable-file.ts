import { randomBytes } from "node:crypto"
import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { basename, dirname, join } from "node:path"

export interface DirectoryIdentity {
  dev: bigint
  ino: bigint
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

export function directoryIdentity(path: string): DirectoryIdentity {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(descriptor, { bigint: true })
    if (!stat.isDirectory()) throw new Error(`durable file parent is not a directory: ${path}`)
    return { dev: stat.dev, ino: stat.ino }
  } finally {
    closeSync(descriptor)
  }
}

export function durableWriteFile(path: string, content: string, mode = 0o600): void {
  const temporary = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, "wx", mode)
    const bytes = Buffer.from(content, "utf8")
    let offset = 0
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    const directory = openSync(dirname(path), "r")
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

/** Create a durable file without replacing an existing directory entry.
 *
 * The parent directory is opened once with O_NOFOLLOW and all subsequent
 * operations are resolved through that descriptor. This binds the final link
 * to the same directory inode even if an attacker renames a path component
 * while the file is being written. */
export function durableCreateFile(
  path: string,
  content: string,
  mode = 0o600,
  expectedDirectory?: DirectoryIdentity,
): void {
  const parent = dirname(path)
  const directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const procDirectory = `/proc/self/fd/${directory}`
  const temporaryName = `.${basename(path)}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`
  const temporary = join(procDirectory, temporaryName)
  const target = join(procDirectory, basename(path))
  let descriptor: number | undefined
  try {
    const stat = fstatSync(directory, { bigint: true })
    const actual = { dev: stat.dev, ino: stat.ino }
    if (!stat.isDirectory() || (expectedDirectory && !sameDirectory(expectedDirectory, actual))) {
      throw new Error(`durable file parent directory identity changed: ${parent}`)
    }
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    )
    const bytes = Buffer.from(content, "utf8")
    let offset = 0
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    linkSync(temporary, target)
    unlinkSync(temporary)
    fsyncSync(directory)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch {}
    throw error
  } finally {
    closeSync(directory)
  }
}
