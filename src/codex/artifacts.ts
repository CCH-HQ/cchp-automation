import { realpathSync, renameSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export function assertArtifactWritePath(botWorkdir: string, requestedPath: string): string {
  const ctx = resolve(botWorkdir, "ctx")
  const review = resolve(ctx, "review")
  const reply = resolve(ctx, "reply.md")
  const candidate = resolve(requestedPath)

  if (candidate === review) throw new Error("artifact target must be a file, not the review directory")
  if (candidate !== reply && !inside(review, candidate)) {
    throw new Error(`artifact write is outside the allowed review/reply paths: ${candidate}`)
  }

  const allowedParent = candidate === reply ? realpathSync(ctx) : realpathSync(review)
  let actualParent: string
  try {
    actualParent = realpathSync(dirname(candidate))
  } catch {
    throw new Error(`artifact parent directory must already exist: ${dirname(candidate)}`)
  }
  if (candidate === reply ? actualParent !== allowedParent : actualParent !== allowedParent && !inside(allowedParent, actualParent)) {
    throw new Error(`artifact path escapes through a symlink: ${candidate}`)
  }
  return candidate
}

/** The planner has one fixed writable file outside the review bundle. */
export function assertPlanWritePath(botWorkdir: string, requestedPath: string): string {
  const ctx = resolve(botWorkdir, "ctx")
  const plan = resolve(ctx, "plan.md")
  const candidate = resolve(requestedPath)
  if (candidate !== plan) throw new Error(`plan write must target ${plan}`)
  let actualParent: string
  try {
    actualParent = realpathSync(dirname(candidate))
  } catch {
    throw new Error(`plan parent directory must already exist: ${dirname(candidate)}`)
  }
  if (actualParent !== realpathSync(ctx)) throw new Error(`plan path escapes through a symlink: ${candidate}`)
  return candidate
}

export class ArtifactStore {
  constructor(private readonly botWorkdir: string) {}

  writeReview(relativePath: string, content: string): string {
    const target = assertArtifactWritePath(
      this.botWorkdir,
      join(this.botWorkdir, "ctx", "review", relativePath),
    )
    this.atomicWrite(target, content)
    return target
  }

  writeReply(content: string): string {
    const target = assertArtifactWritePath(this.botWorkdir, join(this.botWorkdir, "ctx", "reply.md"))
    this.atomicWrite(target, content)
    return target
  }

  writePlan(content: string): string {
    const target = assertPlanWritePath(this.botWorkdir, join(this.botWorkdir, "ctx", "plan.md"))
    this.atomicWrite(target, content)
    return target
  }

  private atomicWrite(target: string, content: string): void {
    const temporary = `${target}.tmp`
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 })
    renameSync(temporary, target)
  }
}
