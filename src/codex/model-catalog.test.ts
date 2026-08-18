import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  buildAppServerArgs,
  exportBundledModelCatalog,
  parseBundledModelCatalog,
  patchBundledModelWindows,
  threadStartConfigOverrides,
  type BundledModelCatalog,
} from "./model-catalog"

const fixturePath = resolve(import.meta.dir, "../../scripts/fixtures/bundled-model-catalog.json")
const fakeCodex = resolve(import.meta.dir, "../../scripts/fixtures/fake-codex-debug-models.ts")
const bundledCatalog = JSON.parse(readFileSync(fixturePath, "utf8")) as BundledModelCatalog
const builtinSlugs = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.2",
  "codex-auto-review",
]

test("export+patch keeps 8 bundled slugs and only raises gpt-5.6-sol windows", () => {
  const exportHome = mkdtempSync(join(tmpdir(), "cchp-catalog-export-"))
  const exported = exportBundledModelCatalog({
    codexBin: fakeCodex,
    exportHome,
  })
  expect(exported.models.map((model) => model.slug)).toEqual(builtinSlugs)
  expect(exported.models[0]).toMatchObject({
    slug: "gpt-5.6-sol",
    context_window: 272000,
    max_context_window: 272000,
  })

  const patched = patchBundledModelWindows(exported, "gpt-5.6-sol", 1_000_000)
  expect(patched.models.map((model) => model.slug)).toEqual(builtinSlugs)
  expect(patched.models).toHaveLength(8)
  expect(patched.models[0]).toMatchObject({
    slug: "gpt-5.6-sol",
    context_window: 1_000_000,
    max_context_window: 1_000_000,
  })
  expect(patched.models.slice(1)).toEqual(bundledCatalog.models.slice(1))
  expect(exported.models[0]).toMatchObject({
    context_window: 272000,
    max_context_window: 272000,
  })
})

test("parses debug models JSON even when Codex prints a warning first", () => {
  const catalog = parseBundledModelCatalog(`WARNING: proceeding\n${JSON.stringify(bundledCatalog)}\n`)
  expect(catalog.models).toHaveLength(8)
})

test("builds app-server and thread/start window overrides", () => {
  expect(buildAppServerArgs({
    modelContextWindow: 1_000_000,
    modelAutoCompactTokenLimit: 900_000,
  })).toEqual([
    "app-server",
    "--stdio",
    "--strict-config",
    "-c",
    "model_context_window=1000000",
    "-c",
    "model_auto_compact_token_limit=900000",
  ])
  expect(threadStartConfigOverrides({
    modelContextWindow: 1_000_000,
    modelAutoCompactTokenLimit: 900_000,
  })).toEqual({
    model_context_window: 1_000_000,
    model_auto_compact_token_limit: 900_000,
  })
})

const realCodexBin = process.env.CODEX_BIN
const realVersion = realCodexBin
  ? spawnSync(realCodexBin, ["--version"], { encoding: "utf8" }).stdout.trim()
  : ""

if (realCodexBin && realVersion === "codex-cli 0.147.0") {
  function isolatedDebugModels(home: string, args: string[] = ["debug", "models"]) {
    return spawnSync(realCodexBin, args, {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        CODEX_HOME: home,
      },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    })
  }

  test("real Codex 0.147 debug models reads patched sol windows as 1000000", () => {
    const exportHome = mkdtempSync(join(tmpdir(), "cchp-real-catalog-export-"))
    const exported = exportBundledModelCatalog({
      codexBin: realCodexBin,
      exportHome,
    })
    expect(exported.models.map((model) => model.slug)).toEqual(builtinSlugs)
    expect(exported.models[0]).toMatchObject({
      slug: "gpt-5.6-sol",
      context_window: 272000,
      max_context_window: 272000,
    })
    const patched = patchBundledModelWindows(exported, "gpt-5.6-sol", 1_000_000)
    expect(patched.models.slice(1)).toEqual(exported.models.slice(1))
    const runtimeHome = mkdtempSync(join(tmpdir(), "cchp-real-catalog-home-"))
    const catalogPath = join(runtimeHome, "model_catalog.json")
    Bun.write(catalogPath, `${JSON.stringify(patched, null, 2)}\n`)
    Bun.write(join(runtimeHome, "config.toml"), [
      'model = "gpt-5.6-sol"',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      "model_context_window = 1000000",
      "model_auto_compact_token_limit = 900000",
      "",
    ].join("\n"))
    const observed = isolatedDebugModels(runtimeHome)
    expect(observed.status).toBe(0)
    const catalog = parseBundledModelCatalog(observed.stdout)
    expect(catalog.models.map((model) => model.slug)).toEqual(builtinSlugs)
    expect(catalog.models.find((model) => model.slug === "gpt-5.6-sol")).toMatchObject({
      slug: "gpt-5.6-sol",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
    })
  })

  test("real Codex 0.147 still clamps sol to 272000 when only -c window flags are set", () => {
    const controlHome = mkdtempSync(join(tmpdir(), "cchp-real-catalog-control-"))
    const observed = isolatedDebugModels(controlHome, [
      "debug",
      "models",
      "-c",
      "model_context_window=1000000",
      "-c",
      "model_auto_compact_token_limit=900000",
    ])
    expect(observed.status).toBe(0)
    const catalog = parseBundledModelCatalog(observed.stdout)
    expect(catalog.models.map((model) => model.slug)).toEqual(builtinSlugs)
    expect(catalog.models.find((model) => model.slug === "gpt-5.6-sol")).toMatchObject({
      slug: "gpt-5.6-sol",
      context_window: 272000,
      max_context_window: 272000,
    })
  })
}
