import { expect, test } from "bun:test"
import { startProviderBridge, translateResponsesRequest } from "./provider-bridge"
import { parseProviders } from "./providers"

test("openai-responses bridge accepts only its loopback token and forwards the original provider key", async () => {
  let observed: { url: string; authorization: string | null; body: unknown } | undefined
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      observed = {
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      }
      return Response.json({ id: "resp_1", model: "upstream/gpt-5.6-sol", output: [] })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: `${upstream.url}v1`,
        models: {
          primary: { upstream_id: "upstream/gpt-5.6-sol", context: 372000, output: 131072 },
        },
      },
    }),
    providerKeysJson: JSON.stringify({ relay: "real-provider-key" }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers, { token: "loopback-token" })

  try {
    const denied = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: "{}",
    })
    expect(denied.status).toBe(401)

    const response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "hello", stream: true }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: "resp_1", model: "primary", output: [] })
    expect(observed).toEqual({
      url: `${upstream.url}v1/responses`,
      authorization: "Bearer real-provider-key",
      body: { model: "upstream/gpt-5.6-sol", input: "hello", max_output_tokens: 131072, stream: true },
    })
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})

test("cancelling a streamed response cancels the locked upstream reader without crashing", async () => {
  const encoder = new TextEncoder()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_cancel","status":"in_progress"}}\n\n'))
        },
        cancel() {},
      }), { headers: { "content-type": "text/event-stream" } })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: `${upstream.url}v1`,
        models: { primary: { upstream_id: "upstream/gpt-5.6-sol" } },
      },
    }),
    providerKeysJson: JSON.stringify({ relay: "real-provider-key" }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers)
  try {
    const response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "cancel", stream: true }),
    })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    await expect(reader.cancel()).resolves.toBeUndefined()
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})

test("provider bridge redacts upstream credentials from structured error responses", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return Response.json({
        error: {
          message: `authorization=${request.headers.get("authorization")} custom=${request.headers.get("x-custom-secret")}`,
        },
        model: "upstream/gpt-5.6-sol",
      }, { status: 401 })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: `${upstream.url}v1`,
        headers: { "x-custom-secret": "custom-provider-secret" },
        models: { primary: { upstream_id: "upstream/gpt-5.6-sol" } },
      },
    }),
    providerKeysJson: JSON.stringify({ relay: "provider-api-secret" }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers, { token: "bridge" })

  try {
    const response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer bridge", "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "hello" }),
    })
    const raw = await response.text()
    expect(response.status).toBe(401)
    expect(raw).not.toContain("provider-api-secret")
    expect(raw).not.toContain("custom-provider-secret")
    expect(raw).toContain("[REDACTED]")
    expect(JSON.parse(raw)).toMatchObject({ model: "primary" })
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})

test("provider bridge redacts JSON-escaped credential values from structured errors", async () => {
  const secret = 'ghp_"provider-secret'
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return Response.json({ error: { message: request.headers.get("x-custom-secret") } }, { status: 401 })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: `${upstream.url}v1`,
        headers: { "x-custom-secret": secret },
        models: { primary: { upstream_id: "upstream/gpt-5.6-sol" } },
      },
    }),
    providerKeysJson: JSON.stringify({ relay: "provider-api-secret" }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers, { token: "bridge" })
  try {
    const response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer bridge", "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "hello" }),
    })
    const payload = await response.json() as { error: { message: string } }
    expect(payload.error.message).not.toContain(secret)
    expect(payload.error.message).toContain("[REDACTED]")
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})

test("provider bridge redacts scheme-stripped credentials across raw response chunk boundaries", async () => {
  const secret = "scheme-stripped-secret"
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const split = Math.floor(secret.length / 2)
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(`credential=${secret.slice(0, split)}`))
          controller.enqueue(Buffer.from(secret.slice(split)))
          controller.close()
        },
      }), { status: 401, headers: { "content-type": "text/plain" } })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: `${upstream.url}v1`,
        headers: { Authorization: `Bearer ${secret}` },
        models: { primary: { upstream_id: "upstream/gpt-5.6-sol" } },
      },
    }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers, { token: "bridge" })
  try {
    const response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer bridge", "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "hello" }),
    })
    const raw = await response.text()
    expect(raw).not.toContain(secret)
    expect(raw).toContain("[REDACTED]")
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})

