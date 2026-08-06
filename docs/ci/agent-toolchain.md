# Codex agent toolchain and runtime contract

This repository runs only Codex CLI. The production workflow installs and
audits the following engine-owned pin:

| Field | Value |
| --- | --- |
| npm package | `@openai/codex` |
| version | `0.146.0` |
| source tag | `rust-v0.146.0` |
| source commit | `e363b08c9175ac1cbe5893615dd2cb9ddf95043b` |
| wrapper tarball SHA-256 | `8050af14387e23b8d46026f023f0c1d33a2eefb39267bf36abe8cec2cec17b49` |
| Linux x64 native tarball SHA-512 | `7ecc2fc86a6b00f08c88e12e7bfecc28c93ba428e1f6464825f257e62f5ab667e798661b602714859b041fd2c43f4fb4b79c723ea0db7cd5d8ecd4b1215b97c4` |
| Linux arm64 native tarball SHA-512 | `aa2603c649041675c6ee3a1a7495ba43e5dc8320d70a919da5af6793f73e8b4804a26babd63edb1efc75d8d7d658217fcbc4eaae2e9acbe14bb82d8c8dd7a1b4` |

`scripts/install-codex.sh` owns this pin. It verifies both the npm wrapper and
the platform-native package, extracts them into the engine-owned
`$BOT_WORKDIR/codex-install/npm` prefix, checks the exact
`codex-cli 0.146.0` version, and exports the verified absolute `CODEX_BIN` path.
It never selects a pre-existing PATH binary. Caller inputs, secrets, and
variables cannot override it. Production supports the workflow's Linux x64
target and a pinned Linux arm64 target; every other OS/architecture fails
closed before download.

## Runtime topology

```text
reusable workflow
  -> prepare isolated repository and CODEX_HOME
  -> install latest skills from skills/manifest.json
     -> fill only missing skills from the validated skills-backup/ mirror
  -> start supervisor-owned provider and GitHub brokers
  -> start Codex app-server
     -> native multi-agent v2 when the pinned capability gate passes
        -> root keeps v2; every role config disables agents and v2 before child session creation
     -> explicit codex exec --json children when the gate fails
  -> persist graph, usage, TODO, provenance, and run manifest ledgers
  -> finalize and publish only after trusted attestation
```

The provider bridge maps the existing Responses, Chat-compatible, and Anthropic
provider definitions to Codex's Responses wire contract. The caller's provider
JSON and provider-key JSON formats are unchanged. Raw caller credentials are not
written to `config.toml` and are excluded from Codex, explicit children, fff, and
Serena child-process environments.

Native leaf isolation is enforced by generated role TOML, not by prompt text.
Each child role sets `[agents].enabled = false`, `[features].multi_agent = false`,
and `[features.multi_agent_v2].enabled = false`. Codex applies that role layer
before resolving the spawned session, so the root remains V2 while every child
is created with `multi_agent_version = disabled`. Internal leaf model aliases
only preserve the caller's existing main/small provider mapping; they are not
the capability boundary.

## Deadlines and recovery

- The reusable job timeout is 720 minutes.
- `run-codex.sh` defaults the supervisor process timeout to 42,690 seconds,
  leaving the supervisor's 11h50m deadline time for cleanup and durable fsync.
- A non-timeout runtime crash may restart once only when the durable manifest
  proves ownership of the same nonterminal root thread and run id.
- An app-server crash may restart once inside the supervisor and must resume the
  same thread with `thread/resume`; it never starts a second root turn.
- Runtime or app-server restart budget exhaustion is terminal `LOST`.
- Graph edges, provider usage, TODO revisions, and provenance sequences replay
  from JSONL/JSON state and remain idempotent across process restart.

## Skills

`skills/manifest.json` is the single source list for runtime install and the
scheduled backup workflow. Each source installs latest non-interactively with
telemetry disabled and a bounded timeout. A source failure does not block the
bot run; fallback restores only missing skills whose directory, `SKILL.md`,
symlink policy, and content hash match `skills-backup/manifest.json`.

The scheduled refresh is fail-closed: every source must succeed before the old
complete backup is atomically replaced.

## Local verification

```bash
TMPDIR=/tmp/cchp-automation-tests bun test
TMPDIR=/tmp/cchp-automation-tests bunx tsc --noEmit

bash scripts/compact-prompt.test.sh
bash scripts/external-scan.test.sh
bash scripts/prepare-codex-env.test.sh
bash scripts/run-codex.test.sh
bash scripts/install-codex.test.sh
bash scripts/codex-capability-smoke-wrapper.test.sh
bash scripts/pre-cutover-acceptance.test.sh
bash scripts/codex-removal-gate.test.sh
bash scripts/install-skills.test.sh
bash scripts/refresh-skills-backup.test.sh
bash scripts/codex-removal-gate.sh

CCHP_CODEX_VERSION=0.146.0 \
  TMPDIR=/tmp/cchp-automation-tests \
  bash scripts/codex-capability-smoke.sh

actionlint -ignore job_workflow_ref .github/workflows/*.yml
zizmor --min-severity medium .github/workflows
```

The capability smoke starts the real pinned app-server in native-v2 and
explicit-exec modes. It performs real collaboration lifecycle calls and real
fff/Serena MCP initialize and tool calls from both root and child execution
contexts, then verifies their process environments contain no raw caller
credentials. The native report must also contain
`"native_child_collaboration_tools": []`.
