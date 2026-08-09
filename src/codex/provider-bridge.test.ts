import { expect, test } from "bun:test"
import {
  estimateProviderRequestTokens,
  observeResponseUsage,
  passthroughResponse,
  startProviderBridge,
  translateResponsesRequest,
} from "./provider-bridge"
import { parseProviders } from "./providers"
import type { UsageReservationRef } from "./usage"

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

test("usage observation preserves client cancellation and releases the reservation", async () => {
  let upstreamCancelled = false
  const finished: Array<{ outcome: string; reason?: string }> = []
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: "https://provider.invalid/v1",
        models: { primary: { upstream_id: "gpt-5.6-sol", context: 1000 } },
      },
    }),
    model: "relay/primary",
  })
  const tasks: Promise<void>[] = []
  const response = observeResponseUsage(
    new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_cancel_observed","status":"in_progress"}}\n\n',
        ))
        controller.enqueue(new TextEncoder().encode(
          'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"partial',
        ))
      },
      cancel() {
        upstreamCancelled = true
      },
    }), { headers: { "content-type": "text/event-stream" } }),
    providers.providers[0]!,
    "primary",
    undefined,
    {
      reservationId: "reservation-cancelled",
      writerId: "writer",
      writerGeneration: 1,
      requestId: "request-cancelled",
    },
    async () => undefined,
    (_reservation, outcome, reason) => {
      finished.push({ outcome, ...(reason ? { reason } : {}) })
    },
    (task) => { tasks.push(task) },
  )
  const reader = response.body!.getReader()
  expect((await reader.read()).done).toBe(false)
  await Promise.race([
    reader.cancel(),
    Bun.sleep(200).then(() => { throw new Error("client cancellation did not settle") }),
  ])
  await Promise.all(tasks)
  expect(upstreamCancelled).toBe(true)
  expect(finished).toEqual([{ outcome: "released", reason: "stream_cancelled" }])
})

test("usage observation applies bounded backpressure when the client does not read", async () => {
  let upstreamPulls = 0
  const tasks: Promise<void>[] = []
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: { format: "openai-responses", base_url: "https://provider.invalid/v1", models: { primary: { upstream_id: "gpt-5.6-sol" } } },
    }),
    model: "relay/primary",
  })
  const response = observeResponseUsage(
    new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        upstreamPulls++
        controller.enqueue(new TextEncoder().encode(`event: response.created\ndata: {"type":"response.created","sequence":${upstreamPulls}}\n\n`))
      },
    }), { headers: { "content-type": "text/event-stream" } }),
    providers.providers[0]!,
    "primary",
    undefined,
    undefined,
    async () => undefined,
    undefined,
    (task) => { tasks.push(task) },
  )
  await Bun.sleep(25)
  expect(upstreamPulls).toBeLessThan(10)
  await response.body!.cancel()
  await Promise.all(tasks)
})

test("seal settles an unread SSE observer and releases its reservation", async () => {
  const finished: Array<{ outcome: string; reason?: string }> = []
  const encoder = new TextEncoder()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_unread","status":"in_progress"}}\n\n',
          ))
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
        models: { primary: { upstream_id: "gpt-5.6-sol", context: 1000 } },
      },
    }),
    model: "relay/primary",
  })
  const reservation: UsageReservationRef = {
    reservationId: "reservation-unread",
    writerId: "writer",
    writerGeneration: 1,
    requestId: "request-unread",
  }
  const bridge = startProviderBridge(providers, {
    onBeforeRequest: () => ({ allowed: true, reservation }),
    onUsage: async () => undefined,
    onRequestFinished: (_reservation, outcome, reason) => {
      finished.push({ outcome, ...(reason ? { reason } : {}) })
    },
  })
  let response: Response | undefined
  try {
    response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "unread", stream: true }),
    })
    expect(response.status).toBe(200)
    await Bun.sleep(25)
    await Promise.race([
      bridge.sealAndDrain(),
      Bun.sleep(500).then(() => { throw new Error("provider seal did not cancel the unread SSE stream") }),
    ])
    expect(finished).toEqual([{ outcome: "released", reason: "bridge_sealed" }])
  } finally {
    await response?.body?.cancel().catch(() => undefined)
    await bridge.close()
    await upstream.stop(true)
  }
})

