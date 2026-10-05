import { createHash } from "node:crypto"

export type PiApi =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses"
  | "mistral-conversations"
  | "google-generative-ai"
  | "google-vertex"
  | "bedrock-converse-stream"
  | string

export interface PiModel {
  key: string
  id: string
  name: string
  reasoning: boolean
  input: string[]
  contextWindow: number
  maxTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  api?: PiApi
  thinkingLevelMap?: Record<string, string | null>
  compat?: Record<string, unknown>
}

export interface PiProvider {
  id: string
  name: string
  baseUrl: string
  api: PiApi
  apiKeyEnv?: string
  headers: Record<string, string>
  models: PiModel[]
}

export interface PiProviderSet {
  providers: PiProvider[]
  mainModel: string
  smallModel?: string
  secretEnv: Record<string, string>
  providerModelRefs: Set<string>
}

type JsonRecord = Record<string, unknown>

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as JsonRecord
}

function text(value: unknown, label: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function positive(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10)
}

function safeName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "") || "provider"
  return `${normalized}_${digest(value)}`
}

function apiFor(value: unknown, label: string): PiApi {
  const source = text(value, label)
  switch (source) {
    case "anthropic":
    case "anthropic-messages":
      return "anthropic-messages"
    case "openai-compatible":
    case "openai-completions":
    case "chat-completions":
      return "openai-completions"
    case "openai-responses":
      return "openai-responses"
    case "gemini":
    case "google-generative-ai":
      return "google-generative-ai"
    case "google-vertex":
      return "google-vertex"
    case "mistral":
    case "mistral-conversations":
      return "mistral-conversations"
    default:
      return source
  }
}

function modelEntries(value: unknown, label: string): Array<[string, JsonRecord]> {
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const model = record(item, `${label}[${index}]`)
      return [text(model.id ?? model.model_id ?? model.model, `${label}[${index}].id`), model]
    })
  }
  const source = record(value, label)
  return Object.entries(source).map(([key, raw]) => [key, record(raw, `${label}.${key}`)])
}

function parseModel(providerId: string, modelId: string, raw: JsonRecord, providerApi: PiApi): PiModel {
  const input = Array.isArray(raw.input)
    ? raw.input.map((item, index) => text(item, `provider ${providerId}/${modelId}.input[${index}]`))
    : raw.vision === true ? ["text", "image"] : ["text"]
  const costSource = raw.cost === undefined ? {} : record(raw.cost, `provider ${providerId}/${modelId}.cost`)
  return {
    key: modelId,
    id: text(raw.upstream_id ?? raw.upstreamId ?? raw.id ?? raw.model_id ?? raw.model ?? modelId, `provider ${providerId}/${modelId}.id`),
    name: text(raw.name, `provider ${providerId}/${modelId}.name`, modelId),
    reasoning: raw.reasoning !== false,
    input,
    contextWindow: positive(raw.contextWindow ?? raw.context ?? raw.context_window, `provider ${providerId}/${modelId}.contextWindow`, 128000),
    maxTokens: positive(raw.maxTokens ?? raw.output ?? raw.max_tokens, `provider ${providerId}/${modelId}.maxTokens`, 32768),
    cost: {
      input: typeof costSource.input === "number" ? costSource.input : 0,
      output: typeof costSource.output === "number" ? costSource.output : 0,
      cacheRead: typeof costSource.cacheRead === "number" ? costSource.cacheRead : 0,
      cacheWrite: typeof costSource.cacheWrite === "number" ? costSource.cacheWrite : 0,
    },
    ...(raw.api === undefined ? {} : { api: apiFor(raw.api, `provider ${providerId}/${modelId}.api`) }),
    ...(raw.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: record(raw.thinkingLevelMap, `provider ${providerId}/${modelId}.thinkingLevelMap`) as Record<string, string | null> }),
    ...(raw.compat === undefined ? {} : { compat: record(raw.compat, `provider ${providerId}/${modelId}.compat`) }),
  }
}

function parseJson(value: string, label: string): JsonRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
  const root = record(parsed, label)
  return (root.providers && typeof root.providers === "object" && !Array.isArray(root.providers))
    ? record(root.providers, `${label}.providers`)
    : root
}

function normalizeRef(ref: string, providers: Map<string, PiProvider>, label: string): string {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) throw new Error(`${label} must use provider/model format`)
  const providerId = ref.slice(0, slash)
  const modelId = ref.slice(slash + 1)
  const provider = providers.get(providerId)
  if (!provider) throw new Error(`${label} references unknown provider ${providerId}`)
  if (!provider.models.some((model) => model.id === modelId || modelId === model.id || modelId === model.name)) {
    throw new Error(`${label} references unknown model ${providerId}/${modelId}`)
  }
  const matched = provider.models.find((model) => model.id === modelId || model.name === modelId)!
  return `${providerId}/${matched.id}`
}

