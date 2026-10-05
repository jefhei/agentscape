/**
 * `agent_messages` export adapter (M1-T4).
 *
 * The ONE ingest path for v1: a recorded export of Supabase `agent_messages`
 * rows goes in, a normalized {@link Run} — the trace contract landed in
 * `src/types/` (M1-T3) — comes out. Everything here is a pure function of the
 * input text: no network call, no clock, no DOM, no three.js, so the module is
 * fully unit-testable in jsdom and safe to import from anywhere. The demo feeds
 * it a pre-exported file; it never fetches.
 *
 * What it maps, row by row:
 * - a row becomes a `Message` (`to === null` when `to_agent IS NULL`, i.e. a
 *   broadcast), with `body` kept verbatim and decoded into a `payload` when it
 *   is valid JSON;
 * - when the payload carries an `action`, that action is ALSO a `ToolCall`
 *   (v1 rows have no spawn/tool columns, so the declared action is the only
 *   tool signal available) — the tool call mirrors the message's sender + time;
 * - both surface as `MessageEvent` / `ToolCallEvent`, bracketed by a single
 *   `run_start` ... `run_end` pair;
 * - agent identities, per-agent send/receive counts and first/last-seen times
 *   are derived from the `from_agent` / `to_agent` names, never authored. A
 *   message counts toward BOTH its sender and its recipient, so an agent's
 *   first/last-seen window spans everything it was involved in (a received
 *   broadcast included) rather than only what it authored.
 *
 * Determinism (PRD §5): ids and `Event.sequence` are stable functions of the
 * trace, rows are canonically ordered by `created_at` then row id BEFORE
 * anything is derived, and the run id + layout seed are hashed from the
 * normalized messages — so the same export parses to a byte-identical `Run`
 * regardless of the order rows appear in, and a different export gets a
 * different, stable shape. M1-T5 (normalization) hardens and pins that
 * property; this task establishes it.
 *
 * Scope note: this is the *adapter*, not the normalizer (M1-T5) and not the
 * derived-edge model — fan-out / handoff / parentage (M2-T4) are NOT inferred
 * here, so every `Agent.parentId` is `null` and every `role` is `'unknown'`
 * at this stage. v1 rows also carry no token/cost columns, so those fields are
 * `0` (the contract's "omitted" value), never invented.
 */

import type {
  Agent,
  AgentId,
  Event,
  Message,
  MessageId,
  MessagePayload,
  MessageStatus,
  Run,
  RunMeta,
  ToolCall,
  ToolCallId,
} from '../types/index.ts'
import { TRACE_SOURCE } from '../types/index.ts'

// ── Public shapes ───────────────────────────────────────────────────────────

/**
 * A raw `agent_messages` row as exported from Supabase. Only `id`,
 * `from_agent` and `created_at` are required; the columns that may legitimately
 * be NULL (`to_agent` for a broadcast, `body`, `status`) are optional here and
 * defaulted deterministically below.
 */
export interface AgentMessageRow {
  /** Primary key (Supabase `bigint`, surfaced as a number or string). */
  id: number | string
  /** Sending agent, e.g. `hermes_bot`. */
  from_agent: string
  /** ISO-8601 `timestamptz`, e.g. `2026-09-24T07:41:29.9937+00:00`. */
  created_at: string
  /** Receiving agent; omitted / NULL means a broadcast. */
  to_agent?: string | null
  /** Message subject line. */
  subject?: string
  /** JSON *string* body (`{"action": "...", ...}`); may be NULL. */
  body?: string | null
  /** `unread` | `read`; anything else is treated as `unread`. */
  status?: string | null
}

/** Options for {@link parseAgentMessagesExport}. All default from the trace. */
export interface AdapterOptions {
  /** Human-readable run name; defaults to `agent_messages export`. */
  label?: string
  /**
   * Layout seed. Defaults to a hash of the normalized messages, so the same
   * export always renders with the same shape and different exports differ.
   */
  seed?: number
  /** Run id. Defaults to a hash of the normalized messages. */
  runId?: string
}

/** Thrown when an export cannot be parsed into the trace contract. */
export class TraceParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TraceParseError'
  }
}

