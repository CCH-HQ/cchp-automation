// Trusted file/hunk index over a complete unified diff — a faithful port of
// `.github/cchp-bot/review-patch-index.mjs`. Maps every changed path to the list
// of `@@ … @@` hunk headers found for it in the patch. Consumed by the review
// manifest (`patch_present` + `hunk_headers`) and, transitively, the finalizer's
// coverage cross-check. Pure string processing over trusted base-side input.

/** Build a path → hunk-header index from a complete unified diff. Same header
 *  conventions as the source script: `--- a/…` sets the old path, `+++ b/…` sets
 *  the current path (falling back to the old path, `/dev/null` → null), and every
 *  subsequent `@@ ` line is appended to the current path's hunk list. */
export function buildPatchIndex(text: string): Record<string, string[]> {
  const files = new Map<string, string[]>()
  let oldPath: string | null = null
  let currentPath: string | null = null

  const normalize = (raw: string, prefix: string): string | null => {
    if (raw === "/dev/null") return null
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
  }

  for (const line of text.split("\n")) {
    if (line.startsWith("--- ")) {
      oldPath = normalize(line.slice(4), "a/")
      continue
    }
    if (line.startsWith("+++ ")) {
      currentPath = normalize(line.slice(4), "b/") || oldPath
      if (currentPath && !files.has(currentPath)) files.set(currentPath, [])
      continue
    }
    if (currentPath && line.startsWith("@@ ")) files.get(currentPath)!.push(line)
  }

  return Object.fromEntries(files)
}
