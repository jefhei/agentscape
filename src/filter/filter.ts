/**
 * Filter and focus (M4-T5) — the pure half of narrowing the scene.
 *
 * A trace is a graph *and* a clock. M4's transport already lets a viewer move the
 * clock; this module lets them narrow the graph: **by agent**, **by event type**
 * and **by time window**, in any combination. Every rule about what those three
 * facets mean lives here, in one reducer and three predicates, because a filter
 * is exactly the kind of feature that quietly drifts when each component decides
 * its own idea of "matches".
 *
 * ## Structure persists, activity narrows
 *
 * The filter does **not** remove nodes, arcs or agents from the scene. The PRD's
 * rule for the spatial view is that the *shape* of the run is the product, so a
 * filter dims what is outside it and leaves the wiring readable — it never
 * re-lays-out the trace or hides the cast. Mechanically that falls out of the
 * existing reveal (`src/scene/reveal.ts`): {@link FilterState} is turned into a
 * *narrowed* reveal track by `filterTrack.ts`, and an element with no matching
 * events reads as *dormant* — the same dim-but-present state an unfired element
 * has. Nothing in this module chooses a brightness; it chooses what **counts**.
 *
 * ## The three facets, and what "empty" means
 *
 * - **agents** — an empty selection means *every* agent (the facet is off). A
 *   non-empty selection keeps the messages an agent sent **or** received, so
 *   picking a worker also keeps the assignment that created it (a filter that
 *   showed a worker with no inbound work would hide the thing worth seeing).
 *   A broadcast is kept when it reaches any selected agent, which is what a
 *   broadcast means.
 * - **kinds** — both kinds means the facet is off. An empty selection means
 *   *nothing matches*, which is the honest reading of "no event types selected"
 *   and is reported as such ({@link FilterView.empty}) rather than silently
 *   reverting to "everything".
 * - **window** — inclusive offsets from the run's start. `null` is the whole
 *   run. The window narrows *activity*; it never rescales the transport: the
 *   scrubber still scrubs the whole run, because a filter is a lens on the run,
 *   not a different run.
 *
 * ## What this is, and what it is not
 *
 * It is a **lens on the spatial view**: its output feeds the scene's reveal, so
 * narrowing by agent leaves that agent's subgraph lit inside the run's real shape.
 * It is NOT a search box, a transcript filter or a query language — AgentReplay /
 * traceview / tracediff own linear search and diff (PRD §8), and the spatial view
 * is the product. There is deliberately no free-text facet here.
 *
 * ## Purity (PRD §5)
 *
 * Pure and deterministic: no React, no DOM, no three.js, no clock, no
 * `Math.random`, no mutation of the model or of any filter value. Every helper
 * returns the **same object** when an action changes nothing, so a UI rendering
 * from this state re-renders only when the filter really moved. The React
 * plumbing (the reducer's state, the run prune) is `useFilter.ts`, one layer up.
 */

import type { AgentId, EventKind, Message, ToolCall } from '../types/index.ts'
import type { TraceModel } from '../model/index.ts'
import { compareModelIds } from '../model/index.ts'
import { formatDuration } from '../playback/playback.ts'

// ── The facets ──────────────────────────────────────────────────────────────

/**
 * The event kinds a filter can narrow the scene to. Deliberately a *subset* of
 * `EVENT_KINDS`: `run_start` / `run_end` bracket the run and draw nothing (no
 * node, no arc, no glyph), so a toggle for them could only ever be a no-op that
 * made the bar lie about what it controls.
 */
export type FilterKind = Extract<EventKind, 'message' | 'tool_call'>

/** Every filterable kind, in the order the bar lists them. */
export const FILTER_KINDS: readonly FilterKind[] = Object.freeze([
  'message',
  'tool_call',
] as FilterKind[])

/** The bar's labels for the two kinds — printed, never invented in the JSX. */
export const FILTER_KIND_LABELS: Readonly<Record<FilterKind, string>> = Object.freeze({
  message: 'Messages',
  tool_call: 'Tool calls',
})

/**
 * An inclusive time window, in milliseconds **from the run's start**. Absolute
 * epoch times would tie a saved filter to one export; offsets let the same lens
 * describe "the first two minutes" of any run.
 */