test("cancels an active provider stream by child thread id", async () => {
  let upstreamCancelled = false
  let resolveUpstreamCancelled!: () => void
  const upstreamCancellation = new Promise<void>((resolve) => { resolveUpstreamCancelled = resolve })
  const finished: Array<{ outcome: string; reason?: string }> = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_child","status":"in_progress"}}\n\n',
          ))
        },
        cancel() {
          upstreamCancelled = true
          resolveUpstreamCancelled()
        },
      }), { headers: { "content-type": "text/event-stream" } })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: `${upstream.url}v1`,
        models: { primary: { upstream_id: "gpt-5.6-sol", context: 1000 } },
      },
    }),
    model: "relay/primary",
  })
  const reservation: UsageReservationRef = {
    reservationId: "reservation-child",
    writerId: "writer",
    writerGeneration: 1,
    requestId: "request-child",
  }
  const bridge = startProviderBridge(providers, {
    onBeforeRequest: () => ({ allowed: true, reservation }),
    onUsage: async () => undefined,
    onRequestFinished: (_reservation, outcome, reason) => {
      finished.push({ outcome, ...(reason ? { reason } : {}) })
    },
  })
  let response: Response | undefined
  try {
    response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "primary",
        input: "child request",
        stream: true,
        client_metadata: { thread_id: "child-thread", turn_id: "child-turn" },
      }),
    })
    expect(response.status).toBe(200)
    await Bun.sleep(25)
    expect(await bridge.cancelThread("another-thread")).toBe(0)
    expect(await bridge.cancelThread("child-thread")).toBe(1)
    expect(await bridge.cancelThread("child-thread")).toBe(0)
    await Promise.race([
      upstreamCancellation,
      Bun.sleep(500).then(() => { throw new Error("thread cancellation did not reach the upstream stream") }),
    ])
    expect(upstreamCancelled).toBe(true)
    expect(finished).toEqual([{ outcome: "released", reason: "thread_terminal" }])
  } finally {
    await response?.body?.cancel().catch(() => undefined)
    await bridge.close()
    await upstream.stop(true)
  }
})

test("non-JSON usage observation releases without reading the response body", async () => {
  const finished: Array<{ outcome: string; reason?: string }> = []
  const tasks: Promise<void>[] = []
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: "https://provider.invalid/v1",
        models: { primary: { upstream_id: "gpt-5.6-sol", context: 1000 } },
      },
    }),
    model: "relay/primary",
  })
  const reservation: UsageReservationRef = {
    reservationId: "reservation-non-json",
    writerId: "writer",
    writerGeneration: 1,
    requestId: "request-non-json",
  }
  const response = observeResponseUsage(
    new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial response"))
      },
    }), { headers: { "content-type": "text/plain" } }),
    providers.providers[0]!,
    "primary",
    undefined,
    reservation,
    async () => undefined,
    (_reservation, outcome, reason) => {
      finished.push({ outcome, ...(reason ? { reason } : {}) })
    },
    (task) => { tasks.push(task) },
  )
  await Promise.race([
    Promise.all(tasks),
    Bun.sleep(500).then(() => { throw new Error("non-JSON usage observer waited for the response body") }),
  ])
  expect(finished).toEqual([{ outcome: "released", reason: "non_json_response" }])
  await response.body!.cancel()
})

