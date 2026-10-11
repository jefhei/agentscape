/**
 * Visual-attribute mapping (M2-T3).
 *
 * The third piece of the M2 "Spatial Layout Engine". M2-T1 answers *where each
 * agent sits*; this module answers *how each agent and each link should read*
 * once it is there: a busier node is drawn larger and glows brighter, and a
 * heavier conversation between two agents is drawn as a thicker arc. It turns
 * the trace's facts into a small, deterministic set of numbers the render layer
 * (M3) hands straight to instanced meshes and batched arcs — nothing here draws
 * anything.
 *
 * ## What drives what (PRD §6 "Scene construction")
 *
 * - **Node size** and **node emissive** are driven by an agent's **activity** —
 *   how much it took part in the run (`messagesSent + messagesReceived +
 *   toolCalls`). One signal, two magnitudes: a busier agent is both bigger and
 *   hotter. That is the mapping the PRD names ("size/emissive driven by
 *   activity").
 * - **Arc width** is driven by the **message volume** between a pair — the
 *   weight of the communication link the layout already relaxed
 *   ({@link deriveLayoutLinks}, M2-T1), so the arc is drawn exactly along the
 *   edge the shape was computed over.
 *
 * ## Normalization (and why it is relative, not absolute)
 *
 * Both channels are normalized **within the run**: activity is min-max scaled
 * across its agents, volume across its links, each into `[0, 1]`, then lerped
 * into the channel's output range. Relative scaling is what gives a single run
 * good visual dynamic range regardless of its absolute scale — a five-message
 * run and a five-thousand-message run both read at full contrast. When a run has
 * **no spread** (every agent has equal activity, or every link equal volume —
 * e.g. a one-agent run, or a lone link) there is no relative signal to show, so
 * every element gets the **neutral midpoint** ({@link NEUTRAL_INTENSITY})
 * rather than dividing by zero.
 *
 * ## Determinism + purity (PRD §5)
 *
 * Pure: no three.js, no DOM, no clock, no `Math.random`, no mutation of the
 * model. The output is a byte-identical function of the trace whatever order
 * its arrays arrive in (agents are iterated in canonical id order and the link
 * list comes from the already-canonical {@link deriveLayoutLinks}). The *look*
 * is not asserted in tests — jsdom has no GPU; it is human-reviewed (M5-T5).
 * What is gated is the mapping as data: ranges, monotonicity, the neutral
 * fallback and reproducibility.
 *
 * ## Scope
 *
 * Deliberately NOT here: token/cost-driven visuals (v1 `agent_messages` rows
 * carry neither, so every value would be `0`), the typed spawn/handoff/message
 * edge model (M2-T4) that will refine *which* arcs exist, color/hue selection,
 * and the bloom calibration that makes bright read as "hot" (M3-T4). This task
 * is the magnitude mapping only.
 */

import type { AgentId } from '../types/index.ts'
import { compareModelIds } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import { deriveLayoutLinks } from './forceLayout.ts'

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Smallest node radius (`intensity === 0`), in the layout's scene units. The
 * layout's ideal edge length is `1`, so the size range is kept well below the
 * settled inter-node distance — nodes must not swallow their own arcs. These
 * defaults are calibrated to that scale and are **tunable**: the look is
 * human-reviewed (M5-T5), not pinned by a test.
 */
export const DEFAULT_MIN_NODE_SIZE = 0.25

/** Largest node radius (`intensity === 1`). */
export const DEFAULT_MAX_NODE_SIZE = 0.9

/** Dimmest emissive multiplier (`intensity === 0`) — a node that barely glows. */
export const DEFAULT_MIN_EMISSIVE = 0.15

/** Brightest emissive multiplier (`intensity === 1`) — the "hot" end. */
export const DEFAULT_MAX_EMISSIVE = 1

/** Thinnest arc radius (`intensity === 0`), in scene units. */
export const DEFAULT_MIN_ARC_WIDTH = 0.015

/** Thickest arc radius (`intensity === 1`) — a heavily-used channel. */
export const DEFAULT_MAX_ARC_WIDTH = 0.12

/**
 * The normalized value every element gets when its channel has **no spread**
 * (all agents equally active / all links equally heavy). The midpoint is the
 * neutral reading: neither the smallest nor the largest, just "no relative
 * signal here". Avoids the `0 / 0` of a min-max scale over a single value.
 */
export const NEUTRAL_INTENSITY = 0.5

