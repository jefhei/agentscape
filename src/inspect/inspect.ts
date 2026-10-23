/**
 * Agent detail model (M4-T4) — the pure half of the node inspector.
 *
 * Clicking a node asks one question: *what is this agent, what did it do, and
 * what did it cost?* The answer is a join of facts the earlier layers already
 * own — the normalized run (M1-T5), the derived lineage and typed edges (M2-T4)
 * and the run's own totals — plus one new derivation this module is the single
 * owner of: **cost and token attribution, itemised per message and per tool
 * call**.
 *
 * It is the same PRD §5 split as every other layer: this module decides
 * *everything the panel shows* (which messages belong to the agent, in what
 * direction, at what offset, costing what), and `ui/AgentDetailPanel.tsx` is the
 * thin consumer that renders it and decides nothing. Reshaping trace facts into
 * a panel is exactly the kind of work that silently drifts when it lives in a
 * component, so it lives here where vitest can pin it.
 *
 * ## What "belongs to this agent" means
 *
 * A message is the agent's if it **sent** it, or if it **received** it — and a
 * broadcast (`Message.to === null`) is received by every other participant, the
 * same rule `normalizeTrace` uses to count `messagesReceived` (M1-T5) and the
 * same rule `deriveLayoutLinks`/`reveal.ts` use to spread a broadcast. Each
 * message appears **once**: an agent that sends a broadcast is the sender there,
 * not one of its own listeners, and a self-message is one *sent* entry.
 *
 * ## Attribution must agree with the model, or it fails loudly
 *
 * The model precomputes `Agent.tokens` / `Agent.costUsd` from the very same
 * rules (M1-T5: tokens from messages the agent sent, cost from those messages
 * plus its tool calls). This module re-derives them item by item so the panel
 * can *itemise* them, and then **checks the two agree** — a mismatch means one
 * of the two attribution rules drifted, which would show a viewer a total that
 * does not match its own breakdown. That is a defect worth a thrown error, not
 * a rounding note, so it throws {@link InspectError}.
 *
 * ## Playhead-aware, without owning the clock
 *
 * The panel is read while the transport moves, so every row carries a `fired`
 * flag: has the run reached this message / call at the detail's `elapsedMs`?
 * The cutoff is passed *in* (there is no clock here); with no cutoff every row
 * counts as fired, because a run with no playhead is drawn fully lit
 * (`Viewport`'s rule since M4-T1). The panel dims pending rows rather than
 * hiding them — structure persists, activity is revealed.
 *
 * ## Purity (PRD §5)
 *
 * Pure and deterministic: no React, no DOM, no three.js, no clock, no
 * `Math.random`, no mutation of the model or of an edge model passed in. Entries
 * come out in canonical order (`at`, then natural id order), so the same trace
 * yields a byte-identical detail whatever order the model's arrays arrive in.
 * Nothing about how the panel *looks* is decided here (that is M5-T5).
 */

import type {
  Agent,
  AgentId,
  AgentRole,
  Message,
  MessageId,
  MessagePayload,
  MessageStatus,
  ToolCall,
  ToolCallId,
} from '../types/index.ts'
import type { TraceModel } from '../model/index.ts'
import { compareModelIds } from '../model/index.ts'
import { deriveEdgeModel, lineageOf } from '../layout/index.ts'
import type { EdgeKind, EdgeModel } from '../layout/index.ts'
import { formatDuration } from '../playback/playback.ts'

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Most entries the panel renders per list. A 2k-message agent would otherwise
 * put 2k DOM rows behind a 21rem panel — far more than anyone reads, and enough
 * to make opening the panel cost a frame. The limit is exported so the panel
 * and its test agree on the number instead of repeating a literal.
 */
export const DETAIL_ROW_LIMIT = 50

/** How many `key=value` pairs {@link summarizeArgs} prints by default. */
export const ARG_SUMMARY_LIMIT = 3

/** Longest value {@link summarizeArgs} prints before eliding it. */
export const ARG_VALUE_LIMIT = 24

