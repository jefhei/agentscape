/**
 * Filtering the scene's reveal (M4-T5) — one lens, applied to the timeline model.
 *
 * `filter.ts` decides *what matches*. This module answers the next question: what
 * does the scene show, at a given playhead, **once the filter is applied**? The
 * answer is deliberately not a new render-layer concept and not a new brightness
 * curve: it is the *existing* reveal (M4- T1, `src/scene/reveal.ts`) computed over
 * a **narrowed reveal track**.
 *
 * That choice is the whole design. A reveal track is already "one entry per drawn
 * element, holding the times that light it": a node's first appearance, an arc's
 * message times, a glyph's call time. Filtering is then a question of *which of
 * those times count* — and everything else falls out of the rules M4-T1 already
 * pinned:
 *
 * - a node with no matching event has `firstAt: null` → it draws **dormant**
 *   ({@link DORMANT_NODE_GLOW}) at its settled position;
 * - an arc with no matching message has `volume: 0` → it draws **faint**
 *   ({@link DORMANT_ARC_INTENSITY}) between its two nodes;
 * - a glyph whose call is filtered out gets {@link HIDDEN_GLYPH_AT} → it is never
 *   visible, because a glyph *is* an event and events do not persist.
 *
 * So filtering **narrows activity and keeps structure**: the run's shape, its
 * cast and its wiring stay on screen, dimmed, and the selected slice lights up
 * inside it. No second notion of "now", no second intensity model, and no
 * duplication of the reveal's arithmetic that could drift from it.
 *
 * ## The track must line up with the plan it was built from
 *
 * The element *arrays* are carried over one-for-one: same length, same order, same
 * agents / arcs / glyphs. That is the contract the render layers already rely on
 * (they index the reveal by instance), so filtering cannot add, remove or reorder
 * an entry — only change the times inside it. A track that names an agent or tool
 * call the run does not have is a bug in the caller, and throws
 * {@link FilterError} rather than drawing something that is not there.
 *
 * ## Time is the run's, not the window's
 *
 * `startedAt` / `endedAt` / `spanMs` / `eventCount` are carried through untouched.
 * A time-window filter narrows what is *lit*, never what the transport scrubs: the
 * scrubber still spans the whole run, because a lens on a run is not a different
 * run. Rescaling the reveal's span to the window would make the playhead mean two
 * different things depending on the filter.
 *
 * ## Purity (PRD §5)
 *
 * Pure and deterministic: no React, no DOM, no three.js, no clock, no
 * `Math.random`, and neither the track nor the model is mutated (the arc `times`
 * arrays are fresh copies). The same track, model and filter always yield a
 * byte-identical result — which `filterTrack.test.ts` pins, including the
 * strongest form: the identity filter reproduces the unfiltered track exactly.
 */

import type { AgentId } from '../types/index.ts'
import type { TraceModel } from '../model/index.ts'
import { matchesMessage, matchesToolCall } from './filter.ts'
import type { FilterState } from './filter.ts'
import { pairKey } from '../scene/reveal.ts'
import type { RevealTrack } from '../scene/reveal.ts'

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * The time a filtered-out glyph is given, so the reveal's own `at <= timeMs` rule
 * hides it forever without needing a second visibility channel. `Infinity` is
 * exact here — no event can ever happen after it — and it keeps the glyph's
 * entry in place, so the layer's index alignment is untouched.
 */
export const HIDDEN_GLYPH_AT = Number.POSITIVE_INFINITY

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown when a reveal track cannot be filtered for a run: it belongs to another
 * run, or it names an agent / tool call the run does not have. Both are
 * impossible for a track built by {@link buildRevealTrack} from the same run, and
 * both would otherwise silently show the wrong element's activity.
 */
export class FilterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FilterError'
  }
}

// ── The filtered track ──────────────────────────────────────────────────────

/** The earliest of `at` and the map's current value. */
function touchFirst(first: Map<AgentId, number>, agentId: AgentId, at: number): void {
  const current = first.get(agentId)
  if (current === undefined || at < current) first.set(agentId, at)
}