test("cancelling a JSON usage observer settles the cloned reader and releases once", async () => {
  const finished: Array<{ outcome: string; reason?: string }> = []
  const tasks: Promise<void>[] = []
  let cancelObserver!: (reason: string) => Promise<void>
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: "https://provider.invalid/v1",
        models: { primary: { upstream_id: "gpt-5.6-sol", context: 1000 } },
      },
    }),
    model: "relay/primary",
  })
  const reservation: UsageReservationRef = {
    reservationId: "reservation-json-cancel",
    writerId: "writer",
    writerGeneration: 1,
    requestId: "request-json-cancel",
  }
  let response!: Response
  response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"response.completed","response":{"id":"resp_json_cancel"'))
    },
  }), { headers: { "content-type": "application/json" } })
  observeResponseUsage(
    response,
    providers.providers[0]!,
    "primary",
    undefined,
    reservation,
    async () => undefined,
    (_reservation, outcome, reason) => {
      finished.push({ outcome, ...(reason ? { reason } : {}) })
    },
    (task) => { tasks.push(task) },
    (_threadId, cancel) => {
      cancelObserver = cancel
      return () => undefined
    },
    () => { void response.body?.cancel("bridge_sealed") },
  )
  await Promise.race([
    cancelObserver("bridge_sealed"),
    Bun.sleep(500).then(() => { throw new Error("JSON usage observer cancellation did not settle") }),
  ])
  await Promise.all(tasks)
  await response.body?.cancel("test cleanup")
  expect(finished).toEqual([{ outcome: "released", reason: "bridge_sealed" }])
})

test("each provider transformation stream propagates downstream backpressure to its upstream", async () => {
  for (const format of ["openai-responses", "openai-compatible", "anthropic"] as const) {
    let upstreamPulls = 0
    let upstreamCancels = 0
    const encoder = new TextEncoder()
    const upstream = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        upstreamPulls++
        const payload = format === "openai-responses"
          ? `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${upstreamPulls}"}\n\n`
          : format === "openai-compatible"
            ? `data: {"choices":[{"delta":{"content":"${upstreamPulls}"}}]}\n\n`
            : `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${upstreamPulls}"}}\n\n`
        controller.enqueue(encoder.encode(payload))
      },
      cancel() {
        upstreamCancels++
      },
    }), { headers: { "content-type": "text/event-stream" } })
    const providers = parseProviders({
      providerJson: JSON.stringify({
        relay: { format, base_url: "https://provider.invalid/v1", models: { primary: { upstream_id: "gpt-5.6-sol" } } },
      }),
      model: "relay/primary",
    })
    const response = await passthroughResponse(providers.providers[0]!, upstream, "primary")
    await Bun.sleep(25)
    const pullsWhilePaused = upstreamPulls
    expect(pullsWhilePaused).toBeLessThan(5)
    await Bun.sleep(25)
    expect(upstreamPulls).toBe(pullsWhilePaused)

    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    await Bun.sleep(25)
    expect(upstreamPulls).toBeGreaterThan(pullsWhilePaused)
    await reader.cancel("test complete")
    expect(upstreamCancels).toBe(1)
  }
})

