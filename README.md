# cchp-automation

Runner-native GitHub App automation engine — one OpenCode review/automation agent
that runs **per GitHub event inside a GitHub Actions runner**, distributed as a
reusable workflow. TypeScript + Octokit; no standalone server, no durable-workflow
engine.

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
```

Requires a GitHub App (installation-token auth) and a self-hosted runner.

Repo-specific config lives in the consumer under `.github/cchp-automation.yml`
(scalars) and `.github/cchp-automation/` (prompts, policy, references), which
overlay the engine defaults.