// ── Public shapes ───────────────────────────────────────────────────────────

/**
 * An agent's raw activity, broken down so a test (or a detail panel) can read
 * the numbers behind a node's size/glow. `total` is what the visuals key off.
 */
export interface NodeActivity {
  agentId: AgentId
  /** Messages this agent sent (its fan-out volume). */
  messagesSent: number
  /** Messages it received, broadcasts counted per recipient. */
  messagesReceived: number
  /** Tool calls derived from its action-bearing messages. */
  toolCalls: number
  /** `messagesSent + messagesReceived + toolCalls` — the activity scalar. */
  total: number
}

/** How one agent node should read. */
export interface NodeAttribute {
  agentId: AgentId
  /** The facts behind the mapping. */
  activity: NodeActivity
  /** Normalized activity in `[0, 1]`; the neutral midpoint when there is no spread. */
  intensity: number
  /** Node radius in scene units, lerped from `intensity` across the size range. */
  size: number
  /** Emissive multiplier, lerped from `intensity` across the emissive range. */
  emissive: number
}

/** How one communication arc should read. */
export interface LinkAttribute {
  /** Canonically-first endpoint (mirrors {@link deriveLayoutLinks}). */
  source: AgentId
  /** The other endpoint. */
  target: AgentId
  /** Messages exchanged between the pair — the layout link's weight. */
  volume: number
  /** Normalized volume in `[0, 1]`; the neutral midpoint when there is no spread. */
  intensity: number
  /** Arc radius in scene units, lerped from `intensity` across the width range. */
  width: number
}

/** A numeric `[min, max]` span a channel was normalized over. */
export interface AttributeRange {
  min: number
  max: number
}

/** The complete attribute mapping for one run. */
export interface TraceAttributes {
  /** Node attributes, one per agent, in canonical id order. */
  nodes: NodeAttribute[]
  /** Arc attributes, one per communication link, in canonical order. */
  links: LinkAttribute[]
  /** The activity span the node channels were normalized over (`{0,0}` when empty). */
  activityRange: AttributeRange
  /** The volume span the arc channel was normalized over (`{0,0}` when empty). */
  volumeRange: AttributeRange
}

/** Optional overrides for {@link mapTraceAttributes}. All deterministically defaulted. */
export interface AttributeOptions {
  /** Node radius at `intensity === 0`; default {@link DEFAULT_MIN_NODE_SIZE}. */
  minNodeSize?: number
  /** Node radius at `intensity === 1`; default {@link DEFAULT_MAX_NODE_SIZE}. */
  maxNodeSize?: number
  /** Emissive at `intensity === 0`; default {@link DEFAULT_MIN_EMISSIVE}. */
  minEmissive?: number
  /** Emissive at `intensity === 1`; default {@link DEFAULT_MAX_EMISSIVE}. */
  maxEmissive?: number
  /** Arc radius at `intensity === 0`; default {@link DEFAULT_MIN_ARC_WIDTH}. */
  minArcWidth?: number
  /** Arc radius at `intensity === 1`; default {@link DEFAULT_MAX_ARC_WIDTH}. */
  maxArcWidth?: number
}

// ── Numeric helpers ─────────────────────────────────────────────────────────

/** A finite override, or its deterministic default. */
function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** An output range as `{ lo, hi }`, tolerant of a swapped pair. */
function rangeOf(min: number, max: number): { lo: number; hi: number } {
  return { lo: Math.min(min, max), hi: Math.max(min, max) }
}

/** Linear interpolation `a → b` by `t` (expected in `[0, 1]`). */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Min/max of a non-empty list, or `{0,0}` when empty (so empty runs normalize cleanly). */
function span(values: readonly number[]): AttributeRange {
  if (values.length === 0) return { min: 0, max: 0 }
  let min = values[0]
  let max = values[0]
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  return { min, max }
}

/**
 * Min-max normalize `value` into `[0, 1]` given its channel's span. When the
 * span has no width (a single value, or several equal ones) there is no
 * relative signal, so the neutral midpoint is returned instead of `0 / 0`.
 */
function normalize(value: number, span: AttributeRange): number {
  if (span.max <= span.min) return NEUTRAL_INTENSITY
  return (value - span.min) / (span.max - span.min)
}

// ── The mapping ─────────────────────────────────────────────────────────────

