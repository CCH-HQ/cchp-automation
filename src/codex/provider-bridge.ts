import { randomBytes, timingSafeEqual } from "node:crypto"
import type { ParsedProvider, ProviderSet } from "./providers"
import type { UsageReservationRef } from "./usage"

export interface ProviderBridge {
  baseUrl: string
  token: string
  drain(): Promise<void>
  cancelThread(threadId: string, reason?: string): Promise<number>
  sealAndDrain(): Promise<void>
  close(): Promise<void>
}

export interface ProviderBridgeOptions {
  token?: string
  hostname?: string
  onUsage?(usage: ProviderBridgeUsage): void | Promise<void>
  onBeforeRequest?(request: ProviderBridgeRequest): ProviderBridgeAdmission | Promise<ProviderBridgeAdmission>
  onRequestFinished?(reservation: UsageReservationRef, outcome: "usage" | "released", reason?: string): void | Promise<void>
}

export interface ProviderBridgeRequest {
  providerId: string
  model: string
  threadId?: string
  turnId?: string
  contextWindow?: number
  estimatedTokens?: number
}

export interface ProviderBridgeAdmission {
  allowed: boolean
  reason?: string
  reservation?: UsageReservationRef
}

export interface ProviderBridgeUsage {
  providerId: string
  model: string
  responseId: string
  threadId?: string
  turnId?: string
  inputTokens: number
  contextInputTokens?: number
  billableInputTokens?: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  contextWindow?: number
  reservation?: UsageReservationRef
}

