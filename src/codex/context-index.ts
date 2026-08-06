import { readFileSync, statSync } from "node:fs"
import { relative, resolve } from "node:path"

export interface ContextIndexOptions {
  repoDir: string
  maxBytes?: number
  maxFiles?: number
}

export interface ContextHit {
  path: string
  line: number
  text: string
}

function safePath(root: string, input: string): string {
  const candidate = resolve(root, input)
  const rel = relative(resolve(root), candidate)
  if (!rel || rel === ".." || rel.startsWith("..") || candidate.startsWith("/proc/") || candidate.startsWith("/sys/")) {
    throw new Error("context path escapes trusted clone")
  }
  return candidate
}

/** Small CCHP-owned read-only context index. It deliberately avoids executing
 * project code and caps every response so large repositories cannot recreate the
 * token runaway previously seen with context-mode. */
export class ContextIndex {
  private readonly maxBytes: number
  private readonly maxFiles: number

  constructor(private readonly options: ContextIndexOptions) {
    this.maxBytes = options.maxBytes ?? 128_000
    this.maxFiles = options.maxFiles ?? 200
  }

  read(path: string): { path: string; content: string } {
    const file = safePath(this.options.repoDir, path)
    const stat = statSync(file)
    if (!stat.isFile()) throw new Error("context target is not a regular file")
    const content = readFileSync(file, "utf8")
    return { path: relative(this.options.repoDir, file), content: content.slice(0, this.maxBytes) }
  }

  search(query: string, paths: readonly string[] = ["."]): ContextHit[] {
    if (!query.trim()) throw new Error("context query must be non-empty")
    const hits: ContextHit[] = []
    for (const root of paths.slice(0, this.maxFiles)) {
      const file = safePath(this.options.repoDir, root)
      let content: string
      try { content = readFileSync(file, "utf8") } catch { continue }
      content.split("\n").forEach((line, index) => {
        if (line.toLowerCase().includes(query.toLowerCase()) && hits.length < this.maxFiles) {
          hits.push({ path: relative(this.options.repoDir, file), line: index + 1, text: line.slice(0, 500) })
        }
      })
      if (hits.length >= this.maxFiles) break
    }
    return hits
  }
}