export interface FilterWindow {
  /** First instant inside the window, ms from the run's start. */
  startMs: number
  /** Last instant inside the window, ms from the run's start (inclusive). */
  endMs: number
}

/**
 * The whole filter: one value, three facets. Immutable by convention — the
 * reducer never mutates the value it is given.
 */
export interface FilterState {
  /** Agents to keep; empty means every agent (the facet is off). */
  agentIds: readonly AgentId[]
  /** Event kinds to keep; both kinds means the facet is off. */
  kinds: readonly FilterKind[]
  /** Time window to keep, or `null` for the whole run. */
  window: FilterWindow | null
}

/** The empty agent selection, shared so the identity filter can be frozen. */
const NO_AGENTS: readonly AgentId[] = Object.freeze([] as AgentId[])

/**
 * The filter that keeps everything: no agent restriction, both kinds, the whole
 * run. Every run opens with it — loading a trace must never hide part of it.
 */
export const IDENTITY_FILTER: FilterState = Object.freeze({
  agentIds: NO_AGENTS,
  kinds: FILTER_KINDS,
  window: null,
})

// ── Reading a filter ────────────────────────────────────────────────────────

/** The identity filter (a named constructor for the state's zero value). */
export function createFilter(): FilterState {
  return IDENTITY_FILTER
}

/**
 * Whether `filter` keeps everything, i.e. is the identity filter in value (a
 * structurally equal filter built by the UI counts too, so an untouched control
 * never leaves the scene "filtered").
 */
export function isIdentity(filter: FilterState): boolean {
  return (
    filter.agentIds.length === 0 &&
    filter.kinds.length === FILTER_KINDS.length &&
    filter.window === null
  )
}

/** Whether the filter narrows anything at all (the bar's active state). */
export function isFilterActive(filter: FilterState): boolean {
  return !isIdentity(filter)
}

/** Whether `kind` is one of the kinds the filter keeps. */
export function keepsKind(filter: FilterState, kind: FilterKind): boolean {
  return filter.kinds.includes(kind)
}

// ── Normalization ───────────────────────────────────────────────────────────

/** A finite number, or `null`. */
function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

/**
 * Dedupe, drop blanks and sort agent ids canonically (natural id order, the same
 * comparator the layout and the inspector use). A caller may hand ids in any
 * order — a persisted filter, a URL fragment — and still get one canonical
 * selection, so two equal selections are `toEqual` and the reducer can tell that
 * nothing changed.
 */
export function normalizeAgentIds(ids: readonly AgentId[]): AgentId[] {
  const seen = new Set<AgentId>()
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0) seen.add(id)
  }
  return [...seen].sort(compareModelIds)
}

/**
 * Dedupe kinds and put them in {@link FILTER_KINDS} order. An unknown string
 * (a stale persisted filter) is dropped rather than trusted.
 */
export function normalizeKinds(kinds: readonly FilterKind[]): FilterKind[] {
  return FILTER_KINDS.filter((kind) => kinds.includes(kind))
}

/**
 * A well-formed window: integer, non-negative offsets, `startMs <= endMs` (a
 * reversed pair is read as the same window, which is what a user dragging the
 * two sliders past each other means). `null` in, `null` out.
 */
export function normalizeWindow(
  window: FilterWindow | null | undefined,
): FilterWindow | null {
  if (window === null || window === undefined) return null
  const start = finiteOrNull(window.startMs)
  const end = finiteOrNull(window.endMs)
  if (start === null || end === null) return null
  const a = Math.max(0, Math.round(start))
  const b = Math.max(0, Math.round(end))
  return a <= b ? { startMs: a, endMs: b } : { startMs: b, endMs: a }
}

/** Whether two filters are the same value (facet by facet). */
export function sameFilter(a: FilterState, b: FilterState): boolean {
  if (a === b) return true
  if (a.agentIds.length !== b.agentIds.length) return false
  for (let index = 0; index < a.agentIds.length; index += 1) {
    if (a.agentIds[index] !== b.agentIds[index]) return false
  }
  if (a.kinds.length !== b.kinds.length) return false
  for (let index = 0; index < a.kinds.length; index += 1) {
    if (a.kinds[index] !== b.kinds[index]) return false
  }
  if (a.window === null || b.window === null) return a.window === b.window
  return a.window.startMs === b.window.startMs && a.window.endMs === b.window.endMs
}