test("non-reasoning models remove reasoning controls for every provider protocol", () => {
  for (const format of ["openai-responses", "openai-compatible", "anthropic"] as const) {
    const providers = parseProviders({
      providerJson: JSON.stringify({
        main: {
          format: "openai-responses",
          base_url: "https://main.example/v1",
          models: { "gpt-5.6-sol": { reasoning: true } },
        },
        small: {
          format,
          base_url: "https://small.example/v1",
          models: { leaf: { upstream_id: "small-model", reasoning: false } },
        },
      }),
      model: "main/gpt-5.6-sol",
      smallModel: "small/leaf",
    })
    const small = providers.providers.find((provider) => provider.id === "small")!
    const translated = translateResponsesRequest(small, {
      model: "leaf",
      input: "inspect",
      reasoning: { effort: "high" },
    })
    expect(translated.body).not.toHaveProperty("reasoning")
    expect(translated.body).not.toHaveProperty("reasoning_effort")
    expect(translated.body).not.toHaveProperty("thinking")
  }
})

test("maps internal leaf model aliases back to the unchanged caller models", async () => {
  const observations: Array<{ pathname: string; model: unknown }> = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as Record<string, unknown>
      observations.push({ pathname: new URL(request.url).pathname, model: body.model })
      return Response.json({ id: `resp_${observations.length}`, model: body.model, output: [] })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      main: {
        format: "openai-responses",
        base_url: `${upstream.url}main/v1`,
        models: { "gpt-5.6-sol": { context: 372000, output: 131072 } },
      },
      small: {
        format: "openai-responses",
        base_url: `${upstream.url}small/v1`,
        models: { review: { upstream_id: "gpt-5.6-sol-mini", context: 128000, output: 32000 } },
      },
    }),
    providerKeysJson: JSON.stringify({ main: "main-key", small: "small-key" }),
    model: "main/gpt-5.6-sol",
    smallModel: "small/review",
  })
  const bridge = startProviderBridge(providers, { token: "loopback-token" })

  try {
    for (const model of [providers.reviewModelKey, providers.workerModelKey]) {
      const response = await fetch(`${bridge.baseUrl}/providers/main/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model, input: "leaf" }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ model })
    }
    expect(observations).toEqual([
      { pathname: "/small/v1/responses", model: "gpt-5.6-sol-mini" },
      { pathname: "/main/v1/responses", model: "gpt-5.6-sol" },
    ])
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})

test("restores internal leaf model aliases in openai-responses SSE events", async () => {
  let observedModel: unknown
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as Record<string, unknown>
      observedModel = body.model
      const events = [
        {
          type: "response.created",
          response: { id: "resp_leaf", model: body.model, status: "in_progress" },
        },
        {
          type: "response.output_text.delta",
          model: body.model,
          delta: "leaf",
        },
        {
          type: "response.completed",
          response: {
            id: "resp_leaf",
            model: body.model,
            status: "completed",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]
      return new Response(
        `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      main: {
        format: "openai-responses",
        base_url: `${upstream.url}main/v1`,
        models: { "gpt-5.6-sol": { context: 372000, output: 131072 } },
      },
      small: {
        format: "openai-responses",
        base_url: `${upstream.url}small/v1`,
        models: { review: { upstream_id: "gpt-5.6-sol-mini", context: 128000, output: 32000 } },
      },
    }),
    providerKeysJson: JSON.stringify({ main: "main-key", small: "small-key" }),
    model: "main/gpt-5.6-sol",
    smallModel: "small/review",
  })
  const bridge = startProviderBridge(providers, { token: "loopback-token" })

  try {
    const response = await fetch(`${bridge.baseUrl}/providers/main/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: providers.reviewModelKey, input: "leaf", stream: true }),
    })
    expect(response.status).toBe(200)
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    expect(observedModel).toBe("gpt-5.6-sol-mini")
    expect(events).toEqual([
      {
        type: "response.created",
        response: { id: "resp_leaf", model: providers.reviewModelKey, status: "in_progress" },
      },
      {
        type: "response.output_text.delta",
        model: providers.reviewModelKey,
        delta: "leaf",
      },
      {
        type: "response.completed",
        response: {
          id: "resp_leaf",
          model: providers.reviewModelKey,
          status: "completed",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ])
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})

test("reports stable provider response usage without exposing the upstream credential", async () => {
  const usage: Array<Record<string, unknown>> = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({
        id: "resp_stable",
        model: "gpt-5.6-sol",
        status: "completed",
        output: [],
        usage: {
          input_tokens: 20_000,
          input_tokens_details: { cached_tokens: 3_000, cache_write_tokens: 500 },
          output_tokens: 1_000,
          output_tokens_details: { reasoning_tokens: 400 },
          total_tokens: 21_000,
        },
      })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      "gpt-cchp": {
        format: "openai-responses",
        base_url: `${upstream.url}v1`,
        models: { "gpt-5.6-sol": { context: 372000, output: 131072 } },
      },
    }),
    providerKeysJson: JSON.stringify({ "gpt-cchp": "provider-secret" }),
    model: "gpt-cchp/gpt-5.6-sol",
  })
  const bridge = startProviderBridge(providers, {
    token: "loopback-token",
    onUsage: async (record) => { usage.push(record as unknown as Record<string, unknown>) },
  })
  try {
    const response = await fetch(`${bridge.baseUrl}/providers/gpt-cchp/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "inspect" }),
    })
    await response.json()
    for (let index = 0; index < 100 && usage.length === 0; index++) await Bun.sleep(5)
    expect(usage).toEqual([{
      providerId: "gpt-cchp",
      model: "gpt-5.6-sol",
      responseId: "resp_stable",
      inputTokens: 20_000,
      contextInputTokens: 20_000,
      billableInputTokens: 20_000,
      cachedInputTokens: 3_000,
      cacheWriteInputTokens: 500,
      outputTokens: 1_000,
      reasoningOutputTokens: 400,
      totalTokens: 21_000,
      contextWindow: 372_000,
    }])
    expect(JSON.stringify(usage)).not.toContain("provider-secret")
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})

