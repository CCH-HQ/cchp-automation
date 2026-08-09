import { mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { appendJsonl, parseJsonl, readJsonl } from "./jsonl"

export type ChildTerminalState = "completed" | "failed" | "timed_out" | "interrupted" | "lost"

export interface ChildEdge {
  parentId: string
  childId: string
  spawnItemId: string
  transport: "native_v2" | "explicit_child"
  state: "open" | "closed"
  openedAt: string
  closedAt?: string
  terminalState?: ChildTerminalState
  generation: number
  wakeId?: string
  wakeState?: "pending" | "delivered"
  wakeAttempts?: number
  wakeLastError?: string
  resumeDeliveredAt?: string
}

function wakeId(edge: Pick<ChildEdge, "parentId" | "childId" | "spawnItemId" | "generation" | "terminalState">): string {
  return createHash("sha256")
    .update([edge.parentId, edge.childId, edge.spawnItemId, edge.generation, edge.terminalState].join("\0"))
    .digest("hex")
}

export class ChildGraph {
  private readonly byChild = new Map<string, ChildEdge>()
  private readonly children = new Map<string, string[]>()

  constructor(private readonly path?: string, private readonly assertWriterOwnership?: () => void) {
    if (path) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      for (const row of readJsonl(path)) this.replay(row)
    }
  }

  static fromSnapshot(value: string | Buffer, sourceName = "graph snapshot"): ChildGraph {
    const graph = new ChildGraph()
    for (const row of parseJsonl(value, sourceName)) graph.replay(row)
    return graph
  }

  open(
    parentId: string,
    childId: string,
    spawnItemId: string,
    transport: ChildEdge["transport"] = "native_v2",
    generation = 1,
  ): ChildEdge {
    if (!parentId || !childId || !spawnItemId) throw new Error("graph edge ids must be non-empty")
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("graph edge generation must be positive")
    const existing = this.byChild.get(childId)
    if (existing) {
      if (existing.parentId !== parentId) {
        throw new Error(`child ${childId} already has parent ${existing.parentId}`)
      }
      if (existing.spawnItemId !== spawnItemId) {
        throw new Error(`child ${childId} already has spawn item ${existing.spawnItemId}`)
      }
      if (existing.transport !== transport) throw new Error(`child ${childId} already uses transport ${existing.transport}`)
      return existing
    }
    const edge: ChildEdge = {
      parentId,
      childId,
      spawnItemId,
      transport,
      state: "open",
      openedAt: new Date().toISOString(),
      generation,
    }
    this.byChild.set(childId, edge)
    const children = this.children.get(parentId) ?? []
    children.push(childId)
    this.children.set(parentId, children)
    this.append({ event: "edge_opened", ...edge })
    return edge
  }

  close(childId: string, terminalState: ChildTerminalState): boolean {
    const edge = this.byChild.get(childId)
    if (!edge) throw new Error(`unknown child ${childId}`)
    if (edge.state === "closed") return false
    edge.state = "closed"
    edge.terminalState = terminalState
    edge.closedAt = new Date().toISOString()
    edge.wakeId = wakeId(edge)
    edge.wakeState = "pending"
    edge.wakeAttempts = 0
    edge.wakeLastError = undefined
    this.append({ event: "edge_closed", ...edge })
    return true
  }

  reopen(childId: string): ChildEdge {
    const edge = this.byChild.get(childId)
    if (!edge) throw new Error(`unknown child ${childId}`)
    if (edge.state === "open") return edge
    edge.state = "open"
    edge.closedAt = undefined
    edge.terminalState = undefined
    edge.resumeDeliveredAt = undefined
    edge.generation++
    edge.wakeId = undefined
    edge.wakeState = undefined
    edge.wakeAttempts = undefined
    edge.wakeLastError = undefined
    this.append({ event: "edge_reopened", ...edge })
    return edge
  }

  markResumeDelivered(childId: string): void {
    const edge = this.byChild.get(childId)
    if (!edge) throw new Error(`unknown child ${childId}`)
    if (edge.state !== "closed") throw new Error(`child ${childId} is not terminal`)
    if (edge.resumeDeliveredAt || edge.wakeState === "delivered") return
    edge.resumeDeliveredAt = new Date().toISOString()
    edge.wakeState = "delivered"
    this.append({ event: "parent_resume_delivered", ...edge })
  }

  markResumeAttempt(childId: string, error?: string): ChildEdge {
    const edge = this.byChild.get(childId)
    if (!edge || edge.state !== "closed" || !edge.wakeId) throw new Error(`child ${childId} has no pending parent wake`)
    if (edge.wakeState === "delivered") return { ...edge }
    edge.wakeAttempts = (edge.wakeAttempts ?? 0) + 1
    edge.wakeLastError = error
    this.append({ event: "parent_resume_attempted", ...edge })
    return { ...edge }
  }

  pendingResumes(): ChildEdge[] {
    return [...this.byChild.values()]
      .filter((edge) => edge.state === "closed" && edge.wakeState === "pending")
      .map((edge) => ({ ...edge }))
  }

  edge(childId: string): ChildEdge | undefined {
    const edge = this.byChild.get(childId)
    return edge ? { ...edge } : undefined
  }

  openEdges(): ChildEdge[] {
    return [...this.byChild.values()].filter((edge) => edge.state === "open")
  }

  edges(): ChildEdge[] {
    return [...this.byChild.values()].map((edge) => ({ ...edge }))
  }

  descendants(parentId: string): string[] {
    const result: string[] = []
    const queue = [...(this.children.get(parentId) ?? [])]
    for (let index = 0; index < queue.length; index++) {
      const child = queue[index]!
      result.push(child)
      queue.push(...(this.children.get(child) ?? []))
    }
    return result
  }

  private append(value: unknown): void {
    if (!this.path) return
    this.assertWriterOwnership?.()
    appendJsonl(this.path, value)
  }

  private replay(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("graph ledger row must be an object")
    const row = value as Record<string, unknown>
    const event = row.event
    const parentId = typeof row.parentId === "string" ? row.parentId : ""
    const childId = typeof row.childId === "string" ? row.childId : ""
    const spawnItemId = typeof row.spawnItemId === "string" ? row.spawnItemId : ""
    const transport = row.transport === undefined || row.transport === "native_v2"
      ? "native_v2"
      : row.transport === "explicit_child"
        ? "explicit_child"
        : undefined
    if (!transport) throw new Error(`graph ledger row has invalid transport ${String(row.transport)}`)
    if (!parentId || !childId || !spawnItemId) throw new Error("graph ledger row has invalid edge identity")
    const existing = this.byChild.get(childId)
    if (event === "edge_opened") {
      const generation = Number.isSafeInteger(row.generation) && Number(row.generation) > 0 ? Number(row.generation) : 1
      if (existing) {
        if (existing.parentId !== parentId || existing.spawnItemId !== spawnItemId) throw new Error(`conflicting replay identity for child ${childId}`)
        if (existing.transport !== transport) throw new Error(`conflicting replay transport for child ${childId}`)
        if (existing.generation !== generation) throw new Error(`conflicting replay generation for child ${childId}`)
        return
      }
      const openedAt = typeof row.openedAt === "string" ? row.openedAt : ""
      if (!openedAt) throw new Error(`graph open row missing openedAt for ${childId}`)
      this.byChild.set(childId, { parentId, childId, spawnItemId, transport, state: "open", openedAt, generation })
      this.children.set(parentId, [...(this.children.get(parentId) ?? []), childId])
      return
    }
    if (!existing) throw new Error(`graph replay references unknown child ${childId}`)
    if (existing.parentId !== parentId || existing.spawnItemId !== spawnItemId) throw new Error(`conflicting replay identity for child ${childId}`)
    if (existing.transport !== transport) throw new Error(`conflicting replay transport for child ${childId}`)
    if (event === "edge_closed") {
      const terminalState = row.terminalState as ChildTerminalState
      const closedAt = typeof row.closedAt === "string" ? row.closedAt : ""
      if (!closedAt || !["completed", "failed", "timed_out", "interrupted", "lost"].includes(terminalState)) {
        throw new Error(`invalid graph close row for ${childId}`)
      }
      if (existing.state === "closed") {
        if (existing.terminalState !== terminalState) throw new Error(`conflicting terminal replay for child ${childId}`)
        return
      }
      existing.state = "closed"
      existing.closedAt = closedAt
      existing.terminalState = terminalState
      existing.wakeId = typeof row.wakeId === "string" && row.wakeId ? row.wakeId : wakeId(existing)
      existing.wakeState = row.wakeState === "delivered" ? "delivered" : "pending"
      existing.wakeAttempts = Number.isSafeInteger(row.wakeAttempts) && Number(row.wakeAttempts) >= 0 ? Number(row.wakeAttempts) : 0
      existing.wakeLastError = typeof row.wakeLastError === "string" ? row.wakeLastError : undefined
      existing.resumeDeliveredAt = typeof row.resumeDeliveredAt === "string" ? row.resumeDeliveredAt : undefined
      return
    }
    if (event === "edge_reopened") {
      const generation = Number.isSafeInteger(row.generation) && Number(row.generation) > 0 ? Number(row.generation) : existing.generation + 1
      if (existing.state === "open" && existing.generation === generation) return
      if (generation !== existing.generation + 1) throw new Error(`invalid graph generation replay for ${childId}`)
      existing.state = "open"
      existing.generation = generation
      existing.closedAt = undefined
      existing.terminalState = undefined
      existing.resumeDeliveredAt = undefined
      existing.wakeId = undefined
      existing.wakeState = undefined
      existing.wakeAttempts = undefined
      existing.wakeLastError = undefined
      return
    }
    if (event === "parent_resume_attempted") {
      if (existing.state !== "closed" || !existing.wakeId) throw new Error(`resume attempt replay precedes child terminal state for ${childId}`)
      const attempts = Number(row.wakeAttempts)
      if (!Number.isSafeInteger(attempts) || attempts < (existing.wakeAttempts ?? 0)) throw new Error(`invalid resume attempt replay for ${childId}`)
      existing.wakeAttempts = attempts
      existing.wakeLastError = typeof row.wakeLastError === "string" ? row.wakeLastError : undefined
      return
    }
    if (event === "parent_resume_delivered") {
      if (existing.state !== "closed") throw new Error(`resume delivery replay precedes child terminal state for ${childId}`)
      const deliveredAt = typeof row.resumeDeliveredAt === "string" ? row.resumeDeliveredAt : ""
      if (!deliveredAt) throw new Error(`resume delivery row missing timestamp for ${childId}`)
      existing.resumeDeliveredAt ??= deliveredAt
      existing.wakeState = "delivered"
      return
    }
    throw new Error(`unknown graph ledger event ${String(event)}`)
  }
}