// ── Deterministic id + hash helpers ─────────────────────────────────────────

/** Stable agent id derived from its name (the trace's only identity). */
export function agentIdFor(name: string): AgentId {
  return `a_${name}`
}

/** Stable message id derived from its source row id. */
export function messageIdFor(rowId: number | string): MessageId {
  return `m_${rowId}`
}

/** Stable tool-call id derived from the row it was inferred from. */
export function toolCallIdFor(rowId: number | string): ToolCallId {
  return `tc_${rowId}`
}

/**
 * Deterministic 32-bit FNV-1a hash. Used only to derive a *stable* run id and
 * layout seed from content — never for anything the trace should carry as
 * fact, and never a source of randomness.
 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// ── Body decoding ───────────────────────────────────────────────────────────

/**
 * Decode an `agent_messages.body` JSON string into a payload object. Returns
 * `null` for absent/empty bodies, malformed JSON, or JSON that is not an
 * object (the column is free text, so anything that isn't a JSON object is not
 * a payload). Unknown keys are preserved so the detail panel can show all the
 * sender attached.
 */
export function decodePayload(body: string | null | undefined): MessagePayload | null {
  if (body === null || body === undefined || body === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  return parsed as MessagePayload
}

/** Coerce any `body`-ish value to the raw string form the contract stores. */
function bodyOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function actionOf(payload: MessagePayload | null): string | null {
  const action = payload?.action
  return typeof action === 'string' && action.length > 0 ? action : null
}

function statusOf(value: unknown): MessageStatus {
  return value === 'read' ? 'read' : 'unread'
}

/** Tool args = the payload's structured fields, minus the `action` name. */
function argsOf(payload: MessagePayload | null): Record<string, unknown> {
  if (payload === null) return {}
  const args: Record<string, unknown> = {}
  for (const key of Object.keys(payload)) {
    if (key === 'action') continue
    args[key] = payload[key]
  }
  return args
}

// ── Input coercion + row validation ─────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Epoch ms from an ISO timestamp; throws rather than yielding NaN. */
function epochMs(value: string): number {
  const at = Date.parse(value)
  if (!Number.isFinite(at)) {
    throw new TraceParseError(`invalid created_at timestamp: ${JSON.stringify(value)}`)
  }
  return at
}

/**
 * Accepts either the export text (JSON) or an already-parsed row array. The
 * text may be a bare array or a wrapper object (`{ data }`, `{ rows }`, or
 * `{ agent_messages }`) so both a raw JSON dump and a Supabase-style REST body
 * load without a pre-pass.
 */
function coerceRows(input: string | readonly AgentMessageRow[]): unknown[] {
  let value: unknown = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch (error) {
      throw new TraceParseError(`export is not valid JSON: ${(error as Error).message}`)
    }
  }
  if (Array.isArray(value)) return value
  if (isRecord(value)) {
    for (const key of ['data', 'rows', 'agent_messages'] as const) {
      const candidate = value[key]
      if (Array.isArray(candidate)) return candidate
    }
  }
  throw new TraceParseError('export must be a JSON array of agent_messages rows')
}

/** One validated, canonically-orderable row ready to become contract parts. */
interface NormalizedRow {
  rowId: number | string
  at: number
  from: string
  to: string | null
  message: Message
  toolCall: ToolCall | null
}

