export function redactRuntimeDiagnostic(message: string, secrets: readonly string[]): string {
  let redacted = message.replace(
    /((?:["']?(?:authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|[a-z0-9_-]*(?:token|secret|private[-_]?key|api[-_]?key)[a-z0-9_-]*)["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer|Basic)\s+[^\s,;}\]]+|[^\s,;}\]]+)/gi,
    (_match, prefix: string, value: string) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : ""
      return `${prefix}${quote}[REDACTED]${quote}`
    },
  )
  const variants = new Set<string>()
  for (const secret of secrets) {
    if (secret.length < 4) continue
    variants.add(secret)
    variants.add(JSON.stringify(secret).slice(1, -1))
  }
  for (const variant of [...variants].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(variant).join("[REDACTED]")
  }
  return redacted
}