/** Relative tolerance when checking itemised attribution against the model. */
const ATTRIBUTION_EPSILON = 1e-9

// ── Public shapes ───────────────────────────────────────────────────────────

/** Thrown when the detail cannot be built coherently from the model. */
export class InspectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InspectError'
  }
}

/** Which side of a message the inspected agent was on. */
export type DetailDirection = 'sent' | 'received'

/**
 * One message as it appears from the inspected agent's point of view: who the
 * other party was, what was said, when (absolute and relative to the run), and
 * what it cost.
 */
export interface AgentMessageEntry {
  messageId: MessageId
  /** `sent` when the agent was the sender, `received` otherwise. */
  direction: DetailDirection
  /** The message was addressed to everyone (`Message.to === null`). */
  broadcast: boolean
  /**
   * The other participant: the recipient for a sent message, the sender for a
   * received one — `null` for a *sent* broadcast, which has no single recipient.
   */
  counterpartId: AgentId | null
  /** `counterpartId`'s display name, or `null` (a sent broadcast, or absent). */
  counterpartName: string | null
  subject: string
  /** The declaring agent's `action`, if the body carried one. */
  action: string | null
  status: MessageStatus
  /** Send time, epoch ms. */
  at: number
  /** Offset from the run's start, ms (`at - run.startedAt`). */
  offsetMs: number
  tokens: number
  costUsd: number
  /** The decoded body payload, when the body was JSON. */
  payload: MessagePayload | null
  /** Whether the run has reached this message at the detail's playhead. */
  fired: boolean
}

/** One tool call as it appears from the inspected agent's point of view. */
export interface AgentToolCallEntry {
  toolCallId: ToolCallId
  name: string
  /** The message this call was derived from, or `null` when standalone. */
  messageId: MessageId | null
  /** Invocation time, epoch ms. */
  at: number
  /** Offset from the run's start, ms. */
  offsetMs: number
  /** Recorded wall-clock duration, or `null` when the trace does not say. */
  durationMs: number | null
  costUsd: number
  args: Record<string, unknown>
  /** `key=value, …` digest of the first few args; `''` when there are none. */
  argSummary: string
  /** Whether the run has reached this call at the detail's playhead. */
  fired: boolean
}

/**
 * The agent's activity window and the timing facts behind it. All offsets are
 * from the run's start; `null` means "never", never `0` pretending to be a time.
 */
export interface AgentTiming {
  /** Whether the agent has any message or tool call at all. */
  active: boolean
  /** Length of the whole run, ms. */
  runSpanMs: number
  /** First activity, epoch ms (`null` when inactive). */
  firstAt: number | null
  /** Last activity, epoch ms (`null` when inactive). */
  lastAt: number | null
  /** `firstAt - run.startedAt` (`null` when inactive). */
  elapsedStartMs: number | null
  /** `lastAt - run.startedAt` (`null` when inactive). */
  elapsedEndMs: number | null
  /** `lastAt - firstAt`: how long the agent was visibly doing things. */
  activeMs: number
  /** `activeMs / runSpanMs`, `[0, 1]`; `0` for an inactive agent or a zero-span run. */
  share: number
  /** Run time after the agent's last activity, ms (`null` when inactive). */
  quietAfterMs: number | null
  /** Sum of the recorded tool-call durations, ms (unknown durations ignored). */
  toolTimeMs: number
  /** Longest single recorded tool call, ms, or `null` when none is known. */
  longestToolMs: number | null
}

/**
 * The agent's tokens and spend, itemised. The totals mirror `Agent.tokens` /
 * `Agent.costUsd`; the parts show where they came from, and the shares are of
 * the run's own totals.
 */
