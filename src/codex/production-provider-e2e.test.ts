import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCallerContract } from "./caller-contract"
import { prepareCodexHome } from "./config"
import { startProviderBridge } from "./provider-bridge"
import { parseProviders } from "./providers"
import { buildCodexEnvironment } from "./supervisor"

test("uses the production caller provider and key formats without caller-side conversion", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cchp-production-provider-"))
  const sentinel = randomBytes(24).toString("base64url")
  let observation:
    | { pathname: string; authorizationMatches: boolean; model: unknown; input: unknown }
    | undefined
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>
      observation = {
        pathname: new URL(request.url).pathname,
        authorizationMatches: request.headers.get("authorization") === `Bearer ${sentinel}`,
        model: body.model,
        input: body.input,
      }
      return Response.json({
        id: "resp_fixture",
        object: "response",
        model: "gpt-5.6-sol",
        status: "completed",
        output: [],
      })
    },
  })

  const productionShape = {
    "gpt-cchp": {
      format: "openai-responses",
      base_url: `${upstream.url}v1`,
      models: {
        "gpt-5.6-sol": {
          context: 372000,
          output: 131072,
          vision: true,
        },
      },
    },
  }
  const providerJson = JSON.stringify(productionShape)
  const providerKeysJson = JSON.stringify({ "gpt-cchp": sentinel })
  const contract = parseCallerContract({
    BOT_DEFAULT_BRANCH: "dev",
    BOT_ROADMAP_PROJECT: "1",
    BOT_ROADMAP_POLICY: ".github/cchp-automation/roadmap-policy.md",
    BOT_SEMVER_WORKFLOW: "semver-guard",
    BOT_SEMVER_MARKER: "cchp-semver-guard",
    BOT_TECH_STACK: "Go + React/HeroUI + Conventional Commits",
    BOT_LANGUAGES: "Chinese or English",
    CCHP_BOT_PROVIDERS: providerJson,
    CCHP_BOT_MODEL: "gpt-cchp/gpt-5.6-sol",
    CCHP_BOT_PROVIDER_KEYS: providerKeysJson,
    CCHP_BOT_OPENCODE_VERSION: "legacy-value-must-be-ignored",
  })

  expect(contract.providerJson).toBe(providerJson)
  expect(contract.providerKeysJson).toBe(providerKeysJson)
  expect(contract.model).toBe("gpt-cchp/gpt-5.6-sol")

  const providerSet = parseProviders({
    providerJson: contract.providerJson,
    providerKeysJson: contract.providerKeysJson,
    model: contract.model,
    smallModel: contract.smallModel,
  })
  expect(providerSet.main).toMatchObject({
    providerId: "gpt-cchp",
    modelKey: "gpt-5.6-sol",
    upstreamId: "gpt-5.6-sol",
    context: 372000,
    output: 131072,
    vision: true,
  })
  expect(providerSet.providers[0]).toMatchObject({
    id: "gpt-cchp",
    keyEnv: "CCHP_PK_GPT_CCHP",
    format: "openai-responses",
    baseUrl: `${upstream.url}v1`,
  })

  const bridge = startProviderBridge(providerSet)
  try {
    mkdirSync(join(workdir, "repo"), { recursive: true })
    const prepared = prepareCodexHome({
      botWorkdir: workdir,
      engineDir: process.cwd(),
      repoDir: join(workdir, "repo"),
      bridgeBaseUrl: bridge.baseUrl,
      bridgeTokenEnv: "CCHP_CODEX_BRIDGE_TOKEN",
      providerSet,
      sandboxMode: "read-only",
    })
    const config = readFileSync(prepared.configPath, "utf8")
    expect(config).toContain('model = "gpt-5.6-sol"')
    expect(config).toContain(`review_model = "${providerSet.reviewModelKey}"`)
    expect(config).toContain(`/providers/gpt-cchp/v1`)
    expect(config).toContain('env_key = "CCHP_CODEX_BRIDGE_TOKEN"')
    expect(config).not.toContain(String(upstream.url))
    expect(config).not.toContain(sentinel)

    const response = await fetch(`${bridge.baseUrl}/providers/gpt-cchp/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "fixture", stream: false }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ model: "gpt-5.6-sol", status: "completed" })
    expect(observation).toEqual({
      pathname: "/v1/responses",
      authorizationMatches: true,
      model: "gpt-5.6-sol",
      input: "fixture",
    })

    const leafResponse = await fetch(`${bridge.baseUrl}/providers/gpt-cchp/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: providerSet.reviewModelKey, input: "leaf-fixture", stream: false }),
    })
    expect(leafResponse.status).toBe(200)
    expect(await leafResponse.json()).toMatchObject({ model: providerSet.reviewModelKey, status: "completed" })
    expect(observation).toMatchObject({
      pathname: "/v1/responses",
      authorizationMatches: true,
      model: "gpt-5.6-sol",
      input: "leaf-fixture",
    })

    const denied = await fetch(`${bridge.baseUrl}/providers/gpt-cchp/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "denied", stream: false }),
    })
    expect(denied.status).toBe(401)
    expect(observation?.input).toBe("leaf-fixture")

    const childEnv = buildCodexEnvironment({
      PATH: process.env.PATH,
      CODEX_HOME: prepared.codexHome,
      CCHP_CODEX_BRIDGE_TOKEN: bridge.token,
      CCHP_BOT_PROVIDERS: providerJson,
      CCHP_BOT_PROVIDER_KEYS: providerKeysJson,
      CCHP_PK_GPT_CCHP: sentinel,
    })
    expect(childEnv.CCHP_CODEX_BRIDGE_TOKEN).toBe(bridge.token)
    expect(JSON.stringify(childEnv)).not.toContain(sentinel)
    expect(childEnv).not.toHaveProperty("CCHP_BOT_PROVIDERS")
    expect(childEnv).not.toHaveProperty("CCHP_BOT_PROVIDER_KEYS")
    expect(childEnv).not.toHaveProperty("CCHP_PK_GPT_CCHP")
  } finally {
    await bridge.close()
    await upstream.stop(true)
    rmSync(workdir, { recursive: true, force: true })
  }
})
