#!/usr/bin/env bun

import { readFileSync } from "node:fs"
import { join } from "node:path"

const catalog = process.env.FAKE_BUNDLED_CATALOG ??
  readFileSync(join(import.meta.dir, "bundled-model-catalog.json"), "utf8")
if (process.argv.includes("debug") && process.argv.includes("models") && process.argv.includes("--bundled")) {
  process.stdout.write(catalog.endsWith("\n") ? catalog : `${catalog}\n`)
  process.exit(0)
}
process.stderr.write(`unsupported fake codex argv: ${process.argv.slice(2).join(" ")}\n`)
process.exit(2)
