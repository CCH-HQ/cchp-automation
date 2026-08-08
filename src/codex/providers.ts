import { createHash } from "node:crypto"

export type ProviderFormat = "openai-responses" | "openai-compatible" | "anthropic"

export interface CallerModel {
  upstream_id?: string
  context?: number
  output?: number
  vision?: boolean
  reasoning?: boolean
  compact_threshold?: number
}

export interface ParsedModel {
  providerId: string
  modelKey: string
  upstreamId: string
  context?: number
  output: number
  vision: boolean
  reasoning: boolean
  compactThreshold?: number
}

export interface ParsedProvider {
  id: string
  codexId: string
  keyEnv: string
  format: ProviderFormat
  baseUrl: string
  headers: Record<string, string>
  models: Record<string, CallerModel>
  /** 仅允许传给 loopback provider bridge,不得传给 Codex 进程. */
  apiKey?: string
}

export interface ProviderSet {
  providers: ParsedProvider[]
  main: ParsedModel
  small: ParsedModel
  reviewModelKey: string
  workerModelKey: string
}

export interface ProviderInput {
  providerJson: string
  providerKeysJson?: string
  model: string
  smallModel?: string
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function jsonObject(source: string | undefined, label: string): Record<string, unknown> {
  try {
    return object(JSON.parse(source?.trim() || "{}"), label)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} must be valid JSON`)
    throw error
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function internalProviderId(providerId: string): string {
  const readable = providerId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  return `cchp_${readable || "provider"}_${hash(providerId).slice(0, 12)}`
}

export function providerKeyEnv(providerId: string): string {
  return `CCHP_PK_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
}

function parseHeaders(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {}
  const source = object(value, label)
  const headers: Record<string, string> = {}
  for (const [name, raw] of Object.entries(source)) {
    const header = nonEmpty(raw, `${label}.${name}`)
    const credential = /^(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key)$/i.test(name) && header.includes(" ")
      ? header.slice(header.indexOf(" ") + 1).trim()
      : header
    // bridge 将 caller 提供的所有 provider header 都视为 secret material.
    // parser 与 response scrubber 必须使用同一最小长度, 避免合法配置中的
    // 短 custom credential 绕过 literal redaction.
    if (credential.length < 4) throw new Error(`${label}.${name} credential must be at least 4 characters`)
    headers[name] = header
  }
  return headers
}

function parseModels(value: unknown, label: string): Record<string, CallerModel> {
  const source = object(value, label)
  if (Object.keys(source).length === 0) throw new Error(`${label} must not be empty`)
  const models: Record<string, CallerModel> = {}
  for (const [modelKey, raw] of Object.entries(source)) {
    if (!modelKey) throw new Error(`${label} contains an empty model key`)
    const model = object(raw, `${label}.${modelKey}`)
    const context = optionalPositiveInt(model.context, `${label}.${modelKey}.context`)
    const output = optionalPositiveInt(model.output, `${label}.${modelKey}.output`)
    const compactThreshold = model.compact_threshold
    if (
      compactThreshold !== undefined &&
      (typeof compactThreshold !== "number" || compactThreshold <= 0 || compactThreshold > 0.9)
    ) {
      throw new Error(`${label}.${modelKey}.compact_threshold must be between 0 and 0.9`)
    }
    if (compactThreshold !== undefined && context === undefined) {
      throw new Error(`${label}.${modelKey}.compact_threshold requires context`)
    }
    if (model.vision !== undefined && typeof model.vision !== "boolean") {
      throw new Error(`${label}.${modelKey}.vision must be boolean`)
    }
    if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") {
      throw new Error(`${label}.${modelKey}.reasoning must be boolean`)
    }
    models[modelKey] = {
      ...(model.upstream_id === undefined
        ? {}
        : { upstream_id: nonEmpty(model.upstream_id, `${label}.${modelKey}.upstream_id`) }),
      ...(context === undefined ? {} : { context }),
      ...(output === undefined ? {} : { output }),
      ...(model.vision === undefined ? {} : { vision: model.vision }),
      ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      ...(compactThreshold === undefined ? {} : { compact_threshold: compactThreshold }),
    }
  }
  return models
}

