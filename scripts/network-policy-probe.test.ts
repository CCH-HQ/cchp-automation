import { expect, test } from "bun:test"
import { classifyNetworkProbe } from "./network-policy-probe"

test("accepts only structured proxy or socket policy denials", () => {
  expect(classifyNetworkProbe({
    target: "https://example.com",
    status: 403,
    proxyError: "blocked-by-policy",
  })).toMatchObject({ result: "policy-blocked", reason: "proxy-structured-denial" })
  expect(classifyNetworkProbe({
    target: "https://example.com",
    error: { message: "connect failed", syscall: "connect", code: "EPERM" },
  })).toMatchObject({ result: "policy-blocked", reason: "os-connect-denied" })
})

test("treats HTTP reachability and generic transport failures as non-passing evidence", () => {
  expect(classifyNetworkProbe({
    target: "https://example.com",
    status: 500,
  })).toMatchObject({ result: "reachable", reason: "http-response" })
  for (const error of [
    { message: "fetch failed" },
    { message: "certificate verify failed", code: "CERT_HAS_EXPIRED" },
    { message: "permission denied" },
    { message: "network sandbox refused the request" },
    { message: "connect timeout", syscall: "connect", code: "ETIMEDOUT" },
    { message: "dns failed", syscall: "getaddrinfo", code: "ENOTFOUND" },
  ]) {
    expect(classifyNetworkProbe({ target: "https://example.com", error })).toMatchObject({
      result: "indeterminate",
      reason: "unclassified-error",
    })
  }
})
