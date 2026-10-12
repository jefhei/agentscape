/**
 * Derived edge model (M2-T4).
 *
 * The fourth piece of the M2 "Spatial Layout Engine". M2-T1 answers *where*
 * each agent sits and M2-T3 answers *how bright / how thick* each element
 * reads; this module answers *how the agents are related* — what kind of
 * relationship each directed contact represents, and, from that, each agent's
 * role and parent.
 *
 * Every edge is **derived from the trace** — a message's declared `action` plus
 * its direction — and never hand-placed. There is no authored topology
 * anywhere: rules applied to recorded facts, nothing else.
 *
 * ## The three kinds (the product's structural questions, PRD §2/§4)
 *
 * - **spawn** — a coordination act that puts another agent to work (an
 *   `assign_task`, a `spawn_agent`, a kickoff `start_loop`). The sender is the
 *   *parent*, the recipient the *child*: this is the edge behind "which parent
 *   spawned how many children?".
 * - **handoff** — the baton passing on (a `handoff`, a `relay`, an `escalate`).
 *   A directed relay edge.
 * - **message** — an ordinary contact: everything else (a reply, a `draft`, a
 *   `task_complete`, an action-less message). The chatter.
 *
 * The model also derives each agent's **role** and **parentId** — the two
 * `Agent` fields M1-T5 deliberately left to this pass (`src/model/traceModel.ts`)
 * — so the fan-out hierarchy has exactly one owner: here. A `null` `parentId`
 * means a root (see {@link DerivedLineage}).
 *
 * ## Direction is preserved (unlike the layout adjacency)
 *
 * {@link deriveLayoutLinks} (M2-T1) collapses a pair of agents into ONE
 * undirected, weighted link, because the *shape* only cares that two agents
 * talk. This model keeps each direction separate — `researcher → critic` and
 * `critic → researcher` are two edges — because the *relationship* is
 * directional: a spawn points at its child, a handoff at its successor.
 * Likewise a broadcast (`Message.to === null`) yields one **message** edge from
 * its sender to every other agent, since it is heard by all of them.
 *
 * ## Roles and parents (which the trace can, and cannot, tell us)
 *
 * From the spawn edges the model derives each agent's `parentId` (the earliest
 * spawner, or `null` for a root) and `role`: an agent that spawns children is a
 * **coordinator** (even if it was itself spawned — a sub-orchestrator), one that
 * was spawned is a **worker**, the run's initiator is a **coordinator**, any
 * other participant is a **worker**, and an agent touched by nothing is
 * **unknown**. The v1 `agent_messages` graph carries no signal that
 * distinguishes an *external* endpoint from a dead leaf, or a *human* from an
 * agent, so those two roles are never invented here.
 *
 * ## Determinism + purity (PRD §5)
 *
 * Pure: no three.js, no DOM, no clock, no `Math.random`, no model mutation. It
 * iterates the model in canonical order and sorts its output, so the same trace
 * yields a byte-identical {@link EdgeModel} whatever order the model's arrays
 * arrive in. A spawn **cycle** is incoherent data — you cannot be your own
 * ancestor — and throws {@link DerivedEdgeError} rather than being silently
 * repaired, the same fail-loudly rule normalization uses.
 *
 * ## Scope (v1 signals only)
 *
 * The `agent_messages` export carries an optional JSON `action` and a
 * sender / recipient, which is the whole basis of classification here. Richer
 * sources with explicit spawn / parent columns or OTel spans are post-MVP
 * (M6-T5) and would refine {@link classifyAction} without changing consumers.
 * Nothing about the look is asserted — the look is human-reviewed (M5-T5).
 */

import type { AgentId, AgentRole, Message, MessageId } from '../types/index.ts'
import { compareModelIds } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'

// ── Edge kinds ──────────────────────────────────────────────────────────────

/**
 * The three relationship kinds the edge model derives, in their canonical
 * (documented) order. `EventKind`-style: the union is derived from this list,
 * so the two can never disagree.
 */
export const EDGE_KINDS = ['spawn', 'handoff', 'message'] as const

/** One of the {@link EDGE_KINDS} tags. */
export type EdgeKind = (typeof EDGE_KINDS)[number]

/** Intra-instant priority of the edge kinds, so the edge list is a total order. */
const EDGE_RANK: Record<EdgeKind, number> = { spawn: 0, handoff: 1, message: 2 }