function modelRef(ref: string, providers: Map<string, ParsedProvider>, label: string): ParsedModel {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`${label} must use provider/model format`)
  }
  const providerId = ref.slice(0, slash)
  const modelKey = ref.slice(slash + 1)
  const provider = providers.get(providerId)
  if (!provider) throw new Error(`${label} references unknown provider ${providerId}`)
  const model = provider.models[modelKey]
  if (!model) throw new Error(`${label} references unknown model ${providerId}/${modelKey}`)
  return {
    providerId,
    modelKey,
    upstreamId: model.upstream_id ?? modelKey,
    context: model.context,
    output: model.output ?? 32768,
    vision: model.vision === true,
    reasoning: model.reasoning !== false,
    compactThreshold: model.compact_threshold,
  }
}

export function parseProviders(input: ProviderInput): ProviderSet {
  const providerObject = jsonObject(input.providerJson, "CCHP_BOT_PROVIDERS")
  const keyObject = jsonObject(input.providerKeysJson, "CCHP_BOT_PROVIDER_KEYS")
  const providers = new Map<string, ParsedProvider>()
  const keyEnvOwners = new Map<string, string>()

  for (const [id, value] of Object.entries(keyObject)) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`CCHP_BOT_PROVIDER_KEYS.${id} must be a non-empty string`)
    }
    if (value.trim().length < 4) throw new Error(`CCHP_BOT_PROVIDER_KEYS.${id} must be at least 4 characters`)
  }

  for (const [id, raw] of Object.entries(providerObject)) {
    if (!id || id.includes("/")) throw new Error(`provider id ${JSON.stringify(id)} must be non-empty and exclude /`)
    const source = object(raw, `provider ${id}`)
    const format = nonEmpty(source.format, `provider ${id}.format`)
    if (!(["openai-responses", "openai-compatible", "anthropic"] as string[]).includes(format)) {
      throw new Error(`provider ${id}.format is unsupported: ${format}`)
    }
    const keyEnv = providerKeyEnv(id)
    const owner = keyEnvOwners.get(keyEnv)
    if (owner && owner !== id) {
      throw new Error(`provider credential environment collision: ${owner} and ${id} both map to ${keyEnv}`)
    }
    keyEnvOwners.set(keyEnv, id)
    const key = keyObject[id] as string | undefined
    providers.set(id, {
      id,
      codexId: internalProviderId(id),
      keyEnv,
      format: format as ProviderFormat,
      baseUrl: nonEmpty(source.base_url, `provider ${id}.base_url`).replace(/\/+$/, ""),
      headers: parseHeaders(source.headers, `provider ${id}.headers`),
      models: parseModels(source.models, `provider ${id}.models`),
      ...(key === undefined ? {} : { apiKey: key }),
    })
  }

  for (const id of Object.keys(keyObject)) {
    if (!providers.has(id)) throw new Error(`CCHP_BOT_PROVIDER_KEYS references unknown provider ${id}`)
  }

  const main = modelRef(input.model.trim(), providers, "CCHP_BOT_MODEL")
  if (!main.reasoning) throw new Error("CCHP_BOT_MODEL must reference a reasoning model")
  if (!/(^|\/)gpt-5\.6-sol($|[-/])/.test(main.upstreamId)) {
    throw new Error("CCHP_BOT_MODEL must resolve to gpt-5.6-sol")
  }
  const small = input.smallModel?.trim()
    ? modelRef(input.smallModel.trim(), providers, "CCHP_BOT_SMALL_MODEL")
    : main

  const reviewModelKey = `__cchp_leaf_small_${hash(`${small.providerId}/${small.modelKey}`).slice(0, 24)}`
  const workerModelKey = `__cchp_leaf_main_${hash(`${main.providerId}/${main.modelKey}`).slice(0, 24)}`
  for (const current of providers.values()) {
    for (const generated of [reviewModelKey, workerModelKey]) {
      if (current.models[generated]) {
        throw new Error(`generated leaf model route collides with ${current.id}/${generated}`)
      }
    }
  }
  return { providers: [...providers.values()], main, small, reviewModelKey, workerModelKey }
}
