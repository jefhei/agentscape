/**
 * TraceModel normalization pass (M1-T5).
 *
 * The adapter (M1-T4) turns an `agent_messages` export into a {@link Run}; this
 * pass turns ANY `Run`-shaped object into a {@link TraceModel} — the same run
 * with every contract invariant enforced. It is the single place that:
 *
 * 1. **Canonicalizes order.** `agents`, `messages`, `toolCalls` and `events`
 *    are re-sorted into a deterministic total order, independent of the order
 *    the arrays happened to arrive in.
 * 2. **Assigns `Event.sequence`.** A contiguous 0-based index over the
 *    canonical event order — the contract says the normalizer owns this field
 *    (`src/types/trace.ts`), and the playhead model (M1-T7) rides on it.
 * 3. **Recomputes every derived/precomputed field** from the facts: per-agent
 *    send/receive counts, active window, token/cost attribution, the whole
 *    `RunMeta` and the `startedAt`/`endedAt` span. A stale count in the input
 *    cannot survive normalization.
 * 4. **Validates referential integrity** — ids are unique, every message /
 *    tool call / event points at something that exists, lifecycle events are
 *    unattributed and `message` / `tool_call` events are attributed. A broken
 *    run throws {@link TraceModelError} rather than being silently repaired.
 *
 * It deliberately does NOT re-derive `Agent.role` / `Agent.parentId` (the
 * fan-out / handoff edge model is M2-T4's job) — those are preserved as-is, so
 * the pass composes cleanly with the later derivation. It never invents facts:
 * absent token/cost data stays `0`, an empty export stays an empty model.
 *
 * Pure by construction — no network, no clock, no DOM, no three.js — so it is
 * fully unit-testable in jsdom. Determinism is the deliverable (PRD §5): the
 * same facts in ⇒ byte-identical model out, *whatever* order they came in.
 */

import type {
  Agent,
  Event,
  EventKind,
  Message,
  MessageId,
  Run,
  RunMeta,
  ToolCall,
} from '../types/index.ts'
import { isLifecycleEvent, isMessageEvent } from '../types/index.ts'

/**
 * A {@link Run} that has passed normalization: canonical order, contiguous
 * `Event.sequence`, derived fields recomputed and referential integrity
 * verified. Consumers (layout M2, render M3+) can rely on those invariants.
 *
 * It is an alias, not a new shape — a `TraceModel` IS a `Run`; the name marks
 * the provenance so a function can say "give me a normalized one".
 */
export type TraceModel = Run

/** Thrown when a `Run` cannot be normalized because its facts do not cohere. */
export class TraceModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TraceModelError'
  }
}

// ── Deterministic ordering ──────────────────────────────────────────────────

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57 // '0' .. '9'
}

/**
 * Deterministic *natural* comparison of two ids: runs of digits are compared
 * numerically, everything else character-by-character. This gives a total,
 * platform-independent order in which `m_2` sorts before `m_10` (a plain
 * lexical sort would not), which is what makes the canonical array order
 * match the numeric order ids are minted in — and therefore what lets
 * normalization reproduce the adapter's order exactly.
 */
export function compareModelIds(a: string, b: string): number {
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const ca = a.charCodeAt(i)
    const cb = b.charCodeAt(j)
    if (isDigit(ca) && isDigit(cb)) {
      let ni = i
      let nj = j
      while (ni < a.length && isDigit(a.charCodeAt(ni))) ni += 1
      while (nj < b.length && isDigit(b.charCodeAt(nj))) nj += 1
      const na = Number(a.slice(i, ni))
      const nb = Number(b.slice(j, nj))
      if (na !== nb) return na - nb
      i = ni
      j = nj
    } else {
      if (ca !== cb) return ca < cb ? -1 : 1
      i += 1
      j += 1
    }
  }
  return a.length - b.length
}

/**
 * Intra-millisecond priority of the event kinds. When several events share an
 * `at`, the run opens first, then messages, then tool calls, then it closes —
 * a canonical order that does not depend on the input's `sequence` values (so
 * a scrambled input still normalizes to the same model).
 */
const EVENT_RANK: Record<EventKind, number> = {
  run_start: 0,
  message: 1,
  tool_call: 2,
  run_end: 3,
}