/**
 * Narrow a reveal track to `filter`.
 *
 * `model` is the run the track was built from — it supplies the run's start (the
 * window's origin), the agent list (so a node's activity is derived from events,
 * not from a filter's opinion) and the tool calls (so a glyph's agent can be
 * matched).
 *
 * Pure: reads the track and the model, mutates neither, and returns a fresh track
 * whose element arrays are aligned with the input's.
 *
 * @throws FilterError when the track belongs to a different run, or names an
 *         element the run does not have.
 */
export function filterRevealTrack(
  track: RevealTrack,
  model: TraceModel,
  filter: FilterState,
): RevealTrack {
  if (track.runId !== model.id) {
    throw new FilterError(
      `reveal track for run ${track.runId} cannot be filtered against run ${model.id}`,
    )
  }

  const agentIds = model.agents.map((agent) => agent.id)
  const agentSet = new Set<AgentId>(agentIds)
  const firstByAgent = new Map<AgentId, number>()
  const timesByPair = new Map<string, number[]>()

  const record = (a: AgentId, b: AgentId, at: number): void => {
    if (a === b) return
    const key = pairKey(a, b)
    const times = timesByPair.get(key)
    if (times === undefined) timesByPair.set(key, [at])
    else times.push(at)
  }

  for (const message of model.messages) {
    if (!matchesMessage(model, filter, message)) continue
    // Activity is credited exactly the way normalization credits it (M1-T5): the
    // sender, and the recipient — a broadcast reaches every other agent.
    touchFirst(firstByAgent, message.from, message.at)
    if (message.to === null) {
      for (const id of agentIds) {
        if (id === message.from) continue
        touchFirst(firstByAgent, id, message.at)
        record(message.from, id, message.at)
      }
    } else {
      touchFirst(firstByAgent, message.to, message.at)
      record(message.from, message.to, message.at)
    }
  }

  for (const call of model.toolCalls) {
    if (!matchesToolCall(model, filter, call)) continue
    touchFirst(firstByAgent, call.agentId, call.at)
  }

  const nodes = track.nodes.map((entry) => {
    if (!agentSet.has(entry.agentId)) {
      throw new FilterError(`no agent ${entry.agentId} for a reveal-track node`)
    }
    // Lit when the agent *participates* in a kept event — the sender, the
    // recipient, a broadcast's listener, or the agent that made a kept call. So a
    // lens on one worker also lights the orchestrator that assigned its work: the
    // filtered subgraph, not a lone dot — and the same rule the bar's
    // "N of M agents" count uses, so the number and the scene cannot disagree.
    return {
      agentId: entry.agentId,
      firstAt: firstByAgent.get(entry.agentId) ?? null,
    }
  })

  // The arc half re-derives each link's messages from the *kept* ones, keyed by
  // the reveal's own pairing rule — so an arc whose traffic is entirely outside
  // the filter keeps its entry with `volume: 0` and reads as unused, which is the
  // honest description of "nothing on this link is in view".
  const arcs = track.arcs.map((entry) => {
    const times = [
      ...(timesByPair.get(pairKey(entry.source, entry.target)) ?? []),
    ].sort((a, b) => a - b)
    return {
      source: entry.source,
      target: entry.target,
      volume: times.length,
      times,
    }
  })

  const callById = new Map(model.toolCalls.map((call) => [call.id, call]))
  const glyphs = track.glyphs.map((entry) => {
    const call = callById.get(entry.toolCallId)
    if (call === undefined) {
      throw new FilterError(`no tool call ${entry.toolCallId} for a reveal-track glyph`)
    }
    return {
      toolCallId: entry.toolCallId,
      at: matchesToolCall(model, filter, call) ? entry.at : HIDDEN_GLYPH_AT,
    }
  })

  return {
    runId: track.runId,
    startedAt: track.startedAt,
    endedAt: track.endedAt,
    spanMs: track.spanMs,
    eventCount: track.eventCount,
    nodes,
    arcs,
    glyphs,
  }
}