/**
 * Map a normalized {@link TraceModel} to its visual attributes.
 *
 * Node size and emissive derive from each agent's activity
 * (`messagesSent + messagesReceived + toolCalls`); arc width derives from the
 * message volume on each communication link (M2-T1's
 * {@link deriveLayoutLinks}). Both channels are normalized within the run and
 * lerped into their configured output ranges; a channel with no spread yields
 * the neutral midpoint. Pure and deterministic — the same trace yields a
 * byte-identical {@link TraceAttributes} whatever order its arrays arrive in,
 * and the model is never mutated. A degenerate run is well-formed: an empty
 * run yields empty `nodes`/`links` with `{0,0}` ranges.
 *
 * @param model a normalized trace (M1-T5).
 * @param options output-range overrides — all deterministically defaulted.
 */
export function mapTraceAttributes(
  model: TraceModel,
  options: AttributeOptions = {},
): TraceAttributes {
  const sizeRange = rangeOf(
    finite(options.minNodeSize, DEFAULT_MIN_NODE_SIZE),
    finite(options.maxNodeSize, DEFAULT_MAX_NODE_SIZE),
  )
  const emissiveRange = rangeOf(
    finite(options.minEmissive, DEFAULT_MIN_EMISSIVE),
    finite(options.maxEmissive, DEFAULT_MAX_EMISSIVE),
  )
  const widthRange = rangeOf(
    finite(options.minArcWidth, DEFAULT_MIN_ARC_WIDTH),
    finite(options.maxArcWidth, DEFAULT_MAX_ARC_WIDTH),
  )

  // Canonical, id-sorted agent order — independent of the input's array order.
  const agents = [...model.agents].sort((a, b) => compareModelIds(a.id, b.id))

  // Tool calls per agent: counted from the facts (the contract has no
  // precomputed per-agent tool-call field). Message counts are read from the
  // agent's own precomputed fields — that is exactly what they are for.
  const toolCallsByAgent = new Map<AgentId, number>()
  for (const call of model.toolCalls) {
    toolCallsByAgent.set(call.agentId, (toolCallsByAgent.get(call.agentId) ?? 0) + 1)
  }

  const activity: NodeActivity[] = agents.map((agent) => {
    const toolCalls = toolCallsByAgent.get(agent.id) ?? 0
    return {
      agentId: agent.id,
      messagesSent: agent.messagesSent,
      messagesReceived: agent.messagesReceived,
      toolCalls,
      total: agent.messagesSent + agent.messagesReceived + toolCalls,
    }
  })

  const activityRange = span(activity.map((entry) => entry.total))

  const nodes: NodeAttribute[] = activity.map((entry) => {
    const intensity = normalize(entry.total, activityRange)
    return {
      agentId: entry.agentId,
      activity: entry,
      intensity,
      size: lerp(sizeRange.lo, sizeRange.hi, intensity),
      emissive: lerp(emissiveRange.lo, emissiveRange.hi, intensity),
    }
  })

  // The layout's own adjacency (M2-T1): undirected, both directions collapsed,
  // a broadcast reaching every other agent. One arc per link, width by volume.
  const layoutLinks = deriveLayoutLinks(model)
  const volumeRange = span(layoutLinks.map((link) => link.weight))

  const links: LinkAttribute[] = layoutLinks.map((link) => {
    const intensity = normalize(link.weight, volumeRange)
    return {
      source: link.source,
      target: link.target,
      volume: link.weight,
      intensity,
      width: lerp(widthRange.lo, widthRange.hi, intensity),
    }
  })

  return { nodes, links, activityRange, volumeRange }
}

/**
 * The attribute for `agentId`, or `null` when the agent has none (an absent
 * agent). A lookup over the mapped array — mirrors `positionById` (M2-T1) so a
 * consumer can read one node's visuals without building its own index.
 */
export function nodeAttribute(
  attributes: TraceAttributes,
  agentId: AgentId,
): NodeAttribute | null {
  for (const node of attributes.nodes) {
    if (node.agentId === agentId) return node
  }
  return null
}

/**
 * The attribute for the arc between `a` and `b` (either direction), or `null`
 * when the pair never communicated (and therefore has no link).
 */
export function linkAttribute(
  attributes: TraceAttributes,
  a: AgentId,
  b: AgentId,
): LinkAttribute | null {
  for (const link of attributes.links) {
    if (
      (link.source === a && link.target === b) ||
      (link.source === b && link.target === a)
    ) {
      return link
    }
  }
  return null
}
