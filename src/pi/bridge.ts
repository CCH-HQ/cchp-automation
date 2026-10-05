import type { ParsedProvider, ProviderSet } from "../codex/providers"
import type { PiProvider, PiProviderSet } from "./providers"

export interface PiBridgeRouting {
  providerIds: Set<string>
  providerSet: ProviderSet
}

function bridgeFormat(provider: PiProvider): ParsedProvider["format"] | undefined {
  if (provider.api === "openai-responses") return "openai-responses"
  if (provider.api === "openai-completions") return "openai-compatible"
  if (provider.api === "anthropic-messages") return "anthropic"
  return undefined
}

function secretValue(set: PiProviderSet, reference: string): string {
  const match = /^\$\{([^}]+)\}$/.exec(reference)
  return match ? set.secretEnv[match[1]!] ?? reference : reference
}

function parsedProvider(provider: PiProvider, set: PiProviderSet): ParsedProvider | undefined {
  const format = bridgeFormat(provider)
  if (!format) return undefined
  const models: ParsedProvider["models"] = {}
  for (const model of provider.models) {
    models[model.key] = {
      upstream_id: model.id,
      context: model.contextWindow,
      output: model.maxTokens,
      vision: model.input.includes("image"),
      reasoning: model.reasoning,
    }
  }
  const headers = Object.fromEntries(Object.entries(provider.headers).map(([name, value]) => [name, secretValue(set, value)]))
  const apiKey = provider.apiKeyEnv ? set.secretEnv[provider.apiKeyEnv] : undefined
  return {
    id: provider.id,
    codexId: `pi_bridge_${provider.id.replace(/[^A-Za-z0-9_-]/g, "_")}`,
    keyEnv: provider.apiKeyEnv ?? `CCHP_PI_PROVIDER_KEY_${provider.id}`,
    format,
    baseUrl: provider.baseUrl,
    headers,
    models,
    ...(apiKey ? { apiKey } : {}),
  }
}

function modelRef(provider: ParsedProvider, key: string) {
  const model = provider.models[key]
  if (!model) throw new Error(`bridge provider ${provider.id} is missing model ${key}`)
  return {
    providerId: provider.id,
    modelKey: key,
    upstreamId: model.upstream_id ?? key,
    context: model.context,
    output: model.output ?? 32768,
    vision: model.vision === true,
    reasoning: model.reasoning !== false,
    compactThreshold: model.compact_threshold,
  }
}

function providerModelKey(provider: PiProvider, reference: string): string | undefined {
  return provider.models.find((model) => model.key === reference || model.id === reference)?.key
}

function splitReference(reference: string): [string, string] {
  const slash = reference.indexOf("/")
  return [reference.slice(0, slash), reference.slice(slash + 1)]
}

export function toPiBridgeRouting(set: PiProviderSet): PiBridgeRouting | undefined {
  const providers = set.providers.map((provider) => parsedProvider(provider, set)).filter((value): value is ParsedProvider => value !== undefined)
  if (!providers.length) return undefined
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  const [mainProviderId, mainKey] = splitReference(set.mainModel)
  const mainProvider = byId.get(mainProviderId) ?? providers[0]!
  const mainPiProvider = set.providers.find((provider) => provider.id === mainProvider.id)!
  const mainModelKey = providerModelKey(mainPiProvider, mainKey) ?? Object.keys(mainProvider.models)[0]!
  const main = modelRef(mainProvider, mainModelKey)
  const [smallProviderId, smallKey] = set.smallModel ? splitReference(set.smallModel) : [mainProvider.id, undefined]
  const smallProvider = set.smallModel ? byId.get(smallProviderId) ?? mainProvider : mainProvider
  const smallPiProvider = set.providers.find((provider) => provider.id === smallProvider.id)!
  const small = modelRef(smallProvider, smallKey ? providerModelKey(smallPiProvider, smallKey) ?? Object.keys(smallProvider.models)[0]! : Object.keys(smallProvider.models)[0]!)
  return {
    providerIds: new Set(providers.map((provider) => provider.id)),
    providerSet: {
      providers,
      main,
      small,
      reviewModelKey: "__pi_review_unused",
      workerModelKey: "__pi_worker_unused",
    },
  }
}
