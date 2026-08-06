import { mintInstallationToken, type TokenScope } from "./app-token"

/** Prevent same-UID processes from reading this runtime's credential-bearing
 * `/proc/<pid>/environ` or memory after App credentials have been captured. */
export function hideProcEnviron(log: (message: string) => void): void {
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi")
    const libc = dlopen("libc.so.6", {
      prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    })
    libc.symbols.prctl(4 /* PR_SET_DUMPABLE */, 0, 0, 0, 0)
  } catch {
    log("warn: PR_SET_DUMPABLE hardening unavailable (continuing)")
  }
}

export interface TokenRotationOptions {
  clientId?: string
  privateKey?: string
  repo: string
  scope: TokenScope
  fallback?: string
  refreshMs?: number
  retryMs?: number
  mint?: typeof mintInstallationToken
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

export interface TokenRotationHandle {
  token(): string
  close(): Promise<void>
}

export async function startTokenRotation(options: TokenRotationOptions): Promise<TokenRotationHandle> {
  const mint = options.mint ?? mintInstallationToken
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? (() => undefined)
  let current = options.fallback
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const canRotate = Boolean(options.clientId && options.privateKey)

  const refresh = async (): Promise<boolean> => {
    if (!canRotate) return false
    try {
      current = await mint({
        clientId: options.clientId!,
        privateKey: options.privateKey!,
        repo: options.repo,
        scope: options.scope,
      })
      log("GitHub installation token refreshed in memory")
      return true
    } catch (error) {
      log(`GitHub installation token refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  if (canRotate) {
    let minted = false
    for (let attempt = 0; attempt < 3 && !minted; attempt++) {
      minted = await refresh()
      if (!minted && attempt < 2) await sleep(2_000)
    }
    if (!minted && !current) throw new Error("could not mint an initial GitHub installation token")
  }
  if (!current) throw new Error("GitHub token source is unavailable")

  const schedule = (delay: number) => {
    if (closed || !canRotate) return
    timer = setTimeout(async () => {
      const ok = await refresh()
      schedule(ok ? options.refreshMs ?? 2_700_000 : options.retryMs ?? 60_000)
    }, delay)
    timer.unref?.()
  }
  schedule(options.refreshMs ?? 2_700_000)

  return {
    token() {
      if (!current) throw new Error("GitHub token source is unavailable")
      return current
    },
    async close() {
      closed = true
      if (timer) clearTimeout(timer)
    },
  }
}