function authorized(request: Request, token: string): boolean {
  const actual = request.headers.get("authorization") ?? ""
  const expected = `Bearer ${token}`
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function upstreamPath(provider: ParsedProvider): string {
  switch (provider.format) {
    case "openai-responses":
      return "responses"
    case "openai-compatible":
      return "chat/completions"
    case "anthropic":
      return "messages"
  }
}

function callerModel(provider: ParsedProvider, upstreamModel: unknown): string | undefined {
  if (typeof upstreamModel !== "string") return undefined
  return Object.entries(provider.models).find(
    ([modelKey, model]) => (model.upstream_id ?? modelKey) === upstreamModel,
  )?.[0]
}

function callerModelConfig(provider: ParsedProvider, body: Record<string, unknown>) {
  if (typeof body.model !== "string") throw new Error("model must be a string")
  const modelKey = body.model
  const configured = provider.models[modelKey]
  if (!configured) throw new Error(`unknown model ${provider.id}/${modelKey}`)
  return { modelKey, configured, upstreamId: configured.upstream_id ?? modelKey }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

async function readRequestJson(request: Request, signal?: AbortSignal): Promise<unknown> {
  const json = request.json()
  void json.catch(() => undefined)
  if (!signal) return json
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("provider request aborted"))
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([json, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
    if (signal.aborted) {
      try { await request.body?.cancel(signal.reason) } catch {}
    }
  }
}

/** Reserve against the request sent upstream, not the model's full capacity. */
export function estimateProviderRequestTokens(body: JsonRecord, contextWindow?: number): number {
  const output = positiveInteger(body.max_output_tokens) ?? positiveInteger(body.max_tokens) ?? 0
  const promptBody = { ...body }
  delete promptBody.max_output_tokens
  delete promptBody.max_tokens
  delete promptBody.stream
  const promptBytes = Buffer.byteLength(JSON.stringify(promptBody), "utf8")
  const promptTokens = Math.max(1, Math.ceil(promptBytes / 3))
  const estimate = promptTokens + output
  const contextLimit = positiveInteger(contextWindow)
  return contextLimit ? Math.min(estimate, contextLimit) : estimate
}

type JsonRecord = Record<string, unknown>

function records(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${label}[${index}] must be an object`)
    }
    return item as JsonRecord
  })
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  return value
}

function responseContent(value: unknown, label: string): JsonRecord[] {
  if (typeof value === "string") return [{ type: "input_text", text: value }]
  return records(value, label)
}

function contentAsText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item && typeof item === "object" && "text" in item && typeof item.text === "string"
          ? item.text
          : JSON.stringify(item),
      )
      .join("\n")
  }
  return JSON.stringify(value)
}

function chatContent(value: unknown, label: string): string | JsonRecord[] {
  const parts = responseContent(value, label)
  const mapped = parts.map((part, index): JsonRecord => {
    switch (part.type) {
      case "input_text":
      case "output_text":
        return { type: "text", text: text(part.text, `${label}[${index}].text`) }
      case "input_image": {
        const url = text(part.image_url ?? part.url, `${label}[${index}].image_url`)
        return { type: "image_url", image_url: { url } }
      }
      default:
        throw new Error(`unsupported Responses content type ${String(part.type)}`)
    }
  })
  return mapped.every((part) => part.type === "text")
    ? mapped.map((part) => String(part.text)).join("")
    : mapped
}

function anthropicImage(url: string): JsonRecord {
  const data = /^data:([^;,]+);base64,(.+)$/s.exec(url)
  return data
    ? { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } }
    : { type: "image", source: { type: "url", url } }
}

function anthropicContent(value: unknown, label: string): JsonRecord[] {
  return responseContent(value, label).map((part, index): JsonRecord => {
    switch (part.type) {
      case "input_text":
      case "output_text":
        return { type: "text", text: text(part.text, `${label}[${index}].text`) }
      case "input_image":
        return anthropicImage(text(part.image_url ?? part.url, `${label}[${index}].image_url`))
      default:
        throw new Error(`unsupported Responses content type ${String(part.type)}`)
    }
  })
}

function responseItems(input: unknown): JsonRecord[] {
  if (typeof input === "string") return [{ type: "message", role: "user", content: input }]
  return records(input, "input")
}

interface BridgeTool {
  name: string
  namespace?: string
  description?: string
  parameters: unknown
}

const NAMESPACED_TOOL_PREFIX = "cchpns1_"
const MAX_COMPATIBLE_TOOL_NAME_BYTES = 64

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8")
}

function toolIdentity(value: Pick<BridgeTool, "name" | "namespace">): string {
  return `${value.namespace ?? ""}\0${value.name}`
}

function encodeToolName(value: Pick<BridgeTool, "name" | "namespace">): string {
  if (!value.namespace) return value.name
  const namespace = base64Url(value.namespace)
  const name = base64Url(value.name)
  const encoded = `${NAMESPACED_TOOL_PREFIX}${namespace.length}_${namespace}${name}`
  if (Buffer.byteLength(encoded, "utf8") > MAX_COMPATIBLE_TOOL_NAME_BYTES) {
    throw new Error(
      `namespaced tool ${value.namespace}/${value.name} exceeds the ${MAX_COMPATIBLE_TOOL_NAME_BYTES}-byte compatible name limit`,
    )
  }
  return encoded
}

function decodeToolName(value: string): { name: string; namespace?: string } {
  if (!value.startsWith(NAMESPACED_TOOL_PREFIX)) return { name: value }
  const rest = value.slice(NAMESPACED_TOOL_PREFIX.length)
  const separator = rest.indexOf("_")
  if (separator <= 0 || !/^\d+$/.test(rest.slice(0, separator))) return { name: value }
  const namespaceLength = Number(rest.slice(0, separator))
  const payload = rest.slice(separator + 1)
  if (!Number.isSafeInteger(namespaceLength) || namespaceLength <= 0 || namespaceLength >= payload.length) {
    return { name: value }
  }
  try {
    const namespace = fromBase64Url(payload.slice(0, namespaceLength))
    const name = fromBase64Url(payload.slice(namespaceLength))
    if (!namespace || !name || encodeToolName({ namespace, name }) !== value) return { name: value }
    return { namespace, name }
  } catch {
    return { name: value }
  }
}

function collectTools(
  value: unknown,
  label: string,
  inheritedNamespace: string | undefined,
  result: BridgeTool[],
): void {
  for (const [index, tool] of records(value, label).entries()) {
    const currentLabel = `${label}[${index}]`
    if (tool.type === "namespace") {
      const namespace = text(tool.name, `${currentLabel}.name`)
      collectTools(tool.tools, `${currentLabel}.tools`, namespace, result)
      continue
    }
    if (tool.type !== "function") throw new Error(`${currentLabel}.type must be function or namespace`)
    const namespace =
      typeof tool.namespace === "string" && tool.namespace
        ? tool.namespace
        : inheritedNamespace
    result.push({
      name: text(tool.name, `${currentLabel}.name`),
      ...(namespace ? { namespace } : {}),
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      parameters: tool.parameters ?? {},
    })
  }
}

function responseTools(request: JsonRecord): BridgeTool[] {
  const result: BridgeTool[] = []
  if (request.tools !== undefined) collectTools(request.tools, "tools", undefined, result)
  for (const [index, item] of responseItems(request.input).entries()) {
    if (item.type === "additional_tools") {
      collectTools(item.tools, `input[${index}].tools`, undefined, result)
    }
  }
  const available = result.filter((tool) => tool.namespace || tool.name !== "request_user_input")
  const encodedOwners = new Map<string, string>()
  for (const tool of available) {
    const encoded = encodeToolName(tool)
    const identity = toolIdentity(tool)
    const owner = encodedOwners.get(encoded)
    if (owner !== undefined && owner !== identity) {
      throw new Error(`tool name encoding collision for ${encoded}`)
    }
    encodedOwners.set(encoded, identity)
  }
  return available
}

function encodedFunctionCallName(item: JsonRecord, label: string): string {
  const name = text(item.name, `${label}.name`)
  const namespace = item.namespace
  if (namespace !== undefined && typeof namespace !== "string") {
    throw new Error(`${label}.namespace must be a string`)
  }
  return encodeToolName({ name, ...(namespace ? { namespace } : {}) })
}

function functionCallItem(callId: string, encodedName: string, args: string): JsonRecord {
  const decoded = decodeToolName(encodedName)
  return {
    id: randomId("fc"),
    type: "function_call",
    status: "completed",
    call_id: callId,
    ...(decoded.namespace ? { namespace: decoded.namespace } : {}),
    name: decoded.name,
    arguments: args,
  }
}

function jsonSchemaFormat(request: JsonRecord): JsonRecord | undefined {
  if (!request.text || typeof request.text !== "object" || Array.isArray(request.text)) return undefined
  const format = (request.text as JsonRecord).format
  if (format === undefined) return undefined
  if (!format || typeof format !== "object" || Array.isArray(format)) {
    throw new Error("text.format must be an object")
  }
  const value = format as JsonRecord
  if (value.type !== "json_schema") throw new Error(`unsupported text.format.type ${String(value.type)}`)
  if (!value.schema || typeof value.schema !== "object" || Array.isArray(value.schema)) {
    throw new Error("text.format.schema must be an object")
  }
  if (typeof value.name !== "string" || !value.name) throw new Error("text.format.name must be a non-empty string")
  if (value.strict !== undefined && typeof value.strict !== "boolean") {
    throw new Error("text.format.strict must be boolean")
  }
  return value
}

function chatToolChoice(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const choice = value as JsonRecord
  return choice.type === "function" && typeof choice.name === "string"
    ? { type: "function", function: { name: encodedFunctionCallName(choice, "tool_choice") } }
    : value
}

function unavailableDefaultToolChoice(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const choice = value as JsonRecord
  return choice.type === "function" && choice.name === "request_user_input" && !choice.namespace
}

function toChatBody(
  provider: ParsedProvider,
  request: JsonRecord,
  upstreamId: string,
  output: number,
  reasoning: boolean,
): JsonRecord {
  const messages: JsonRecord[] = []
  if (typeof request.instructions === "string" && request.instructions) {
    messages.push({ role: "system", content: request.instructions })
  }
  for (const [index, item] of responseItems(request.input).entries()) {
    switch (item.type) {
      case "additional_tools":
        break
      case "message": {
        const role = text(item.role, `input[${index}].role`)
        messages.push({ role, content: chatContent(item.content, `input[${index}].content`) })
        break
      }
      case "function_call":
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: text(item.call_id, `input[${index}].call_id`),
              type: "function",
              function: {
                name: encodedFunctionCallName(item, `input[${index}]`),
                arguments: text(item.arguments, `input[${index}].arguments`),
              },
            },
          ],
        })
        break
      case "function_call_output":
        messages.push({
          role: "tool",
          tool_call_id: text(item.call_id, `input[${index}].call_id`),
          content: contentAsText(item.output),
        })
        break
      case "reasoning":
        break
      default:
        throw new Error(`unsupported Responses input item ${String(item.type)}`)
    }
  }

  const body: JsonRecord = {
    model: upstreamId,
    messages,
    max_completion_tokens: output,
    stream: request.stream !== false,
    stream_options: { include_usage: true },
  }
  const tools = responseTools(request)
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: encodeToolName(tool),
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters,
      },
    }))
  }
  if (request.tool_choice !== undefined && !unavailableDefaultToolChoice(request.tool_choice)) {
    body.tool_choice = chatToolChoice(request.tool_choice)
  }
  if (request.parallel_tool_calls !== undefined) body.parallel_tool_calls = request.parallel_tool_calls
  const format = jsonSchemaFormat(request)
  if (format) body.response_format = { type: "json_schema", json_schema: format }
  if (reasoning && request.reasoning && typeof request.reasoning === "object" && !Array.isArray(request.reasoning)) {
    const effort = (request.reasoning as JsonRecord).effort
    if (typeof effort === "string") body.reasoning_effort = effort
  }
  return body
}

function anthropicToolChoice(value: unknown): unknown {
  if (value === "auto") return { type: "auto" }
  if (value === "required") return { type: "any" }
  if (value === "none") return { type: "none" }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const choice = value as JsonRecord
    if (choice.type === "function" && typeof choice.name === "string") {
      return { type: "tool", name: encodedFunctionCallName(choice, "tool_choice") }
    }
  }
  return value
}

function parsedArguments(value: unknown, label: string): unknown {
  const source = text(value, label)
  try {
    return JSON.parse(source)
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
}

function toAnthropicBody(
  request: JsonRecord,
  upstreamId: string,
  output: number,
  reasoning: boolean,
): JsonRecord {
  const system: string[] = []
  if (typeof request.instructions === "string" && request.instructions) system.push(request.instructions)
  const messages: JsonRecord[] = []
  for (const [index, item] of responseItems(request.input).entries()) {
    switch (item.type) {
      case "additional_tools":
        break
      case "message": {
        const role = text(item.role, `input[${index}].role`)
        const content = anthropicContent(item.content, `input[${index}].content`)
        if (role === "system" || role === "developer") {
          system.push(content.map((part) => String(part.text ?? "")).join(""))
        } else {
          messages.push({ role: role === "assistant" ? "assistant" : "user", content })
        }
        break
      }
      case "function_call":
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: text(item.call_id, `input[${index}].call_id`),
              name: encodedFunctionCallName(item, `input[${index}]`),
              input: parsedArguments(item.arguments, `input[${index}].arguments`),
            },
          ],
        })
        break
      case "function_call_output":
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: text(item.call_id, `input[${index}].call_id`),
              content: contentAsText(item.output),
            },
          ],
        })
        break
      case "reasoning":
        break
      default:
        throw new Error(`unsupported Responses input item ${String(item.type)}`)
    }
  }
  const body: JsonRecord = {
    model: upstreamId,
    ...(system.length ? { system: system.join("\n\n") } : {}),
    messages,
    max_tokens: output,
    stream: request.stream !== false,
  }
  const tools = responseTools(request)
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      name: encodeToolName(tool),
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: tool.parameters,
    }))
  }
  if (request.tool_choice !== undefined && !unavailableDefaultToolChoice(request.tool_choice)) {
    body.tool_choice = anthropicToolChoice(request.tool_choice)
  }
  const format = jsonSchemaFormat(request)
  if (format) body.output_config = { format: { type: "json_schema", schema: format.schema } }
  if (reasoning && request.reasoning !== undefined) body.thinking = { type: "adaptive" }
  return body
}

export function translateResponsesRequest(
  provider: ParsedProvider,
  request: JsonRecord,
): { path: string; body: JsonRecord } {
  const { configured, upstreamId } = callerModelConfig(provider, request)
  const requestedOutput = request.max_output_tokens
  const configuredOutput = configured.output ?? 32768
  const output =
    typeof requestedOutput === "number" && Number.isSafeInteger(requestedOutput) && requestedOutput > 0
      ? Math.min(requestedOutput, configuredOutput)
      : configuredOutput
  if (provider.format === "openai-responses") {
    const body: JsonRecord = { ...request, model: upstreamId, max_output_tokens: output }
    if (configured.reasoning === false) delete body.reasoning
    return { path: "responses", body }
  }
  if (provider.format === "openai-compatible") {
    return { path: "chat/completions", body: toChatBody(provider, request, upstreamId, output, configured.reasoning !== false) }
  }
  return { path: "messages", body: toAnthropicBody(request, upstreamId, output, configured.reasoning !== false) }
}

function upstreamHeaders(provider: ParsedProvider, request: Request): Headers {
  const headers = new Headers(provider.headers)
  headers.set("content-type", request.headers.get("content-type") ?? "application/json")
  headers.set("accept", request.headers.get("accept") ?? "text/event-stream")
  if (provider.format === "anthropic") {
    if (provider.apiKey) headers.set("x-api-key", provider.apiKey)
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
  } else if (provider.apiKey) {
    headers.set("authorization", `Bearer ${provider.apiKey}`)
  }
  return headers
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers()
  for (const name of ["content-type", "retry-after", "request-id", "x-request-id"]) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set("cache-control", "no-store")
  return headers
}

const REDACTED = Buffer.from("[REDACTED]")

function providerSecrets(provider: ParsedProvider): Buffer[] {
  const headerSecrets = Object.entries(provider.headers).flatMap(([name, value]) => {
    if (!/^(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key)$/i.test(name)) return [value]
    const credential = value.includes(" ") ? value.slice(value.indexOf(" ") + 1).trim() : value
    return credential && credential !== value ? [value, credential] : [value]
  })
  const values = [provider.apiKey, ...headerSecrets]
    .filter((value): value is string => Boolean(value))
  const encoded = values.flatMap((value) => {
    const json = JSON.stringify(value)
    const escaped = json.startsWith('"') && json.endsWith('"') ? json.slice(1, -1) : value
    const unicodeEscaped = [...value].map((char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`).join("")
    return [value, escaped, encodeURIComponent(value), Buffer.from(value).toString("base64"), unicodeEscaped]
  })
  return [...new Set(encoded)]
    .map((value) => Buffer.from(value))
    .sort((left, right) => right.length - left.length)
}

