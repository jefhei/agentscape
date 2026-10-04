/**
 * AgentScape trace contract (M1-T3).
 *
 * The single typed vocabulary every part of the app speaks: the
 * `agent_messages` export adapter (M1-T4) normalizes raw rows *into* these
 * shapes, the TraceModel pass (M1-T5) sorts and counts them, and the render
 * layer (M3+) is a thin consumer that only ever reads them. Nothing here
 * touches three.js, the DOM or the clock — the whole module is pure data, so
 * it is fully unit-testable in jsdom and safe to import from anywhere.
 *
 * Scope note (PRD §5 architectural rule): this is the *contract*, not a
 * parser. It declares the normal shape of a run; turning a real
 * `agent_messages` export into it is M1-T4's job. Deliberately ONE ingest
 * format for v1 (`agent_messages`); OpenTelemetry GenAI and LangGraph
 * adapters are post-MVP (M6-T5) — do not widen `TraceSource` early.
 *
 * Design rules baked into the shapes below:
 * - **Derived, never authored.** Every field on an `Agent`, `Message` or
 *   `ToolCall` is a function of the trace. There are no coordinates here;
 *   layout is M2, computed from this data, never stored back onto it.
 * - **Deterministic.** Ids and `Event.sequence` are stable functions of the
 *   input, so the same export always yields byte-identical structures — the
 *   property M1-T5's tests pin and M2's layout depends on.
 * - **UTC epoch ms everywhere.** Timestamps are numbers (epoch
 *   milliseconds), not strings or `Date`s, so comparisons and arithmetic are
 *   total and timezone-free.
 */

// ── Identity ────────────────────────────────────────────────────────────────
// Ids are opaque strings, distinct aliases so a `MessageId` can never be
// passed where an `AgentId` is expected. They are derived from the trace
// (never random), which is what makes repeat parsing reproducible.

/** Identifies a whole recorded run. */
export type RunId = string
/** Identifies an agent within a run. */
export type AgentId = string
/** Identifies a single message within a run. */
export type MessageId = string
/** Identifies a single tool call within a run. */
export type ToolCallId = string
/** Identifies a single event in the unified timeline. */
export type EventId = string

// ── Ingest source ───────────────────────────────────────────────────────────

/**
 * The one trace format v1 ingests: a Supabase `agent_messages` export.
 * Kept a union so a future adapter (M6-T5) extends it without touching
 * consumers, but it has exactly one member today by design.
 */
export type TraceSource = 'agent_messages'

/** The single v1 ingest format. See BUILD_PLAN "two rules": one format only. */
export const TRACE_SOURCE: TraceSource = 'agent_messages'

// ── Enumerations (const-unions; no TS `enum` under `erasableSyntaxOnly`) ────

/** Coarse role inferred from the trace — never hand-authored. */
export type AgentRole = 'coordinator' | 'worker' | 'human' | 'external' | 'unknown'

/** Delivery state of a message, mirroring the `agent_messages.status` column. */
export type MessageStatus = 'unread' | 'read'

/**
 * The kinds of node the unified event stream carries. `run_start` / `run_end`
 * bracket the run; `message` and `tool_call` are the two things a trace
 * records. Exhaustive by construction: `EventKind` is derived from this list.
 */
export const EVENT_KINDS = ['run_start', 'run_end', 'message', 'tool_call'] as const

/** One of the `EVENT_KINDS` tags. */
export type EventKind = (typeof EVENT_KINDS)[number]

// ── Agent ───────────────────────────────────────────────────────────────────

/**
 * A participant in the run. Counts and timestamps are precomputed by the
 * normalization pass (M1-T5) so the render layer and HUD never re-scan the
 * message list.
 */
export interface Agent {
  /** Stable id, a deterministic function of `name`. */
  id: AgentId
  /** Raw identity as it appears in the trace, e.g. `hermes_bot`. */
  name: string
  /** Coarse role inferred from the trace; `unknown` when it cannot be told. */
  role: AgentRole
  /**
   * Fan-out parent: the agent that spawned / owns this one, or `null` for a
   * root. This is the one structural link the layout (M2) reads to place
   * agents — derived from the trace, never hand-placed.
   */
  parentId: AgentId | null
  /** First event timestamp attributed to this agent (epoch ms). */
  firstSeenAt: number
  /** Last event timestamp attributed to this agent (epoch ms). */
  lastSeenAt: number
  /** Count of messages this agent SENT (its fan-out volume). */
  messagesSent: number
  /** Count of messages this agent RECEIVED (broadcasts counted per recipient). */
  messagesReceived: number
  /** Aggregated tokens attributed to this agent; 0 when the trace omits it. */
  tokens: number
  /** Aggregated cost (USD) attributed to this agent; 0 when the trace omits it. */
  costUsd: number
}

// ── Message ─────────────────────────────────────────────────────────────────

/**
 * A parsed `agent_messages.body` payload. `agent_messages` stores `body` as a
 * JSON *string* carrying an `action` plus arbitrary structured fields
 * (`video_id`, `topic`, `verdict`, …); this is that object once decoded, with
 * unknown keys preserved so the detail panel can show everything the sender
 * attached.
 */
export interface MessagePayload {
  /** The sender's declared action, when present, e.g. `review_complete`. */
  action?: string
  [key: string]: unknown
}

