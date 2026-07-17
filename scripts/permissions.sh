#!/usr/bin/env bash
# cchp-automation bot - OpenCode 任务权限装配(run.sh source 本文件)。

build_external_directory_permission() { # $1=workdir $2=task $3=pr_is_fork
  jq -nc --arg workdir "$1" --arg task "${2:-}" --arg fork "${3:-0}" '
    def restricted_fork_task:
      $fork == "1" and
      ($task == "pr_opened" or $task == "lgtm_merge" or $task == "engage");

    # --auto 会批准 ask；不可信 fork review/engage/merge 又持有 GitHub/模型凭据，
    # 因此外部目录 fail-closed，只开放可信路由预生成的 ctx 文件。
    if restricted_fork_task then
      { "*": "deny", ($workdir + "/ctx/*"): "allow" }
    else
      { "*": "ask", ($workdir + "/*"): "allow" }
    end
  '
}

build_opencode_permission() { # $1=workdir $2=can_write $3=task $4=pr_is_fork
  local external_directory
  external_directory="$(build_external_directory_permission \
    "$1" "${3:-}" "${4:-0}")" || return 1
  jq -nc --argjson external_directory "$external_directory" \
    --arg workdir "$1" --arg cw "${2:-0}" --arg task "${3:-}" --arg fork "${4:-0}" '
    def restricted_fork_task:
      $fork == "1" and
      ($task == "pr_opened" or $task == "lgtm_merge" or $task == "engage");

    { read: { "*": "allow", "*.env": "deny", "*.env.*": "deny" },
      external_directory: $external_directory }
    + (if restricted_fork_task then
         { edit: {
             "*": "deny",
             ($workdir + "/ctx/review/*"): "allow",
             ($workdir + "/ctx/reply.md"): "allow",
             "../ctx/review/*": "allow",
             "../ctx/reply.md": "allow"
           } }
       elif $task == "pr_opened" then
         # Ultra review ledgers live outside the clone. The coordinator may
         # persist evidence there, but no review task may edit repository files.
         { edit: {
             "*": "deny",
             ($workdir + "/ctx/review/*"): "allow",
             ($workdir + "/ctx/reply.md"): "allow",
             "../ctx/review/*": "allow",
             "../ctx/reply.md": "allow"
           } }
       elif $cw != "1" then
         { edit: "deny" }
       else {} end)
    + (if restricted_fork_task or $task == "pr_opened" then {
        bash: {
          "*": "deny",
          "cchp-review-meta *": "allow",
          "cchp-review-meta *>*": "deny",
          "cchp-review-meta *<*": "deny",
          "cchp-review-meta *|*": "deny",
          "cchp-review-meta *;*": "deny",
          "cchp-review-meta *&*": "deny",
          "cchp-review-meta *$(*": "deny",
          "cchp-review-meta *$*": "deny",
          "cchp-review-meta *`*": "deny",
          "cchp-review-meta *<(*": "deny",
          "cchp-review-meta *>(*": "deny",
          "cchp-review-meta *\n*": "deny"
        }
      } else {} end)
  '
}
