export function normalizedForbiddenValues(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

function containsInString(value: string, forbidden: readonly string[]): boolean {
  return forbidden.some((secret) => value.includes(secret))
}

export function containsForbiddenMaterial(value: unknown, values: readonly string[]): boolean {
  const forbidden = normalizedForbiddenValues(values)
  if (forbidden.length === 0) return false
  const seen = new WeakSet<object>()
  const visit = (current: unknown): boolean => {
    if (typeof current === "string") return containsInString(current, forbidden)
    if (current instanceof Uint8Array) {
      const bytes = Buffer.from(current)
      return forbidden.some((secret) => bytes.includes(Buffer.from(secret)))
    }
    if (!current || typeof current !== "object") return false
    if (seen.has(current)) return false
    seen.add(current)
    if (Array.isArray(current)) return current.some(visit)
    return Object.entries(current).some(([key, nested]) => containsInString(key, forbidden) || visit(nested))
  }
  return visit(value)
}

export function assertNoForbiddenMaterial(value: unknown, values: readonly string[], message: string): void {
  if (containsForbiddenMaterial(value, values)) throw new Error(message)
}