// ── The reducer ─────────────────────────────────────────────────────────────

/** Every way the filter can be driven. */
export type FilterAction =
  | { type: 'setAgents'; agentIds: readonly AgentId[] }
  | { type: 'setKinds'; kinds: readonly FilterKind[] }
  | { type: 'toggleKind'; kind: FilterKind }
  | { type: 'setWindow'; window: FilterWindow | null }
  | { type: 'clearWindow' }
  | { type: 'replace'; filter: FilterState }
  | { type: 'clear' }

/** A normalized copy of `filter`, sharing `fallback` when nothing changed. */
function normalized(filter: FilterState, fallback: FilterState): FilterState {
  const next: FilterState = {
    agentIds: normalizeAgentIds(filter.agentIds),
    kinds: normalizeKinds(filter.kinds),
    window: normalizeWindow(filter.window),
  }
  if (sameFilter(next, fallback)) return fallback
  // One representation for "no restriction": a value that narrows nothing IS the
  // identity filter, so a control dragged back to its neutral position clears the
  // lens instead of leaving a look-alike that reports itself as active.
  return isIdentity(next) ? IDENTITY_FILTER : next
}

/**
 * Apply one filter action. Pure: the same state + action always yields the same
 * result, and an action that changes nothing returns the **same state object**,
 * so a click that re-selects an already-selected agent does not re-render the
 * scene.
 */
export function reduceFilter(state: FilterState, action: FilterAction): FilterState {
  switch (action.type) {
    case 'setAgents':
      return state.agentIds.length === 0 && action.agentIds.length === 0
        ? state
        : normalized({ ...state, agentIds: action.agentIds }, state)
    case 'setKinds':
      return normalized({ ...state, kinds: action.kinds }, state)
    case 'toggleKind': {
      const kept = state.kinds.includes(action.kind)
      const kinds = kept
        ? state.kinds.filter((kind) => kind !== action.kind)
        : FILTER_KINDS.filter(
            (kind) => kind === action.kind || state.kinds.includes(kind),
          )
      return normalized({ ...state, kinds }, state)
    }
    case 'setWindow':
      return normalized({ ...state, window: action.window }, state)
    case 'clearWindow':
      return state.window === null
        ? state
        : normalized({ ...state, window: null }, state)
    case 'replace':
      return normalized(action.filter, state)
    case 'clear':
      return isIdentity(state) ? state : IDENTITY_FILTER
  }
}

// ── Agent selection (needs the run's agent list) ────────────────────────────

/**
 * The agent facet resolved against a run: every agent id when the selection is
 * empty (the facet is off), otherwise the canonical selection. This is what a
 * chip row should render as "pressed", so the UI never has to special-case the
 * empty-means-all convention.
 */
export function resolveAgentIds(
  filter: FilterState,
  knownAgentIds: readonly AgentId[],
): AgentId[] {
  return filter.agentIds.length === 0
    ? normalizeAgentIds(knownAgentIds)
    : normalizeAgentIds(filter.agentIds)
}

/**
 * The new agent selection after toggling `agentId`: one agent in or out of the
 * facet, starting from the resolved selection (so toggling a chip *off* an
 * unfiltered run means "everyone but this one").
 *
 * A selection covering every agent normalizes back to `[]` — "all agents" is the
 * facet being *off*, not a list that happens to be complete, and keeping the two
 * representations apart is what makes `isIdentity` meaningful.
 */
export function toggleAgentSelection(
  filter: FilterState,
  agentId: AgentId,
  knownAgentIds: readonly AgentId[],
): AgentId[] {
  const known = normalizeAgentIds(knownAgentIds)
  if (!known.includes(agentId)) return normalizeAgentIds(filter.agentIds)
  const selected = resolveAgentIds(filter, known)
  const next = selected.includes(agentId)
    ? selected.filter((id) => id !== agentId)
    : [...selected, agentId].sort(compareModelIds)
  return next.length === known.length ? [] : next
}

