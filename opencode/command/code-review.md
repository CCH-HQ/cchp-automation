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
minutes. Use the strongest configured agent, which is fixed to the `max`
reasoning variant.

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
read-only. Publish only independently verified findings: one inline comment per
unique root cause after `list_review_history` deduplication. Pass
`confirmed: true` and a stable lowercase SHA-256 root-cause fingerprint; the
server will reject publication until the trusted artifact finalizer passes and
the line is present in the current patch. Use one consolidated shell-safe top-level comment when no
diff line can anchor it. If nothing is confirmed, publish nothing.
