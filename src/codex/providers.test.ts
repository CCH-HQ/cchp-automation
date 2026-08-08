import { expect, test } from "bun:test"
import { parseProviders } from "./providers"

test("maps the live caller provider shape to distinct internal Codex providers", () => {
  const parsed = parseProviders({
    providerJson: JSON.stringify({
      "gpt-cchp": {
        format: "openai-responses",
        base_url: "https://cc.autobits.cc/v1",
        models: {
          "gpt-5.6-sol": { context: 372000, output: 131072, vision: true },
        },
      },
    }),
    providerKeysJson: JSON.stringify({ "gpt-cchp": "top-secret" }),
    model: "gpt-cchp/gpt-5.6-sol",
  })

  expect(parsed.main).toMatchObject({
    providerId: "gpt-cchp",
    modelKey: "gpt-5.6-sol",
    upstreamId: "gpt-5.6-sol",
    context: 372000,
    output: 131072,
    vision: true,
    reasoning: true,
  })
  expect(parsed.small).toEqual(parsed.main)
  expect(parsed.providers).toHaveLength(1)
  expect(parsed.providers[0]).toMatchObject({
    id: "gpt-cchp",
    format: "openai-responses",
    baseUrl: "https://cc.autobits.cc/v1",
    apiKey: "top-secret",
  })
  expect(parsed.providers[0]!.codexId).toMatch(/^cchp_gpt_cchp_[0-9a-f]{12}$/)
  expect(parsed.providers[0]!.keyEnv).toBe("CCHP_PK_GPT_CCHP")
  expect(parsed.reviewModelKey).toMatch(/^__cchp_leaf_small_[0-9a-f]{24}$/)
  expect(parsed.workerModelKey).toMatch(/^__cchp_leaf_main_[0-9a-f]{24}$/)
  expect(parsed.reviewModelKey).not.toBe(parsed.small.modelKey)
  expect(parsed.workerModelKey).not.toBe(parsed.main.modelKey)
})

test("preserves the caller key sanitizer and rejects ambiguous or malformed key maps", () => {
  const providers = {
    "a-b": {
      format: "openai-responses",
      base_url: "https://first.example/v1",
      models: { "gpt-5.6-sol": {} },
    },
    a_b: {
      format: "openai-responses",
      base_url: "https://second.example/v1",
      models: { "gpt-5.6-sol": {} },
    },
  }
  expect(() => parseProviders({
    providerJson: JSON.stringify(providers),
    providerKeysJson: JSON.stringify({ "a-b": "first", a_b: "second" }),
    model: "a-b/gpt-5.6-sol",
  })).toThrow("credential environment collision")

  expect(() => parseProviders({
    providerJson: JSON.stringify({ "gpt-cchp": providers["a-b"] }),
    providerKeysJson: JSON.stringify({ typo: "secret" }),
    model: "gpt-cchp/gpt-5.6-sol",
  })).toThrow("references unknown provider typo")

  expect(() => parseProviders({
    providerJson: JSON.stringify({ "gpt-cchp": providers["a-b"] }),
    providerKeysJson: JSON.stringify({ "gpt-cchp": "   " }),
    model: "gpt-cchp/gpt-5.6-sol",
  })).toThrow("must be a non-empty string")
})

test("rejects credentials too short to scrub safely", () => {
  const provider = {
    relay: {
      format: "openai-responses",
      base_url: "https://relay.example/v1",
      models: { "gpt-5.6-sol": {} },
    },
  }
  expect(() => parseProviders({
    providerJson: JSON.stringify(provider),
    providerKeysJson: JSON.stringify({ relay: "abc" }),
    model: "relay/gpt-5.6-sol",
  })).toThrow("at least 4 characters")
  expect(() => parseProviders({
    providerJson: JSON.stringify({ relay: { ...provider.relay, headers: { Authorization: "Bearer abc" } } }),
    model: "relay/gpt-5.6-sol",
  })).toThrow("credential must be at least 4 characters")
  expect(() => parseProviders({
    providerJson: JSON.stringify({ relay: { ...provider.relay, headers: { "x-custom-secret": "abc" } } }),
    model: "relay/gpt-5.6-sol",
  })).toThrow("credential must be at least 4 characters")
})

test("requires a context window for compact threshold and preserves the configured value", () => {
  const base = {
    format: "openai-responses",
    base_url: "https://provider.example/v1",
    models: { "gpt-5.6-sol": { output: 1000, context: 1000, compact_threshold: 0.8 } },
  }
  expect(parseProviders({
    providerJson: JSON.stringify({ main: base }),
    providerKeysJson: JSON.stringify({ main: "secret" }),
    model: "main/gpt-5.6-sol",
  }).main.compactThreshold).toBe(0.8)
  expect(() => parseProviders({
    providerJson: JSON.stringify({ main: { ...base, models: { "gpt-5.6-sol": { compact_threshold: 0.8 } } } }),
    providerKeysJson: JSON.stringify({ main: "secret" }),
    model: "main/gpt-5.6-sol",
  })).toThrow("requires context")
  expect(() => parseProviders({
    providerJson: JSON.stringify({ main: { ...base, models: { "gpt-5.6-sol": { context: 1000, compact_threshold: 0.91 } } } }),
    providerKeysJson: JSON.stringify({ main: "secret" }),
    model: "main/gpt-5.6-sol",
  })).toThrow("between 0 and 0.9")
})