export interface AgentAttribution {
  /** Tokens attributed to the messages this agent sent. */
  tokens: number
  /** `tokens / run.meta.totalTokens`, `[0, 1]`; `0` when the run reported none. */
  tokenShare: number
  /** Total spend, USD — messages sent plus tool calls it made. */
  costUsd: number
  /** `costUsd / run.meta.totalCostUsd`, `[0, 1]`; `0` when the run reported none. */
  costShare: number
  /** Spend on the messages this agent sent, USD. */
  messageCostUsd: number
  /** Spend on the tool calls this agent made, USD. */
  toolCallCostUsd: number
  /** `tokens / messagesSent`, or `null` when it sent nothing. */
  tokensPerSentMessage: number | null
}

/** The agent's derived identity and relationships (M2-T4). */
export interface AgentRelations {
  /** Derived role (an agent that spawns children is a coordinator). */
  role: AgentRole
  /** The spawning agent, or `null` for a root. */
  parentId: AgentId | null
  parentName: string | null
  /** Spawn children, canonical order. */
  childIds: AgentId[]
  childNames: string[]
  /** Outgoing spawn degree — how many children this agent put to work. */
  fanOut: number
  /** Weight of the typed edges this agent is the source of, per kind. */
  outgoing: Record<EdgeKind, number>
  /** Weight of the typed edges this agent is the target of, per kind. */
  incoming: Record<EdgeKind, number>
  /** Every other agent it exchanged edges with, canonical order. */
  peerIds: AgentId[]
  /** `peerIds`' display names, same order. */
  peerNames: string[]
}

/** Everything the detail panel renders for one agent, derived once. */
export interface AgentDetail {
  /** The contract's own agent record (counts and attribution included). */
  agent: Agent
  /** The agent's display name (a convenience mirror of `agent.name`). */
  name: string
  relations: AgentRelations
  timing: AgentTiming
  attribution: AgentAttribution
  /** Messages sent and received, canonical order (one entry per message). */
  messages: AgentMessageEntry[]
  /** Tool calls this agent made, canonical order. */
  toolCalls: AgentToolCallEntry[]
  /** Entry counts — `messagesSent` etc. are the contract's own fields. */
  counts: {
    sent: number
    received: number
    /** Broadcasts this agent sent. */
    broadcastsSent: number
    /** Broadcasts it heard (sent by someone else). */
    broadcastsHeard: number
    toolCalls: number
  }
  /** The playhead the `fired` flags were computed at, or `null` for "all fired". */
  elapsedMs: number | null
}

/** Optional inputs for {@link buildAgentDetail}. */
export interface InspectOptions {
  /**
   * Playhead position from the run's start, ms. Rows after it are `fired: false`.
   * Omit (or pass a non-finite value) to treat every row as fired.
   */
  elapsedMs?: number
  /** An already-derived edge model to reuse (the scene has one; don't derive twice). */
  edgeModel?: EdgeModel
}

// ── Ordering ────────────────────────────────────────────────────────────────

/** Canonical message order: time, then natural id order. */
function compareMessages(a: Message, b: Message): number {
  return a.at - b.at || compareModelIds(a.id, b.id)
}

/** Canonical tool-call order: time, then natural id order. */
function compareToolCalls(a: ToolCall, b: ToolCall): number {
  return a.at - b.at || compareModelIds(a.id, b.id)
}

// ── Attribution checks ──────────────────────────────────────────────────────

/** Whether two monetary sums are the same to within float noise. */
function sameAmount(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b))
  return Math.abs(a - b) <= ATTRIBUTION_EPSILON * scale
}

/**
 * Prove the itemised attribution adds up to the agent's own precomputed
 * figures. Both are derived from the same rules (M1-T5), so a disagreement
 * means one of the two drifted — a panel whose parts do not sum to its total is
 * worse than no panel, so this throws rather than showing it.
 */
function assertAttribution(
  agent: Agent,
  messageTokens: number,
  messageCostUsd: number,
  toolCallCostUsd: number,
): void {
  if (!sameAmount(messageTokens, agent.tokens)) {
    throw new InspectError(
      `token attribution drift for agent ${agent.id}: entries ${messageTokens} vs model ${agent.tokens}`,
    )
  }
  if (!sameAmount(messageCostUsd + toolCallCostUsd, agent.costUsd)) {
    throw new InspectError(
      `cost attribution drift for agent ${agent.id}: entries ${
        messageCostUsd + toolCallCostUsd
      } vs model ${agent.costUsd}`,
    )
  }
}