/**
 * One directed message between two agents. `to === null` is a broadcast,
 * matching the `agent_messages.to_agent IS NULL` convention.
 */
export interface Message {
  id: MessageId
  /** Sending agent. */
  from: AgentId
  /** Receiving agent, or `null` for a broadcast to all agents. */
  to: AgentId | null
  subject: string
  /** Raw body text exactly as ingested (the JSON string, not re-encoded). */
  body: string
  /** Decoded `body` when it is valid JSON; `null` otherwise. */
  payload: MessagePayload | null
  /** Convenience mirror of `payload?.action ?? null` for fast grouping. */
  action: string | null
  status: MessageStatus
  /** Send time, epoch ms. */
  at: number
  /** Tokens attributed to this message; 0 when the trace omits it. */
  tokens: number
  /** Cost (USD) attributed to this message; 0 when the trace omits it. */
  costUsd: number
}

// ── ToolCall ────────────────────────────────────────────────────────────────

/**
 * A single tool invocation, attributed to the agent that made it. In the v1
 * `agent_messages` source these are derived from a message's declared action
 * and payload (M1-T4); the shape stays generic so richer sources slot in later
 * without changing consumers.
 */
export interface ToolCall {
  id: ToolCallId
  /** The agent that made the call. */
  agentId: AgentId
  /** Tool / action name, e.g. `research_brief_ready`. */
  name: string
  /** The message this call was derived from, or `null` if standalone. */
  messageId: MessageId | null
  /** Invocation time, epoch ms. */
  at: number
  /** Structured arguments as recorded; `{}` when none were captured. */
  args: Record<string, unknown>
  /** Wall-clock duration of the call in ms, or `null` when unknown. */
  durationMs: number | null
  /** Cost (USD) attributed to this call; 0 when the trace omits it. */
  costUsd: number
}

// ── Event ───────────────────────────────────────────────────────────────────

/** Fields every event carries regardless of kind. */
export interface EventBase {
  id: EventId
  /** Event time, epoch ms. */
  at: number
  /**
   * Deterministic, globally-unique ordering index assigned by normalization
   * (M1-T5). Together with `at` it makes the timeline a total order even when
   * many events share a millisecond — the seam the playhead model (M1-T7)
   * rides on.
   */
  sequence: number
  /** The acting agent, or `null` for whole-run lifecycle events. */
  agentId: AgentId | null
  /** Short human-readable label (UI + inspection). */
  label: string
}

/** Brackets the run: a single `run_start` ... `run_end` pair. */
export interface RunLifecycleEvent extends EventBase {
  kind: 'run_start' | 'run_end'
  agentId: null
}

/** A message appeared on the stream (mirrors a `Message` by id). */
export interface MessageEvent extends EventBase {
  kind: 'message'
  messageId: MessageId
  from: AgentId
  to: AgentId | null
}

/** A tool call appeared on the stream (mirrors a `ToolCall` by id). */
export interface ToolCallEvent extends EventBase {
  kind: 'tool_call'
  toolCallId: ToolCallId
  toolName: string
}

/**
 * The unified, chronologically-orderable node of the run. A discriminated
 * union on `kind`, so a `switch (event.kind)` is exhaustive and each arm is
 * precisely typed.
 */
export type Event = RunLifecycleEvent | MessageEvent | ToolCallEvent

/** Narrows an `Event` to a message event. */
export function isMessageEvent(event: Event): event is MessageEvent {
  return event.kind === 'message'
}

/** Narrows an `Event` to a tool-call event. */
export function isToolCallEvent(event: Event): event is ToolCallEvent {
  return event.kind === 'tool_call'
}

/** Narrows an `Event` to a run lifecycle (`run_start` / `run_end`) event. */
export function isLifecycleEvent(event: Event): event is RunLifecycleEvent {
  return event.kind === 'run_start' || event.kind === 'run_end'
}

// ── Run ─────────────────────────────────────────────────────────────────────

/** Aggregate counts and attributions the HUD and detail panels read (M4-T6). */
export interface RunMeta {
  agentCount: number
  messageCount: number
  toolCallCount: number
  eventCount: number
  /** Messages with `to === null`. */
  broadcastCount: number
  /** `endedAt - startedAt`, epoch ms. */
  durationMs: number
  /** Total tokens across the run; 0 when the trace omits them. */
  totalTokens: number
  /** Total cost (USD) across the run; 0 when the trace omits it. */
  totalCostUsd: number
}

/**
 * A whole recorded run: the normalized root that everything else hangs off.
 * Produced by the adapter (M1-T4) + normalization pass (M1-T5), consumed by
 * layout (M2) and the render layer (M3+).
 */
export interface Run {
  id: RunId
  /** Human-readable run name (e.g. the export filename or its own label). */
  label: string
  source: TraceSource
  /**
   * Layout seed. Pins the spatial shape so the same run always renders
   * identically — determinism is a product requirement, not a nicety
   * (PRD §5), so the seed is part of the contract, not the layout's private
   * business.
   */
  seed: number
  agents: Agent[]
  messages: Message[]
  toolCalls: ToolCall[]
  /** All events, in canonical order by `at` then `sequence`. */
  events: Event[]
  /** Earliest event time, epoch ms. */
  startedAt: number
  /** Latest event time, epoch ms. */
  endedAt: number
  meta: RunMeta
}
