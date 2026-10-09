/**
 * Force-directed 3D layout over the agent graph (M2-T1).
 *
 * The first half of the M2 "Spatial Layout Engine": a {@link TraceModel} goes
 * in, a deterministic {@link ForceLayout} — one 3D position per agent — comes
 * out. It is the thing that turns a run's *communication graph* into a *shape*
 * you can walk: tightly-coupled agents settle near each other, a fan-out
 * parent spreads its children into a crown, an agent that talks to nobody is
 * pushed out to the rim.
 *
 * It is the pure half of the data layer (PRD §5): no three.js, no DOM, no
 * clock, no `Math.random`. The render layer (M3) is a thin consumer that reads
 * `nodes[].position` and draws a mesh there. **Nothing about the look is
 * asserted in tests** — jsdom has no GPU; the layout is gated as *data*
 * (determinism, structure, invariants), the look is human-reviewed (M5-T5).
 *
 * ## Determinism is the deliverable (PRD §5)
 *
 * The same trace must always produce a byte-identical layout — that is what
 * makes a run reproducible, a shared link meaningful and a re-layout stable.
 * Two mechanisms make that true here:
 *
 * 1. The **initial placement** is drawn from a seeded PRNG
 *    ({@link mulberry32}) keyed by the run's own `seed` (M1-T3 made the seed
 *    part of the contract for exactly this reason), never `Math.random`.
 * 2. Every accumulation is iterated in a **canonical, id-sorted order** and the
 *    derived link list is sorted, so the layout does not depend on the order
 *    the model's arrays happen to arrive in.
 *
 * ## The algorithm
 *
 * A Fruchterman–Reingold-style simulation in 3D, run for a fixed number of
 * iterations so the result is a pure function of the input:
 *
 * - **Repulsion** between every pair of agents, `F = k² / d` (k = ideal edge
 *   length). Nodes never coincide because the force diverges as `d → 0`.
 * - **Attraction** along each communication link, `F = d² / k · weight`, so the
 *   more two agents talk the closer they settle.
 * - **Cooling**: a per-iteration displacement cap that decays linearly to zero,
 *   so late iterations only nudge and the layout settles rather than jitters
 *   (M2-T2 formalizes the settlement rule on top of this).
 *
 * ## Scope
 *
 * The adjacency it lays out is the raw *communication graph* derived from the
 * messages ({@link deriveLayoutLinks}) — an untyped, undirected, weighted
 * graph used purely for positioning. The richer, typed **edge model**
 * (spawn / handoff / message edges) is M2-T4's job and is deliberately not
 * built here. Nothing on the model is mutated, and no coordinates are written
 * back onto it: the contract (§ types) stays coordinate-free.
 */

import type { AgentId } from '../types/index.ts'
import { compareModelIds } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'

// ── Vectors ─────────────────────────────────────────────────────────────────

/** A point or displacement in the 3D scene. Plain numbers — no three.js here. */
export interface Vec3 {
  x: number
  y: number
  z: number
}

/** Euclidean length of a vector. */
function length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
}

/** `a - b` as a fresh vector. */
function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

/** Add `v * scale` to `target` in place (internal accumulator, never a model value). */
function addScaled(target: Vec3, v: Vec3, scale: number): void {
  target.x += v.x * scale
  target.y += v.y * scale
  target.z += v.z * scale
}

// ── Tunables ────────────────────────────────────────────────────────────────

/** Relaxation iterations. Fixed so the layout is a pure function of the input. */
export const DEFAULT_ITERATIONS = 300

/** Ideal edge length (the settled distance between two connected agents). */
export const DEFAULT_IDEAL_DISTANCE = 1

/** Floor on a measured distance, so forces stay finite as nodes approach. */
export const MIN_DISTANCE = 1e-4

// ── Seeded PRNG ─────────────────────────────────────────────────────────────

/**
 * A tiny, deterministic PRNG (mulberry32). Given the same `seed` it yields the
 * exact same float sequence on every call — the substitute for `Math.random`
 * that makes the initial placement reproducible. Seeded from the run's own
 * `seed`, so a run's shape is stable across sessions.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), 1 | t)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Public shapes ───────────────────────────────────────────────────────────

/**
 * One communication link in the graph the layout relaxes: an undirected edge
 * between two agents, weighted by how many messages passed between them. A
 * broadcast (`Message.to === null`) contributes one link from its sender to
 * every other agent, since it is heard by all of them.
 */
export interface LayoutLink {
  /** Alphabetically-first endpoint (canonical, so the list is order-stable). */
  source: AgentId
  /** The other endpoint. */
  target: AgentId
  /** Number of messages exchanged between the pair; always `>= 1`. */
  weight: number
}

/** A settled agent position. */
export interface LayoutNode {
  agentId: AgentId
  position: Vec3
}

