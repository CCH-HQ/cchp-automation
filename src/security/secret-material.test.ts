import { expect, test } from "bun:test"
import { assertNoForbiddenMaterial, containsForbiddenMaterial } from "./secret-material"

test("detects multiline and escaped secret material in raw values", () => {
  const secret = "-----BEGIN PRIVATE KEY-----\nline\\\"value\n-----END PRIVATE KEY-----"
  expect(containsForbiddenMaterial({ body: secret }, [secret])).toBe(true)
  expect(containsForbiddenMaterial({ body: JSON.stringify(secret) }, [secret])).toBe(false)
  expect(() => assertNoForbiddenMaterial({ name: secret }, [secret], "blocked")).toThrow("blocked")
})

test("detects secret material in byte snapshots", () => {
  expect(containsForbiddenMaterial(Buffer.from("prefix\nsecret\nsuffix"), ["secret"])).toBe(true)
  expect(containsForbiddenMaterial(Buffer.from("safe"), ["secret"])).toBe(false)
})