test("accounts usage from every non-completed Responses terminal event", async () => {
  const statuses = ["incomplete", "failed", "cancelled"] as const
  let request = 0
  const usage: Array<Record<string, unknown>> = []
  const finished: Array<{ outcome: string; reason?: string }> = []
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input, init) => {
    if (String(input).startsWith("https://upstream.invalid/")) {
      const status = statuses[request++]!
      return Promise.resolve(new Response(
        `event: response.${status}\ndata: ${JSON.stringify({
          type: `response.${status}`,
          response: {
            id: `resp_${status}`,
            status,
            usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ))
    }
    return realFetch(input, init)
  }) as typeof globalThis.fetch
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: { format: "openai-responses", base_url: "https://upstream.invalid/v1", models: { primary: { upstream_id: "gpt-5.6-sol" } } },
    }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers, {
    onBeforeRequest: () => ({
      allowed: true,
      reservation: {
        reservationId: `reservation-${request}`,
        writerId: "writer",
        writerGeneration: 1,
        requestId: `request-${request}`,
      },
    }),
    onUsage: (record) => { usage.push(record as unknown as Record<string, unknown>) },
    onRequestFinished: (_reservation, outcome, reason) => {
      finished.push({ outcome, ...(reason ? { reason } : {}) })
    },
  })
  try {
    for (const status of statuses) {
      const response = await realFetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "primary", input: status, stream: true }),
      })
      await response.text()
    }
    await bridge.drain()
    expect(usage.map((record) => ({ responseId: record.responseId, totalTokens: record.totalTokens }))).toEqual([
      { responseId: "resp_incomplete", totalTokens: 10 },
      { responseId: "resp_failed", totalTokens: 10 },
      { responseId: "resp_cancelled", totalTokens: 10 },
    ])
    expect(finished).toEqual(statuses.map(() => ({ outcome: "usage", reason: "usage_observed" })))
  } finally {
    globalThis.fetch = realFetch
    await bridge.close()
  }
})

test("Chat and Anthropic adapters stop at their terminal marker", async () => {
  for (const format of ["openai-compatible", "anthropic"] as const) {
    let cancelStarted = false
    const realFetch = globalThis.fetch
    globalThis.fetch = ((input, init) => {
      if (String(input).startsWith("https://upstream.invalid/")) {
        const payload = format === "openai-compatible"
          ? 'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\ndata: [DONE]\n\n'
          : 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload))
          },
          cancel() {
            cancelStarted = true
            return new Promise<void>(() => undefined)
          },
        }), { headers: { "content-type": "text/event-stream" } }))
      }
      return realFetch(input, init)
    }) as typeof globalThis.fetch
    const providers = parseProviders({
      providerJson: JSON.stringify({
        relay: { format, base_url: "https://upstream.invalid/v1", models: { primary: { upstream_id: "gpt-5.6-sol" } } },
      }),
      model: "relay/primary",
    })
    const bridge = startProviderBridge(providers)
    try {
      const response = await realFetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "primary", input: "terminal", stream: true }),
      })
      const raw = await Promise.race([
        response.text(),
        Bun.sleep(200).then(() => { throw new Error(`${format} bridge waited past the terminal marker`) }),
      ])
      expect(raw).toContain("response.completed")
      expect(cancelStarted).toBe(true)
    } finally {
      globalThis.fetch = realFetch
      await bridge.close()
    }
  }
})

test("Chat and Anthropic adapters cancel a never-ending upstream after a parse failure", async () => {
  for (const format of ["openai-compatible", "anthropic"] as const) {
    let cancelled = false
    const realFetch = globalThis.fetch
    globalThis.fetch = ((input, init) => {
      if (String(input).startsWith("https://upstream.invalid/")) {
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: {malformed-json}\n\n"))
          },
          cancel() {
            cancelled = true
          },
        }), { headers: { "content-type": "text/event-stream" } }))
      }
      return realFetch(input, init)
    }) as typeof globalThis.fetch
    const providers = parseProviders({
      providerJson: JSON.stringify({
        relay: { format, base_url: "https://upstream.invalid/v1", models: { primary: { upstream_id: "gpt-5.6-sol" } } },
      }),
      model: "relay/primary",
    })
    const bridge = startProviderBridge(providers)
    try {
      const response = await realFetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "primary", input: "malformed", stream: true }),
      })
      expect(await response.text()).toContain("response.failed")
      expect(cancelled).toBe(true)
    } finally {
      globalThis.fetch = realFetch
      await bridge.close()
    }
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
    const raw = await response.text()
    const events = raw
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    expect(raw.match(/^data: \[DONE\]$/gm)).toHaveLength(1)
    expect(raw.endsWith("data: [DONE]\n\n")).toBe(true)
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

test("converts openai-responses stream failures into one redacted terminal event", async () => {
  const secret = "provider-stream-secret"
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_failed","model":"upstream/model","status":"in_progress"}}\n\n' +
        `event: response.output_text.delta\ndata: {"leak":"${secret}"\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: `${upstream.url}v1`,
        models: { primary: { upstream_id: "gpt-5.6-sol" } },
      },
    }),
    providerKeysJson: JSON.stringify({ relay: secret }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers)

  try {
    const response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "fail", stream: true }),
    })
    const raw = await response.text()
    const events = raw
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    const failures = events.filter((event) => event.type === "response.failed")
    expect(failures).toHaveLength(1)
    expect(raw.match(/^data: \[DONE\]$/gm)).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      response: {
        id: "resp_failed",
        model: "primary",
        status: "failed",
        error: { code: "upstream_stream_error" },
      },
    })
    expect(raw).not.toContain(secret)
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})