function compareEvents(a: Event, b: Event): number {
  return (
    a.at - b.at ||
    EVENT_RANK[a.kind] - EVENT_RANK[b.kind] ||
    compareModelIds(a.id, b.id)
  )
}

// ── Integrity validation ────────────────────────────────────────────────────

function assertUnique<T>(
  items: readonly T[],
  label: string,
  idOf: (item: T) => string,
): void {
  const seen = new Set<string>()
  for (const item of items) {
    const id = idOf(item)
    if (seen.has(id)) throw new TraceModelError(`duplicate ${label} id: ${id}`)
    seen.add(id)
  }
}

function assertFinite(check: number, what: string): void {
  if (!Number.isFinite(check))
    throw new TraceModelError(`${what} is not a finite number`)
}

/**
 * Every reference in the run must resolve. This is what keeps a corrupt export
 * from rendering as a silently-wrong scene: normalization fails loudly with a
 * {@link TraceModelError} instead of dropping the dangling reference.
 */
function assertIntegrity(
  agents: readonly Agent[],
  messages: readonly Message[],
  toolCalls: readonly ToolCall[],
  events: readonly Event[],
): void {
  assertUnique(agents, 'agent', (agent) => agent.id)
  assertUnique(messages, 'message', (message) => message.id)
  assertUnique(toolCalls, 'tool call', (call) => call.id)
  assertUnique(events, 'event', (event) => event.id)

  const agentIds = new Set(agents.map((agent) => agent.id))
  const messageById = new Map<MessageId, Message>(
    messages.map((message) => [message.id, message]),
  )
  const toolCallIds = new Set(toolCalls.map((call) => call.id))

  for (const message of messages) {
    assertFinite(message.at, `message ${message.id} at`)
    if (!agentIds.has(message.from)) {
      throw new TraceModelError(
        `message ${message.id} has unknown sender ${message.from}`,
      )
    }
    if (message.to !== null && !agentIds.has(message.to)) {
      throw new TraceModelError(
        `message ${message.id} has unknown recipient ${message.to}`,
      )
    }
  }

  for (const call of toolCalls) {
    assertFinite(call.at, `tool call ${call.id} at`)
    if (!agentIds.has(call.agentId)) {
      throw new TraceModelError(
        `tool call ${call.id} has unknown agent ${call.agentId}`,
      )
    }
    if (call.messageId !== null && !messageById.has(call.messageId)) {
      throw new TraceModelError(
        `tool call ${call.id} references unknown message ${call.messageId}`,
      )
    }
  }

  for (const event of events) {
    const eventId = event.id
    assertFinite(event.at, `event ${eventId} at`)

    if (isLifecycleEvent(event)) {
      // `agentId` is `null` on this arm by contract; a non-null value means the
      // input lied about the shape, which is exactly what we want to catch.
      if (event.agentId !== null) {
        throw new TraceModelError(
          `lifecycle event ${eventId} must not be agent-attributed`,
        )
      }
      continue
    }

    // MessageEvent | ToolCallEvent — must be attributed to a real agent.
    const attributedTo = event.agentId
    if (attributedTo === null || !agentIds.has(attributedTo)) {
      throw new TraceModelError(`event ${eventId} must be attributed to a known agent`)
    }

    if (isMessageEvent(event)) {
      const message = messageById.get(event.messageId)
      if (message === undefined) {
        throw new TraceModelError(`message event ${eventId} references unknown message`)
      }
      if (message.from !== event.from || message.to !== event.to) {
        throw new TraceModelError(
          `message event ${eventId} mirror disagrees with message ${message.id}`,
        )
      }
    } else if (!toolCallIds.has(event.toolCallId)) {
      throw new TraceModelError(
        `tool call event ${eventId} references unknown tool call`,
      )
    }
  }
}

// ── Derived-field recomputation ─────────────────────────────────────────────

/**
 * Recompute every precomputed `Agent` field from the messages and tool calls,
 * mirroring the adapter's attribution rules so a normalized adapter run is
 * unchanged: a message counts as *sent* by its sender and *received* by its
 * recipient — a broadcast (`to === null`) counts as received by every other
 * participant. The active window spans everything the agent took part in.
 * `role` / `parentId` are passed through (M2-T4 derives them).
 */
