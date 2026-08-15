export const DEADLINES = {
  // GitHub job timeout remains 12h. The supervisor stops ten minutes earlier so
  // interrupt escalation, terminal fsync, artifact upload and cleanup can run.
  wholeRunMs: 11 * 60 * 60 * 1000 + 50 * 60 * 1000,
  childMs: 30 * 60 * 1000,
  heartbeatMs: 60 * 1000,
  progressPublishMs: 30 * 1000,
  noProgressWarningMs: 5 * 60 * 1000,
  noProgressTerminalMs: 20 * 60 * 1000,
  reconcileMs: 30 * 1000,
  childNoEventMs: 2 * 60 * 1000,
  parentResumeMs: 2 * 60 * 1000,
  interruptGraceMs: 15 * 1000,
  termGraceMs: 15 * 1000,
} as const

export type ProgressDeadlineState = "healthy" | "warning" | "stale" | "terminal"

export interface ProgressDeadlineResult {
  state: ProgressDeadlineState
  semanticAgeMs: number
  modelAgeMs: number
}

export interface ProgressDeadlineOptions {
  now?: () => number
  semanticAt?: number
  warningMs?: number
  terminalMs?: number
}

export class ProgressDeadline {
  private readonly now: () => number
  private readonly warningMs: number
  private readonly terminalMs: number
  private semanticAt: number
  private transportAt: number
  private modelAt: number
  private sidecarAt: number
  private epoch = 0
  private warnedEpoch = -1

  constructor(options: ProgressDeadlineOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.warningMs = options.warningMs ?? DEADLINES.noProgressWarningMs
    this.terminalMs = options.terminalMs ?? DEADLINES.noProgressTerminalMs
    if (this.warningMs < 0 || this.terminalMs <= this.warningMs) {
      throw new Error("progress deadline must satisfy 0 <= warning < terminal")
    }
    const started = options.semanticAt ?? this.now()
    if (!Number.isFinite(started)) throw new Error("progress deadline semanticAt must be finite")
    this.semanticAt = started
    this.transportAt = started
    this.modelAt = started
    this.sidecarAt = started
  }

  semanticProgress(_reason: string): void {
    const now = this.now()
    this.semanticAt = now
    this.transportAt = now
    this.modelAt = now
    this.epoch++
  }

  transportEvent(_source: string): void {
    this.transportAt = this.now()
  }

  modelEvent(): void {
    const now = this.now()
    this.modelAt = now
    this.transportAt = now
  }

  sidecarEvent(): void {
    this.sidecarAt = this.now()
  }

  check(): ProgressDeadlineResult {
    const now = this.now()
    const semanticAge = Math.max(0, now - this.semanticAt)
    const modelAge = Math.max(0, now - this.modelAt)
    // Terminal requires both clocks. Completed model output can keep a healthy
    // long review alive past 20m of plan/item silence; heartbeats cannot.
    if (semanticAge >= this.terminalMs && modelAge >= this.terminalMs) {
      return { state: "terminal", semanticAgeMs: semanticAge, modelAgeMs: modelAge }
    }
    if (semanticAge >= this.warningMs) {
      if (this.warnedEpoch !== this.epoch) {
        this.warnedEpoch = this.epoch
        return { state: "warning", semanticAgeMs: semanticAge, modelAgeMs: modelAge }
      }
      return { state: "stale", semanticAgeMs: semanticAge, modelAgeMs: modelAge }
    }
    return { state: "healthy", semanticAgeMs: semanticAge, modelAgeMs: modelAge }
  }

  snapshot() {
    const now = this.now()
    return {
      lastSemanticProgressMs: this.semanticAt,
      lastTransportEventMs: this.transportAt,
      lastModelEventMs: this.modelAt,
      lastSidecarEventMs: this.sidecarAt,
      semanticAgeMs: Math.max(0, now - this.semanticAt),
      modelAgeMs: Math.max(0, now - this.modelAt),
    }
  }
}
