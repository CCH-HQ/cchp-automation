#!/usr/bin/env bash
# cchp-automation bot - 受限 PR 任务允许的窄化 GitHub metadata 写操作。
set -euo pipefail

die() {
  printf 'cchp-review-meta: %s\n' "$*" >&2
  exit 2
}

require_count() {
  local want="$1" got="$2"
  [[ "${got}" -eq "${want}" ]] || die "expected ${want} argument(s), got ${got}"
}

require_number() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] || die "invalid number"
}

require_node_id() {
  [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid node id"
}

require_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || die "invalid commit sha"
}

require_current_pr() {
  require_number "${BOT_PR_NUMBER:-}"
}

require_roadmap_project() {
  require_number "${BOT_ROADMAP_PROJECT:-}"
}

require_text() {
  local value="$1" max="$2" label="$3" forbidden
  [[ -n "${value}" && "${#value}" -le "${max}" ]] || die "invalid ${label} length"
  [[ "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] || die "${label} must be one line"
  for forbidden in '<' '>' '|' ';' '&' '$' '`' '\'; do
    [[ "${value}" != *"${forbidden}"* ]] || die "${label} contains a forbidden shell character"
  done
}

require_review_finalized() {
  [[ "${BOT_TASK:-}" == "pr_opened" ]] || die "review publication is only valid for pr_opened"
  : "${BOT_WORKDIR:?}" "${CCHP_REVIEW_FINALIZER:?}" "${CCHP_TRUSTED_REVIEW_MANIFEST:?}"
  "${CCHP_REVIEW_FINALIZER}" \
    "${BOT_WORKDIR}/ctx/review" \
    "${CCHP_TRUSTED_REVIEW_MANIFEST}" \
    "${BOT_WORKDIR}/ctx/review-finalized.json" >/dev/null \
    || die "Ultra review artifacts did not pass finalization"
}

repo="${BOT_REPO:-${GH_REPO:-}}"
[[ "${repo}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "BOT_REPO/GH_REPO is invalid"
owner="${repo%%/*}"
gh_bin="gh"

op="${1:-}"
[[ -n "${op}" ]] || die "missing operation"
shift

# Fork pr_opened、fork lgtm_merge 与 fork engage 内容完全不可信。受限模式只能
# 触达当前 BOT_PR_NUMBER；roadmap、milestone、任意 issue/tag/project 留给正常任务。
if [[ "${BOT_PR_IS_FORK:-0}" == "1" ]] && \
   { [[ "${BOT_TASK:-}" == "pr_opened" ]] || \
     [[ "${BOT_TASK:-}" == "lgtm_merge" ]] || \
     [[ "${BOT_TASK:-}" == "engage" ]]; }; then
  if [[ "${BOT_TASK:-}" == "lgtm_merge" ]]; then
    case "${op}" in
      pr-comment|pr-comment-file|pr-review-comment-file|pr-lgtm-label|pr-merge) ;;
      *) die "operation ${op} is not allowed for fork PR merge" ;;
    esac
  else
    case "${op}" in
      pr-title|pr-title-note|pr-comment|pr-comment-file|pr-review-comment-file|pr-close|pr-lock|pr-triage-label) ;;
      *) die "operation ${op} is not allowed for restricted fork PR tasks" ;;
    esac
  fi
fi

