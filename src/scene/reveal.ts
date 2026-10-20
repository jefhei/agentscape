/**
 * Scene reveal — what the spatial scene shows at a moment in the run (M4-T1).
 *
 * A scrubber is only worth having if moving it changes the *scene*. This module
 * is the pure join between the playhead (M1-T7) and the composed scene
 * (M3-T6): given the scene plan and an elapsed time, it says, for every drawn
 * element, how lit it is right now.
 *
 * ## The reveal philosophy
 *
 * **Structure persists; activity is revealed.** The settled layout, the arcs
 * between agents and every node exist from the first frame — that is the shape
 * of the run, and a scrubber that made the shape pop in and out would hide
 * exactly what the spatial view is for. What time changes is *emphasis*:
 *
 * - a **node** is dormant (dim) until the first event touches it, then it glows
 *   at its calibrated radiance;
 * - an **arc** (one per communication link) is a faint skeleton until traffic
 *   crosses it, then its brightness ramps with the fraction of that link's
 *   messages that have fired;
 * - a **glyph** is an *event*, not structure — one tool call — so it is absent
 *   until its call fires, then it appears and starts orbiting.
 *
 * This is also the honest reading of a trace: at t=0 you see the cast and the
 * wiring; as the run plays, the wiring lights up in the order it was used.
 *
 * ## Two steps: a track, then a lookup
 *
 * {@link buildRevealTrack} does all the O(n) work **once per scene**: it
 * indexes each agent's first appearance, each arc's backing message times and
 * each glyph's call time. {@link revealAt} is then a binary search per element —
 * so scrubbing at 60 fps costs nothing that grows with the trace, which is what
 * keeps M4's transport off M5's scale budget.
 *
 * ## Purity (PRD §5)
 *
 * Pure and deterministic: no three.js, no DOM, no clock, no `Math.random`, no
 * mutation of the plan or the model. The same track plus the same elapsed time
 * always yields a byte-identical reveal, and positions/colours are never chosen
 * here — this module only multiplies the magnitudes the scene plan already
 * derived. Nothing about the rendered *look* is asserted in tests: the numbers
 * below are channels the render layer applies, and the look is human-reviewed
 * (M5-T5).
 *
 * ## Scope
 *
 * Deliberately NOT here: the transport state machine and the scrubber UI
 * (`src/playback/`), the camera (M4-T2/T3), the detail panel (M4-T4) and
 * filters (M4-T5). This module answers one question — *how lit is this element
 * at time t* — and nothing else.
 */

import type { AgentId, ToolCallId } from '../types/index.ts'
import { compareModelIds } from '../model/index.ts'
import type { ScenePlan } from './scenePlan.ts'

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Glow multiplier on an agent node before the run has touched it. Not `0`: the
 * node is still there, still at its settled position, just unlit — the shape is
 * the product. The exact value is a look decision (M5-T5).
 */
export const DORMANT_NODE_GLOW = 0.32

/**
 * Brightness multiplier on a communication arc that no message has crossed yet.
 * Very low but non-zero, so the wiring is faintly visible before traffic.
 */
export const DORMANT_ARC_INTENSITY = 0.12

/**
 * Brightness a link jumps to the moment its first message fires, before ramping
 * with revealed volume. Keeps "this channel has been used" legible even when
 * only one of fifty messages has fired.
 */
export const ARC_LIVE_FLOOR = 0.4

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown when a scene plan and its run disagree about the elements to reveal —
 * an arc whose backing messages do not add up to its volume, a node for an
 * agent the run never had, a glyph for an unknown tool call. Impossible for a
 * plan composed by {@link buildScenePlan}; it fails loudly rather than silently
 * revealing the wrong thing.
 */
export class RevealError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RevealError'
  }
}

// ── The track ───────────────────────────────────────────────────────────────

/** Unordered-pair separator; the same idiom the layout's adjacency uses. */
const PAIR_SEPARATOR = '\u0000'

/** Key for an undirected pair, canonically ordered so both directions collapse. */
function pairKey(a: AgentId, b: AgentId): string {
  return compareModelIds(a, b) <= 0
    ? `${a}${PAIR_SEPARATOR}${b}`
    : `${b}${PAIR_SEPARATOR}${a}`
}

