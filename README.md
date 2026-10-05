# cchp-automation

Runner-native GitHub App automation engine built on Pi 1.0 RPC, Pi's native MCP
transport, and task-scoped TypeScript extensions. One isolated supervisor runs
**per GitHub event inside a GitHub Actions runner** and is distributed as a
reusable workflow. TypeScript + Octokit; no standalone server and no external
durable-workflow engine.

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

The Pi migration preserves the caller ABI. Existing callers continue to use
the same workflow reference, 7 inputs, 5 reusable-workflow secrets, and 6
repository or organization variables. Callers do not provide a Pi installation
path or Pi settings file.

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
the provider JSON and writes an isolated Pi `models.json` with environment
references for credentials. Raw provider keys are held in the run process and
are never written to the generated configuration files.

### Variables

- `CCHP_BOT_PROVIDERS` and `CCHP_BOT_MODEL` select the provider/model. The Pi
  adapter accepts OpenAI Responses, OpenAI-compatible, Anthropic, and any Pi
  API identifier supported by a custom provider extension.
- `CCHP_BOT_SMALL_MODEL`, `CCHP_BOT_EXTRA_INSTRUCTIONS`, and
  `CCHP_DISABLE_AUTO_APPROVE` keep their existing behavior.
- `CCHP_BOT_OPENCODE_VERSION` is retained as an ignored legacy no-op so existing
  caller variable sets do not need to change. It never selects the Pi version.

The provider variable keeps the existing JSON boundary. A Pi-compatible example
looks like this:

```json
{
  "relay": {
    "api": "openai-responses",
    "base_url": "https://gateway.example/v1",
    "models": {
      "current": {
        "upstream_id": "provider-model-id",
        "context": 200000,
        "output": 32768,
        "reasoning": true
      }
    }
  }
}
```

Set `CCHP_BOT_MODEL=relay/current`. Provider keys stay in the existing
`provider-keys` secret object.

OpenAI Responses, OpenAI-compatible, and Anthropic providers use the run-owned
loopback bridge, so Pi receives a bridge credential and the parent runtime keeps
the upstream provider key. Pi-specific APIs can use a reviewed project
extension through `.pi/extensions`.

Requires a GitHub App with the permissions requested by the reusable workflow
and a self-hosted runner matching `[self-hosted, linux, x64]`. The runner must
provide Node.js 22.19 or newer for Pi 1.0. Pi's native MCP config, provider
adapter, RPC lifecycle, skills installation/fallback, and local verification
commands are documented in
[`docs/ci/pi-agent-toolchain.md`](docs/ci/pi-agent-toolchain.md).

Repo-specific config lives in the consumer under `.github/cchp-automation.yml`
(scalars) and `.github/cchp-automation/` (prompts, policy, references), which
overlay the engine defaults. The run creates a private Pi agent directory under
the run-owned working directory, generates `models.json` and `mcp.json`, loads
the CCHP Pi package from [`pi/package.json`](pi/package.json), and starts Pi
with `--mode rpc`.