export function parsePiProviders(input: {
  providerJson: string
  providerKeysJson?: string
  model: string
  smallModel?: string
}): PiProviderSet {
  const source = parseJson(input.providerJson, "CCHP_BOT_PROVIDERS")
  const keys = input.providerKeysJson ? parseJson(input.providerKeysJson, "CCHP_BOT_PROVIDER_KEYS") : {}
  const providers = new Map<string, PiProvider>()
  const secretEnv: Record<string, string> = {}
  for (const [id, raw] of Object.entries(source)) {
    const provider = record(raw, `provider ${id}`)
    const api = apiFor(provider.api ?? provider.format ?? provider.protocol, `provider ${id}.api`)
    const models = modelEntries(provider.models, `provider ${id}.models`).map(([modelId, model]) => parseModel(id, modelId, model, api))
    if (models.length === 0) throw new Error(`provider ${id}.models must not be empty`)
    const key = keys[id]
    const keyEnv = `CCHP_PI_PROVIDER_KEY_${safeName(id).toUpperCase()}`
    if (typeof key === "string" && key.trim()) {
      secretEnv[keyEnv] = key
    }
    const headers: Record<string, string> = {}
    const headerSource = provider.headers === undefined ? {} : record(provider.headers, `provider ${id}.headers`)
    for (const [headerName, headerValue] of Object.entries(headerSource)) {
      const headerEnv = `CCHP_PI_HEADER_${safeName(`${id}_${headerName}`).toUpperCase()}`
      if (typeof headerValue !== "string" || !headerValue.trim()) throw new Error(`provider ${id}.headers.${headerName} must be a non-empty string`)
      secretEnv[headerEnv] = headerValue
      headers[headerName] = `\${${headerEnv}}`
    }
    providers.set(id, {
      id,
      name: text(provider.name, `provider ${id}.name`, id),
      baseUrl: text(provider.base_url ?? provider.baseUrl ?? provider.baseURL ?? provider.endpoint, `provider ${id}.base_url`).replace(/\/+$/, ""),
      api,
      ...(secretEnv[keyEnv] === undefined ? {} : { apiKeyEnv: keyEnv }),
      headers,
      models,
    })
  }
  if (providers.size === 0) throw new Error("CCHP_BOT_PROVIDERS must contain at least one provider")
  for (const key of Object.keys(keys)) if (!providers.has(key)) throw new Error(`CCHP_BOT_PROVIDER_KEYS references unknown provider ${key}`)
  const mainModel = normalizeRef(input.model.trim(), providers, "CCHP_BOT_MODEL")
  const smallModel = input.smallModel?.trim() ? normalizeRef(input.smallModel.trim(), providers, "CCHP_BOT_SMALL_MODEL") : undefined
  return {
    providers: [...providers.values()],
    mainModel,
    ...(smallModel ? { smallModel } : {}),
    secretEnv,
    providerModelRefs: new Set([...providers.values()].flatMap((provider) => provider.models.map((model) => `${provider.id}/${model.id}`))),
  }
}

function serializedModel(model: PiModel, id = model.id): Record<string, unknown> {
  return {
    id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
    ...(model.api ? { api: model.api } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    ...(model.compat ? { compat: model.compat } : {}),
  }
}

export function piModelsJson(providerSet: PiProviderSet, bridge?: { baseUrl: string; tokenEnv: string; providerIds: ReadonlySet<string> }): string {
  const providers: Record<string, unknown> = {}
  for (const provider of providerSet.providers) {
    const routedThroughBridge = bridge?.providerIds.has(provider.id) === true
    providers[provider.id] = {
      name: provider.name,
      baseUrl: routedThroughBridge ? `${bridge!.baseUrl}/providers/${provider.id}/v1` : provider.baseUrl,
      api: routedThroughBridge ? "openai-responses" : provider.api,
      ...(routedThroughBridge
        ? { apiKey: `\${${bridge!.tokenEnv}}` }
        : {
            ...(provider.apiKeyEnv ? { apiKey: `\${${provider.apiKeyEnv}}` } : {}),
            ...(Object.keys(provider.headers).length ? { headers: provider.headers } : {}),
          }),
      models: provider.models.map((model) => serializedModel(model, routedThroughBridge ? model.key : model.id)),
    }
  }
  return `${JSON.stringify({ providers }, null, 2)}\n`
}
