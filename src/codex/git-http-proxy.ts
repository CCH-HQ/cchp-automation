import { createServer, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import type { Socket } from "node:net"
import type { TokenSource } from "../github/client"

export interface GitHttpProxyOptions {
  repo: string
  token: TokenSource
  allowPush: boolean
  upstreamBaseUrl?: string
}

export interface GitHttpProxyHandle {
  repoUrl: string
  close(): Promise<void>
}

function trustedRepoPath(repo: string): string {
  const [owner, name, extra] = repo.split("/")
  if (!owner || !name || extra || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`invalid Git repository: ${repo}`)
  }
  return `/${owner}/${name}.git`
}

function currentToken(source: TokenSource): string {
  const token = typeof source === "function" ? source() : source
  if (!token) throw new Error("Git proxy token source returned an empty token")
  return token
}

interface AllowedRequest {
  service: "upload" | "receive"
  pathAndQuery: string
}

function serviceFor(request: IncomingMessage, repoPath: string): AllowedRequest | undefined {
  const target = request.url ?? ""
  // HTTP proxies may receive an absolute-form target (`http://host/path`). Never
  // feed that untrusted origin back into `new URL`, otherwise the GitHub token can
  // be forwarded to an attacker-controlled host. Git smart-HTTP only needs the
  // exact origin-form targets below.
  if (!target.startsWith("/") || target.startsWith("//")) return undefined
  if (request.method === "GET") {
    if (target === `${repoPath}/info/refs?service=git-upload-pack`) return { service: "upload", pathAndQuery: target }
    if (target === `${repoPath}/info/refs?service=git-receive-pack`) return { service: "receive", pathAndQuery: target }
    return undefined
  }
  if (request.method === "POST" && target === `${repoPath}/git-upload-pack`) return { service: "upload", pathAndQuery: target }
  if (request.method === "POST" && target === `${repoPath}/git-receive-pack`) return { service: "receive", pathAndQuery: target }
  return undefined
}

function forwardHeaders(request: IncomingMessage, token: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  }
  for (const name of ["accept", "content-type", "git-protocol", "user-agent"]) {
    const value = request.headers[name]
    if (typeof value === "string") headers[name] = value
  }
  if (typeof request.headers["content-length"] === "string") headers["content-length"] = request.headers["content-length"]
  return headers
}

function copyResponseHeaders(source: IncomingMessage, target: ServerResponse): void {
  for (const name of ["content-type", "cache-control", "expires", "pragma", "vary"]) {
    const value = source.headers[name]
    if (value != null) target.setHeader(name, value)
  }
}

export async function startGitHttpProxy(options: GitHttpProxyOptions): Promise<GitHttpProxyHandle> {
  const repoPath = trustedRepoPath(options.repo)
  const upstreamBase = new URL(options.upstreamBaseUrl ?? "https://github.com")
  if (!new Set(["http:", "https:"]).has(upstreamBase.protocol)) throw new Error("Git proxy upstream must use http or https")
  if (upstreamBase.username || upstreamBase.password || upstreamBase.search || upstreamBase.hash || upstreamBase.pathname !== "/") {
    throw new Error("Git proxy upstream must be a credential-free origin URL")
  }

  const sockets = new Set<Socket>()
  const outboundRequests = new Set<ClientRequest>()

  const server = createServer((request, response) => {
    const allowed = serviceFor(request, repoPath)
    if (!allowed || (allowed.service === "receive" && !options.allowPush)) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" })
      response.end("Git operation is not allowed for this run\n")
      return
    }
    let token: string
    try {
      token = currentToken(options.token)
    } catch (error) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" })
      response.end(`${error instanceof Error ? error.message : String(error)}\n`)
      return
    }
    const upstream = new URL(allowed.pathAndQuery, `${upstreamBase.origin}/`)
    const send = upstream.protocol === "https:" ? httpsRequest : httpRequest
    const outbound = send(upstream, {
      method: request.method,
      headers: forwardHeaders(request, token),
    }, (upstreamResponse) => {
      response.statusCode = upstreamResponse.statusCode ?? 502
      copyResponseHeaders(upstreamResponse, response)
      upstreamResponse.pipe(response)
    })
    outboundRequests.add(outbound)
    outbound.setTimeout(120_000, () => outbound.destroy(new Error("Git upstream request timed out")))
    outbound.on("close", () => outboundRequests.delete(outbound))
    outbound.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
      if (!response.writableEnded) response.end(`Git upstream failed: ${error.message}\n`)
    })
    request.on("aborted", () => outbound.destroy(new Error("Git client aborted request")))
    response.on("close", () => {
      if (!response.writableEnded) outbound.destroy(new Error("Git client disconnected"))
    })
    request.pipe(outbound)
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  server.keepAliveTimeout = 5_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Git proxy did not bind a TCP address")
  return {
    repoUrl: `http://127.0.0.1:${address.port}${repoPath}`,
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      for (const outbound of outboundRequests) outbound.destroy(new Error("Git proxy is shutting down"))
      for (const socket of sockets) socket.destroy()
      server.closeIdleConnections()
      await closed
    },
  }
}