/** Axis-aligned extent of the point cloud — what a camera (M3/M4) frames to. */
export interface LayoutBounds {
  min: Vec3
  max: Vec3
  /** Midpoint of `min`/`max`. */
  center: Vec3
  /** Greatest distance from `center` to any node (a framing radius). */
  radius: number
}

/**
 * The layout result: where each agent sits, the graph it was computed over,
 * and enough diagnostics for M2-T2 (settlement) to build on.
 */
export interface ForceLayout {
  /** Agents with their positions, in canonical (id-sorted) order. */
  nodes: LayoutNode[]
  /** The undirected communication graph the relaxation used, sorted. */
  links: LayoutLink[]
  /** The seed the run's shape was pinned to (the model's `seed` by default). */
  seed: number
  /** Relaxation iterations performed (`0` for a trivial 0/1-agent run). */
  iterations: number
  /**
   * Residual force magnitude at the final configuration (`Σ ‖Fᵢ‖`) — the
   * convergence signal M2-T2 reads. Approaching `0` means the layout has
   * settled; it is finite and non-negative.
   */
  energy: number
  /** Extent of the point cloud. */
  bounds: LayoutBounds
}

/** Optional overrides for {@link layoutTrace}. All have deterministic defaults. */
export interface LayoutOptions {
  /** Relaxation iterations; default {@link DEFAULT_ITERATIONS}. */
  iterations?: number
  /** Ideal edge length; default {@link DEFAULT_IDEAL_DISTANCE}. */
  idealDistance?: number
  /** Seed override; default is the model's own `seed`. */
  seed?: number
}

// ── Graph derivation ────────────────────────────────────────────────────────