case "${op}" in
  pr-title)
    require_count 1 "$#"
    require_current_pr
    require_text "$1" 256 title
    exec "${gh_bin}" pr edit "${BOT_PR_NUMBER}" --repo "${repo}" --title "$1"
    ;;
  pr-title-note)
    require_count 0 "$#"
    require_current_pr
    exec "${gh_bin}" pr comment "${BOT_PR_NUMBER}" --repo "${repo}" \
      --body "Title normalized to match the conventional-commit rule."
    ;;
  issue-title)
    require_count 2 "$#"
    require_number "$1"
    require_text "$2" 256 title
    exec "${gh_bin}" issue edit "$1" --repo "${repo}" --title "$2"
    ;;
  pr-comment)
    [[ "${BOT_TASK:-}" != "pr_opened" ]] || die "pr_opened findings must use pr-review-comment-file"
    require_count 1 "$#"
    require_current_pr
    require_text "$1" 4096 comment
    exec "${gh_bin}" pr comment "${BOT_PR_NUMBER}" --repo "${repo}" --body "$1"
    ;;
  pr-comment-file)
    [[ "${BOT_TASK:-}" != "pr_opened" ]] || die "pr_opened findings must use pr-review-comment-file"
    require_count 0 "$#"
    require_current_pr
    reply_file="${BOT_WORKDIR:?}/ctx/reply.md"
    [[ -f "${reply_file}" && ! -L "${reply_file}" ]] || die "reply file is missing or invalid"
    reply_size="$(wc -c < "${reply_file}")"
    [[ "${reply_size}" =~ ^[0-9]+$ && "${reply_size}" -ge 1 && "${reply_size}" -le 65536 ]] \
      || die "reply file size must be 1..65536 bytes"
    exec "${gh_bin}" pr comment "${BOT_PR_NUMBER}" --repo "${repo}" --body-file "${reply_file}"
    ;;
  pr-review-comment-file)
    require_count 1 "$#"
    require_current_pr
    [[ "$1" =~ ^[0-9a-f]{64}$ ]] || die "review fingerprint must be lowercase SHA-256 hex"
    require_review_finalized
    reply_file="${BOT_WORKDIR:?}/ctx/reply.md"
    [[ -f "${reply_file}" && ! -L "${reply_file}" ]] || die "reply file is missing or invalid"
    reply_size="$(wc -c < "${reply_file}")"
    [[ "${reply_size}" =~ ^[0-9]+$ && "${reply_size}" -ge 1 && "${reply_size}" -le 65000 ]] \
      || die "reply file size must be 1..65000 bytes"
    marker="<!-- cchp-review-fingerprint:$1 -->"
    if "${gh_bin}" api --paginate "repos/${repo}/issues/${BOT_PR_NUMBER}/comments" \
        --jq '.[].body // empty' | grep -Fqx -- "${marker}"; then
      printf 'already-posted: %s\n' "$1"
      exit 0
    fi
    if grep -Eq '<!-- cchp-review-fingerprint:[0-9a-f]{64} -->' "${reply_file}"; then
      die "reply file must not contain a caller-supplied review fingerprint marker"
    fi
    publish_file="${BOT_WORKDIR}/ctx/review-comment-publish.md"
    { cat "${reply_file}"; printf '\n\n%s\n' "${marker}"; } > "${publish_file}"
    exec "${gh_bin}" pr comment "${BOT_PR_NUMBER}" --repo "${repo}" --body-file "${publish_file}"
    ;;
  pr-close)
    require_count 1 "$#"
    require_current_pr
    require_text "$1" 512 reason
    exec "${gh_bin}" pr close "${BOT_PR_NUMBER}" --repo "${repo}" --comment "$1"
    ;;
  pr-lock)
    require_count 1 "$#"
    require_current_pr
    case "$1" in
      spam|off_topic|resolved|too_heated) ;;
      *) die "invalid lock reason" ;;
    esac
    exec "${gh_bin}" issue lock "${BOT_PR_NUMBER}" --repo "${repo}" --reason "$1"
    ;;
  pr-triage-label)
    require_count 1 "$#"
    require_current_pr
    case "$1" in
      spam) color=b60205 ;;
      invalid) color=e4e669 ;;
      *) die "invalid triage label" ;;
    esac
    if ! "${gh_bin}" label view "$1" --repo "${repo}" >/dev/null 2>&1; then
      "${gh_bin}" label create "$1" --repo "${repo}" --color "${color}" --force
    fi
    exec "${gh_bin}" pr edit "${BOT_PR_NUMBER}" --repo "${repo}" --add-label "$1"
    ;;
  pr-lgtm-label)
    require_count 0 "$#"
    require_current_pr
    if ! "${gh_bin}" label view LGTM --repo "${repo}" >/dev/null 2>&1; then
      "${gh_bin}" label create LGTM --repo "${repo}" --color 0e8a16 --force
    fi
    exec "${gh_bin}" pr edit "${BOT_PR_NUMBER}" --repo "${repo}" --add-label LGTM
    ;;
  pr-merge)
    require_count 0 "$#"
    require_current_pr
    require_sha "${BOT_HEAD_SHA:-}"
    exec "${gh_bin}" pr merge "${BOT_PR_NUMBER}" --repo "${repo}" --squash \
      --match-head-commit "${BOT_HEAD_SHA}"
    ;;
  pr-label)
    require_count 1 "$#"
    require_current_pr
    require_text "$1" 50 label
    exec "${gh_bin}" pr edit "${BOT_PR_NUMBER}" --repo "${repo}" --add-label "$1"
    ;;
  label-create)
    require_count 2 "$#"
    require_text "$1" 50 label
    [[ "$1" != -* ]] || die "label must not start with '-'"
    [[ "$2" =~ ^[0-9A-Fa-f]{6}$ ]] || die "invalid label color"
    exec "${gh_bin}" label create "$1" --repo "${repo}" --color "$2"
    ;;
  milestone-list)
    require_count 0 "$#"
    exec "${gh_bin}" api "repos/${repo}/milestones?state=all" --paginate \
      --jq '.[] | {number, title, state}'
    ;;
  tag-list)
    require_count 0 "$#"
    exec "${gh_bin}" api "repos/${repo}/tags" --paginate --jq '.[].name'
    ;;
  milestone-create)
    require_count 1 "$#"
    [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid milestone title"
    exec "${gh_bin}" api --method POST "repos/${repo}/milestones" -f "title=$1"
    ;;
  issue-milestone|pr-milestone)
    require_count 2 "$#"
    require_number "$1"
    [[ "$2" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid milestone title"
    kind="${op%%-*}"
    exec "${gh_bin}" "${kind}" edit "$1" --repo "${repo}" --milestone "$2"
    ;;
  project-item-add)
    require_count 1 "$#"
    require_roadmap_project
    case "$1" in
      "https://github.com/${repo}/issues/"*|"https://github.com/${repo}/pull/"*) ;;
      *) die "project item URL must belong to this repository" ;;
    esac
    require_number "${1##*/}"
    exec "${gh_bin}" project item-add "${BOT_ROADMAP_PROJECT}" --owner "${owner}" \
      --url "$1" --format json --jq .id
    ;;
  project-item-status)
    require_count 3 "$#"
    require_roadmap_project
    require_node_id "$1"
    require_node_id "$2"
    require_node_id "$3"
    project_id="$("${gh_bin}" project view "${BOT_ROADMAP_PROJECT}" --owner "${owner}" --format json --jq .id)"
    require_node_id "${project_id}"
    exec "${gh_bin}" project item-edit --project-id "${project_id}" --id "$1" \
      --field-id "$2" --single-select-option-id "$3"
    ;;
  project-item-archive)
    require_count 1 "$#"
    require_roadmap_project
    require_node_id "$1"
    exec "${gh_bin}" project item-archive "${BOT_ROADMAP_PROJECT}" --owner "${owner}" --id "$1"
    ;;
  project-view)
    require_count 0 "$#"
    require_roadmap_project
    exec "${gh_bin}" project view "${BOT_ROADMAP_PROJECT}" --owner "${owner}" --format json
    ;;
  project-fields)
    require_count 0 "$#"
    require_roadmap_project
    exec "${gh_bin}" project field-list "${BOT_ROADMAP_PROJECT}" --owner "${owner}" --format json
    ;;
  project-items)
    require_count 0 "$#"
    require_roadmap_project
    exec "${gh_bin}" project item-list "${BOT_ROADMAP_PROJECT}" --owner "${owner}" \
      --limit 1000 --format json
    ;;
  *)
    die "unsupported operation"
    ;;
esac