test("adds one failed terminal event when an openai-responses stream ends early", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_early","model":"upstream/model","status":"in_progress"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: `${upstream.url}v1`,
        models: { primary: { upstream_id: "gpt-5.6-sol" } },
      },
    }),
    providerKeysJson: JSON.stringify({ relay: "provider-key" }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers)

  try {
    const response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "fail", stream: true }),
    })
    const raw = await response.text()
    const events = raw
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    expect(events.filter((event) => event.type === "response.failed")).toHaveLength(1)
    expect(raw.match(/^data: \[DONE\]$/gm)).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({
      type: "response.failed",
      response: { id: "resp_early", model: "primary", status: "failed" },
    })
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})

test("fails closed on Responses event and payload type drift and cancels upstream", async () => {
  let cancelled = false
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input, init) => {
    if (String(input).startsWith("https://upstream.invalid/")) {
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: message\ndata: {"type":"response.completed","response":{"id":"resp_done","model":"upstream/model","status":"completed"}}\n\n' +
            'event: response.output_text.delta\ndata: {broken\n\n',
          ))
        },
        cancel() {
          cancelled = true
        },
      }), { headers: { "content-type": "text/event-stream" } }))
    }
    return realFetch(input, init)
  }) as typeof globalThis.fetch
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: "https://upstream.invalid/v1",
        models: { primary: { upstream_id: "gpt-5.6-sol" } },
      },
    }),
    providerKeysJson: JSON.stringify({ relay: "provider-key" }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers)

  try {
    const response = await realFetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "done", stream: true }),
    })
    const raw = await response.text()
    const events = raw
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    expect(events.filter((event) => ["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(String(event.type))))
      .toHaveLength(1)
    expect(events.at(-1)?.type).toBe("response.failed")
    expect(events.at(-1)).toMatchObject({
      response: { error: { code: "upstream_stream_error" } },
    })
    expect(raw.match(/^data: \[DONE\]$/gm)).toHaveLength(1)
    expect(raw.endsWith("data: [DONE]\n\n")).toBe(true)
    for (let attempt = 0; attempt < 20 && !cancelled; attempt++) await Bun.sleep(5)
    expect(cancelled).toBe(true)
  } finally {
    globalThis.fetch = realFetch
    await bridge.close()
  }
})

test("finishes a terminal Responses stream without waiting for upstream cancellation", async () => {
  let cancelStarted = false
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input, init) => {
    if (String(input).startsWith("https://upstream.invalid/")) {
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_done","model":"upstream/model","status":"completed"}}\n\n',
          ))
        },
        cancel() {
          cancelStarted = true
          return new Promise<void>(() => undefined)
        },
      }), { headers: { "content-type": "text/event-stream" } }))
    }
    return realFetch(input, init)
  }) as typeof globalThis.fetch
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: "https://upstream.invalid/v1",
        models: { primary: { upstream_id: "gpt-5.6-sol" } },
      },
    }),
    providerKeysJson: JSON.stringify({ relay: "provider-key" }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers)

  try {
    const response = await realFetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "done", stream: true }),
    })
    const raw = await Promise.race([
      response.text(),
      Bun.sleep(100).then(() => { throw new Error("bridge waited for upstream cancellation") }),
    ])
    expect(raw.match(/^data: \[DONE\]$/gm)).toHaveLength(1)
    expect(raw.endsWith("data: [DONE]\n\n")).toBe(true)
    expect(cancelStarted).toBe(true)
  } finally {
    globalThis.fetch = realFetch
    await bridge.close()
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
    onBeforeRequest: () => ({
      allowed: true,
      reservation: {
        reservationId: "reservation-stable",
        writerId: "writer-stable",
        writerGeneration: 1,
        requestId: "request-stable",
      },
    }),
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
      reservation: {
        reservationId: "reservation-stable",
        writerId: "writer-stable",
        writerGeneration: 1,
        requestId: "request-stable",
      },
    }])
    expect(JSON.stringify(usage)).not.toContain("provider-secret")
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})