test("drains delayed usage observers before the bridge closes", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let observed = false
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({
        id: "resp_delayed",
        model: "primary",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: `${upstream.url}v1`,
        models: { primary: { upstream_id: "gpt-5.6-sol", context: 1000, output: 100 } },
      },
    }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers, {
    onUsage: async () => {
      await gate
      observed = true
    },
  })
  try {
    const response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "inspect" }),
    })
    await response.json()
    let drained = false
    const draining = bridge.drain().then(() => { drained = true })
    await Bun.sleep(20)
    expect(drained).toBe(false)
    release()
    await draining
    expect(observed).toBe(true)
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})

test("converts Responses messages and tool history to OpenAI Chat without changing caller config", () => {
  const provider = parseProviders({
    providerJson: JSON.stringify({
      chat: {
        format: "openai-compatible",
        base_url: "https://chat.example/v1",
        models: { primary: { upstream_id: "openai/gpt-5.6-sol", output: 64000, vision: true } },
      },
    }),
    model: "chat/primary",
  }).providers[0]!

  expect(
    translateResponsesRequest(provider, {
      model: "primary",
      instructions: "trusted system",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "inspect" }] },
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
        { type: "function_call_output", call_id: "call_1", output: "source" },
      ],
      tools: [{ type: "function", name: "read_file", description: "read", parameters: { type: "object" } }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "high" },
      stream: true,
    }),
  ).toEqual({
    path: "chat/completions",
    body: {
      model: "openai/gpt-5.6-sol",
      messages: [
        { role: "system", content: "trusted system" },
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "source" },
      ],
      tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning_effort: "high",
      max_completion_tokens: 64000,
      stream: true,
      stream_options: { include_usage: true },
    },
  })
})