// ── Classification rules (derived, never hand-placed) ───────────────────────

/**
 * Action **verbs** that mark a *spawn / coordination* edge — the sender is
 * putting the recipient to work. Matched against the first word of the
 * normalized action, so `assign_task` spawns but `assignment_complete` does
 * not. These are rules over trace data, not an authored topology.
 */
export const SPAWN_VERBS: readonly string[] = [
  'spawn',
  'assign',
  'delegate',
  'dispatch',
  'launch',
  'create',
  'start',
  'kick',
  'kickoff',
  'init',
  'initiate',
  'fork',
]

/** Action verbs that mark a *handoff* edge — the baton passing on. */
export const HANDOFF_VERBS: readonly string[] = [
  'handoff',
  'handover',
  'relay',
  'transfer',
  'escalate',
]

/**
 * The words of an action: camelCase is split into words and any
 * non-alphanumeric separator is dropped, so `assignTask`, `assign-task` and
 * `assign_task` all start with `assign`.
 */
function actionWords(action: string): string[] {
  return action
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
}

/**
 * Classify a message's declared action into an {@link EdgeKind}. Handoff is
 * checked before spawn (a `relay_handoff` is a handoff). The action's first
 * word is matched against the verb tables, and the whole action is matched
 * separator-insensitively, so `hand_off` reads as `handoff`. Anything
 * unrecognised — including a message with no action at all — is an ordinary
 * `message` edge: the model never guesses a stronger relationship than the
 * trace states.
 */
export function classifyAction(action: string | null): EdgeKind {
  if (action === null || action.length === 0) return 'message'
  const words = actionWords(action)
  const first = words[0] ?? ''
  const whole = words.join('')
  if (HANDOFF_VERBS.includes(first) || HANDOFF_VERBS.includes(whole)) return 'handoff'
  if (SPAWN_VERBS.includes(first) || SPAWN_VERBS.includes(whole)) return 'spawn'
  return 'message'
}

// ── Public shapes ───────────────────────────────────────────────────────────

/** Thrown when a run's edges cannot form a coherent lineage (a spawn cycle). */
export class DerivedEdgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DerivedEdgeError'
  }
}

/**
 * One directed, typed relationship between two agents, aggregated over every
 * message that carried it. Mirrors {@link LayoutLink} but keeps the direction:
 * `source → target`.
 */
export interface DerivedEdge {
  kind: EdgeKind
  /** The acting / parent / predecessor agent. */
  source: AgentId
  /** The receiving / child / successor agent. */
  target: AgentId
  /** Number of messages backing this edge; always `>= 1`. */
  weight: number
  /** The backing message ids, in canonical order. */
  messageIds: MessageId[]
  /** The distinct declared actions on the edge, in canonical order. */
  actions: string[]
  /** Earliest message time on the edge, epoch ms. */
  firstAt: number
  /** Latest message time on the edge, epoch ms. */
  lastAt: number
}

/**
 * One agent's derived lineage: the role and parent M1-T5 left to this pass, plus
 * the fan-out children behind them.
 */
export interface DerivedLineage {
  agentId: AgentId
  /** Derived role ({@link AgentRole}); `unknown` when the trace does not say. */
  role: AgentRole
  /** The spawning agent, or `null` for a root. */
  parentId: AgentId | null
  /** Spawn children (outgoing spawn-edge targets), in canonical order. */
  childIds: AgentId[]
  /** Outgoing spawn degree — how many children this agent spawned. */
  fanOut: number
}

/**
 * The complete derived edge model for one run: every typed edge, the same edges
 * grouped by kind, and each agent's lineage.
 */
export interface EdgeModel {
  /** Every edge, in canonical order (kind-rank, then source, then target). */
  edges: DerivedEdge[]
  /** The same edges grouped by kind, each group in canonical order. */
  byKind: Record<EdgeKind, DerivedEdge[]>
  /** One lineage entry per agent, in canonical id order. */
  agents: DerivedLineage[]
  /** Agents with no spawn parent, in canonical order (the forest roots). */
  rootIds: AgentId[]
  /** Edge count per kind. */
  counts: Record<EdgeKind, number>
  /** Largest `DerivedLineage.fanOut` across the run (`0` when nobody spawns). */
  maxFanOut: number
}