function matchesAt(input: Buffer, offset: number, pattern: Buffer): boolean {
  if (offset + pattern.length > input.length) return false
  for (let index = 0; index < pattern.length; index++) {
    if (input[offset + index] !== pattern[index]) return false
  }
  return true
}

function scrubPrefix(input: Buffer, patterns: readonly Buffer[], limit: number): { bytes: Buffer; consumed: number } {
  const chunks: Buffer[] = []
  let literalStart = 0
  let offset = 0
  while (offset < limit) {
    const match = patterns.find((pattern) => matchesAt(input, offset, pattern))
    if (!match) {
      offset += 1
      continue
    }
    if (literalStart < offset) chunks.push(input.subarray(literalStart, offset))
    chunks.push(REDACTED)
    offset += match.length
    literalStart = offset
  }
  if (literalStart < offset) chunks.push(input.subarray(literalStart, offset))
  return { bytes: Buffer.concat(chunks), consumed: offset }
}

function scrubResponse(response: Response, provider: ParsedProvider): Response {
  const patterns = providerSecrets(provider)
  if (!response.body || patterns.length === 0) return response
  const reader = response.body.getReader()
  const carryLength = patterns[0]!.length - 1
  let carry = Buffer.alloc(0)
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          const final = scrubPrefix(carry, patterns, carry.length)
          if (final.bytes.length) controller.enqueue(final.bytes)
          controller.close()
          return
        }
        const combined = Buffer.concat([carry, Buffer.from(value)])
        const safeLimit = Math.max(0, combined.length - carryLength)
        const scrubbed = scrubPrefix(combined, patterns, safeLimit)
        carry = combined.subarray(scrubbed.consumed)
        if (scrubbed.bytes.length) {
          controller.enqueue(scrubbed.bytes)
          return
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

interface ResponsesUsage {
  input_tokens: number
  input_tokens_details: { cached_tokens: number; cache_write_tokens: number }
  output_tokens: number
  output_tokens_details: { reasoning_tokens: number }
  total_tokens: number
}

function zeroUsage(): ResponsesUsage {
  return {
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 0,
  }
}

function chatUsage(raw: unknown): ResponsesUsage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const usage = raw as JsonRecord
  const input = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0
  const output = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0
  const promptDetails =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as JsonRecord)
      : {}
  const completionDetails =
    usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
      ? (usage.completion_tokens_details as JsonRecord)
      : {}
  return {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: typeof promptDetails.cached_tokens === "number" ? promptDetails.cached_tokens : 0,
      cache_write_tokens:
        typeof promptDetails.cache_write_tokens === "number" ? promptDetails.cache_write_tokens : 0,
    },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens:
        typeof completionDetails.reasoning_tokens === "number" ? completionDetails.reasoning_tokens : 0,
    },
    total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : input + output,
  }
}

