#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/repo/scripts" "$test_root/repo/skills" "$test_root/bin"
cp "$ROOT/scripts/skills-lib.sh" "$ROOT/scripts/refresh-skills-backup.sh" "$test_root/repo/scripts/"
cat > "$test_root/repo/skills/manifest.json" <<'JSON'
{"schemaVersion":1,"sources":[{"id":"fixture","url":"https://github.com/example/skills/tree/main/skills/live","timeoutSeconds":5}]}
JSON
cat > "$test_root/bin/bunx" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${FAIL_SKILLS:-0}" != "1" ]] || exit 23
mkdir -p .agents/skills/live
printf '%s\n' '# live' > .agents/skills/live/SKILL.md
cat > skills-lock.json <<'JSON'
{"version":1,"skills":{"live":{"source":"example/skills","ref":"main","sourceType":"github","skillPath":"skills/live/SKILL.md","computedHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}
JSON
SH
cat > "$test_root/bin/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == "ls-remote" ]] || exit 2
printf '%s\t%s\n' '1111111111111111111111111111111111111111' "${3:-HEAD}"
SH
chmod +x "$test_root/bin/bunx" "$test_root/bin/git"

PATH="$test_root/bin:/usr/bin:/bin" TMPDIR="$test_root" bash "$test_root/repo/scripts/refresh-skills-backup.sh"
[[ -f "$test_root/repo/skills-backup/skills/live/SKILL.md" ]] || { echo 'refreshed skill missing' >&2; exit 1; }
jq -e '.sourceCount == 1 and .installFailures == 0 and (.skills.live.contentHash | test("^[0-9a-f]{64}$"))' \
  "$test_root/repo/skills-backup/manifest.json" >/dev/null
before="$(sha256sum "$test_root/repo/skills-backup/manifest.json")"
if PATH="$test_root/bin:/usr/bin:/bin" TMPDIR="$test_root" FAIL_SKILLS=1 bash "$test_root/repo/scripts/refresh-skills-backup.sh"; then
  echo 'partial refresh unexpectedly succeeded' >&2
  exit 1
fi
after="$(sha256sum "$test_root/repo/skills-backup/manifest.json")"
[[ "$before" == "$after" ]] || { echo 'failed refresh mutated previous backup' >&2; exit 1; }

cat > "$test_root/repo/skills/manifest.json" <<'JSON'
{"schemaVersion":1,"sources":[
  {"id":"fixture","url":"https://github.com/example/skills/tree/main/skills/live","timeoutSeconds":5},
  {"id":"INVALID","url":"https://github.com/example/other","timeoutSeconds":5}
]}
JSON
if PATH="$test_root/bin:/usr/bin:/bin" TMPDIR="$test_root" bash "$test_root/repo/scripts/refresh-skills-backup.sh"; then
  echo 'mixed valid/invalid refresh manifest unexpectedly succeeded' >&2
  exit 1
fi
after_invalid="$(sha256sum "$test_root/repo/skills-backup/manifest.json")"
[[ "$before" == "$after_invalid" ]] || { echo 'invalid manifest mutated previous backup' >&2; exit 1; }
printf 'skills backup refresh tests passed\n'