// ── Formatting (shared with the panel, pinned by tests) ─────────────────────

/** Group an integer with thousands separators, locale-independent. */
function groupDigits(value: number): string {
  const whole = Math.round(Math.abs(value))
  const digits = String(whole)
  let out = ''
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return value < 0 ? `-${out}` : out
}

/**
 * Format a token count: `0`, `912`, `12,480`. Negative and non-finite inputs
 * clamp to `0`, so the panel can never print `NaN`.
 */
export function formatTokens(count: number): string {
  return Number.isFinite(count) && count > 0 ? groupDigits(count) : '0'
}

/**
 * Format a USD amount at a precision that is honest for LLM bills: two decimals
 * once it is a cent or more (`$1.23`), four below that (`$0.0042`) so a small
 * run does not read as free. Non-finite/negative clamps to `$0.00`.
 */
export function formatCost(usd: number): string {
  const safe = Number.isFinite(usd) && usd > 0 ? usd : 0
  if (safe === 0) return '$0.00'
  if (safe < 0.01) return `$${safe.toFixed(4)}`
  const cents = Math.round(safe * 100) / 100
  const [whole, fraction] = cents.toFixed(2).split('.')
  return `$${groupDigits(Number(whole))}.${fraction}`
}

/**
 * Format a `[0, 1]` share as a whole percentage: `0%`, `37%`, `<1%` for a real
 * but tiny slice (so "1%" and "nothing" are distinguishable).
 */
export function formatShare(fraction: number): string {
  const safe = Number.isFinite(fraction) ? fraction : 0
  if (safe <= 0) return '0%'
  if (safe < 0.005) return '<1%'
  return `${Math.round(Math.min(safe, 1) * 100)}%`
}

/** A short, deterministic rendering of one argument value. */
function formatArgValue(value: unknown): string {
  let text: string
  if (typeof value === 'string') text = value
  else if (value === null) text = 'null'
  else if (typeof value === 'object') text = JSON.stringify(value) ?? 'object'
  else text = String(value)
  return text.length > ARG_VALUE_LIMIT ? `${text.slice(0, ARG_VALUE_LIMIT - 1)}…` : text
}

/**
 * Summarize a tool call's arguments as `key=value, key=value`, in the object's
 * own key order (so it is deterministic for a given trace), capped at `limit`
 * pairs with `…` when there are more. An empty/non-object argument map yields
 * `''`.
 */
export function summarizeArgs(
  args: Record<string, unknown> | null | undefined,
  limit: number = ARG_SUMMARY_LIMIT,
): string {
  if (args === null || args === undefined) return ''
  const keys = Object.keys(args)
  if (keys.length === 0) return ''
  const max =
    Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : ARG_SUMMARY_LIMIT
  const shown = keys.slice(0, max).map((key) => `${key}=${formatArgValue(args[key])}`)
  if (keys.length > max) shown.push(`+${keys.length - max} more`)
  return shown.join(', ')
}

// ── The detail ──────────────────────────────────────────────────────────────

/** A finite, non-negative playhead, or `null` for "no playhead". */
function cutoffOf(elapsedMs: number | undefined): number | null {
  return typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0
    ? elapsedMs
    : null
}

/** The zero record the relations' per-kind weights start from. */
function emptyKindWeights(): Record<EdgeKind, number> {
  return { spawn: 0, handoff: 0, message: 0 }
}

/**
 * Build the detail panel's whole model for one agent.
 *
 * Pure and deterministic: the same model (and playhead) yields a byte-identical
 * detail whatever order the model's arrays arrive in, and nothing is mutated.
 *
 * @param model a normalized trace (M1-T5).
 * @param agentId the agent to inspect.
 * @param options an optional playhead and an optional edge model to reuse.
 * @returns the detail, or `null` when the run has no such agent (a selection
 *          that outlived its run renders nothing rather than a ghost panel).
 * @throws InspectError when the model's attribution cannot be reproduced from
 *         its own messages and tool calls, or when the agent has no derived
 *         lineage (impossible for a normalized model — it would mean the edge
 *         model and the agent list disagree).
 */
