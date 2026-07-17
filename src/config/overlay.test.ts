import { expect, test } from "bun:test"
import { loadOverlay } from "./overlay"

test("neutral engine defaults when the consumer sets nothing", () => {
  expect(loadOverlay({})).toEqual({ defaultBranch: "main", roadmapProject: "" })
})

test("consumer overrides via BOT_* env", () => {
  expect(loadOverlay({ BOT_DEFAULT_BRANCH: "dev", BOT_ROADMAP_PROJECT: "1" })).toEqual({
    defaultBranch: "dev",
    roadmapProject: "1",
  })
})

test("whitespace-only values fall back to defaults", () => {
  expect(loadOverlay({ BOT_DEFAULT_BRANCH: "  ", BOT_ROADMAP_PROJECT: " " })).toEqual({
    defaultBranch: "main",
    roadmapProject: "",
  })
})