function parseRow(raw: unknown, index: number): NormalizedRow {
  if (!isRecord(raw)) {
    throw new TraceParseError(`row ${index} is not an object`)
  }

  const { id, from_agent: from, to_agent: to, created_at: createdAt } = raw
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new TraceParseError(`row ${index} is missing a numeric/string id`)
  }
  if (typeof from !== 'string' || from === '') {
    throw new TraceParseError(`row ${index} is missing from_agent`)
  }
  if (typeof createdAt !== 'string') {
    throw new TraceParseError(`row ${index} is missing created_at`)
  }
  if (to !== null && to !== undefined && typeof to !== 'string') {
    throw new TraceParseError(`row ${index} has a non-string to_agent`)
  }

  const at = epochMs(createdAt)
  const toName = typeof to === 'string' && to !== '' ? to : null
  const body = bodyOf(raw.body)
  const payload = decodePayload(body)
  const action = actionOf(payload)
  const messageId = messageIdFor(id)

  const message: Message = {
    id: messageId,
    from: agentIdFor(from),
    to: toName === null ? null : agentIdFor(toName),
    subject: typeof raw.subject === 'string' ? raw.subject : '',
    body: body ?? '',
    payload,
    action,
    status: statusOf(raw.status),
    at,
    tokens: 0,
    costUsd: 0,
  }

  const toolCall: ToolCall | null =
    action === null
      ? null
      : {
          id: toolCallIdFor(id),
          agentId: agentIdFor(from),
          name: action,
          messageId,
          at,
          args: argsOf(payload),
          durationMs: null,
          costUsd: 0,
        }

  return { rowId: id, at, from, to: toName, message, toolCall }
}

/** Total order on row ids: numeric when both parse as numbers, else lexical. */
function compareId(a: number | string, b: number | string): number {
  const an = typeof a === 'number' ? a : Number(a)
  const bn = typeof b === 'number' ? b : Number(b)
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
  const as = String(a)
  const bs = String(b)
  return as < bs ? -1 : as > bs ? 1 : 0
}

// ── The adapter ─────────────────────────────────────────────────────────────

/**
 * Parse an `agent_messages` export into a normalized {@link Run}.
 *
 * @param input export text (JSON) or an already-parsed row array
 * @param options optional label / seed / run-id overrides
 * @throws TraceParseError when the input is not a row array or a row is
 *         malformed (bad JSON, missing `from_agent`, unparseable
 *         `created_at`, a duplicate primary key)
 */
export function parseAgentMessagesExport(
  input: string | readonly AgentMessageRow[],
  options: AdapterOptions = {},
): Run {
  const raws = coerceRows(input)
  if (raws.length === 0) return emptyRun(options)

  // Canonical order FIRST, so everything derived downstream is independent of
  // the order rows happened to arrive in.
  const ordered: NormalizedRow[] = []
  const seenIds = new Set<string>()
  for (let index = 0; index < raws.length; index += 1) {
    const row = parseRow(raws[index], index)
    const key = String(row.rowId)
    if (seenIds.has(key)) {
      throw new TraceParseError(`duplicate row id: ${key}`)
    }
    seenIds.add(key)
    ordered.push(row)
  }
  ordered.sort((a, b) => a.at - b.at || compareId(a.rowId, b.rowId))

  const messages = ordered.map((row) => row.message)
  const toolCalls = ordered
    .map((row) => row.toolCall)
    .filter((call): call is ToolCall => call !== null)

  const agents = deriveAgents(ordered)
  const events = buildEvents(ordered)

  const startedAt = ordered[0].at
  const endedAt = ordered[ordered.length - 1].at
  const meta: RunMeta = {
    agentCount: agents.length,
    messageCount: messages.length,
    toolCallCount: toolCalls.length,
    eventCount: events.length,
    broadcastCount: messages.filter((message) => message.to === null).length,
    durationMs: endedAt - startedAt,
    totalTokens: messages.reduce((sum, message) => sum + message.tokens, 0),
    totalCostUsd: messages.reduce((sum, message) => sum + message.costUsd, 0),
  }

  // Same export → same id + seed (determinism, PRD §5); different export →
  // different, stable values. `messages` is already in canonical order.
  const digest = fnv1a(JSON.stringify(messages))

  return {
    id: options.runId ?? `run_${digest.toString(16).padStart(8, '0')}`,
    label: options.label ?? 'agent_messages export',
    source: TRACE_SOURCE,
    seed: options.seed ?? digest,
    agents,
    messages,
    toolCalls,
    events,
    startedAt,
    endedAt,
    meta,
  }
}

// ── Derivation passes ───────────────────────────────────────────────────────

/**
 * One agent per distinct name seen in `from_agent` / `to_agent`, alphabetically
 * ordered for a stable array. Send/receive counts, the active window and
 * token/cost attribution are all derived — a broadcast counts as *received* by
 * every agent except its sender (the contract's "broadcasts counted per
 * recipient"). `role` and `parentId` are deliberately deferred: role inference
 * and the fan-out/handoff edge model are separate passes (M2-T4).
 */
