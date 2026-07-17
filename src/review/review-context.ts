// The real `ReviewContext` implementation for the #5 review pipeline. context.ts
// declares the `ReviewContext` port (with `noopReviewContext` as the pre-#5
// default); this module supplies the working capture wiring so the CLI can inject
// it via `CtxDeps.review`. Both methods share the ctx dir on disk exactly as the
// bash functions did: `capturePrReviewDiff` writes `pr-diff.patch` (+ omissions),
// and `capturePrReviewManifest` reads that patch to bind + hash the manifest.
import type { ReviewContext } from "../context"
import { capturePrReviewDiff, type ReviewDeps } from "./diff"
import { capturePrReviewManifest } from "./manifest"

export type { ReviewDeps }

/** Build a `ReviewContext` bound to the given client/repo/ctx-dir/prompt sink.
 *  Drop-in replacement for `noopReviewContext` — the CLI wires
 *  `deps.review = makeReviewContext(deps)` so `ctxPr` / `ctxPrReview` gather the
 *  real trusted diff + manifest. `ReviewDeps` is structurally a subset of
 *  `CtxDeps`, so the CLI can pass its existing deps object straight through. */
export function makeReviewContext(deps: ReviewDeps): ReviewContext {
  return {
    capturePrReviewDiff: (num) => capturePrReviewDiff(deps, num),
    capturePrReviewManifest: (num) => capturePrReviewManifest(deps, num),
  }
}
