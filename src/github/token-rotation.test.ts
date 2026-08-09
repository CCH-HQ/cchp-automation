import { expect, test } from "bun:test"
import { scopePermissions } from "./app-token"
import { startTokenRotation } from "./token-rotation"

const writeScope = "write" as const

test("mints the initial token with the exact repository permission scope", async () => {
  const calls: unknown[] = []
  const rotation = await startTokenRotation({
    clientId: "client",
    privateKey: "private-key",
    repo: "CCH-HQ/fixture",
    scope: writeScope,
    refreshMs: 60_000,
    mint: async (input) => {
      calls.push(input)
      return "minted-token"
    },
  })
  try {
    expect(rotation.token()).toBe("minted-token")
    expect(calls).toEqual([{
      clientId: "client",
      privateKey: "private-key",
      repo: "CCH-HQ/fixture",
      scope: writeScope,
    }])
    expect(scopePermissions(writeScope)).toEqual({
      contents: "write",
      metadata: "read",
      issues: "write",
      pull_requests: "write",
      discussions: "write",
      actions: "write",
      checks: "write",
      workflows: "write",
      organization_projects: "write",
    })
    expect(scopePermissions("base")).toEqual({
      contents: "read",
      metadata: "read",
      issues: "read",
      pull_requests: "read",
      discussions: "read",
      actions: "read",
      organization_projects: "read",
    })
    expect(scopePermissions("interaction")).toEqual({
      contents: "read",
      metadata: "read",
      issues: "write",
      pull_requests: "write",
      discussions: "write",
      actions: "read",
      organization_projects: "write",
    })
  } finally {
    await rotation.close()
  }
})

test("uses the static fallback when App credentials are unavailable", async () => {
  let calls = 0
  const rotation = await startTokenRotation({
    repo: "CCH-HQ/fixture",
    scope: writeScope,
    fallback: "fallback-token",
    mint: async () => {
      calls++
      return "unexpected"
    },
  })
  try {
    expect(rotation.token()).toBe("fallback-token")
    expect(calls).toBe(0)
  } finally {
    await rotation.close()
  }
})

test("retains the last token across a failed refresh and then rotates in memory", async () => {
  let calls = 0
  const logs: string[] = []
  const rotation = await startTokenRotation({
    clientId: "client",
    privateKey: "private-key",
    repo: "CCH-HQ/fixture",
    scope: writeScope,
    refreshMs: 5,
    retryMs: 5,
    mint: async () => {
      calls++
      if (calls === 1) return "token-1"
      if (calls === 2) throw new Error("temporary failure")
      return "token-2"
    },
    log: (message) => logs.push(message),
  })
  try {
    expect(rotation.token()).toBe("token-1")
    while (calls < 2) await Bun.sleep(2)
    expect(rotation.token()).toBe("token-1")
    while (calls < 3) await Bun.sleep(2)
    expect(rotation.token()).toBe("token-2")
    expect(logs.some((message) => message.includes("temporary failure"))).toBe(true)
  } finally {
    await rotation.close()
  }
})

test("close cancels future refreshes", async () => {
  let calls = 0
  const rotation = await startTokenRotation({
    clientId: "client",
    privateKey: "private-key",
    repo: "CCH-HQ/fixture",
    scope: writeScope,
    refreshMs: 20,
    mint: async () => `token-${++calls}`,
  })
  expect(calls).toBe(1)
  await rotation.close()
  await Bun.sleep(35)
  expect(calls).toBe(1)
})

test("fails closed only when both App minting and fallback are unavailable", async () => {
  const sleeps: number[] = []
  await expect(startTokenRotation({
    clientId: "client",
    privateKey: "private-key",
    repo: "CCH-HQ/fixture",
    scope: writeScope,
    mint: async () => { throw new Error("mint failed") },
    sleep: async (ms) => { sleeps.push(ms) },
  })).rejects.toThrow("could not mint an initial GitHub installation token")
  expect(sleeps).toEqual([2_000, 2_000])
})
