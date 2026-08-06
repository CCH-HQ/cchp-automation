import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { connect } from "node:net"
import { startGitHttpProxy } from "./git-http-proxy"

async function upstream() {
  const requests: Array<{ url: string; method: string; authorization?: string; body: string }> = []
  const server = createServer((request, response) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      requests.push({
        url: request.url ?? "",
        method: request.method ?? "",
        authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
        body,
      })
      response.writeHead(200, { "content-type": "application/x-git-upload-pack-result" })
      response.end("ok")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fixture upstream did not bind")
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function rawRequest(port: number, target: string, body = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    let response = ""
    socket.setEncoding("utf8")
    socket.on("connect", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    })
    socket.on("data", (chunk) => { response += chunk })
    socket.on("end", () => resolve(response))
    socket.on("error", reject)
  })
}

test("proxies only the trusted repository and re-reads the rotating token per request", async () => {
  const remote = await upstream()
  let token = "first-token"
  const proxy = await startGitHttpProxy({
    repo: "CCH-HQ/fixture",
    token: () => token,
    allowPush: false,
    upstreamBaseUrl: remote.url,
  })
  try {
    const fetchResponse = await fetch(`${proxy.repoUrl}/info/refs?service=git-upload-pack`)
    expect(await fetchResponse.text()).toBe("ok")
    token = "second-token"
    await fetch(`${proxy.repoUrl}/git-upload-pack`, { method: "POST", body: "0000" })
    expect(remote.requests).toHaveLength(2)
    expect(remote.requests[0]?.authorization).toBe(`Basic ${Buffer.from("x-access-token:first-token").toString("base64")}`)
    expect(remote.requests[1]?.authorization).toBe(`Basic ${Buffer.from("x-access-token:second-token").toString("base64")}`)
    expect(await fetch(proxy.repoUrl.replace("/CCH-HQ/fixture.git", "/other/repo.git") + "/info/refs?service=git-upload-pack").then((response) => response.status)).toBe(403)
    expect(await fetch(`${proxy.repoUrl}/info/refs?service=git-receive-pack`).then((response) => response.status)).toBe(403)
  } finally {
    await proxy.close()
    await remote.close()
  }
})

test("allows receive-pack only for a write-authorized run", async () => {
  const remote = await upstream()
  const proxy = await startGitHttpProxy({ repo: "CCH-HQ/fixture", token: "write-token", allowPush: true, upstreamBaseUrl: remote.url })
  try {
    const response = await fetch(`${proxy.repoUrl}/git-receive-pack`, { method: "POST", body: "pack" })
    expect(response.status).toBe(200)
    expect(remote.requests[0]).toMatchObject({ url: "/CCH-HQ/fixture.git/git-receive-pack", method: "POST", body: "pack" })
  } finally {
    await proxy.close()
    await remote.close()
  }
})

test("rejects absolute-form and network-path targets without forwarding the token", async () => {
  const legitimate = await upstream()
  const attacker = await upstream()
  const proxy = await startGitHttpProxy({
    repo: "CCH-HQ/fixture",
    token: "secret-token",
    allowPush: true,
    upstreamBaseUrl: legitimate.url,
  })
  const proxyPort = Number(new URL(proxy.repoUrl).port)
  try {
    const absolute = await rawRequest(
      proxyPort,
      `${attacker.url}/CCH-HQ/fixture.git/info/refs?service=git-upload-pack`,
    )
    expect(absolute).toContain("403 Forbidden")
    const networkPath = await rawRequest(
      proxyPort,
      `//127.0.0.1:${new URL(attacker.url).port}/CCH-HQ/fixture.git/info/refs?service=git-upload-pack`,
    )
    expect(networkPath).toContain("403 Forbidden")
    expect(attacker.requests).toHaveLength(0)
    expect(legitimate.requests).toHaveLength(0)
  } finally {
    await proxy.close()
    await legitimate.close()
    await attacker.close()
  }
})

test("close aborts incomplete client and upstream requests instead of hanging", async () => {
  const remote = createServer((_request, _response) => {
    // Deliberately never consume the full body and never respond.
  })
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve))
  const address = remote.address()
  if (!address || typeof address === "string") throw new Error("fixture upstream did not bind")
  const proxy = await startGitHttpProxy({
    repo: "CCH-HQ/fixture",
    token: "write-token",
    allowPush: true,
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
  })
  const proxyPort = Number(new URL(proxy.repoUrl).port)
  const client = connect(proxyPort, "127.0.0.1")
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve)
    client.once("error", reject)
  })
  client.write("POST /CCH-HQ/fixture.git/git-receive-pack HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000000\r\n\r\nx")
  try {
    await expect(Promise.race([
      proxy.close().then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ])).resolves.toBe("closed")
  } finally {
    client.destroy()
    await new Promise<void>((resolve) => remote.close(() => resolve()))
  }
})
