// cchp-automation — plan-guard opencode plugin.
//
// 长实现任务里,planner 产出的计划全文落在 ${BOT_WORKDIR}/ctx/plan.md(克隆外,
// 永不入库)。上下文自动压缩(compaction)会丢弃早期消息 —— 本插件挂
// `experimental.session.compacting` 钩子,强制压缩摘要:①原样保留计划文件的
// 绝对路径;②把「先完整重读计划」钉为压缩后的第一条 Next Move。与
// system-prompt.md 的兜底规则(发现被压缩/对计划不确定 → 先全文重读)双保险。
// 设计见 docs/ci/cchp-bot-opencode.md §4。
import { existsSync } from "node:fs"

export const PlanGuard = async () => {
  const workdir = process.env["BOT_WORKDIR"]
  if (!workdir) return {}
  const planFile = `${workdir}/ctx/plan.md`
  return {
    "experimental.session.compacting": async (_input: unknown, output: { context: string[] }) => {
      if (!existsSync(planFile)) return
      output.context.push(
        `An approved implementation plan exists at ${planFile}. ` +
          `Your summary MUST preserve that exact absolute file path verbatim, and MUST list as the very first next step: ` +
          `"Re-read ${planFile} IN FULL with the read tool before doing anything else."`,
      )
    },
  }
}