async function consumeSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  consume: (event: string | undefined, data: string) => boolean | void | Promise<boolean | void>,
  forward?: (chunk: Uint8Array) => void | Promise<void>,
  waitForDemand?: () => void | Promise<void>,
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""
  const parse = async (block: string): Promise<boolean> => {
    let event: string | undefined
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
    }
    return data.length ? (await consume(event, data.join("\n"))) !== false : true
  }
  while (true) {
    await waitForDemand?.()
    const { value, done } = await reader.read()
    if (value) await forward?.(value)
    buffer += decoder.decode(value, { stream: !done })
    let boundary: RegExpExecArray | null
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      await waitForDemand?.()
      if (!(await parse(buffer.slice(0, boundary.index)))) return
      buffer = buffer.slice(boundary.index + boundary[0].length)
    }
    if (done) break
  }
  if (buffer.trim()) {
    await waitForDemand?.()
    await parse(buffer)
  }
}

function streamDemandGate() {
  let cancelled = false
  let resume: (() => void) | undefined
  return {
    async wait(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
      while (!cancelled && controller.desiredSize !== null && controller.desiredSize <= 0) {
        await new Promise<void>((resolve) => { resume = resolve })
        resume = undefined
      }
    },
    pull(): void {
      resume?.()
    },
    cancel(): void {
      cancelled = true
      resume?.()
    },
  }
}

function sseEvent(value: JsonRecord): Uint8Array {
  return new TextEncoder().encode(`event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`)
}