export function buildAgentDetail(
  model: TraceModel,
  agentId: AgentId,
  options: InspectOptions = {},
): AgentDetail | null {
  let agent: Agent | undefined
  for (const candidate of model.agents) {
    if (candidate.id === agentId) {
      agent = candidate
      break
    }
  }
  if (agent === undefined) return null

  const edges = options.edgeModel ?? deriveEdgeModel(model)
  const lineage = lineageOf(edges, agentId)
  if (lineage === null) {
    throw new InspectError(`agent ${agentId} has no derived lineage`)
  }

  const elapsedMs = cutoffOf(options.elapsedMs)
  const cutoff = elapsedMs === null ? Infinity : model.startedAt + elapsedMs
  const nameById = new Map<AgentId, string>(
    model.agents.map((participant) => [participant.id, participant.name]),
  )
  const nameOf = (id: AgentId | null): string | null =>
    id === null ? null : (nameById.get(id) ?? id)

  const messages: AgentMessageEntry[] = []
  for (const message of [...model.messages].sort(compareMessages)) {
    const sent = message.from === agentId
    const received = !sent && (message.to === agentId || message.to === null)
    if (!sent && !received) continue
    const broadcast = message.to === null
    const counterpartId = sent ? message.to : message.from
    messages.push({
      messageId: message.id,
      direction: sent ? 'sent' : 'received',
      broadcast,
      counterpartId,
      counterpartName: nameOf(counterpartId),
      subject: message.subject,
      action: message.action,
      status: message.status,
      at: message.at,
      offsetMs: message.at - model.startedAt,
      tokens: message.tokens,
      costUsd: message.costUsd,
      payload: message.payload,
      fired: message.at <= cutoff,
    })
  }

  const toolCalls: AgentToolCallEntry[] = []
  for (const call of [...model.toolCalls].sort(compareToolCalls)) {
    if (call.agentId !== agentId) continue
    toolCalls.push({
      toolCallId: call.id,
      name: call.name,
      messageId: call.messageId,
      at: call.at,
      offsetMs: call.at - model.startedAt,
      durationMs: call.durationMs,
      costUsd: call.costUsd,
      args: call.args,
      argSummary: summarizeArgs(call.args),
      fired: call.at <= cutoff,
    })
  }

  // Itemised attribution: the same rules normalization uses (M1-T5) — tokens
  // ride on the messages the agent SENT, cost on those messages plus its calls.
  let messageTokens = 0
  let messageCostUsd = 0
  let sentCount = 0
  let receivedCount = 0
  let broadcastsSent = 0
  let broadcastsHeard = 0
  for (const entry of messages) {
    if (entry.direction === 'sent') {
      sentCount += 1
      messageTokens += entry.tokens
      messageCostUsd += entry.costUsd
      if (entry.broadcast) broadcastsSent += 1
    } else {
      receivedCount += 1
      if (entry.broadcast) broadcastsHeard += 1
    }
  }
  let toolCallCostUsd = 0
  let toolTimeMs = 0
  let longestToolMs: number | null = null
  for (const entry of toolCalls) {
    toolCallCostUsd += entry.costUsd
    if (entry.durationMs !== null && Number.isFinite(entry.durationMs)) {
      toolTimeMs += entry.durationMs
      if (longestToolMs === null || entry.durationMs > longestToolMs) {
        longestToolMs = entry.durationMs
      }
    }
  }
  assertAttribution(agent, messageTokens, messageCostUsd, toolCallCostUsd)

  const active = messages.length > 0 || toolCalls.length > 0
  const runSpanMs = Math.max(0, model.endedAt - model.startedAt)
  const firstAt = active ? agent.firstSeenAt : null
  const lastAt = active ? agent.lastSeenAt : null
  const elapsedStartMs = firstAt === null ? null : firstAt - model.startedAt
  const elapsedEndMs = lastAt === null ? null : lastAt - model.startedAt
  const activeMs =
    firstAt === null || lastAt === null ? 0 : Math.max(0, lastAt - firstAt)

  const timing: AgentTiming = {
    active,
    runSpanMs,
    firstAt,
    lastAt,
    elapsedStartMs,
    elapsedEndMs,
    activeMs,
    share: runSpanMs <= 0 ? 0 : Math.min(1, activeMs / runSpanMs),
    quietAfterMs: elapsedEndMs === null ? null : Math.max(0, runSpanMs - elapsedEndMs),
    toolTimeMs,
    longestToolMs,
  }

  const totalCostUsd = model.meta.totalCostUsd
  const totalTokens = model.meta.totalTokens
  const attribution: AgentAttribution = {
    tokens: messageTokens,
    tokenShare:
      Number.isFinite(totalTokens) && totalTokens > 0
        ? Math.min(1, messageTokens / totalTokens)
        : 0,
    costUsd: messageCostUsd + toolCallCostUsd,
    costShare:
      Number.isFinite(totalCostUsd) && totalCostUsd > 0
        ? Math.min(1, (messageCostUsd + toolCallCostUsd) / totalCostUsd)
        : 0,
    messageCostUsd,
    toolCallCostUsd,
    tokensPerSentMessage: sentCount === 0 ? null : messageTokens / sentCount,
  }

  const outgoing = emptyKindWeights()
  const incoming = emptyKindWeights()
  const peers = new Set<AgentId>()
  for (const edge of edges.edges) {
    if (edge.source === agentId) {
      outgoing[edge.kind] += edge.weight
      if (edge.target !== agentId) peers.add(edge.target)
    }
    if (edge.target === agentId) {
      incoming[edge.kind] += edge.weight
      if (edge.source !== agentId) peers.add(edge.source)
    }
  }
  const peerIds = [...peers].sort(compareModelIds)

  return {
    agent,
    name: agent.name,
    relations: {
      role: lineage.role,
      parentId: lineage.parentId,
      parentName: nameOf(lineage.parentId),
      childIds: [...lineage.childIds],
      childNames: lineage.childIds.map((id) => nameById.get(id) ?? id),
      fanOut: lineage.fanOut,
      outgoing,
      incoming,
      peerIds,
      peerNames: peerIds.map((id) => nameById.get(id) ?? id),
    },
    timing,
    attribution,
    messages,
    toolCalls,
    counts: {
      sent: sentCount,
      received: receivedCount,
      broadcastsSent,
      broadcastsHeard,
      toolCalls: toolCalls.length,
    },
    elapsedMs,
  }
}

/**
 * The panel's headline for a message row: who it was with, in words a screen
 * reader can announce. `to worker_beta`, `from orchestrator`, `to all agents`.
 * Pure; the panel uses it as the row's visible direction label.
 */
export function describeMessageDirection(entry: AgentMessageEntry): string {
  if (entry.direction === 'sent') {
    return entry.broadcast
      ? 'to all agents'
      : `to ${entry.counterpartName ?? 'unknown'}`
  }
  return entry.broadcast
    ? `from ${entry.counterpartName ?? 'unknown'} (broadcast)`
    : `from ${entry.counterpartName ?? 'unknown'}`
}

/**
 * The panel's one-line timing summary, or `null` when the agent never acted.
 * Formatting lives here so the component renders a string it did not invent.
 */
export function describeAgentTiming(timing: AgentTiming): string | null {
  if (
    !timing.active ||
    timing.elapsedStartMs === null ||
    timing.elapsedEndMs === null
  ) {
    return null
  }
  return `${formatDuration(timing.elapsedStartMs)} → ${formatDuration(
    timing.elapsedEndMs,
  )} · active ${formatDuration(timing.activeMs)} (${formatShare(timing.share)} of the run)`
}