/** One agent's reveal input: when the run first touched it. */
export interface NodeRevealTrack {
  agentId: AgentId
  /** First event involving the agent, epoch ms. */
  firstAt: number | null
}

/** One arc's reveal input: every message on that link, ascending. */
export interface ArcRevealTrack {
  /** Canonically-first endpoint (mirrors the arc plan). */
  source: AgentId
  /** The other endpoint. */
  target: AgentId
  /** Messages on the link — the arc plan's own `volume`. */
  volume: number
  /** Times of those messages, ascending (one entry per message). */
  times: number[]
}

/** One glyph's reveal input: when its tool call happened. */
export interface GlyphRevealTrack {
  toolCallId: ToolCallId
  /** Invocation time, epoch ms. */
  at: number
}

/** Everything {@link revealAt} needs, indexed once per scene. */
export interface RevealTrack {
  /** The run this track belongs to — a reveal from another run is a bug. */
  runId: string
  /** Run start, epoch ms. */
  startedAt: number
  /** Run end, epoch ms. */
  endedAt: number
  /** `endedAt - startedAt`. */
  spanMs: number
  /** Total events, for the progress reading. */
  eventCount: number
  /** One entry per drawn node, aligned with `plan.nodes.instances`. */
  nodes: NodeRevealTrack[]
  /** One entry per drawn arc, aligned with `plan.arcs.arcs`. */
  arcs: ArcRevealTrack[]
  /** One entry per drawn glyph, aligned with `plan.glyphs.glyphs`. */
  glyphs: GlyphRevealTrack[]
}

/**
 * Index a composed scene for time-based reveal.
 *
 * The arc half deliberately re-derives the link→messages mapping the same way
 * the layout did (an undirected pair, a broadcast reaching every other agent)
 * and then **checks it against the arc plan's own `volume`** — so a plan that
 * drifted from its run fails here instead of revealing the wrong number of
 * messages. That check is the reason this is a track-builder and not a lazy
 * per-frame scan.
 *
 * Pure: the plan and the model are read, never mutated.
 *
 * @throws RevealError when the plan and the run disagree.
 */
export function buildRevealTrack(plan: ScenePlan): RevealTrack {
  const model = plan.run

  const timesByPair = new Map<string, number[]>()
  const record = (a: AgentId, b: AgentId, at: number): void => {
    if (a === b) return
    const key = pairKey(a, b)
    const times = timesByPair.get(key)
    if (times === undefined) timesByPair.set(key, [at])
    else times.push(at)
  }

  const agentIds = model.agents.map((agent) => agent.id)
  for (const message of model.messages) {
    if (message.to === null) {
      for (const id of agentIds) record(message.from, id, message.at)
    } else {
      record(message.from, message.to, message.at)
    }
  }

  const arcs: ArcRevealTrack[] = plan.arcs.arcs.map((arc) => {
    const key = pairKey(arc.source, arc.target)
    // Canonical events are already ascending in `at`, so the pushes are too;
    // sorting anyway costs nothing once and makes the ordering a guarantee.
    const times = [...(timesByPair.get(key) ?? [])].sort((a, b) => a - b)
    if (times.length !== arc.volume) {
      throw new RevealError(
        `arc ${arc.source} → ${arc.target} claims ${arc.volume} messages but the run has ${times.length}`,
      )
    }
    return { source: arc.source, target: arc.target, volume: arc.volume, times }
  })

  const agentById = new Map(model.agents.map((agent) => [agent.id, agent]))
  const nodes: NodeRevealTrack[] = plan.nodes.instances.map((instance) => {
    const agent = agentById.get(instance.agentId)
    if (agent === undefined) {
      throw new RevealError(`no agent ${instance.agentId} for a drawn node`)
    }
    return { agentId: instance.agentId, firstAt: agent.firstSeenAt }
  })

  const callById = new Map(model.toolCalls.map((call) => [call.id, call]))
  const glyphs: GlyphRevealTrack[] = plan.glyphs.glyphs.map((glyph) => {
    const call = callById.get(glyph.toolCallId)
    if (call === undefined) {
      throw new RevealError(`no tool call ${glyph.toolCallId} for a drawn glyph`)
    }
    return { toolCallId: glyph.toolCallId, at: call.at }
  })

  return {
    runId: model.id,
    startedAt: model.startedAt,
    endedAt: model.endedAt,
    spanMs: model.endedAt - model.startedAt,
    eventCount: model.events.length,
    nodes,
    arcs,
    glyphs,
  }
}

