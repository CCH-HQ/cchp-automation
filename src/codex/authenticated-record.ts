import { createHmac, timingSafeEqual } from "node:crypto"

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value !== "object") throw new Error("authenticated record contains an unsupported value")
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
}

export function validateRecordHmacKey(key: string | undefined): string {
  if (!key || !/^[a-f0-9]{64}$/.test(key)) throw new Error("process record HMAC key must be 32-byte lowercase hex")
  return key
}

export function recordHmac(record: Record<string, unknown>, key: string): string {
  const payload = Object.fromEntries(Object.entries(record).filter(([name]) => name !== "mac"))
  return createHmac("sha256", Buffer.from(validateRecordHmacKey(key), "hex"))
    .update(canonical(payload))
    .digest("hex")
}

export function attachRecordHmac<T extends Record<string, unknown>>(record: T, key: string): T & { mac: string } {
  return { ...record, mac: recordHmac(record, key) }
}

export function hasValidRecordHmac(record: Record<string, unknown>, key: string): boolean {
  if (typeof record.mac !== "string" || !/^[a-f0-9]{64}$/.test(record.mac)) return false
  const actual = Buffer.from(record.mac, "hex")
  const expected = Buffer.from(recordHmac(record, key), "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