test("converts Responses history to Anthropic system, tool_use and tool_result blocks", () => {
  const provider = parseProviders({
    providerJson: JSON.stringify({
      claude: {
        format: "anthropic",
        base_url: "https://api.anthropic.com/v1",
        models: { primary: { upstream_id: "vendor/gpt-5.6-sol", output: 32000 } },
      },
    }),
    model: "claude/primary",
  }).providers[0]!

  expect(
    translateResponsesRequest(provider, {
      model: "primary",
      instructions: "trusted system",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "policy" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "inspect" }] },
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
        { type: "function_call_output", call_id: "call_1", output: "source" },
      ],
      tools: [{ type: "function", name: "read_file", description: "read", parameters: { type: "object" } }],
      tool_choice: "auto",
      reasoning: { effort: "high" },
      stream: true,
    }),
  ).toEqual({
    path: "messages",
    body: {
      model: "vendor/gpt-5.6-sol",
      system: "trusted system\n\npolicy",
      messages: [
        { role: "user", content: [{ type: "text", text: "inspect" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "source" }] },
      ],
      tools: [{ name: "read_file", description: "read", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
      thinking: { type: "adaptive" },
      max_tokens: 32000,
      stream: true,
    },
  })
})

test("maps Responses Lite additional tools and namespaced history to Chat and Anthropic", () => {
  const providerJson = (format: "openai-compatible" | "anthropic") =>
    JSON.stringify({
      relay: {
        format,
        base_url: "https://provider.example/v1",
        models: { primary: { upstream_id: "vendor/gpt-5.6-sol", output: 32000 } },
      },
    })
  const request = {
    model: "primary",
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "agents.v2",
            tools: [
              {
                type: "function",
                name: "spawn__agent",
                description: "spawn one child",
                parameters: {
                  type: "object",
                  properties: { task_name: { type: "string" } },
                  required: ["task_name"],
                },
              },
            ],
          },
        ],
      },
      { type: "message", role: "user", content: "delegate" },
      {
        type: "function_call",
        call_id: "call_1",
        namespace: "agents.v2",
        name: "spawn__agent",
        arguments: '{"task_name":"child"}',
      },
      { type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: "done" }] },
    ],
    tool_choice: { type: "function", namespace: "agents.v2", name: "spawn__agent" },
    stream: true,
  }

  const chatProvider = parseProviders({
    providerJson: providerJson("openai-compatible"),
    model: "relay/primary",
  }).providers[0]!
  const chat = translateResponsesRequest(chatProvider, request).body
  const chatToolName = (chat.tools as any[])[0].function.name as string
  expect(chatToolName).not.toBe("spawn__agent")
  expect(chat.messages).toEqual([
    { role: "user", content: "delegate" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: chatToolName, arguments: '{"task_name":"child"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "done" },
  ])
  expect(chat.tool_choice).toEqual({ type: "function", function: { name: chatToolName } })
  expect((chat.tools as any[])[0]).toEqual({
    type: "function",
    function: {
      name: chatToolName,
      description: "spawn one child",
      parameters: {
        type: "object",
        properties: { task_name: { type: "string" } },
        required: ["task_name"],
      },
    },
  })

  const anthropicProvider = parseProviders({
    providerJson: providerJson("anthropic"),
    model: "relay/primary",
  }).providers[0]!
  const anthropic = translateResponsesRequest(anthropicProvider, request).body
  const anthropicToolName = (anthropic.tools as any[])[0].name as string
  expect(anthropicToolName).toBe(chatToolName)
  expect((anthropic.messages as any[])[1].content[0]).toMatchObject({
    type: "tool_use",
    id: "call_1",
    name: anthropicToolName,
    input: { task_name: "child" },
  })
  expect(anthropic.tool_choice).toEqual({ type: "tool", name: anthropicToolName })
})