test("denies a provider request before upstream dispatch when runtime admission rejects it", async () => {
  let upstreamRequests = 0
  const admissions: Array<Record<string, unknown>> = []
  const finished: Array<{ reservation: UsageReservationRef; outcome: string; reason?: string }> = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      upstreamRequests += 1
      return Response.json({ id: "unexpected", status: "completed", output: [] })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: `${upstream.url}v1`,
        models: { primary: { upstream_id: "gpt-5.6-sol", context: 372000 } },
      },
    }),
    providerKeysJson: JSON.stringify({ relay: "provider-secret" }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers, {
    onBeforeRequest(request) {
      admissions.push(request as unknown as Record<string, unknown>)
      return {
        allowed: false,
        reason: "projected token budget would exceed the threshold",
        reservation: {
          reservationId: "reservation-denied",
          writerId: "writer-denied",
          writerGeneration: 2,
          requestId: "request-denied",
        },
      }
    },
    onRequestFinished: (reservation, outcome, reason) => {
      finished.push({ reservation, outcome, ...(reason ? { reason } : {}) })
    },
  })
  try {
    const response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "primary",
        input: "inspect",
        client_metadata: { thread_id: "thread", turn_id: "turn" },
      }),
    })
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({
      error: {
        type: "token_budget_admission_denied",
        message: "projected token budget would exceed the threshold",
      },
    })
    expect(admissions).toEqual([{
      providerId: "relay",
      model: "primary",
      threadId: "thread",
      turnId: "turn",
      contextWindow: 372000,
      estimatedTokens: expect.any(Number),
    }])
    expect(upstreamRequests).toBe(0)
    expect(finished).toEqual([{
      reservation: {
        reservationId: "reservation-denied",
        writerId: "writer-denied",
        writerGeneration: 2,
        requestId: "request-denied",
      },
      outcome: "released",
      reason: "admission_denied",
    }])
  } finally {
    await bridge.close()
    upstream.stop(true)
  }
})

test("estimates request-derived usage instead of reserving the whole context window", () => {
  const estimate = estimateProviderRequestTokens({
    model: "gpt-5.6-sol",
    input: "inspect the fixture",
    max_output_tokens: 2_000,
    stream: true,
  }, 372_000)
  expect(estimate).toBeGreaterThan(2_000)
  expect(estimate).toBeLessThan(10_000)
  expect(estimateProviderRequestTokens({
    model: "gpt-5.6-sol",
    messages: [{ role: "user", content: "x" }],
    max_tokens: 10,
  }, 5)).toBe(5)
})

test("releases an admitted reservation when upstream returns without terminal usage", async () => {
  const finished: Array<{ reservation: UsageReservationRef; outcome: string; reason?: string }> = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({ error: { message: "temporary upstream failure" } }, { status: 502 })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({ relay: { format: "openai-responses", base_url: `${upstream.url}v1`, models: { primary: { upstream_id: "gpt-5.6-sol", context: 1000 } } } }),
    providerKeysJson: JSON.stringify({ relay: "provider-secret" }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers, {
    onBeforeRequest: () => ({
      allowed: true,
      reservation: {
        reservationId: "reservation-failure",
        writerId: "writer-failure",
        writerGeneration: 3,
        requestId: "request-failure",
      },
    }),
    onRequestFinished: (reservation, outcome, reason) => {
      finished.push({ reservation, outcome, ...(reason ? { reason } : {}) })
    },
  })
  try {
    const response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "inspect" }),
    })
    expect(response.status).toBe(502)
    await bridge.drain()
    expect(finished).toEqual([{
      reservation: {
        reservationId: "reservation-failure",
        writerId: "writer-failure",
        writerGeneration: 3,
        requestId: "request-failure",
      },
      outcome: "released",
      reason: "upstream_status_502",
    }])
  } finally {
    await bridge.close()
    await upstream.stop(true)
  }
})

