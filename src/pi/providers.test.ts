import { describe, expect, test } from "bun:test"
import { parsePiProviders, piModelsJson } from "./providers"
import { toPiBridgeRouting } from "./bridge"

describe("Pi provider adapter", () => {
  test("normalizes the existing CCHP provider shape without writing credentials", () => {
    const providers = parsePiProviders({
      providerJson: JSON.stringify({
        relay: {
          format: "openai-compatible",
          base_url: "https://cch.example.test/v1",
          headers: { "X-Relay": "header-secret" },
          models: {
            latest: { upstream_id: "model-current", context: 200000, output: 16000, reasoning: true },
          },
        },
      }),
      providerKeysJson: JSON.stringify({ relay: "api-secret" }),
      model: "relay/latest",
    })
    expect(providers.mainModel).toBe("relay/model-current")
    expect(providers.providers[0]?.api).toBe("openai-completions")
    expect(Object.values(providers.secretEnv)).toEqual(expect.arrayContaining(["api-secret", "header-secret"]))
    expect(piModelsJson(providers)).not.toContain("api-secret")
    expect(piModelsJson(providers)).not.toContain("header-secret")
    expect(piModelsJson(providers)).toContain("CCHP_PI_PROVIDER_KEY_")
  })

  test("passes through Pi native API identifiers for custom providers", () => {
    const providers = parsePiProviders({
      providerJson: JSON.stringify({
        custom: {
          api: "mistral-conversations",
          baseUrl: "https://models.example.test",
          models: [{ id: "reasoner", reasoning: true, thinkingLevelMap: { high: "medium" } }],
        },
      }),
      model: "custom/reasoner",
    })
    expect(providers.providers[0]?.api).toBe("mistral-conversations")
    expect(providers.mainModel).toBe("custom/reasoner")
  })

  test("rejects an unknown model reference before Pi starts", () => {
    expect(() => parsePiProviders({
      providerJson: JSON.stringify({ relay: { api: "openai-responses", base_url: "https://example.test", models: { current: {} } } }),
      model: "relay/missing",
    })).toThrow("references unknown model")
  })

  test("builds a loopback bridge route for supported protocols", () => {
    const providers = parsePiProviders({
      providerJson: JSON.stringify({ relay: { format: "openai-compatible", base_url: "https://relay.example", models: { current: { upstream_id: "upstream-current" } } } }),
      providerKeysJson: JSON.stringify({ relay: "secret-key" }),
      model: "relay/current",
    })
    const routing = toPiBridgeRouting(providers)
    expect(routing?.providerIds).toEqual(new Set(["relay"]))
    expect(routing?.providerSet.providers[0]?.format).toBe("openai-compatible")
    expect(routing?.providerSet.providers[0]?.apiKey).toBe("secret-key")
    const models = piModelsJson(providers, { baseUrl: "http://127.0.0.1:1234", tokenEnv: "CCHP_PI_BRIDGE_TOKEN", providerIds: routing!.providerIds })
    expect(models).toContain("http://127.0.0.1:1234/providers/relay/v1")
    expect(models).toContain("CCHP_PI_BRIDGE_TOKEN")
    expect(models).not.toContain("secret-key")
    expect(models).toContain('"id": "current"')
  })
})