function recountAgents(
  agents: readonly Agent[],
  messages: readonly Message[],
  toolCalls: readonly ToolCall[],
): Agent[] {
  const ids = agents.map((agent) => agent.id)
  const sent = new Map<string, number>()
  const received = new Map<string, number>()
  const firstSeen = new Map<string, number>()
  const lastSeen = new Map<string, number>()
  const tokens = new Map<string, number>()
  const cost = new Map<string, number>()

  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  const touch = (key: string, at: number): void => {
    const first = firstSeen.get(key)
    if (first === undefined || at < first) firstSeen.set(key, at)
    const last = lastSeen.get(key)
    if (last === undefined || at > last) lastSeen.set(key, at)
  }

  for (const message of messages) {
    bump(sent, message.from)
    touch(message.from, message.at)
    tokens.set(message.from, (tokens.get(message.from) ?? 0) + message.tokens)
    cost.set(message.from, (cost.get(message.from) ?? 0) + message.costUsd)

    if (message.to !== null) {
      bump(received, message.to)
      touch(message.to, message.at)
    } else {
      for (const id of ids) {
        if (id === message.from) continue
        bump(received, id)
        touch(id, message.at)
      }
    }
  }

  for (const call of toolCalls) {
    cost.set(call.agentId, (cost.get(call.agentId) ?? 0) + call.costUsd)
  }

  return agents.map((agent) => ({
    ...agent,
    firstSeenAt: firstSeen.get(agent.id) ?? 0,
    lastSeenAt: lastSeen.get(agent.id) ?? 0,
    messagesSent: sent.get(agent.id) ?? 0,
    messagesReceived: received.get(agent.id) ?? 0,
    tokens: tokens.get(agent.id) ?? 0,
    costUsd: cost.get(agent.id) ?? 0,
  }))
}

// ── The pass ────────────────────────────────────────────────────────────────

/**
 * Normalize a {@link Run} into a {@link TraceModel}: canonical order,
 * contiguous `Event.sequence`, derived fields recomputed from the facts, and
 * referential integrity verified. Pure and deterministic — the same facts in
 * produce a byte-identical model out, regardless of array order or the input's
 * `sequence` values.
 *
 * @throws TraceModelError when the run's references do not resolve (unknown
 *         agent on a message / tool call / event, a dangling message or tool
 *         call reference, a mis-attributed lifecycle event, a duplicate id, a
 *         non-finite timestamp) — a broken run fails loudly, never silently.
 */
export function normalizeTrace(run: Run): TraceModel {
  const agents = [...run.agents].sort((a, b) => compareModelIds(a.id, b.id))
  const messages = [...run.messages].sort(
    (a, b) => a.at - b.at || compareModelIds(a.id, b.id),
  )
  const toolCalls = [...run.toolCalls].sort(
    (a, b) => a.at - b.at || compareModelIds(a.id, b.id),
  )
  const events = [...run.events]
    .sort(compareEvents)
    .map((event, sequence) => ({ ...event, sequence }))

  assertIntegrity(agents, messages, toolCalls, events)

  const recountedAgents = recountAgents(agents, messages, toolCalls)

  // The span is the earliest / latest fact in the run whether or not a
  // lifecycle event happens to bracket it.
  const timestamps: number[] = [
    ...messages.map((message) => message.at),
    ...toolCalls.map((call) => call.at),
    ...events.map((event) => event.at),
  ]
  const startedAt = timestamps.reduce((min, at) => (at < min ? at : min), Infinity)
  const endedAt = timestamps.reduce((max, at) => (at > max ? at : max), -Infinity)

  const meta: RunMeta = {
    agentCount: recountedAgents.length,
    messageCount: messages.length,
    toolCallCount: toolCalls.length,
    eventCount: events.length,
    broadcastCount: messages.filter((message) => message.to === null).length,
    durationMs: timestamps.length === 0 ? 0 : endedAt - startedAt,
    totalTokens: messages.reduce((sum, message) => sum + message.tokens, 0),
    totalCostUsd:
      messages.reduce((sum, message) => sum + message.costUsd, 0) +
      toolCalls.reduce((sum, call) => sum + call.costUsd, 0),
  }

  return {
    id: run.id,
    label: run.label,
    source: run.source,
    seed: run.seed,
    agents: recountedAgents,
    messages,
    toolCalls,
    events,
    startedAt: timestamps.length === 0 ? 0 : startedAt,
    endedAt: timestamps.length === 0 ? 0 : endedAt,
    meta,
  }
}