test("maps Responses JSON schema output configuration to compatible provider fields", () => {
  const request = {
    model: "primary",
    input: "return json",
    stream: false,
    text: {
      format: {
        type: "json_schema",
        name: "result",
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    },
  }
  const provider = (format: "openai-compatible" | "anthropic") =>
    parseProviders({
      providerJson: JSON.stringify({
        relay: {
          format,
          base_url: "https://provider.example/v1",
          models: { primary: { upstream_id: "vendor/gpt-5.6-sol" } },
        },
      }),
      model: "relay/primary",
    }).providers[0]!

  expect(translateResponsesRequest(provider("openai-compatible"), request).body.response_format).toEqual({
    type: "json_schema",
    json_schema: request.text.format,
  })
  expect(translateResponsesRequest(provider("anthropic"), request).body.output_config).toEqual({
    format: {
      type: "json_schema",
      schema: request.text.format.schema,
    },
  })
})

test("converts non-stream Chat and Anthropic responses into Responses output", async () => {
  for (const format of ["openai-compatible", "anthropic"] as const) {
    let encodedName = ""
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as any
        encodedName = format === "openai-compatible" ? body.tools[0].function.name : body.tools[0].name
        if (format === "openai-compatible") {
          return Response.json({
            id: "chat_1",
            model: "vendor/gpt-5.6-sol",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "working",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: encodedName, arguments: '{"task_name":"child"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          })
        }
        return Response.json({
          id: "msg_1",
          model: "vendor/gpt-5.6-sol",
          role: "assistant",
          content: [
            { type: "text", text: "working" },
            { type: "tool_use", id: "call_1", name: encodedName, input: { task_name: "child" } },
          ],
          stop_reason: "tool_use",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
            output_tokens: 4,
          },
        })
      },
    })
    const providers = parseProviders({
      providerJson: JSON.stringify({
        relay: {
          format,
          base_url: `${upstream.url}v1`,
          models: { primary: { upstream_id: "vendor/gpt-5.6-sol" } },
        },
      }),
      model: "relay/primary",
    })
    const bridge = startProviderBridge(providers, { token: "bridge" })

    try {
      const response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
        method: "POST",
        headers: { authorization: "Bearer bridge", "content-type": "application/json" },
        body: JSON.stringify({
          model: "primary",
          input: [
            {
              type: "additional_tools",
              role: "developer",
              tools: [
                {
                  type: "namespace",
                  name: "agents",
                  tools: [
                    {
                      type: "function",
                      name: "spawn_agent",
                      parameters: { type: "object" },
                    },
                  ],
                },
              ],
            },
            { type: "message", role: "user", content: "delegate" },
          ],
          stream: false,
        }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as any
      expect(body).toMatchObject({
        object: "response",
        model: "primary",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "working", annotations: [] }],
          },
          {
            type: "function_call",
            status: "completed",
            call_id: "call_1",
            namespace: "agents",
            name: "spawn_agent",
            arguments: '{"task_name":"child"}',
          },
        ],
      })
      expect(body.output[1].id).not.toBe("call_1")
      expect(body.usage).toEqual(
        format === "openai-compatible"
          ? {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens: 4,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 14,
            }
          : {
              input_tokens: 15,
              input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
              output_tokens: 4,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 19,
            },
      )
      expect(encodedName).not.toBe("spawn_agent")
    } finally {
      await bridge.close()
      await upstream.stop(true)
    }
  }
})

test("restores namespaces from compatible provider SSE tool calls", async () => {
  for (const format of ["openai-compatible", "anthropic"] as const) {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as any
        const name = format === "openai-compatible" ? body.tools[0].function.name : body.tools[0].name
        if (format === "openai-compatible") {
          const chunks = [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: "{}" } }] } }] },
          ]
          return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        }
        const events = [
          ["message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name, input: {} } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", usage: { output_tokens: 1 } }],
          ["message_stop", { type: "message_stop" }],
        ]
        return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    const providers = parseProviders({
      providerJson: JSON.stringify({
        relay: {
          format,
          base_url: `${upstream.url}v1`,
          models: { primary: { upstream_id: "vendor/gpt-5.6-sol" } },
        },
      }),
      model: "relay/primary",
    })
    const bridge = startProviderBridge(providers, { token: "bridge" })
    try {
      const response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
        method: "POST",
        headers: { authorization: "Bearer bridge", "content-type": "application/json" },
        body: JSON.stringify({
          model: "primary",
          input: [
            {
              type: "additional_tools",
              role: "developer",
              tools: [
                { type: "namespace", name: "agents", tools: [{ type: "function", name: "spawn_agent", parameters: {} }] },
              ],
            },
            { type: "message", role: "user", content: "delegate" },
          ],
          stream: true,
        }),
      })
      const events = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
      const call = events.find((event) => event.type === "response.output_item.done")?.item
      expect(call).toMatchObject({
        type: "function_call",
        call_id: "call_1",
        namespace: "agents",
        name: "spawn_agent",
        arguments: "{}",
      })
    } finally {
      await bridge.close()
      await upstream.stop(true)
    }
  }
})

