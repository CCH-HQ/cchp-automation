// Prevent review artifact writes from escaping the dedicated ctx/review root.
import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"

function candidatePath(tool: string, args: any): string | undefined {
  if (tool === "write" || tool === "edit" || tool === "patch") {
    return args?.filePath ?? args?.file_path ?? args?.path
  }
  return undefined
}

export const ReviewArtifactGuard = async () => {
  if (process.env.BOT_TASK !== "pr_opened") return {}
  const workdir = process.env.BOT_WORKDIR
  if (!workdir) throw new Error("BOT_WORKDIR is required for review artifact guarding")
  const allowedRoot = realpathSync(`${workdir}/ctx/review`)
  const allowedReply = resolve(workdir, "ctx/reply.md")
  return {
    "tool.execute.before": async (input: { tool: string }, output: { args: any }) => {
      const raw = candidatePath(input.tool, output.args)
      if (!raw) return
      const absolute = isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw)
      const parent = realpathSync(dirname(absolute))
      const canonical = existsSync(absolute)
        ? realpathSync(absolute)
        : resolve(parent, absolute.slice(dirname(absolute).length + 1))
      if (canonical === allowedReply) return
      const rel = relative(allowedRoot, canonical)
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`review artifact write denied outside ${allowedRoot}`)
      }
    },
  }
}