/**
 * The selection that keeps only `agentId` — the "focus on this agent" gesture,
 * which one click cannot express (toggling off an unfiltered run keeps the other
 * N-1, so a single-agent lens would cost N-1 clicks).
 *
 * An id the run does not have yields the empty selection, so the facet stays off
 * rather than narrowing the scene to an agent that is not in it.
 */
export function isolateAgentSelection(
  agentId: AgentId,
  knownAgentIds: readonly AgentId[],
): AgentId[] {
  return normalizeAgentIds(knownAgentIds).includes(agentId) ? [agentId] : []
}

/**
 * The filter, kept only when it still makes sense for a run: selected agents the
 * run does not contain are dropped, and the window is clamped to the run's span.
 * Used when a new run loads, so a lens tuned for one trace never describes a
 * ghost of another. Returns the **same object** when nothing had to change.
 */
export function retainFilter(
  filter: FilterState,
  knownAgentIds: readonly AgentId[],
  spanMs: number,
): FilterState {
  const known = new Set(knownAgentIds)
  const survivors = filter.agentIds.filter((id) => known.has(id))
  // A selection the new run happens to cover completely is the facet being off,
  // not a complete list — the same normalization the reducer applies.
  const agentIds = survivors.length === known.size && known.size > 0 ? [] : survivors
  const span = Number.isFinite(spanMs) && spanMs > 0 ? spanMs : 0
  const window =
    filter.window === null
      ? null
      : normalizeWindow({
          startMs: Math.min(filter.window.startMs, span),
          endMs: Math.min(filter.window.endMs, span),
        })
  return normalized({ agentIds, kinds: filter.kinds, window }, filter)
}

// ── Predicates ──────────────────────────────────────────────────────────────

/**
 * Whether an event at absolute `at` is inside the filter's window. The window is
 * expressed as offsets, so this is the one place that turns an offset back into
 * an instant — the run's start comes from the model, never from a clock.
 */
export function inWindow(model: TraceModel, filter: FilterState, at: number): boolean {
  if (filter.window === null) return true
  const offset = at - model.startedAt
  return offset >= filter.window.startMs && offset <= filter.window.endMs
}

/**
 * Whether a message survives the **agent** facet: it was sent by a selected
 * agent, or received by one. A broadcast (`to === null`) reaches every other
 * agent, so it is kept whenever the selection names any agent other than its
 * sender.
 */
export function messageTouchesSelection(
  filter: FilterState,
  message: Message,
): boolean {
  const ids = filter.agentIds
  if (ids.length === 0) return true
  if (message.to !== null) return ids.includes(message.from) || ids.includes(message.to)
  return ids.includes(message.from) || ids.some((id) => id !== message.from)
}

/**
 * Whether a message survives the whole filter: its kind is kept, it touches the
 * selected agents, and it falls inside the window. Pure; reads the model only for
 * its start time.
 */
export function matchesMessage(
  model: TraceModel,
  filter: FilterState,
  message: Message,
): boolean {
  return (
    keepsKind(filter, 'message') &&
    messageTouchesSelection(filter, message) &&
    inWindow(model, filter, message.at)
  )
}

/**
 * Whether a tool call survives the whole filter. A call belongs to exactly one
 * agent (the one that made it), so the agent facet is a membership test.
 */
export function matchesToolCall(
  model: TraceModel,
  filter: FilterState,
  call: ToolCall,
): boolean {
  const ids = filter.agentIds
  return (
    keepsKind(filter, 'tool_call') &&
    (ids.length === 0 || ids.includes(call.agentId)) &&
    inWindow(model, filter, call.at)
  )
}

// ── The view (what the filter keeps, as numbers a UI can print) ─────────────

/** How much of one thing a filter keeps. */
export interface FilterCount {
  kept: number
  total: number
}

/**
 * The filter resolved against one run: the canonical facets, the clamped window,
 * and how much of each population survives. Built once per (run, filter), so the
 * bar, the scene and any test all read the same numbers.
 */