function openAiResponsesStream(upstream: Response, model: string): Response {
  if (!upstream.body) return new Response("upstream stream has no body", { status: 502 })
  const upstreamReader = upstream.body.getReader()
  const headers = responseHeaders(upstream)
  headers.set("content-type", "text/event-stream; charset=utf-8")
  const encoder = new TextEncoder()
  let responseId = randomId("resp")
  let closed = false
  let terminal = false
  let doneEmitted = false
  const demand = streamDemandGate()
  const stopReading = Symbol("openai-responses-terminal")
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
      const close = () => {
        if (closed) return
        closed = true
        controller.close()
      }
      const enqueue = async (value: Uint8Array) => {
        await demand.wait(controller)
        if (!closed) controller.enqueue(value)
      }
      const emitDone = async () => {
        if (doneEmitted) return
        doneEmitted = true
        await enqueue(encoder.encode("data: [DONE]\n\n"))
      }
      const fail = async (error: unknown) => {
        if (terminal) return
        terminal = true
        await enqueue(sseEvent({
          type: "response.failed",
          response: {
            id: responseId,
            model,
            status: "failed",
            error: {
              code: "upstream_stream_error",
              message: error instanceof Error ? error.message : String(error),
            },
          },
        }))
      }
      try {
        await consumeSse(upstreamReader, async (event, data) => {
          if (data === "[DONE]") {
            throw stopReading
          }
          const value = JSON.parse(data) as JsonRecord
          if (typeof value.model === "string") value.model = model
          if (value.response && typeof value.response === "object" && !Array.isArray(value.response)) {
            const response = value.response as JsonRecord
            if (typeof response.id === "string") responseId = response.id
            response.model = model
          }
          let payloadType = typeof value.type === "string" ? value.type : undefined
          if (event && payloadType && event !== payloadType) {
            throw new Error(`upstream Responses event type mismatch: ${event} != ${payloadType}`)
          }
          const eventName = payloadType ?? event
          if (!payloadType && eventName) {
            value.type = eventName
            payloadType = eventName
          }
          await enqueue(encoder.encode(`${eventName ? `event: ${eventName}\n` : ""}data: ${JSON.stringify(value)}\n\n`))
          if (payloadType && ["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(payloadType)) {
            terminal = true
            throw stopReading
          }
        }, undefined, () => demand.wait(controller))
        if (!terminal) await fail(new Error("upstream Responses stream closed before a terminal response event"))
        await emitDone()
        close()
      } catch (error) {
        if (closed) return
        if (error !== stopReading) await fail(error)
        else if (!terminal) await fail(new Error("upstream Responses stream ended before a terminal response event"))
        await emitDone()
        close()
        void upstreamReader.cancel().catch(() => undefined)
      }
      })()
    },
    pull() {
      demand.pull()
    },
    cancel() {
      // The consumer owns cancellation; prevent a racing reader failure from
      // enqueueing after the stream has already been cancelled.
      closed = true
      demand.cancel()
      void upstreamReader.cancel().catch(() => undefined)
    },
  })
  return new Response(stream, { status: upstream.status, headers })
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`
}

function chatResponsesStream(upstream: Response, model: string): Response {
  if (!upstream.body) return new Response("upstream stream has no body", { status: 502 })
  const upstreamReader = upstream.body.getReader()
  const headers = responseHeaders(upstream)
  headers.set("content-type", "text/event-stream; charset=utf-8")
  const responseId = randomId("resp")
  const messageId = randomId("msg")
  let closed = false
  const demand = streamDemandGate()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
      const emit = async (value: JsonRecord) => {
        await demand.wait(controller)
        if (!closed) controller.enqueue(sseEvent(value))
      }
      const close = () => {
        if (closed) return
        closed = true
        controller.close()
      }
      let messageStarted = false
      let messageText = ""
      let usage = zeroUsage()
      let terminal = false
      const tools = new Map<number, { callId: string; name: string; arguments: string }>()
      await emit({ type: "response.created", response: { id: responseId, model, status: "in_progress" } })
      try {
        await consumeSse(upstreamReader, async (_event, data) => {
          if (data === "[DONE]") {
            terminal = true
            return false
          }
          const chunk = JSON.parse(data) as JsonRecord
          const nextUsage = chatUsage(chunk.usage)
          if (nextUsage) usage = nextUsage
          if (chunk.error) throw new Error(contentAsText(chunk.error))
          if (!Array.isArray(chunk.choices)) return
          for (const choice of chunk.choices) {
            if (!choice || typeof choice !== "object") continue
            const delta = (choice as JsonRecord).delta
            if (!delta || typeof delta !== "object" || Array.isArray(delta)) continue
            const record = delta as JsonRecord
            if (typeof record.content === "string" && record.content) {
              if (!messageStarted) {
                messageStarted = true
                await emit({
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { id: messageId, type: "message", role: "assistant", content: [] },
                })
              }
              messageText += record.content
              await emit({
                type: "response.output_text.delta",
                item_id: messageId,
                output_index: 0,
                content_index: 0,
                delta: record.content,
              })
            }
            if (Array.isArray(record.tool_calls)) {
              for (const rawTool of record.tool_calls) {
                if (!rawTool || typeof rawTool !== "object" || Array.isArray(rawTool)) continue
                const tool = rawTool as JsonRecord
                const index = typeof tool.index === "number" ? tool.index : 0
                const current = tools.get(index) ?? { callId: "", name: "", arguments: "" }
                if (typeof tool.id === "string") current.callId = tool.id
                if (tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)) {
                  const fn = tool.function as JsonRecord
                  if (typeof fn.name === "string") current.name += fn.name
                  if (typeof fn.arguments === "string") current.arguments += fn.arguments
                }
                tools.set(index, current)
              }
            }
          }
        }, undefined, () => demand.wait(controller))
        if (!terminal) throw new Error("upstream Chat stream closed before [DONE]")
        void upstreamReader.cancel().catch(() => undefined)
        if (messageStarted) {
          await emit({
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: messageId,
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: messageText, annotations: [] }],
            },
          })
        }
        for (const [index, tool] of [...tools.entries()].sort(([a], [b]) => a - b)) {
          if (!tool.callId || !tool.name) throw new Error(`incomplete upstream tool call at index ${index}`)
          await emit({
            type: "response.output_item.done",
            output_index: (messageStarted ? 1 : 0) + index,
            item: functionCallItem(tool.callId, tool.name, tool.arguments),
          })
        }
        await emit({
          type: "response.completed",
          response: { id: responseId, model, status: "completed", usage },
        })
        close()
      } catch (error) {
        if (closed) return
        void upstreamReader.cancel(error).catch(() => undefined)
        await emit({
          type: "response.failed",
          response: {
            id: responseId,
            model,
            status: "failed",
            error: { code: "upstream_stream_error", message: (error as Error).message },
          },
        })
        close()
      }
      })()
    },
    pull() {
      demand.pull()
    },
    cancel() {
      closed = true
      demand.cancel()
      void upstreamReader.cancel().catch(() => undefined)
    },
  })
  return new Response(stream, { status: upstream.status, headers })
}

function anthropicResponsesStream(upstream: Response, model: string): Response {
  if (!upstream.body) return new Response("upstream stream has no body", { status: 502 })
  const upstreamReader = upstream.body.getReader()
  const headers = responseHeaders(upstream)
  headers.set("content-type", "text/event-stream; charset=utf-8")
  const responseId = randomId("resp")
  const messageId = randomId("msg")
  let closed = false
  const demand = streamDemandGate()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
      const emit = async (value: JsonRecord) => {
        await demand.wait(controller)
        if (!closed) controller.enqueue(sseEvent(value))
      }
      const close = () => {
        if (closed) return
        closed = true
        controller.close()
      }
      let messageStarted = false
      let messageText = ""
      let reasoning = ""
      let terminal = false
      let inputTokens = 0
      let cachedTokens = 0
      let cacheWriteTokens = 0
      let outputTokens = 0
      const tools = new Map<number, { callId: string; name: string; arguments: string }>()
      await emit({ type: "response.created", response: { id: responseId, model, status: "in_progress" } })
      try {
        await consumeSse(upstreamReader, async (event, data) => {
          const chunk = JSON.parse(data) as JsonRecord
          const kind = typeof chunk.type === "string" ? chunk.type : event
          switch (kind) {
            case "message_start": {
              const message =
                chunk.message && typeof chunk.message === "object" && !Array.isArray(chunk.message)
                  ? (chunk.message as JsonRecord)
                  : {}
              const usage =
                message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
                  ? (message.usage as JsonRecord)
                  : {}
              inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : inputTokens
              cachedTokens =
                typeof usage.cache_read_input_tokens === "number"
                  ? usage.cache_read_input_tokens
                  : cachedTokens
              cacheWriteTokens =
                typeof usage.cache_creation_input_tokens === "number"
                  ? usage.cache_creation_input_tokens
                  : cacheWriteTokens
              break
            }
            case "content_block_start": {
              const index = typeof chunk.index === "number" ? chunk.index : 0
              const block =
                chunk.content_block && typeof chunk.content_block === "object" && !Array.isArray(chunk.content_block)
                  ? (chunk.content_block as JsonRecord)
                  : {}
              if (block.type === "text") {
                if (!messageStarted) {
                  messageStarted = true
                  await emit({
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { id: messageId, type: "message", role: "assistant", content: [] },
                  })
                }
                if (typeof block.text === "string" && block.text) {
                  messageText += block.text
                  await emit({
                    type: "response.output_text.delta",
                    item_id: messageId,
                    output_index: 0,
                    content_index: 0,
                    delta: block.text,
                  })
                }
              } else if (block.type === "tool_use") {
                tools.set(index, {
                  callId: text(block.id, `content_block_start[${index}].id`),
                  name: text(block.name, `content_block_start[${index}].name`),
                  arguments:
                    block.input && typeof block.input === "object" && Object.keys(block.input as JsonRecord).length
                      ? JSON.stringify(block.input)
                      : "",
                })
              } else if (block.type === "thinking" && typeof block.thinking === "string") {
                reasoning += block.thinking
              }
              break
            }
            case "content_block_delta": {
              const index = typeof chunk.index === "number" ? chunk.index : 0
              const delta =
                chunk.delta && typeof chunk.delta === "object" && !Array.isArray(chunk.delta)
                  ? (chunk.delta as JsonRecord)
                  : {}
              if (delta.type === "text_delta" && typeof delta.text === "string") {
                if (!messageStarted) {
                  messageStarted = true
                  await emit({
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { id: messageId, type: "message", role: "assistant", content: [] },
                  })
                }
                messageText += delta.text
                await emit({
                  type: "response.output_text.delta",
                  item_id: messageId,
                  output_index: 0,
                  content_index: 0,
                  delta: delta.text,
                })
              } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                const tool = tools.get(index)
                if (!tool) throw new Error(`tool delta without tool start at index ${index}`)
                tool.arguments += delta.partial_json
              } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                reasoning += delta.thinking
              }
              break
            }
            case "message_delta": {
              const usage =
                chunk.usage && typeof chunk.usage === "object" && !Array.isArray(chunk.usage)
                  ? (chunk.usage as JsonRecord)
                  : {}
              if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens
              if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens
              if (typeof usage.cache_read_input_tokens === "number") {
                cachedTokens = usage.cache_read_input_tokens
              }
              if (typeof usage.cache_creation_input_tokens === "number") {
                cacheWriteTokens = usage.cache_creation_input_tokens
              }
              break
            }
            case "message_stop":
              terminal = true
              return false
            case "error":
              throw new Error(contentAsText(chunk.error ?? chunk))
          }
        }, undefined, () => demand.wait(controller))
        if (!terminal) throw new Error("upstream Anthropic stream closed before message_stop")
        void upstreamReader.cancel().catch(() => undefined)
        if (messageStarted) {
          await emit({
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: messageId,
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: messageText, annotations: [] }],
            },
          })
        }
        if (reasoning) {
          await emit({
            type: "response.output_item.done",
            output_index: messageStarted ? 1 : 0,
            item: {
              id: randomId("rs"),
              type: "reasoning",
              summary: [{ type: "summary_text", text: reasoning }],
              content: [{ type: "reasoning_text", text: reasoning }],
            },
          })
        }
        let outputIndex = (messageStarted ? 1 : 0) + (reasoning ? 1 : 0)
        for (const [, tool] of [...tools.entries()].sort(([a], [b]) => a - b)) {
          // A valid Anthropic tool_use input is always a JSON object. Parsing here
          // makes a truncated stream fail before Codex can execute a malformed call.
          parsedArguments(tool.arguments || "{}", `tool ${tool.callId} arguments`)
          await emit({
            type: "response.output_item.done",
            output_index: outputIndex++,
            item: functionCallItem(tool.callId, tool.name, tool.arguments || "{}"),
          })
        }
        const billedInput = inputTokens + cachedTokens + cacheWriteTokens
        const usage: ResponsesUsage = {
          input_tokens: billedInput,
          input_tokens_details: {
            cached_tokens: cachedTokens,
            cache_write_tokens: cacheWriteTokens,
          },
          output_tokens: outputTokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: billedInput + outputTokens,
        }
        await emit({
          type: "response.completed",
          response: { id: responseId, model, status: "completed", usage },
        })
        close()
      } catch (error) {
        if (closed) return
        void upstreamReader.cancel(error).catch(() => undefined)
        await emit({
          type: "response.failed",
          response: {
            id: responseId,
            model,
            status: "failed",
            error: { code: "upstream_stream_error", message: (error as Error).message },
          },
        })
        close()
      }
      })()
    },
    pull() {
      demand.pull()
    },
    cancel() {
      closed = true
      demand.cancel()
      void upstreamReader.cancel().catch(() => undefined)
    },
  })
  return new Response(stream, { status: upstream.status, headers })
}

function responseMessage(textValue: string): JsonRecord {
  return {
    id: randomId("msg"),
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: textValue, annotations: [] }],
  }
}

function chatResponsesJson(body: JsonRecord, model: string): JsonRecord {
  const choices = records(body.choices, "upstream choices")
  if (choices.length !== 1) throw new Error("upstream Chat response must contain exactly one choice")
  const message = choices[0]!.message
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("upstream Chat response choice.message must be an object")
  }
  const value = message as JsonRecord
  const output: JsonRecord[] = []
  if (typeof value.content === "string" && value.content) output.push(responseMessage(value.content))
  else if (Array.isArray(value.content)) {
    const combined = value.content
      .map((part) =>
        part && typeof part === "object" && !Array.isArray(part) && typeof (part as JsonRecord).text === "string"
          ? String((part as JsonRecord).text)
          : "",
      )
      .join("")
    if (combined) output.push(responseMessage(combined))
  }
  if (typeof value.reasoning_content === "string" && value.reasoning_content) {
    output.push({
      id: randomId("rs"),
      type: "reasoning",
      summary: [{ type: "summary_text", text: value.reasoning_content }],
      content: [{ type: "reasoning_text", text: value.reasoning_content }],
    })
  }
  if (value.tool_calls !== undefined) {
    for (const [index, raw] of records(value.tool_calls, "upstream tool_calls").entries()) {
      const fn = raw.function
      if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
        throw new Error(`upstream tool_calls[${index}].function must be an object`)
      }
      const functionValue = fn as JsonRecord
      output.push(
        functionCallItem(
          text(raw.id, `upstream tool_calls[${index}].id`),
          text(functionValue.name, `upstream tool_calls[${index}].function.name`),
          text(functionValue.arguments, `upstream tool_calls[${index}].function.arguments`),
        ),
      )
    }
  }
  return {
    id: typeof body.id === "string" ? body.id : randomId("resp"),
    object: "response",
    model,
    status: "completed",
    output,
    usage: chatUsage(body.usage) ?? zeroUsage(),
  }
}

function anthropicUsage(raw: unknown): ResponsesUsage {
  const usage = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as JsonRecord) : {}
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0
  const cached = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0
  const cacheWrite =
    typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0
  const billedInput = input + cached + cacheWrite
  return {
    input_tokens: billedInput,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: cacheWrite },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: billedInput + output,
  }
}

function anthropicResponsesJson(body: JsonRecord, model: string): JsonRecord {
  const output: JsonRecord[] = []
  let textValue = ""
  for (const [index, block] of records(body.content, "upstream content").entries()) {
    switch (block.type) {
      case "text":
        textValue += text(block.text, `upstream content[${index}].text`)
        break
      case "thinking": {
        const reasoning = text(block.thinking, `upstream content[${index}].thinking`)
        output.push({
          id: randomId("rs"),
          type: "reasoning",
          summary: [{ type: "summary_text", text: reasoning }],
          content: [{ type: "reasoning_text", text: reasoning }],
        })
        break
      }
      case "tool_use":
        output.push(
          functionCallItem(
            text(block.id, `upstream content[${index}].id`),
            text(block.name, `upstream content[${index}].name`),
            JSON.stringify(block.input ?? {}),
          ),
        )
        break
      default:
        throw new Error(`unsupported upstream Anthropic content type ${String(block.type)}`)
    }
  }
  if (textValue) output.unshift(responseMessage(textValue))
  return {
    id: typeof body.id === "string" ? body.id : randomId("resp"),
    object: "response",
    model,
    status: "completed",
    output,
    usage: anthropicUsage(body.usage),
  }
}

export async function passthroughResponse(
  provider: ParsedProvider,
  upstream: Response,
  model: string,
): Promise<Response> {
  const contentType = upstream.headers.get("content-type") ?? ""
  if (contentType.includes("text/event-stream") && provider.format === "openai-responses") {
    return openAiResponsesStream(upstream, model)
  }
  if (contentType.includes("text/event-stream") && provider.format === "openai-compatible") {
    return chatResponsesStream(upstream, model)
  }
  if (contentType.includes("text/event-stream") && provider.format === "anthropic") {
    return anthropicResponsesStream(upstream, model)
  }
  if (!contentType.includes("application/json")) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream),
    })
  }
  const raw = await upstream.text()
  if (!raw) return new Response(null, { status: upstream.status, headers: responseHeaders(upstream) })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return new Response(raw, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream),
    })
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    if (upstream.ok && provider.format === "openai-compatible") {
      body = chatResponsesJson(record, model)
    } else if (upstream.ok && provider.format === "anthropic") {
      body = anthropicResponsesJson(record, model)
    } else if (upstream.ok) {
      record.model = model
    } else {
      const caller = callerModel(provider, record.model)
      if (caller) record.model = caller
    }
  }
  return Response.json(body, { status: upstream.status, headers: responseHeaders(upstream) })
}

function observedUsage(
  payload: unknown,
  provider: ParsedProvider,
  model: string,
  attribution?: { threadId?: string; turnId?: string },
  reservation?: UsageReservationRef,
): ProviderBridgeUsage | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined
  const envelope = payload as JsonRecord
  const response = typeof envelope.type === "string" && [
    "response.completed",
    "response.failed",
    "response.incomplete",
    "response.cancelled",
  ].includes(envelope.type)
    ? envelope.response && typeof envelope.response === "object" && !Array.isArray(envelope.response)
      ? envelope.response as JsonRecord
      : {}
    : envelope
  const responseId = typeof response.id === "string" ? response.id : undefined
  const usage = response.usage && typeof response.usage === "object" && !Array.isArray(response.usage)
    ? response.usage as JsonRecord
    : undefined
  if (!responseId || !usage) return undefined
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === "object" && !Array.isArray(usage.input_tokens_details)
    ? usage.input_tokens_details as JsonRecord
    : {}
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === "object" && !Array.isArray(usage.output_tokens_details)
    ? usage.output_tokens_details as JsonRecord
    : {}
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0
  const configured = provider.models[model]
  return {
    providerId: provider.id,
    model,
    responseId,
    ...(attribution?.threadId ? { threadId: attribution.threadId } : {}),
    ...(attribution?.turnId ? { turnId: attribution.turnId } : {}),
    ...(reservation ? { reservation } : {}),
    inputTokens,
    contextInputTokens: inputTokens,
    billableInputTokens: inputTokens,
    cachedInputTokens: typeof inputDetails.cached_tokens === "number" ? inputDetails.cached_tokens : 0,
    cacheWriteInputTokens: typeof inputDetails.cache_write_tokens === "number" ? inputDetails.cache_write_tokens : 0,
    outputTokens,
    reasoningOutputTokens: typeof outputDetails.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : 0,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : inputTokens + outputTokens,
    ...(configured?.context ? { contextWindow: configured.context } : {}),
  }
}

export function observeResponseUsage(
  response: Response,
  provider: ParsedProvider,
  model: string,
  attribution: { threadId?: string; turnId?: string } | undefined,
  reservation: UsageReservationRef | undefined,
  onUsage?: ProviderBridgeOptions["onUsage"],
  onRequestFinished?: ProviderBridgeOptions["onRequestFinished"],
  track?: (task: Promise<void>) => void,
  registerActiveStream?: (threadId: string | undefined, cancel: (reason: string) => Promise<void>) => () => void,
  cancelUpstream?: (reason: unknown) => void,
): Response {
  const release = async (reason: string) => {
    if (reservation && onRequestFinished) await onRequestFinished(reservation, "released", reason)
  }
  const scheduleRelease = (reason: string) => {
    const task = release(reason)
    if (track) track(task)
    else void task.catch(() => undefined)
  }
  if (!response.ok) {
    scheduleRelease(`upstream_status_${response.status}`)
    return response
  }
  if (!response.body || !onUsage) {
    scheduleRelease(!response.body ? "empty_response_body" : "usage_observer_disabled")
    return response
  }
  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.includes("text/event-stream")) {
    const reader = response.body.getReader()
    let terminal: ProviderBridgeUsage | undefined
    let cancelled = false
    let settled = false
    let resumeDemand: (() => void) | undefined
    let resolveTask!: () => void
    let rejectTask!: (error: unknown) => void
    const task = new Promise<void>((resolve, reject) => {
      resolveTask = resolve
      rejectTask = reject
    })
    const settle = async (reason: string, error?: unknown) => {
      if (settled) return
      settled = true
      try {
        if (terminal) {
          await onUsage(terminal)
          if (reservation && onRequestFinished) await onRequestFinished(reservation, "usage", "usage_observed")
        } else {
          await release(reason)
        }
        if (error === undefined) resolveTask()
        else rejectTask(error)
      } catch (observerError) {
        if (terminal) {
          try { await release("stream_usage_observer_error") } catch {}
        }
        rejectTask(observerError)
      }
    }
    const cancelStream = async (reason: string, readerReason: unknown = reason) => {
      if (cancelled) return
      cancelled = true
      resumeDemand?.()
      resumeDemand = undefined
      cancelUpstream?.(readerReason)
      try {
        await reader.cancel(readerReason)
      } finally {
        await settle(reason)
      }
    }
    const client = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          try {
            await consumeSse(reader, (_event, data) => {
              if (data === "[DONE]") return
              const usage = observedUsage(JSON.parse(data), provider, model, attribution, reservation)
              if (usage) terminal = usage
            }, async (chunk) => {
              while (!cancelled && controller.desiredSize !== null && controller.desiredSize <= 0) {
                await new Promise<void>((resolve) => { resumeDemand = resolve })
                resumeDemand = undefined
              }
              if (!cancelled) controller.enqueue(chunk)
            })
            if (cancelled) return
            controller.close()
            await settle("stream_completed_without_usage")
          } catch (error) {
            if (cancelled) return
            controller.error(error)
            await settle("stream_usage_observer_error", error)
          }
        })()
      },
      pull() {
        resumeDemand?.()
      },
      async cancel(reason) {
        await cancelStream("stream_cancelled", reason)
      },
    })
    const unregister = registerActiveStream?.(attribution?.threadId, (reason) => cancelStream(reason))
    if (unregister) void task.finally(unregister).catch(() => undefined)
    if (track) track(task)
    else void task.catch(() => undefined)
    return new Response(client, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
  if (!/json/i.test(contentType)) {
    scheduleRelease("non_json_response")
    return response
  }
  const copy = response.clone()
  let cancelled = false
  let finished = false
  let releaseCancellation!: () => void
  const cancellation = new Promise<void>((resolve) => { releaseCancellation = resolve })
  const task = (async () => {
    const json = copy.json()
    void json.catch(() => undefined)
    try {
      const payload = await Promise.race([json, cancellation.then(() => undefined)])
      if (cancelled) return
      finished = true
      const usage = observedUsage(payload, provider, model, attribution, reservation)
      if (usage) {
        await onUsage(usage)
        if (reservation && onRequestFinished) await onRequestFinished(reservation, "usage", "usage_observed")
      } else {
        await release("response_completed_without_usage")
      }
    } catch (error) {
      if (cancelled) return
      await release("response_usage_observer_error")
      throw error
    }
  })()
  const unregister = registerActiveStream?.(attribution?.threadId, async (reason) => {
    if (cancelled || finished) return
    cancelled = true
    cancelUpstream?.(reason)
    releaseCancellation()
    try { await copy.body?.cancel(reason) } catch {}
    await release(reason)
  })
  if (unregister) void task.finally(unregister).catch(() => undefined)
  if (track) track(task)
  else void task.catch(() => undefined)
  return response
}

async function handleProviderRequest(
  request: Request,
  provider: ParsedProvider,
  providerSet: ProviderSet,
  providers: Map<string, ParsedProvider>,
  onUsage?: ProviderBridgeOptions["onUsage"],
  onBeforeRequest?: ProviderBridgeOptions["onBeforeRequest"],
  onRequestFinished?: ProviderBridgeOptions["onRequestFinished"],
  trackUsage?: (task: Promise<void>) => void,
  registerActiveStream?: (threadId: string | undefined, cancel: (reason: string) => Promise<void>) => () => void,
  upstreamAbort?: AbortController,
): Promise<Response> {
  let body: Record<string, unknown>
  let callerModelKey = ""
  let responseModelKey = ""
  let effectiveProvider = provider
  let attribution: { threadId?: string; turnId?: string } | undefined
  let reservation: UsageReservationRef | undefined
  try {
    const raw = await readRequestJson(request, upstreamAbort?.signal)
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("body must be an object")
    callerModelKey = text((raw as Record<string, unknown>).model, "model")
    const metadata = (raw as Record<string, unknown>).client_metadata
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      const value = metadata as Record<string, unknown>
      attribution = {
        ...(typeof value.thread_id === "string" && value.thread_id ? { threadId: value.thread_id } : {}),
        ...(typeof value.turn_id === "string" && value.turn_id ? { turnId: value.turn_id } : {}),
      }
    }
    responseModelKey = callerModelKey
    const leafModel = callerModelKey === providerSet.reviewModelKey
      && (provider.id === providerSet.main.providerId || provider.id === providerSet.small.providerId)
      ? providerSet.small
      : callerModelKey === providerSet.workerModelKey && provider.id === providerSet.main.providerId
        ? providerSet.main
        : undefined
    if (leafModel) {
      effectiveProvider = providers.get(leafModel.providerId)!
      callerModelKey = leafModel.modelKey
      ;(raw as Record<string, unknown>).model = callerModelKey
    }
    const translated = translateResponsesRequest(effectiveProvider, raw as Record<string, unknown>)
    body = translated.body
    if (onBeforeRequest) {
      const configured = effectiveProvider.models[callerModelKey]
      const admission = await onBeforeRequest({
        providerId: effectiveProvider.id,
        model: callerModelKey,
        ...attribution,
        ...(configured?.context ? { contextWindow: configured.context } : {}),
        estimatedTokens: estimateProviderRequestTokens(body, configured?.context),
      })
      if (!admission.allowed) {
        if (admission.reservation && onRequestFinished) {
          try {
            await onRequestFinished(admission.reservation, "released", "admission_denied")
          } catch {
            // Admission is already denied; cleanup failure must not expose a secret or alter the stable 429 response.
          }
        }
        return scrubResponse(Response.json({
          error: {
            type: "token_budget_admission_denied",
            message: admission.reason ?? "provider request denied by runtime admission policy",
          },
        }, { status: 429 }), effectiveProvider)
      }
      reservation = admission.reservation
    }
  } catch (error) {
    if (reservation && onRequestFinished) await onRequestFinished(reservation, "released", "request_translation_error")
    return scrubResponse(Response.json(
      { error: { type: "invalid_request_error", message: (error as Error).message } },
      { status: 400 },
    ), effectiveProvider)
  }

  const target = `${effectiveProvider.baseUrl}/${upstreamPath(effectiveProvider)}`
  let upstream: Response
  const requestAbort = upstreamAbort ?? new AbortController()
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: upstreamHeaders(effectiveProvider, request),
      body: JSON.stringify(body),
      signal: AbortSignal.any([request.signal, requestAbort.signal]),
      redirect: "error",
    })
  } catch (error) {
    if (reservation && onRequestFinished) await onRequestFinished(reservation, "released", "upstream_transport_error")
    return scrubResponse(Response.json(
      { error: { type: "upstream_transport_error", message: (error as Error).message } },
      { status: 502 },
    ), effectiveProvider)
  }
  try {
    return observeResponseUsage(
      scrubResponse(await passthroughResponse(effectiveProvider, upstream, responseModelKey), effectiveProvider),
      effectiveProvider,
      callerModelKey,
      attribution,
      reservation,
      onUsage,
      onRequestFinished,
      trackUsage,
      registerActiveStream,
      (reason) => requestAbort.abort(reason),
    )
  } catch (error) {
    if (reservation && onRequestFinished) await onRequestFinished(reservation, "released", "response_translation_error")
    return scrubResponse(Response.json(
      { error: { type: "upstream_response_error", message: (error as Error).message } },
      { status: 502 },
    ), effectiveProvider)
  }
}

export function startProviderBridge(
  providerSet: ProviderSet,
  options: ProviderBridgeOptions = {},
): ProviderBridge {
  const token = options.token ?? randomBytes(32).toString("base64url")
  const hostname = options.hostname ?? "127.0.0.1"
  const providers = new Map(providerSet.providers.map((provider) => [provider.id, provider]))
  const usageTasks = new Set<Promise<void>>()
  const requestTasks = new Set<Promise<Response>>()
  const usageErrors: unknown[] = []
  const activeRequests = new Set<{ cancel: (reason: string) => void }>()
  const activeStreams = new Set<{ threadId?: string; cancel: (reason: string) => Promise<void> }>()
  let sealed = false
  const trackUsage = (task: Promise<void>) => {
    usageTasks.add(task)
    void task.catch((error) => { usageErrors.push(error) }).finally(() => { usageTasks.delete(task) })
  }
  const drainUsage = async () => {
    while (usageTasks.size) await Promise.allSettled([...usageTasks])
    if (usageErrors.length) throw new AggregateError(usageErrors.splice(0), "provider usage observer failed")
  }
  const registerActiveStream = (threadId: string | undefined, cancel: (reason: string) => Promise<void>) => {
    const active = { ...(threadId ? { threadId } : {}), cancel }
    activeStreams.add(active)
    return () => { activeStreams.delete(active) }
  }
  const registerActiveRequest = (cancel: (reason: string) => void) => {
    const active = { cancel }
    activeRequests.add(active)
    return () => { activeRequests.delete(active) }
  }
  const cancelThread = async (threadId: string, reason = "thread_terminal") => {
    if (!threadId) throw new Error("provider stream cancellation requires a thread id")
    const matches = [...activeStreams].filter((active) => active.threadId === threadId)
    for (const active of matches) activeStreams.delete(active)
    await Promise.all(matches.map((active) => active.cancel(reason)))
    return matches.length
  }
  const sealAndDrain = async () => {
    sealed = true
    const requests = [...activeRequests]
    for (const request of requests) activeRequests.delete(request)
    for (const request of requests) request.cancel("bridge_sealed")
    while (requestTasks.size) await Promise.allSettled([...requestTasks])
    while (activeStreams.size) {
      const active = [...activeStreams]
      for (const stream of active) activeStreams.delete(stream)
      await Promise.allSettled(active.map((stream) => stream.cancel("bridge_sealed")))
    }
    await drainUsage()
  }
  const server = Bun.serve({
    hostname,
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, providers: providers.size })
      }
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
      if (!authorized(request, token)) return new Response("unauthorized", { status: 401 })
      const match = url.pathname.match(/^\/providers\/([^/]+)\/v1\/responses$/)
      if (!match) return new Response("not found", { status: 404 })
      let providerId: string
      try {
        providerId = decodeURIComponent(match[1]!)
      } catch {
        return new Response("invalid provider id", { status: 400 })
      }
      const provider = providers.get(providerId)
      if (!provider) return new Response("unknown provider", { status: 404 })
      if (sealed) {
        return Response.json(
          { error: { type: "provider_admission_closed", message: "provider admission is sealed" } },
          { status: 409 },
        )
      }
      const upstreamAbort = new AbortController()
      const unregisterActiveRequest = registerActiveRequest((reason) => upstreamAbort.abort(reason))
      const task = handleProviderRequest(
        request,
        provider,
        providerSet,
        providers,
        options.onUsage,
        options.onBeforeRequest,
        options.onRequestFinished,
        trackUsage,
        registerActiveStream,
        upstreamAbort,
      )
      requestTasks.add(task)
      try {
        return await task
      } finally {
        unregisterActiveRequest()
        requestTasks.delete(task)
      }
    },
  })

  let closeTask: Promise<void> | undefined
  return {
    baseUrl: `http://${hostname}:${server.port}`,
    token,
    drain: drainUsage,
    cancelThread,
    sealAndDrain,
    async close() {
      closeTask ??= (async () => {
        sealed = true
        await server.stop(true)
        await sealAndDrain()
      })()
      await closeTask
    },
  }
}