function deriveAgents(ordered: readonly NormalizedRow[]): Agent[] {
  const names = new Set<string>()
  for (const row of ordered) {
    names.add(row.from)
    if (row.to !== null) names.add(row.to)
  }

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

  for (const row of ordered) {
    bump(sent, row.from)
    touch(row.from, row.at)
    tokens.set(row.from, (tokens.get(row.from) ?? 0) + row.message.tokens)
    cost.set(
      row.from,
      (cost.get(row.from) ?? 0) + row.message.costUsd + (row.toolCall?.costUsd ?? 0),
    )

    if (row.to !== null) {
      bump(received, row.to)
      touch(row.to, row.at)
    } else {
      // Broadcast: delivered to every other participant.
      for (const name of names) {
        if (name === row.from) continue
        bump(received, name)
        touch(name, row.at)
      }
    }
  }

  return [...names].sort().map((name) => ({
    id: agentIdFor(name),
    name,
    role: 'unknown',
    parentId: null,
    firstSeenAt: firstSeen.get(name) ?? 0,
    lastSeenAt: lastSeen.get(name) ?? 0,
    messagesSent: sent.get(name) ?? 0,
    messagesReceived: received.get(name) ?? 0,
    tokens: tokens.get(name) ?? 0,
    costUsd: cost.get(name) ?? 0,
  }))
}

/**
 * The unified event stream: one `run_start`, then per row a `message` event and
 * (when the row carried an action) its `tool_call` event, then one `run_end`.
 * `sequence` is a contiguous 0-based index in that canonical order, so the
 * array is already sorted by `at` then `sequence` as the contract requires.
 */
function buildEvents(ordered: readonly NormalizedRow[]): Event[] {
  const events: Event[] = []
  let sequence = 0

  events.push({
    id: 'e_run_start',
    at: ordered[0].at,
    sequence,
    agentId: null,
    label: 'run start',
    kind: 'run_start',
  })
  sequence += 1

  for (const row of ordered) {
    events.push({
      id: `e_message_${row.rowId}`,
      at: row.at,
      sequence,
      agentId: row.message.from,
      label: row.message.subject,
      kind: 'message',
      messageId: row.message.id,
      from: row.message.from,
      to: row.message.to,
    })
    sequence += 1

    if (row.toolCall !== null) {
      events.push({
        id: `e_tool_call_${row.rowId}`,
        at: row.at,
        sequence,
        agentId: row.toolCall.agentId,
        label: row.toolCall.name,
        kind: 'tool_call',
        toolCallId: row.toolCall.id,
        toolName: row.toolCall.name,
      })
      sequence += 1
    }
  }

  events.push({
    id: 'e_run_end',
    at: ordered[ordered.length - 1].at,
    sequence,
    agentId: null,
    label: 'run end',
    kind: 'run_end',
  })

  return events
}

// ── Degenerate input ────────────────────────────────────────────────────────

const EMPTY_META: RunMeta = {
  agentCount: 0,
  messageCount: 0,
  toolCallCount: 0,
  eventCount: 0,
  broadcastCount: 0,
  durationMs: 0,
  totalTokens: 0,
  totalCostUsd: 0,
}

/**
 * A valid but empty run: an export with no rows. There is nothing to bracket —
 * inventing a timestamp for a `run_start`/`run_end` pair out of an empty export
 * would be fabricating data — so the event stream is empty and the time span is
 * `[0, 0]`.
 */
function emptyRun(options: AdapterOptions): Run {
  const seed = options.seed ?? fnv1a('agent_messages:empty')
  return {
    id: options.runId ?? `run_${seed.toString(16).padStart(8, '0')}`,
    label: options.label ?? 'agent_messages export',
    source: TRACE_SOURCE,
    seed,
    agents: [],
    messages: [],
    toolCalls: [],
    events: [],
    startedAt: 0,
    endedAt: 0,
    meta: { ...EMPTY_META },
  }
}