test("releases an admitted reservation when a successful upstream payload cannot be translated", async () => {
  const finished: Array<{ reservation: UsageReservationRef; outcome: string; reason?: string }> = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({ id: "malformed", choices: [] })
    },
  })
  const providers = parseProviders({
    providerJson: JSON.stringify({ relay: { format: "openai-compatible", base_url: `${upstream.url}v1`, models: { primary: { upstream_id: "gpt-5.6-sol", context: 1000 } } } }),
    providerKeysJson: JSON.stringify({ relay: "provider-secret" }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers, {
    onBeforeRequest: () => ({
      allowed: true,
      reservation: {
        reservationId: "reservation-malformed",
        writerId: "writer-malformed",
        writerGeneration: 4,
        requestId: "request-malformed",
      },
    }),
    onRequestFinished: (reservation, outcome, reason) => {
      finished.push({ reservation, outcome, ...(reason ? { reason } : {}) })
    },
  })
  try {
    const response = await fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "primary", input: "inspect" }),
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { type: "upstream_response_error" } })
    expect(finished).toEqual([{
      reservation: {
        reservationId: "reservation-malformed",
        writerId: "writer-malformed",
        writerGeneration: 4,
        requestId: "request-malformed",
      },
      outcome: "released",
      reason: "response_translation_error",
    }])
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

test("seals new provider admission before draining already admitted requests", async () => {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const firstEntered = new Promise<void>((resolve) => { entered = resolve })
  let upstreamRequests = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      upstreamRequests++
      entered()
      await gate
      return Response.json({
        id: "resp_sealed",
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
        models: { primary: { upstream_id: "gpt-5.6-sol", context: 1000 } },
      },
    }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers)
  const request = () => fetch(`${bridge.baseUrl}/providers/relay/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "primary", input: "inspect" }),
  })
  try {
    const admitted = request()
    await firstEntered
    let drained = false
    const sealing = bridge.sealAndDrain().then(() => { drained = true })
    const rejected = await request()
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ error: { type: "provider_admission_closed" } })
    expect(upstreamRequests).toBe(1)
    expect(drained).toBe(true)
    release()
    expect((await admitted).status).toBe(502)
    await sealing
    expect(drained).toBe(true)
  } finally {
    release()
    await bridge.close()
    await upstream.stop(true)
  }
})

test("provider bridge close is idempotent", async () => {
  const providers = parseProviders({
    providerJson: JSON.stringify({
      relay: {
        format: "openai-responses",
        base_url: "https://provider.invalid/v1",
        models: { primary: { upstream_id: "gpt-5.6-sol" } },
      },
    }),
    model: "relay/primary",
  })
  const bridge = startProviderBridge(providers)
  await expect(Promise.all([bridge.close(), bridge.close()])).resolves.toBeDefined()
  await expect(bridge.close()).resolves.toBeUndefined()
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

test("removes the unavailable Default-mode request_user_input tool without hiding namespaced tools", () => {
  const providerJson = (format: "openai-compatible" | "anthropic") => JSON.stringify({
    relay: {
      format,
      base_url: "https://provider.example/v1",
      models: { primary: { upstream_id: "vendor/gpt-5.6-sol", output: 32000 } },
    },
  })
  const request = {
    model: "primary",
    input: [{ type: "message", role: "user", content: "inspect" }],
    tools: [
      { type: "function", name: "request_user_input", parameters: { type: "object" } },
      { type: "function", name: "read_file", parameters: { type: "object" } },
      { type: "function", namespace: "caller", name: "request_user_input", parameters: { type: "object" } },
    ],
    tool_choice: { type: "function", name: "request_user_input" },
  }

  for (const format of ["openai-compatible", "anthropic"] as const) {
    const provider = parseProviders({ providerJson: providerJson(format), model: "relay/primary" }).providers[0]!
    const body = translateResponsesRequest(provider, request).body
    const names = format === "openai-compatible"
      ? (body.tools as any[]).map((tool) => tool.function.name as string)
      : (body.tools as any[]).map((tool) => tool.name as string)
    expect(names).toContain("read_file")
    expect(names).not.toContain("request_user_input")
    expect(names).toHaveLength(2)
    expect(names.some((name) => name.startsWith("cchpns1_"))).toBe(true)
    expect(body.tool_choice).toBeUndefined()
  }
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
