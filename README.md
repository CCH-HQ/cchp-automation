# cchp-automation

Runner-native GitHub App automation engine built on pinned Codex CLI 0.147.0,
Codex app-server, and multi-agent v2. One isolated supervisor runs **per GitHub
event inside a GitHub Actions runner** and is distributed as a reusable workflow.
TypeScript + Octokit; no standalone server and no external durable-workflow engine.

> **Status:** private, pre-release. MIT-licensed. The design record (glossary +
> ADRs) is kept local during the private phase and is not yet published.

## Install (consumer repo)

Keep your event matrix, concurrency, permissions, and secret mapping in your own
workflow, and call the engine:

```yaml
jobs:
  bot:
    # First-party ref; auto-follows latest by design — see ADR 0002.
    uses: CCH-HQ/cchp-automation/.github/workflows/run.yml@latest # zizmor: ignore[unpinned-uses]
    secrets:
      app-client-id: ${{ secrets.CCHP_APP_CLIENT_ID }}
      app-private-key: ${{ secrets.CCHP_APP_PRIVATE_KEY }}
      provider-keys: ${{ secrets.CCHP_BOT_PROVIDER_KEYS }}
      heroui-token: ${{ secrets.HEROUI_AUTH_TOKEN }}
      see-api-key: ${{ secrets.SEE_API_KEY }}
    with:
      default_branch: dev
      roadmap_project: "1"
```

The Codex migration preserves the caller ABI. Existing callers continue to use
the same workflow reference, 7 inputs, 5 reusable-workflow secrets, and 6
repository or organization variables. Callers do not provide an OpenAI/Codex API
key, a Codex TOML file, or a Codex version.

### Inputs

| Input | Default |
| --- | --- |
| `default_branch` | `main` |
| `roadmap_project` | empty |
| `roadmap_policy` | `.github/cchp-automation/roadmap-policy.md` |
| `semver_workflow` | empty |
| `semver_marker` | empty |
| `tech_stack` | empty |
| `languages` | empty |

### Secrets

| Reusable-workflow secret | Existing caller secret | Required |
| --- | --- | --- |
| `app-client-id` | `CCHP_APP_CLIENT_ID` | yes |
| `app-private-key` | `CCHP_APP_PRIVATE_KEY` | yes |
| `provider-keys` | `CCHP_BOT_PROVIDER_KEYS` | no |
| `heroui-token` | `HEROUI_AUTH_TOKEN` | no |
| `see-api-key` | `SEE_API_KEY` | no |

`provider-keys` remains one JSON object keyed by provider id. The engine parses
the existing provider JSON and maps it into an isolated Codex provider config;
raw provider keys are retained only by the loopback provider bridge and are not
written to Codex config or inherited by Codex children.

### Variables

- `CCHP_BOT_PROVIDERS` and `CCHP_BOT_MODEL` select the existing provider/model.
- `CCHP_BOT_SMALL_MODEL`, `CCHP_BOT_EXTRA_INSTRUCTIONS`, and
  `CCHP_DISABLE_AUTO_APPROVE` keep their existing behavior.
- `CCHP_BOT_OPENCODE_VERSION` is retained as an ignored legacy no-op so existing
  caller variable sets do not need to change. It never selects the Codex version.

Requires a GitHub App with the permissions requested by the reusable workflow
and a self-hosted runner matching `[self-hosted, linux, x64]`. Runtime deadlines,
restart/resume behavior, the pinned CLI provenance, skills installation/fallback,
and local verification commands are documented in
[`docs/ci/agent-toolchain.md`](docs/ci/agent-toolchain.md).

Repo-specific config lives in the consumer under `.github/cchp-automation.yml`
(scalars) and `.github/cchp-automation/` (prompts, policy, references), which
overlay the engine defaults.