/** Working accumulator for one `(kind, source, target)` edge while deriving. */
interface EdgeAccumulator {
  kind: EdgeKind
  source: AgentId
  target: AgentId
  messageIds: MessageId[]
  actions: string[]
  firstAt: number
  lastAt: number
}

// ── Integrity ───────────────────────────────────────────────────────────────

/**
 * A spawn's parent chain must not loop: following `parentId` upward from any
 * agent must terminate at a root, or the run has an agent that is its own
 * ancestor. Detected deterministically and reported rather than silently
 * broken (the model is a forest by construction).
 */
function assertAcyclicSpawn(parentOf: ReadonlyMap<AgentId, AgentId>): void {
  for (const start of parentOf.keys()) {
    const seen = new Set<AgentId>()
    let current: AgentId | undefined = start
    while (current !== undefined) {
      if (seen.has(current)) {
        throw new DerivedEdgeError(`spawn cycle through agent ${current}`)
      }
      seen.add(current)
      current = parentOf.get(current)
    }
  }
}

// ── The derivation ──────────────────────────────────────────────────────────

/**
 * Derive the typed edge model from a normalized {@link TraceModel}.
 *
 * Each message becomes one edge from its sender to its recipient (`to === null`
 * broadcasts reach every other agent), classified by {@link classifyAction} and
 * aggregated by `(kind, source, target)`. From the spawn edges it then derives
 * every agent's `role` and `parentId` — the fan-out hierarchy. Pure and
 * deterministic: the same trace yields a byte-identical {@link EdgeModel}
 * whatever order its arrays arrive in, and the model is never mutated.
 *
 * @throws DerivedEdgeError when the spawn edges form a cycle.
 */
export function deriveEdgeModel(model: TraceModel): EdgeModel {
  const agentIds = model.agents.map((agent) => agent.id).sort(compareModelIds)
  // Canonical order first, so the aggregation below is order-independent.
  const messages = [...model.messages].sort(
    (a, b) => a.at - b.at || compareModelIds(a.id, b.id),
  )

  const accumulators = new Map<string, EdgeAccumulator>()

  const record = (
    kind: EdgeKind,
    source: AgentId,
    target: AgentId,
    message: Message,
  ): void => {
    if (source === target) return // a self-message has no direction to model
    const key = `${kind}\u0000${source}\u0000${target}`
    const existing = accumulators.get(key)
    if (existing === undefined) {
      accumulators.set(key, {
        kind,
        source,
        target,
        messageIds: [message.id],
        actions: message.action === null ? [] : [message.action],
        firstAt: message.at,
        lastAt: message.at,
      })
      return
    }
    existing.messageIds.push(message.id)
    if (message.action !== null && !existing.actions.includes(message.action)) {
      existing.actions.push(message.action)
    }
    if (message.at < existing.firstAt) existing.firstAt = message.at
    if (message.at > existing.lastAt) existing.lastAt = message.at
  }

  for (const message of messages) {
    const kind = classifyAction(message.action)
    if (message.to !== null) {
      record(kind, message.from, message.to, message)
    } else {
      // Broadcast: heard by every other agent.
      for (const id of agentIds) record(kind, message.from, id, message)
    }
  }

  const edges: DerivedEdge[] = [...accumulators.values()].map((acc) => ({
    kind: acc.kind,
    source: acc.source,
    target: acc.target,
    weight: acc.messageIds.length,
    messageIds: [...acc.messageIds].sort(compareModelIds),
    actions: [...acc.actions].sort(compareModelIds),
    firstAt: acc.firstAt,
    lastAt: acc.lastAt,
  }))
  edges.sort(
    (a, b) =>
      EDGE_RANK[a.kind] - EDGE_RANK[b.kind] ||
      compareModelIds(a.source, b.source) ||
      compareModelIds(a.target, b.target),
  )

  const byKind: Record<EdgeKind, DerivedEdge[]> = {
    spawn: [],
    handoff: [],
    message: [],
  }
  for (const edge of edges) byKind[edge.kind].push(edge)

  // ── Lineage: parent, children, role ──
  const parentOf = new Map<AgentId, AgentId>()
  const parentFirstAt = new Map<AgentId, number>()
  const childIdsOf = new Map<AgentId, AgentId[]>()

  for (const edge of byKind.spawn) {
    const current = parentOf.get(edge.target)
    const seenAt = parentFirstAt.get(edge.target) ?? Infinity
    // Deterministic tie-break when several agents spawn the same child: the
    // earliest spawn wins, then the canonically-first parent id.
    if (
      current === undefined ||
      edge.firstAt < seenAt ||
      (edge.firstAt === seenAt && compareModelIds(edge.source, current) < 0)
    ) {
      parentOf.set(edge.target, edge.source)
      parentFirstAt.set(edge.target, edge.firstAt)
    }

    const kids = childIdsOf.get(edge.source)
    if (kids === undefined) childIdsOf.set(edge.source, [edge.target])
    else if (!kids.includes(edge.target)) kids.push(edge.target)
  }

  assertAcyclicSpawn(parentOf)

  const outDegree = new Map<AgentId, number>()
  const inDegree = new Map<AgentId, number>()
  for (const edge of edges) {
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1)
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
  }

  // The run's initiator: the sender of the earliest message.
  const origin: AgentId | null = messages.length > 0 ? messages[0].from : null

  const agents: DerivedLineage[] = agentIds.map((agentId) => {
    const childIds = [...(childIdsOf.get(agentId) ?? [])].sort(compareModelIds)
    const parentId = parentOf.get(agentId) ?? null
    const outgoing = outDegree.get(agentId) ?? 0
    const incoming = inDegree.get(agentId) ?? 0

    // Coordinating wins over being coordinated: an agent that spawns others is a
    // coordinator even if it was itself spawned (a sub-orchestrator).
    let role: AgentRole
    if (childIds.length > 0) role = 'coordinator'
    else if (parentId !== null) role = 'worker'
    else if (agentId === origin) role = 'coordinator'
    else if (outgoing > 0 || incoming > 0) role = 'worker'
    else role = 'unknown'

    return { agentId, role, parentId, childIds, fanOut: childIds.length }
  })

  const rootIds = agents
    .filter((lineage) => lineage.parentId === null)
    .map((lineage) => lineage.agentId)
  const maxFanOut = agents.reduce((max, lineage) => Math.max(max, lineage.fanOut), 0)

  return {
    edges,
    byKind,
    agents,
    rootIds,
    counts: {
      spawn: byKind.spawn.length,
      handoff: byKind.handoff.length,
      message: byKind.message.length,
    },
    maxFanOut,
  }
}

