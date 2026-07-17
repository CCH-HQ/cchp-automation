// Consumer Overlay: repo-specific config the engine reads (DESIGN §4). The
// reusable workflow maps its inputs → these env vars; the engine ships neutral
// defaults so a new repo works without them. This file holds only what routing
// needs today; the full placeholder set (system-prompt render) lands with run.yml
// (#8).
export interface Overlay {
  /** Default base branch for engine-initiated work (CCHP: `dev`). */
  defaultBranch: string
  /** Public-roadmap Projects-v2 number, or "" if the consumer runs no board. */
  roadmapProject: string
}

type Env = Record<string, string | undefined>

export function loadOverlay(env: Env = process.env): Overlay {
  return {
    // Neutral engine default; the consumer overrides via the workflow input.
    defaultBranch: env.BOT_DEFAULT_BRANCH?.trim() || "main",
    roadmapProject: env.BOT_ROADMAP_PROJECT?.trim() || "",
  }
}