test("does not follow provider redirects with credential headers", async () => {
  let sinkCalls = 0
  const sink = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      sinkCalls += 1
      return Response.json({
        apiKey: request.headers.get("x-api-key"),
        custom: request.headers.get("x-custom-secret"),
      })
    },
  })
  const redirector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(null, { status: 307, headers: { location: `${sink.url}capture` } })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      anthropic: {
        format: "anthropic",
        base_url: `${redirector.url}v1`,
        headers: { "x-custom-secret": "custom-sentinel" },
        models: { primary: { upstream_id: "vendor/gpt-5.6-sol" } },
      },
    }),
    providerKeysJson: JSON.stringify({ anthropic: "provider-sentinel" }),
    model: "anthropic/primary",
  })
  const bridge = startProviderBridge(providers, { token: "bridge" })

  try {
    const response = await fetch(`${bridge.baseUrl}/providers/anthropic/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer bridge", "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "hello", stream: false }),
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { type: "upstream_transport_error" } })
    expect(sinkCalls).toBe(0)
  } finally {
    await bridge.close()
    await redirector.stop(true)
    await sink.stop(true)
  }
})

test("converts Chat SSE text, tool calls and usage into a terminal Responses stream", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const chunks = [
        { id: "chat_1", model: "openai/gpt-5.6-sol", choices: [{ delta: { content: "hello " } }] },
        {
          id: "chat_1",
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path"' } },
                ],
              },
            },
          ],
        },
        {
          id: "chat_1",
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"a.ts"}' } }] } }],
        },
        {
          id: "chat_1",
          choices: [],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
            prompt_tokens_details: { cached_tokens: 3 },
            completion_tokens_details: { reasoning_tokens: 1 },
          },
        },
      ]
      const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      chat: {
        format: "openai-compatible",
        base_url: `${upstream.url}v1`,
        models: { primary: { upstream_id: "openai/gpt-5.6-sol", output: 64000 } },
      },
    }),
    model: "chat/primary",
  })
  const bridge = startProviderBridge(providers, { token: "bridge" })

  try {
    const response = await fetch(`${bridge.baseUrl}/providers/chat/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer bridge", "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "hello", stream: true }),
    })
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)))
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(events[3].item.content[0].text).toBe("hello ")
    expect(events[4].item).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"a.ts"}',
    })
    expect(events[5].response.usage).toEqual({
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 14,
    })
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})

test("converts Anthropic SSE blocks and cumulative usage into a terminal Responses stream", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const events = [
        ["message_start", { type: "message_start", message: { id: "msg_a", usage: { input_tokens: 12, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_1", name: "read_file", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } }],
        ["content_block_stop", { type: "content_block_stop", index: 1 }],
        ["message_delta", { type: "message_delta", usage: { output_tokens: 5 } }],
        ["message_stop", { type: "message_stop" }],
      ] as const
      const body = events
        .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        .join("")
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      anthropic: {
        format: "anthropic",
        base_url: `${upstream.url}v1`,
        models: { primary: { upstream_id: "vendor/gpt-5.6-sol", output: 32000 } },
      },
    }),
    model: "anthropic/primary",
  })
  const bridge = startProviderBridge(providers, { token: "bridge" })

  try {
    const response = await fetch(`${bridge.baseUrl}/providers/anthropic/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer bridge", "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "hello", stream: true }),
    })
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)))
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(events[4].item).toMatchObject({
      type: "function_call",
      call_id: "tool_1",
      name: "read_file",
      arguments: '{"path":"a.ts"}',
    })
    expect(events[5].response.usage).toEqual({
      input_tokens: 18,
      input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 23,
    })
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})