/**
 * Return `model` with every agent's `role` and `parentId` filled in from the
 * derived edge model — the fan-out hierarchy applied back onto the contract.
 * The edge model is derived once and reused when passed in.
 *
 * The result is still a normalized model: M1-T5 recomputes counts but
 * deliberately preserves `role` / `parentId`, so `normalizeTrace(withDerivedLineage(model))`
 * deep-equals `withDerivedLineage(model)`.
 */
export function withDerivedLineage(
  model: TraceModel,
  edgeModel?: EdgeModel,
): TraceModel {
  const derived = edgeModel ?? deriveEdgeModel(model)
  const lineageById = new Map(
    derived.agents.map((lineage) => [lineage.agentId, lineage]),
  )
  return {
    ...model,
    agents: model.agents.map((agent) => {
      const lineage = lineageById.get(agent.id)
      if (lineage === undefined) return agent
      return { ...agent, role: lineage.role, parentId: lineage.parentId }
    }),
  }
}

// ── Lookups ─────────────────────────────────────────────────────────────────

/** The lineage for `agentId`, or `null` when the agent is absent from the run. */
export function lineageOf(
  edgeModel: EdgeModel,
  agentId: AgentId,
): DerivedLineage | null {
  for (const lineage of edgeModel.agents) {
    if (lineage.agentId === agentId) return lineage
  }
  return null
}

/**
 * The directed edge `source → target` (optionally of a specific kind), or
 * `null` when no such edge exists. Mirrors `nodeAttribute` (M2-T3) so a
 * consumer can read one relationship without building its own index.
 */
export function edgeBetween(
  edgeModel: EdgeModel,
  source: AgentId,
  target: AgentId,
  kind?: EdgeKind,
): DerivedEdge | null {
  for (const edge of edgeModel.edges) {
    if (edge.source !== source || edge.target !== target) continue
    if (kind !== undefined && edge.kind !== kind) continue
    return edge
  }
  return null
}