/** Unordered pair key; endpoints are ordered so the two directions collapse. */
function pairKey(a: AgentId, b: AgentId): string {
  return compareModelIds(a, b) <= 0 ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

const PAIR_SEPARATOR = '\u0000'

/**
 * Derive the undirected, weighted communication graph from a model's messages:
 * one link per communicating pair, its `weight` the number of messages between
 * them (both directions collapse). A broadcast reaches every other agent, so
 * it adds one to each of the sender's links to everybody else. A message an
 * agent sends to itself contributes nothing (a self-link has no direction to
 * lay out). Pure and order-independent: the result is sorted by `(source,
 * target)`, and re-sorting the messages does not change it.
 *
 * This is the *layout's* adjacency only. The typed spawn / handoff / message
 * edge model (M2-T4) is separate and not derived here.
 */
export function deriveLayoutLinks(model: TraceModel): LayoutLink[] {
  const ids = model.agents.map((agent) => agent.id).sort(compareModelIds)
  const weights = new Map<string, number>()

  const link = (a: AgentId, b: AgentId): void => {
    if (a === b) return
    const key = pairKey(a, b)
    weights.set(key, (weights.get(key) ?? 0) + 1)
  }

  for (const message of model.messages) {
    if (message.to !== null) {
      link(message.from, message.to)
    } else {
      for (const id of ids) link(message.from, id)
    }
  }

  const links: LayoutLink[] = []
  for (const [key, weight] of weights) {
    const split = key.indexOf(PAIR_SEPARATOR)
    links.push({
      source: key.slice(0, split),
      target: key.slice(split + PAIR_SEPARATOR.length),
      weight,
    })
  }
  links.sort(
    (a, b) =>
      compareModelIds(a.source, b.source) || compareModelIds(a.target, b.target),
  )
  return links
}

// ── Bounds ──────────────────────────────────────────────────────────────────

/** Axis-aligned bounds (min/max/center/radius) of a point cloud. */
function boundsOf(points: readonly Vec3[]): LayoutBounds {
  if (points.length === 0) {
    const origin: Vec3 = { x: 0, y: 0, z: 0 }
    return { min: { ...origin }, max: { ...origin }, center: { ...origin }, radius: 0 }
  }

  const min: Vec3 = { ...points[0] }
  const max: Vec3 = { ...points[0] }
  for (const point of points) {
    min.x = Math.min(min.x, point.x)
    min.y = Math.min(min.y, point.y)
    min.z = Math.min(min.z, point.z)
    max.x = Math.max(max.x, point.x)
    max.y = Math.max(max.y, point.y)
    max.z = Math.max(max.z, point.z)
  }

  const center: Vec3 = {
    x: (min.x + max.x) / 2,
    y: (min.y + max.y) / 2,
    z: (min.z + max.z) / 2,
  }
  let radius = 0
  for (const point of points) radius = Math.max(radius, length(sub(point, center)))

  return { min, max, center, radius }
}

/** Half-extent of the seeded initial cube; grows with the agent count. */
function initialHalfExtent(count: number): number {
  return Math.max(1, Math.cbrt(count))
}

// ── The layout ──────────────────────────────────────────────────────────────

/**
 * Lay a normalized {@link TraceModel} out in 3D. Pure and deterministic: the
 * same model (same facts, same `seed`) always yields a byte-identical layout,
 * independent of the order the model's arrays arrive in, and the model is
 * neither read from nor written to beyond its facts.
 *
 * @param model a normalized trace (M1-T5). Agents are laid out by id; messages
 *        define the communication graph via {@link deriveLayoutLinks}.
 * @param options iteration count, ideal edge length and seed overrides.
 */
export function layoutTrace(
  model: TraceModel,
  options: LayoutOptions = {},
): ForceLayout {
  const ids = model.agents.map((agent) => agent.id).sort(compareModelIds)
  const count = ids.length
  const seed = options.seed ?? model.seed
  const iterations = Math.max(0, Math.floor(options.iterations ?? DEFAULT_ITERATIONS))
  const idealDistance = Math.max(
    MIN_DISTANCE,
    options.idealDistance ?? DEFAULT_IDEAL_DISTANCE,
  )

  const allLinks = deriveLayoutLinks(model)

  // Degenerate runs: nothing to relax. A single agent sits at the origin.
  if (count === 0) {
    return {
      nodes: [],
      links: [],
      seed,
      iterations: 0,
      energy: 0,
      bounds: boundsOf([]),
    }
  }
  if (count === 1) {
    const origin: Vec3 = { x: 0, y: 0, z: 0 }
    return {
      nodes: [{ agentId: ids[0], position: origin }],
      links: [],
      seed,
      iterations: 0,
      energy: 0,
      bounds: boundsOf([origin]),
    }
  }

  const indexOf = new Map<AgentId, number>()
  ids.forEach((id, index) => indexOf.set(id, index))

  // Only links whose endpoints are real agents take part in the relaxation.
  const edges: { a: number; b: number; weight: number }[] = []
  for (const link of allLinks) {
    const a = indexOf.get(link.source)
    const b = indexOf.get(link.target)
    if (a === undefined || b === undefined || a === b) continue
    edges.push({ a, b, weight: link.weight })
  }

  // Seeded initial placement inside a cube around the origin. Same seed ⇒ same
  // start ⇒ same settled layout.
  const random = mulberry32(seed)
  const half = initialHalfExtent(count)
  const points: Vec3[] = ids.map(() => ({
    x: (random() * 2 - 1) * half,
    y: (random() * 2 - 1) * half,
    z: (random() * 2 - 1) * half,
  }))

  let energy = 0

  for (let iter = 0; iter < iterations; iter += 1) {
    const displacement: Vec3[] = points.map(() => ({ x: 0, y: 0, z: 0 }))

    // Repulsion: every pair pushes apart (F = k² / d).
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const delta = sub(points[i], points[j])
        const d = Math.max(length(delta), MIN_DISTANCE)
        const force = (idealDistance * idealDistance) / d
        const unit: Vec3 = { x: delta.x / d, y: delta.y / d, z: delta.z / d }
        addScaled(displacement[i], unit, force)
        addScaled(displacement[j], unit, -force)
      }
    }

    // Attraction: linked pairs pull together (F = d² / k · weight).
    for (const edge of edges) {
      const delta = sub(points[edge.a], points[edge.b])
      const d = Math.max(length(delta), MIN_DISTANCE)
      const force = ((d * d) / idealDistance) * edge.weight
      const unit: Vec3 = { x: delta.x / d, y: delta.y / d, z: delta.z / d }
      addScaled(displacement[edge.a], unit, -force)
      addScaled(displacement[edge.b], unit, force)
    }

    // Residual force magnitude at this configuration — the convergence signal.
    energy = 0
    for (let i = 0; i < count; i += 1) energy += length(displacement[i])

    // Apply, capped by the cooling temperature (max step per iteration).
    // Decaying linearly to zero, so late iterations only nudge: the layout
    // settles rather than jitters (M2-T2 builds the settlement rule on this).
    const temperature = half * (1 - iter / iterations)
    for (let i = 0; i < count; i += 1) {
      const d = length(displacement[i])
      if (d <= 0) continue
      const step = Math.min(d, temperature) / d
      points[i].x += displacement[i].x * step
      points[i].y += displacement[i].y * step
      points[i].z += displacement[i].z * step
    }
  }

  const nodes: LayoutNode[] = ids.map((id, index) => ({
    agentId: id,
    position: points[index],
  }))

  return {
    nodes,
    links: allLinks.filter(
      (link) =>
        link.source !== link.target &&
        indexOf.has(link.source) &&
        indexOf.has(link.target),
    ),
    seed,
    iterations,
    energy,
    bounds: boundsOf(points),
  }
}

/** The position of `agentId` in a layout, or `null` when the agent is absent. */
export function positionById(layout: ForceLayout, agentId: AgentId): Vec3 | null {
  for (const node of layout.nodes) {
    if (node.agentId === agentId) return node.position
  }
  return null
}