export interface FilterView {
  /** Whether the filter narrows anything. */
  active: boolean
  /** The resolved agent facet, canonical (`[]` → every agent). */
  agentIds: AgentId[]
  /** The kinds kept, in {@link FILTER_KINDS} order. */
  kinds: FilterKind[]
  /** The window clamped to the run, or `null` for the whole run. */
  window: FilterWindow | null
  /** `window` formatted for display, or `null`. */
  windowLabel: string | null
  /** The run's span, ms (the window's sliders are bounded by it). */
  spanMs: number
  /** Agents with at least one surviving event. */
  agents: FilterCount
  /** Messages that survive. */
  messages: FilterCount
  /** Tool calls that survive. */
  toolCalls: FilterCount
  /** Nothing survives — the scene is all structure, no activity. */
  empty: boolean
  /** One-line summary the bar prints (`6 of 6 agents · …`). */
  label: string
}

/** The one-line summary for the given numbers. */
function filterLabel(
  agents: FilterCount,
  messages: FilterCount,
  toolCalls: FilterCount,
  windowLabel: string | null,
): string {
  const parts = [
    `${agents.kept} of ${agents.total} agents`,
    `${messages.kept} of ${messages.total} messages`,
    `${toolCalls.kept} of ${toolCalls.total} tool calls`,
  ]
  if (windowLabel !== null) parts.push(windowLabel)
  return parts.join(' · ')
}

/** `0.0s → 2:00` for a window — one formatting rule, shared with the bar. */
export function formatFilterWindow(window: FilterWindow): string {
  return `${formatDuration(window.startMs)} → ${formatDuration(window.endMs)}`
}

/**
 * Resolve `filter` against `model`: canonical facets, a window clamped to the
 * run's span, and the surviving counts.
 *
 * Pure and deterministic; the model and the filter are never mutated. An empty
 * run is well-formed (`0 of 0` everywhere, `empty: true`).
 */
export function buildFilterView(model: TraceModel, filter: FilterState): FilterView {
  const spanMs = Math.max(0, model.endedAt - model.startedAt)
  const knownIds = normalizeAgentIds(model.agents.map((agent) => agent.id))
  const kinds = normalizeKinds(filter.kinds)
  // A selection naming only agents this run does not have cannot narrow
  // anything, so it collapses to "no restriction" — the same rule the reducer's
  // `retainFilter` applies when a run is swapped.
  const selection = knownIds.filter((id) => filter.agentIds.includes(id))
  const windows = normalizeWindow(filter.window)
  const window =
    windows === null
      ? null
      : normalizeWindow({
          startMs: Math.min(windows.startMs, spanMs),
          endMs: Math.min(windows.endMs, spanMs),
        })
  const windowLabel = window === null ? null : formatFilterWindow(window)
  const effective: FilterState = { agentIds: selection, kinds, window }

  const participants = new Set<AgentId>()
  let messagesKept = 0
  for (const message of model.messages) {
    if (!matchesMessage(model, effective, message)) continue
    messagesKept += 1
    participants.add(message.from)
    if (message.to !== null) {
      participants.add(message.to)
    } else {
      // A broadcast is heard by the selected agents (every agent when the facet
      // is off) — never by the sender itself, matching normalization's rule.
      const listeners = selection.length === 0 ? knownIds : selection
      for (const id of listeners) {
        if (id !== message.from) participants.add(id)
      }
    }
  }

  let toolCallsKept = 0
  for (const call of model.toolCalls) {
    if (!matchesToolCall(model, effective, call)) continue
    toolCallsKept += 1
    participants.add(call.agentId)
  }

  const agents: FilterCount = { kept: participants.size, total: model.agents.length }
  const messages: FilterCount = {
    kept: messagesKept,
    total: model.messages.length,
  }
  const toolCalls: FilterCount = {
    kept: toolCallsKept,
    total: model.toolCalls.length,
  }

  return {
    active: !isIdentity(effective),
    agentIds: selection.length === 0 ? knownIds : selection,
    kinds,
    window,
    windowLabel,
    spanMs,
    agents,
    messages,
    toolCalls,
    empty: messages.kept === 0 && toolCalls.kept === 0,
    label: filterLabel(agents, messages, toolCalls, windowLabel),
  }
}
