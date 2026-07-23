Run the Ultra Code Review Protocol for the current PR. Optional focus: $ARGUMENTS

The complete protocol is injected automatically for `pr_opened` from:
`.github/cchp-bot/opencode/review/ultra-protocol.md`.

This command is an independent adversarial second pass. It must not reuse the
primary review's candidate conclusions as evidence. Resolve the literal PR
number from TASK, read the complete current diff and applicable repository
policy, and build your own coverage entries.

If `$BOT_WORKDIR/ctx/external/status.json` and
`$BOT_WORKDIR/ctx/external/findings.json` exist (trusted pre-run CodeQL /
Semgrep output), Read both and ingest each external finding as one
UNVERIFIED candidate in the same verification pipeline, with the tool name
as provenance. External scanner output never defines the review scope, never
counts as completion evidence; a skipped or failed scanner does not block
this pass — disclose it in the summary.

Use `ultra_review_task` for every independent finder, verifier, refuter,
reproducer, discourse, and completeness task. Submit batches of independent
tasks; the runner admits up to 10 in parallel and hard-aborts each after 30
minutes. These leaf reviewers are read-only and therefore use the `low`
reasoning variant under the capability-based policy.

At minimum, run fresh passes for correctness/edge cases, security/trust
boundaries, contracts/schema/compatibility, concurrency/failure/lifecycle,
data integrity/migrations, performance/resource lifetime, tests/regressions,
and repository conventions. Add domain passes for billing, quota, authz,
routing, streaming, frontend, or deployment changes.

For each candidate, personally re-open the source, attempt an adversarial
refutation, and compare base and head when a safe disposable reproduction is
possible. Drop speculative, stylistic, duplicate, pre-existing, and
unreproducible claims. Keep realistic unresolved risks in the ledger rather
than silently discarding them.

Write review evidence only below `$BOT_WORKDIR/ctx/review/`. The clone remains
read-only. Publish only independently verified findings: one inline comment
per unique root cause, in ONE `post_inline_review` batch with a stable
root-cause `fingerprint` key (the server hashes it and skips already-posted
fingerprints; items returned under `rejected` reroute to the review summary
sticky). Before publishing, dedup against other reviewers via
`list_review_threads` — an already-reported root cause gets no new inline
comment, and duplicate threads for one root cause are resolved down to the
single best via `resolve_review_thread`. The server validates every anchor
against the current trusted patch. Use one consolidated shell-safe top-level
comment when no diff line can anchor it. Keep the sticky review status
comment (`sticky_key: "review"`) current from start to final summary; if
nothing is confirmed, say so there and add the `+1` reaction on the PR.