// ── The reveal ──────────────────────────────────────────────────────────────

/** How lit one node is. */
export interface NodeReveal {
  agentId: AgentId
  /** Whether any event has touched the agent by now. */
  active: boolean
  /** Glow multiplier applied to the node's calibrated radiance, `(0, 1]`. */
  glow: number
}

/** How lit one arc is. */
export interface ArcReveal {
  source: AgentId
  target: AgentId
  /** Messages on the link that have fired. */
  fired: number
  /** Messages on the link in total. */
  volume: number
  /** `fired / volume`, `[0, 1]`. */
  reveal: number
  /**
   * Brightness multiplier for the arc, `(0, 1]` — the dormant floor before any
   * traffic, then {@link ARC_LIVE_FLOOR} ramping to `1` as the link's volume is
   * revealed.
   */
  intensity: number
}

/** Whether one glyph is present. */
export interface GlyphReveal {
  toolCallId: ToolCallId
  /** Whether its tool call has fired. */
  visible: boolean
}

/** What the scene shows at one instant. */
export interface SceneReveal {
  /** Clamped position from the run start, ms. */
  elapsedMs: number
  /** Absolute time of the reveal, epoch ms. */
  timeMs: number
  /** Fraction of the run elapsed, `[0, 1]`. */
  progress: number
  /** One per drawn node, aligned with the node plan's instances. */
  nodes: NodeReveal[]
  /** One per drawn arc, aligned with the arc plan's arcs. */
  arcs: ArcReveal[]
  /** One per drawn glyph, aligned with the glyph plan's glyphs. */
  glyphs: GlyphReveal[]
  /** Cheap summary of how much of the run has lit up (a HUD reads this, M4-T6). */
  counts: {
    activeAgents: number
    firedArcs: number
    visibleGlyphs: number
  }
}

/** Number of entries in an ascending array that are `<= value`. */
function upperBound(times: readonly number[], value: number): number {
  let low = 0
  let high = times.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (times[mid] <= value) low = mid + 1
    else high = mid
  }
  return low
}

/** Clamp `value` into `[min, max]`; a non-finite value reads as `min`. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * The scene's reveal at `elapsedMs` from the run start (clamped to the run, so
 * a negative scrub shows the opening state and an over-scrub the finished one).
 *
 * Pure and deterministic; the track is not mutated. Empty runs are well-formed:
 * no nodes, arcs or glyphs, `progress` `0` (an instant-long non-empty run reads
 * `1`).
 */
export function revealAt(track: RevealTrack, elapsedMs: number): SceneReveal {
  const elapsed = clamp(elapsedMs, 0, track.spanMs)
  const timeMs = track.startedAt + elapsed

  const nodes: NodeReveal[] = track.nodes.map((entry) => {
    const active = entry.firstAt !== null && entry.firstAt <= timeMs
    return {
      agentId: entry.agentId,
      active,
      glow: active ? 1 : DORMANT_NODE_GLOW,
    }
  })

  const arcs: ArcReveal[] = track.arcs.map((entry) => {
    const fired = upperBound(entry.times, timeMs)
    const reveal = entry.volume === 0 ? 0 : fired / entry.volume
    return {
      source: entry.source,
      target: entry.target,
      fired,
      volume: entry.volume,
      reveal,
      intensity:
        fired === 0
          ? DORMANT_ARC_INTENSITY
          : ARC_LIVE_FLOOR + (1 - ARC_LIVE_FLOOR) * reveal,
    }
  })

  const glyphs: GlyphReveal[] = track.glyphs.map((entry) => ({
    toolCallId: entry.toolCallId,
    visible: entry.at <= timeMs,
  }))

  const progress =
    track.spanMs === 0
      ? track.eventCount === 0
        ? 0
        : 1
      : clamp(elapsed / track.spanMs, 0, 1)

  return {
    elapsedMs: elapsed,
    timeMs,
    progress,
    nodes,
    arcs,
    glyphs,
    counts: {
      activeAgents: nodes.filter((node) => node.active).length,
      firedArcs: arcs.filter((arc) => arc.fired > 0).length,
      visibleGlyphs: glyphs.filter((glyph) => glyph.visible).length,
    },
  }
}
