#!/usr/bin/env bun

export type NetworkProbeResult = "policy-blocked" | "reachable" | "indeterminate"

export interface NetworkProbeEvidence {
  result: NetworkProbeResult
  reason: "proxy-structured-denial" | "os-connect-denied" | "http-response" | "unclassified-error"
  target: string
  detail: string
}

const PROXY_DENIALS = new Set([
  "blocked-by-allowlist",
  "blocked-by-denylist",
  "blocked-by-policy",
  "blocked-by-method-policy",
  "blocked-by-mitm-required",
  "blocked-by-mitm-hook",
])

export function classifyNetworkProbe(input: {
  target: string
  status?: number
  proxyError?: string | null
  error?: { message?: string; code?: string; syscall?: string }
}): NetworkProbeEvidence {
  const proxyError = input.proxyError ?? ""
  if (input.status === 403 && PROXY_DENIALS.has(proxyError)) {
    return {
      result: "policy-blocked",
      reason: "proxy-structured-denial",
      target: input.target,
      detail: proxyError,
    }
  }
  if (typeof input.status === "number") {
    return {
      result: "reachable",
      reason: "http-response",
      target: input.target,
      detail: `status=${input.status};proxy_error=${proxyError || "none"}`,
    }
  }
  const code = input.error?.code ?? ""
  const syscall = input.error?.syscall ?? ""
  if ((code === "EPERM" || code === "EACCES") && /^(connect|socket)$/i.test(syscall)) {
    return {
      result: "policy-blocked",
      reason: "os-connect-denied",
      target: input.target,
      detail: `${syscall}:${code}`,
    }
  }
  return {
    result: "indeterminate",
    reason: "unclassified-error",
    target: input.target,
    detail: [input.error?.message, syscall, code].filter(Boolean).join(":").slice(0, 500),
  }
}

function errorDetails(error: unknown): { message?: string; code?: string; syscall?: string } {
  let current: unknown = error
  const messages: string[] = []
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const value = current as Record<string, unknown>
    if (typeof value.message === "string") messages.push(value.message)
    const code = typeof value.code === "string" ? value.code : undefined
    const syscall = typeof value.syscall === "string" ? value.syscall : undefined
    if (code || syscall) return { message: messages.join(": "), code, syscall }
    current = value.cause
  }
  return {
    message: messages.join(": ") || (error instanceof Error ? error.message : String(error)),
  }
}

export async function probeNetworkPolicy(target: string): Promise<NetworkProbeEvidence> {
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(5_000) })
    return classifyNetworkProbe({
      target,
      status: response.status,
      proxyError: response.headers.get("x-proxy-error"),
    })
  } catch (error) {
    return classifyNetworkProbe({ target, error: errorDetails(error) })
  }
}

if (import.meta.main) {
  const target = process.argv[2] ?? "https://example.com"
  const evidence = await probeNetworkPolicy(target)
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  if (evidence.result === "policy-blocked") {
    process.stdout.write(`CCHP_NETWORK_POLICY_BLOCKED:${evidence.reason}:${evidence.target}\n`)
  }
  process.exit(evidence.result === "policy-blocked" ? 0 : evidence.result === "reachable" ? 41 : 42)
}
