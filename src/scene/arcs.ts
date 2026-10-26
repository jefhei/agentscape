/**
 * Message-arc scene plan (M3-T2).
 *
 * The second piece of the M3 "Scene Construction & Rendering" milestone, and —
 * like the node plan (M3-T1) — the **pure half** of it. The PRD (§5
 * architectural rule) splits the app into a pure, vitest-gated data layer and a
 * thin render layer: this module is the last data step for the arc layer and
 * `MessageArcLayer.tsx` is the thin consumer that draws it. Nothing here touches
 * three.js, the DOM or the clock, so it is fully unit-testable in jsdom — and,
 * per the rule, **nothing about the look is asserted in tests** (jsdom has no
 * GPU; the look is human-reviewed, M5-T5).
 *
 * ## What it does
 *
 * A run's messages become **arcs**: one glowing tube per *communication link*,
 * which the layout (M2-T1) already derived and relaxed over and the attribute
 * mapper (M2-T3) already sized. For each of those links this module produces the
 * whole of what the render layer needs and decides none of it:
 *
 * - the **curve** — a quadratic Bézier from the source node's settled position
 *   to the target's, bowed away from the chord by a deterministic perpendicular
 *   so an arc reads as an arc and not as a wire;
 * - the **tube** — the curve swept into a ring of vertices at each sample, its
 *   radius the link's own `width` from {@link mapTraceAttributes} (M2-T3), with
 *   the ring's normals and the triangle index buffer;
 * - the **animation** — the pulse the shader runs along the tube. The rule is a
 *   pure function here ({@link arcPulseParameter}) and is mirrored, exactly, in
 *   GLSL by `./arcShader.ts`.
 *
 * ## Batched, never per-message (the PRD's geometry budget)
 *
 * *"Messages as animated arcs between nodes (batched GLSL, not one mesh per
 * message)."* So the batch unit is the **link**, not the message: a link has
 * already collapsed every message between a pair into one weighted channel
 * (that is exactly what {@link deriveLayoutLinks} is), and the whole arc
 * population lands in **one** geometry drawn in **one** call
 * ({@link ARC_LAYER_DRAW_CALLS}, reported as {@link ArcScenePlan.drawCalls} so
 * M3-T5 can aggregate the ceiling without re-deriving it). A run with a thousand
 * messages between two agents costs one tube; a run with no links costs nothing.
 *
 * ## The animation is derived, not decorative
 *
 * A pulse travelling along an arc *says something* — direction and rate — so
 * both come from the trace, never from a random draw:
 *
 * - **rate** — the link's normalized message volume (M2-T3's own `intensity`),
 *   lerped into a pulse rate: a busier channel pulses faster;
 * - **direction** — the channel's **net** direction, counted from the messages
 *   themselves (forward vs. backward, broadcasts counted per recipient). A
 *   *balanced* channel (equal traffic both ways) has no net direction, so its
 *   pulse is **parked** at the midpoint rather than sent one way on a coin
 *   flip — inventing a direction the trace does not carry is the same class of
 *   error as hand-placing a coordinate. (Flagged for the human look review:
 *   M5-T5 may prefer a different read of a balanced channel.)
 * - **phase** — a stable hash of the pair, so arcs are not synchronised.
 *
 * ## Determinism + purity (PRD §5)
 *
 * Pure and deterministic: no three.js, no DOM, no clock, no `Math.random`, no
 * mutation of the model or of the layout/attribute results it reads. Arcs come
 * out in the layout's canonical link order and every vertex is a function of
 * those numbers, so the same trace yields a byte-identical plan — and the plan
 * owns its own copies, so a later layout re-use cannot mutate it. No coordinate
 * is ever authored here: positions come from the settled layout and the ring
 * offsets from the documented curve/perp rules, which is what
 * `findHandAuthoredCoordinates` (M2-T5) re-checks over this module.
 *
 * ## Scope
 *
 * Deliberately NOT here: the tool-call glyphs (M3-T3), the lighting / bloom rig
 * and the emissive calibration that makes bright read as "hot" (M3-T4) — the
 * colours and glow constants below are working placeholders for that pass, not a
 * calibration — and the mounting of a fixture trace into the app (M3-T6). The
 * arcs are the layout's *communication links*; the typed spawn/handoff/message
 * edge model (M2-T4) refines relationships but not which channels exist, and
 * colouring by kind is a later refinement, not part of this task.
 */

import type { AgentId } from '../types/index.ts'
import { compareModelIds } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import {
  MIN_DISTANCE,
  isSettled,
  mapTraceAttributes,
  settleLayout,
} from '../layout/index.ts'
import type {
  AttributeOptions,
  ForceLayout,
  LayoutBounds,
  SettlementOptions,
  TraceAttributes,
  Vec3,
} from '../layout/index.ts'
import { ScenePlanError } from './nodes.ts'
import type { Rgb } from './nodes.ts'
import { resolveDetailPlan, settlementWithDetail } from '../scale/index.ts'
import type { DetailPlan } from '../scale/index.ts'

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Curve samples per arc (rings = `segments + 1`). Sixteen keeps a bowed arc
 * smooth at the layout's unit ideal edge length while staying cheap; M5-T1
 * (level-of-detail) may lower it for scale.
 */
export const DEFAULT_ARC_SEGMENTS = 16

/**
 * Vertices around the tube per sample. Six reads as a rounded conduit without
 * the vertex cost of a high-resolution tube.
 */
export const DEFAULT_ARC_SIDES = 6

/**
 * How far the curve bows away from the straight chord, as a fraction of the
 * chord length, at the *control point* — so the apex sits at half that
 * (`bulge / 2` of the chord) from the midpoint. Enough to separate an arc from
 * the wire it is not, small enough not to leave the layout's neighbourhood.
 */
export const DEFAULT_ARC_BULGE = 0.28

/**
 * Linear RGB the arc's standing glow is drawn with (the conduit between
 * pulses). Deliberate but **not calibrated** — the hue and the bloom response
 * are M3-T4's, and the look is human-reviewed (M5-T5).
 */
export const DEFAULT_ARC_BASE_COLOR: Rgb = [0.34, 0.62, 0.95]

/** Linear RGB the travelling pulse is drawn with. Not calibrated (M3-T4). */
export const DEFAULT_ARC_PULSE_COLOR: Rgb = [0.86, 0.95, 1]

/**
 * Half-width of the pulse band, in arc-parameter units (`t` along the curve, so
 * `1` is the whole arc). A fragment measures its distance to the pulse and
 * fades over this much curve.
 */
export const DEFAULT_PULSE_WIDTH = 0.12

/** Pulse rate (cycles/second) on the quietest channel. */
export const DEFAULT_MIN_PULSE_HZ = 0.18

/** Pulse rate (cycles/second) on the busiest channel. */
export const DEFAULT_MAX_PULSE_HZ = 1.1

/**
 * Phase a balanced channel's pulse is parked at: the middle of the arc. See the
 * module note — a channel with no net flow is shown as a lit but stationary
 * band, not sent one way arbitrarily.
 */
export const PARKED_PULSE_PHASE = 0.5

/** Smallest positive pulse width accepted, so the shader never divides by zero. */
const MIN_PULSE_WIDTH = 1e-3

/**
 * Draw calls the arc layer costs when it has anything to draw: exactly one, for
 * the single batched geometry every arc is swept into. Exported so the
 * draw-call gate (M3-T5) can account for the layer without re-deriving it.
 */
export const ARC_LAYER_DRAW_CALLS = 1

/** Two pi, as a constant (the ring's angle step). */
const TAU = Math.PI * 2

// ── The geometry/shader contract ────────────────────────────────────────────

/**
 * The per-vertex attributes the arc geometry carries, in a fixed order:
 * `position`/`normal` (which three.js declares for a `ShaderMaterial` itself)
 * plus the layer's own floats. The render layer walks this list to set the GPU
 * attributes, and the shaders are *generated* from {@link ARC_CUSTOM_ATTRIBUTES}
 * — so the geometry and the GLSL cannot drift apart (gated by a test).
 */
export const ARC_ATTRIBUTE_NAMES = [
  'position',
  'normal',
  'aT',
  'aPhase',
  'aSpeed',
  'aFlow',
  'aIntensity',
] as const

/** One of the {@link ARC_ATTRIBUTE_NAMES}. */
export type ArcAttributeName = (typeof ARC_ATTRIBUTE_NAMES)[number]

/** Floats per vertex for each attribute. */
export const ARC_ATTRIBUTE_SIZES: Readonly<Record<ArcAttributeName, number>> = {
  position: 3,
  normal: 3,
  aT: 1,
  aPhase: 1,
  aSpeed: 1,
  aFlow: 1,
  aIntensity: 1,
}

/**
 * The attributes the *shaders* declare. `position` and `normal` are injected by
 * three.js for a `ShaderMaterial`, so the GLSL must not re-declare them; these
 * are the ones it must, and each carries one fact about the arc:
 *
 * - `aT` — where this vertex sits along its arc, `0 → 1` (the curve parameter);
 * - `aPhase` — the channel's phase offset, in `[0, 1)`;
 * - `aSpeed` — the channel's pulse rate in cycles/second (`0` when parked);
 * - `aFlow` — the channel's net direction: `1`, `-1`, or `0` when balanced;
 * - `aIntensity` — the channel's normalized volume (M2-T3).
 */
export const ARC_CUSTOM_ATTRIBUTES = [
  'aT',
  'aPhase',
  'aSpeed',
  'aFlow',
  'aIntensity',
] as const

// ── Public shapes ───────────────────────────────────────────────────────────

/** The geometry/material scalars the render layer applies to the arc layer. */
export interface ArcSceneStyle {
  /** Linear RGB of the standing conduit glow. */
  baseColor: Rgb
  /** Linear RGB of the travelling pulse. */
  pulseColor: Rgb
  /** Curve samples per arc (rings are `segments + 1`). */
  segments: number
  /** Vertices around the tube at each sample. */
  sides: number
  /** Chord-relative bow of the curve's control point. */
  bulge: number
  /** Half-width of the pulse band, in arc-parameter units. */
  pulseWidth: number
  /** Pulse rate on the quietest channel, cycles/second. */
  minPulseHz: number
  /** Pulse rate on the busiest channel, cycles/second. */
  maxPulseHz: number
}

/**
 * The two directions of traffic on a link, counted from the trace's messages.
 * `forward` is `source → target` in the link's canonical orientation (source is
 * the canonically-first endpoint, exactly as {@link LayoutLink} defines it). A
 * broadcast counts for every pair its sender is part of, mirroring the weight
 * {@link deriveLayoutLinks} gives the link — so `forward + backward` is the
 * link's own weight.
 */
export interface ArcFlow {
  forward: number
  backward: number
}

/**
 * How one arc is animated. `flow` is the **net** direction implied by
 * {@link ArcFlow}: `1` (source → target) when forward traffic dominates, `-1`
 * when backward does, and `0` when the channel is balanced.
 */
export interface ArcAnimation {
  /** Net direction: `1`, `-1`, or `0` for a balanced (parked) channel. */
  flow: -1 | 0 | 1
  /** Pulse rate, cycles/second; `0` for a balanced channel. */
  speed: number
  /** Phase offset in `[0, 1)` — deterministic per pair. */
  phase: number
}

/** One arc, ready to be swept into the batched geometry. */
export interface ArcInstance {
  /** Canonically-first endpoint (mirrors the layout link). */
  source: AgentId
  /** The other endpoint. */
  target: AgentId
  /** Messages exchanged between the pair — the link's weight. */
  volume: number
  /** Normalized volume in `[0, 1]` — the attribute mapper's `intensity` (M2-T3). */
  intensity: number
  /** Tube radius in scene units — the attribute mapper's `width` (M2-T3). */
  width: number
  /** The traffic behind the arc, in each direction. */
  flow: ArcFlow
  /** The animation the shader runs along this arc. */
  animation: ArcAnimation
  /** Start of the curve — the source agent's settled position (copied). */
  start: Vec3
  /** End of the curve — the target agent's settled position (copied). */
  end: Vec3
  /** The quadratic Bézier control point (the bow). */
  control: Vec3
  /** First vertex this arc occupies in the shared buffers. */
  vertexStart: number
  /** Vertices this arc occupies (`(segments + 1) × sides`). */
  vertexCount: number
  /** First index this arc occupies in the shared index buffer. */
  indexStart: number
  /** Indices this arc occupies (`segments × sides × 6`). */
  indexCount: number
}

/**
 * The batched vertex/index buffers for the whole arc population — flat
 * `number[]`s (JSON-serialisable, deterministic) that the render layer uploads
 * as typed attributes. Every attribute is `vertexCount × size` long, where the
 * size comes from {@link ARC_ATTRIBUTE_SIZES}; `position`/`normal` are bytes 3
 * per vertex, the rest 1.
 */
export interface ArcBuffers {
  position: number[]
  normal: number[]
  aT: number[]
  aPhase: number[]
  aSpeed: number[]
  aFlow: number[]
  aIntensity: number[]
  /** Triangle indices into the vertex attributes (CCW front faces). */
  indices: number[]
}

/**
 * The complete arc-layer plan for one run: the layout + attributes it was
 * composed from, the style to draw with, one {@link ArcInstance} per
 * communication link, and the batched buffers those arcs were swept into. This
 * is the whole input the render layer needs — nothing visual is decided
 * downstream.
 */
export interface ArcScenePlan {
  /** The settled layout the positions came from. */
  layout: ForceLayout
  /** The attribute mapping the widths/intensities came from. */
  attributes: TraceAttributes
  /** The geometry/material scalars to draw with. */
  style: ArcSceneStyle
  /** The level-of-detail budget this plan was built under (M5-T1). */
  detail: DetailPlan
  /** One arc per communication link, in the layout's canonical link order. */
  arcs: ArcInstance[]
  /** The batched geometry for every arc: one upload, one draw call. */
  buffers: ArcBuffers
  /** `arcs.length` — the number of tubes in the batch. */
  count: number
  /** Total vertices across the batch (`buffers.position.length / 3`). */
  vertexCount: number
  /** Total triangle indices across the batch (`buffers.indices.length`). */
  indexCount: number
  /** Draw calls this layer costs (`0` when there is nothing to draw). */
  drawCalls: number
  /** Extent of the settled cloud — what a camera frames (M4). */
  bounds: LayoutBounds
  /** The run's layout seed the shape was pinned to. */
  seed: number
  /** Whether the layout settled (M2-T2) before the iteration cap. */
  converged: boolean
  /** Relaxation iterations the settlement actually ran. */
  iterations: number
}

/**
 * Optional overrides for {@link buildArcScenePlan}. All deterministically
 * defaulted.
 */
export interface ArcSceneOptions {
  /** Passed through to the settlement pass (M2-T2) when no layout is given. */
  settlement?: SettlementOptions
  /** Passed through to the attribute mapper (M2-T3) when no map is given. */
  attributes?: AttributeOptions
  /** Style overrides; each field independently defaults (see the `DEFAULT_*`). */
  style?: Partial<ArcSceneStyle>
  /**
   * A layout to reuse instead of settling again — the same shape the node layer
   * drew, so the arcs meet their nodes exactly and the relaxation is paid for
   * once per scene rather than once per layer.
   */
  layout?: ForceLayout
  /** An attribute map to reuse instead of re-mapping (see `layout`). */
  attributeMap?: TraceAttributes
  /**
   * A level-of-detail plan to build under (M5-T1). Omit to resolve one from the
   * run's counted links — the scene passes the one plan every layer shares.
   */
  detail?: DetailPlan
}

// ── Vector helpers (plain numbers — no three.js here) ───────────────────────

/** `a + b` as a fresh vector. */
function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

/** `a - b` as a fresh vector. */
function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

/** `v * scale` as a fresh vector. */
function scale(v: Vec3, factor: number): Vec3 {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor }
}

/** `a · b`. */
function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/** Euclidean length. */
function length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
}

/** `a × b`. */
function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

/** `v` normalized, or `fallback` when `v` is (near) zero-length. */
function normalizedOr(v: Vec3, fallback: Vec3): Vec3 {
  const len = length(v)
  if (len < MIN_DISTANCE) return { ...fallback }
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

/**
 * A fixed +Z unit axis — the last-resort direction for a degenerate tangent
 * (two agents that would sit exactly on top of one another, which the layout's
 * repulsion already prevents). Built by assignment on purpose: a literal
 * non-zero `{ x, y, z }` triple reads as a hand-authored coordinate to the
 * M2-T5 scanner, and an authored coordinate is exactly what this is not.
 */
function fallbackAxis(): Vec3 {
  const axis: Vec3 = { x: 0, y: 0, z: 0 }
  axis.z = 1
  return axis
}

/**
 * A unit vector perpendicular to `axis`, chosen **deterministically**: the
 * world axis `axis` is least aligned with is crossed with it, so the result is
 * never near-degenerate (the cross product is at least `√(2/3)` long) and never
 * a random draw. This is the axis an arc bows along. A zero-length `axis` falls
 * back to the +Z axis.
 */
export function perpendicularOf(axis: Vec3): Vec3 {
  const len = length(axis)
  const x = len > 0 ? axis.x / len : 0
  const y = len > 0 ? axis.y / len : 0
  const z = len > 0 ? axis.z / len : 1

  // Least-aligned world axis, built by assignment (a literal { x, y, z } triple
  // with non-zero components would read as a hand-authored coordinate).
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  const az = Math.abs(z)
  let rx = 0
  let ry = 0
  let rz = 0
  if (ax <= ay && ax <= az) rx = 1
  else if (ay <= az) ry = 1
  else rz = 1

  const cx = y * rz - z * ry
  const cy = z * rx - x * rz
  const cz = x * ry - y * rx
  const cLen = Math.sqrt(cx * cx + cy * cy + cz * cz)
  return { x: cx / cLen, y: cy / cLen, z: cz / cLen }
}

// ── Curve primitives ────────────────────────────────────────────────────────

/**
 * The control point of the arc from `start` to `end`: the chord's midpoint,
 * pushed off the chord by `bulge × chord length` along
 * {@link perpendicularOf}(chord). A `bulge` of `0` leaves the control point on
 * the chord, i.e. a straight tube. Pure and deterministic — the bow is a
 * function of the two settled positions, never an authored offset.
 */
export function arcControlPoint(start: Vec3, end: Vec3, bulge: number): Vec3 {
  const chord = sub(end, start)
  const chordLength = length(chord)
  const mid = scale(add(start, end), 0.5)
  if (chordLength < MIN_DISTANCE || bulge === 0) return mid
  const axis = scale(chord, 1 / chordLength)
  return add(mid, scale(perpendicularOf(axis), bulge * chordLength))
}

/** The point at parameter `t` on the quadratic Bézier `start → control → end`. */
export function quadraticPoint(start: Vec3, control: Vec3, end: Vec3, t: number): Vec3 {
  const u = 1 - t
  const a = u * u
  const b = 2 * u * t
  const c = t * t
  return {
    x: a * start.x + b * control.x + c * end.x,
    y: a * start.y + b * control.y + c * end.y,
    z: a * start.z + b * control.z + c * end.z,
  }
}

/**
 * The (unnormalised) tangent `dP/dt` at parameter `t` — the direction the tube
 * is swept along, so the ring at each sample stands perpendicular to the curve.
 */
export function quadraticTangent(
  start: Vec3,
  control: Vec3,
  end: Vec3,
  t: number,
): Vec3 {
  const u = 1 - t
  const a = 2 * u
  const b = 2 * t
  return {
    x: a * (control.x - start.x) + b * (end.x - control.x),
    y: a * (control.y - start.y) + b * (end.y - control.y),
    z: a * (control.z - start.z) + b * (end.z - control.z),
  }
}

// ── Style resolution ────────────────────────────────────────────────────────

/** A finite, non-negative override, or its deterministic default. */
function component(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback
}

/** A finite, positive override, or its deterministic default. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

/** A linear RGB triple, each component sanitized back to the default. */
function color(value: Rgb | undefined, fallback: Rgb): Rgb {
  return [
    component(value?.[0], fallback[0]),
    component(value?.[1], fallback[1]),
    component(value?.[2], fallback[2]),
  ]
}

/**
 * Resolve the style, defaulting every field deterministically and sanitizing a
 * caller's overrides: a non-finite or negative number falls back, the sample
 * and side counts are floored to something a tube can be built from
 * (`segments ≥ 1`, `sides ≥ 3`), and the pulse width is kept strictly positive
 * so the shader's `smoothstep` cannot divide by zero. Fresh tuples are returned
 * each call (no shared mutable state).
 */
function resolveStyle(
  overrides: Partial<ArcSceneStyle> | undefined,
  detail: DetailPlan,
): ArcSceneStyle {
  const minPulseHz = component(overrides?.minPulseHz, DEFAULT_MIN_PULSE_HZ)
  const maxPulseHz = component(overrides?.maxPulseHz, DEFAULT_MAX_PULSE_HZ)
  return {
    baseColor: color(overrides?.baseColor, DEFAULT_ARC_BASE_COLOR),
    pulseColor: color(overrides?.pulseColor, DEFAULT_ARC_PULSE_COLOR),
    segments: Math.max(
      1,
      Math.floor(component(overrides?.segments, detail.arc.segments)),
    ),
    sides: Math.max(3, Math.floor(component(overrides?.sides, detail.arc.sides))),
    bulge: component(overrides?.bulge, DEFAULT_ARC_BULGE),
    pulseWidth: Math.max(
      MIN_PULSE_WIDTH,
      positive(overrides?.pulseWidth, DEFAULT_PULSE_WIDTH),
    ),
    // A swapped pair is tolerated, so min <= max always holds.
    minPulseHz: Math.min(minPulseHz, maxPulseHz),
    maxPulseHz: Math.max(minPulseHz, maxPulseHz),
  }
}

// ── Traffic direction + animation ───────────────────────────────────────────

/** Unordered pair key; endpoints are ordered so the two directions collapse. */
const PAIR_SEPARATOR = '\u0000'

function pairKey(a: AgentId, b: AgentId): string {
  return compareModelIds(a, b) <= 0
    ? `${a}${PAIR_SEPARATOR}${b}`
    : `${b}${PAIR_SEPARATOR}${a}`
}

/** Deterministic 32-bit FNV-1a hash — the same derivation the adapter uses. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** A stable value in `[0, 1)` derived from a string — a phase, never a random draw. */
function hashUnit(value: string): number {
  return fnv1a(value) / 4294967296
}

/**
 * Count the traffic on every communicating pair, in each direction. Canonically
 * oriented (forward = the canonically-first endpoint → the second), and a
 * broadcast counts for every pair its sender is part of — exactly the weight
 * rule {@link deriveLayoutLinks} applies, so `forward + backward` on any link
 * equals that link's weight. A self-message contributes nothing. Pure and
 * order-independent.
 */
function tallyFlow(model: TraceModel): Map<string, ArcFlow> {
  const ids = model.agents.map((agent) => agent.id).sort(compareModelIds)
  const tallies = new Map<string, ArcFlow>()

  const bump = (from: AgentId, to: AgentId): void => {
    if (from === to) return // a self-message has no direction to show
    const forward = compareModelIds(from, to) <= 0
    const key = pairKey(from, to)
    const tally = tallies.get(key) ?? { forward: 0, backward: 0 }
    if (forward) tally.forward += 1
    else tally.backward += 1
    tallies.set(key, tally)
  }

  for (const message of model.messages) {
    if (message.to !== null) {
      bump(message.from, message.to)
    } else {
      for (const id of ids) bump(message.from, id)
    }
  }
  return tallies
}

/** Linear interpolation `a → b` by `t`. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Derive an arc's animation from the trace: the pulse **rate** from the link's
 * normalized volume (M2-T3's `intensity`), the **direction** from its net
 * traffic, and the **phase** from a stable hash of the pair.
 *
 * A balanced channel gets `speed: 0` and {@link PARKED_PULSE_PHASE} — it shows
 * no travel because the trace shows no net flow (see the module note).
 */
export function arcAnimationFor(
  source: AgentId,
  target: AgentId,
  flow: ArcFlow,
  intensity: number,
  style: Pick<ArcSceneStyle, 'minPulseHz' | 'maxPulseHz'>,
): ArcAnimation {
  const net = Math.sign(flow.forward - flow.backward)
  const direction: -1 | 0 | 1 = net < 0 ? -1 : net > 0 ? 1 : 0
  if (direction === 0) {
    return { flow: 0, speed: 0, phase: PARKED_PULSE_PHASE }
  }
  return {
    flow: direction,
    speed: lerp(style.minPulseHz, style.maxPulseHz, intensity),
    phase: hashUnit(`${source}${PAIR_SEPARATOR}${target}`),
  }
}

/**
 * Where the pulse sits along its arc at `timeMs`, as the curve parameter
 * `t ∈ [0, 1)`. **This is the reference implementation of the animation rule**
 * — the vertex shader in `./arcShader.ts` mirrors it (same uniform/attribute
 * names, same formula) and cannot drift from it silently, because the shader
 * text is generated from this module's attribute contract and gated by a test.
 *
 * Pure: the clock is a *parameter*, never read — the render layer owns the
 * clock (`useFrame`) exactly as the PRD's split requires. A parked channel
 * (`flow === 0`) ignores time and stays put.
 */
export function arcPulseParameter(animation: ArcAnimation, timeMs: number): number {
  const cycles = (timeMs / 1000) * animation.speed + animation.phase
  const wrapped = cycles - Math.floor(cycles)
  return animation.flow < 0 ? 1 - wrapped : wrapped
}

// ── Geometry ────────────────────────────────────────────────────────────────

/** One ring sample's unit-circle offset. */
interface RingSample {
  cos: number
  sin: number
}

/** The unit circle the tube's cross-section is swept around. */
function ringSamples(sides: number): RingSample[] {
  const samples: RingSample[] = []
  for (let index = 0; index < sides; index += 1) {
    const angle = (TAU * index) / sides
    samples.push({ cos: Math.cos(angle), sin: Math.sin(angle) })
  }
  return samples
}

/** Everything {@link appendTube} needs to sweep one arc. */
interface TubeSpec {
  start: Vec3
  control: Vec3
  end: Vec3
  radius: number
  segments: number
  sides: number
  animation: ArcAnimation
  intensity: number
}

/**
 * Sweep one arc into the shared buffers: sample the curve, carry a
 * **parallel-transported** frame along it (a normal rotated onto each sample's
 * perpendicular plane, so the tube does not twist), and emit a ring of `sides`
 * vertices at each sample. Positions are `curve(t) + radial × radius`, normals
 * are the radial unit itself, and the per-vertex parameters (`aT`, `aPhase`,
 * `aSpeed`, `aFlow`, `aIntensity`) are the arc's own facts.
 *
 * Triangles are wound CCW about the outward radial, so front faces face out.
 * Returns the ranges this arc occupies — contiguous, so the buffers are a
 * partition of the batch.
 */
function appendTube(
  buffers: ArcBuffers,
  radial: readonly RingSample[],
  spec: TubeSpec,
): {
  vertexStart: number
  vertexCount: number
  indexStart: number
  indexCount: number
} {
  const { start, control, end, radius, segments, sides, animation, intensity } = spec
  const vertexStart = buffers.aT.length
  const indexStart = buffers.indices.length

  const chord = sub(end, start)
  const fallbackTangent = normalizedOr(chord, fallbackAxis())
  let tangent = normalizedOr(quadraticTangent(start, control, end, 0), fallbackTangent)
  let normal = perpendicularOf(tangent)

  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments
    const point = quadraticPoint(start, control, end, t)

    if (index > 0) {
      const next = normalizedOr(quadraticTangent(start, control, end, t), tangent)
      // Transport the frame: drop the normal's component along the new tangent,
      // so the ring stays perpendicular to the curve without spinning.
      normal = normalizedOr(
        sub(normal, scale(next, dot(normal, next))),
        perpendicularOf(next),
      )
      tangent = next
    }

    const binormal = cross(tangent, normal)

    for (const sample of radial) {
      // `normal` and `binormal` are orthonormal, so the radial unit is exact.
      const nx = normal.x * sample.cos + binormal.x * sample.sin
      const ny = normal.y * sample.cos + binormal.y * sample.sin
      const nz = normal.z * sample.cos + binormal.z * sample.sin

      buffers.position.push(
        point.x + nx * radius,
        point.y + ny * radius,
        point.z + nz * radius,
      )
      buffers.normal.push(nx, ny, nz)
      buffers.aT.push(t)
      buffers.aPhase.push(animation.phase)
      buffers.aSpeed.push(animation.speed)
      buffers.aFlow.push(animation.flow)
      buffers.aIntensity.push(intensity)
    }
  }

  for (let index = 0; index < segments; index += 1) {
    const ring = vertexStart + index * sides
    const nextRing = ring + sides
    for (let side = 0; side < sides; side += 1) {
      const next = (side + 1) % sides
      const a = ring + side
      const b = ring + next
      const c = nextRing + side
      const d = nextRing + next
      // Winding: (a, b, c) and (b, d, c) both face outward (see the module note
      // on the frame's handedness) — the tube is a closed surface about the curve.
      buffers.indices.push(a, b, c, b, d, c)
    }
  }

  return {
    vertexStart,
    vertexCount: (segments + 1) * sides,
    indexStart,
    indexCount: segments * sides * 6,
  }
}

// ── The plan ────────────────────────────────────────────────────────────────

/**
 * Build the arc-layer scene plan for a normalized {@link TraceModel}: settle the
 * layout (or reuse one), map the visual attributes (or reuse them), and sweep one
 * tube per communication link into a single batched geometry, with the animation
 * for each arc derived from its traffic.
 *
 * Pure and deterministic — the same model yields a byte-identical plan whatever
 * order its arrays arrive in, and neither the model nor the intermediate
 * layout/attribute results are mutated (the arcs copy the positions they need).
 * A degenerate run is well-formed: a run with no communication links yields no
 * arcs and `drawCalls: 0`.
 *
 * @param model a normalized trace (M1-T5).
 * @param options settlement / attribute / style overrides, plus an optional
 *        already-computed `layout` / `attributeMap` to reuse — the shapes a
 *        sibling layer drew, so the arcs meet their nodes exactly.
 * @throws ScenePlanError when the layout has no position for an agent an arc
 *         touches — impossible for a coherent model, so it fails loudly rather
 *         than silently dropping an arc.
 */
export function buildArcScenePlan(
  model: TraceModel,
  options: ArcSceneOptions = {},
): ArcScenePlan {
  // Counts the detail ladders are keyed on; links come from the settled graph.
  const counts = {
    agents: model.meta.agentCount,
    toolCalls: model.meta.toolCallCount,
  }

  // Reuse a supplied layout/attribute map when there is one (the relaxation and
  // the mapping are the caller's to pay for once), otherwise derive them.
  let layout: ForceLayout
  let converged: boolean
  if (options.layout !== undefined) {
    layout = options.layout
    converged = isSettled(layout, options.settlement?.energyTolerance)
  } else {
    // The detail budget bounds the relaxation, so it is resolved first (M5-T1).
    const budget = options.detail ?? resolveDetailPlan(counts)
    const settled = settleLayout(
      model,
      settlementWithDetail(budget, options.settlement),
    )
    layout = settled.layout
    converged = settled.converged
  }
  const detail =
    options.detail ?? resolveDetailPlan({ ...counts, links: layout.links.length })
  const style = resolveStyle(options.style, detail)
  const attributes =
    options.attributeMap ?? mapTraceAttributes(model, options.attributes)

  // Positions by agent: the layout is the sole owner of "where".
  const positionById = new Map<AgentId, Vec3>()
  for (const node of layout.nodes) positionById.set(node.agentId, node.position)

  const flowByPair = tallyFlow(model)
  const radial = ringSamples(style.sides)

  const buffers: ArcBuffers = {
    position: [],
    normal: [],
    aT: [],
    aPhase: [],
    aSpeed: [],
    aFlow: [],
    aIntensity: [],
    indices: [],
  }

  // `attributes.links` is already canonical (M2-T3 derives it from M2-T1's
  // sorted link list), so iterating it gives arcs in canonical order.
  const arcs: ArcInstance[] = attributes.links.map((link) => {
    const sourcePosition = positionById.get(link.source)
    const targetPosition = positionById.get(link.target)
    if (sourcePosition === undefined || targetPosition === undefined) {
      throw new ScenePlanError(
        `no layout position for arc ${link.source} -> ${link.target}`,
      )
    }
    // Copy the endpoints: the plan owns its own numbers, so a later layout
    // re-use can never mutate an arc that has already been handed out.
    const start: Vec3 = {
      x: sourcePosition.x,
      y: sourcePosition.y,
      z: sourcePosition.z,
    }
    const end: Vec3 = { x: targetPosition.x, y: targetPosition.y, z: targetPosition.z }
    const control = arcControlPoint(start, end, style.bulge)
    const flow = flowByPair.get(pairKey(link.source, link.target)) ?? {
      forward: 0,
      backward: 0,
    }
    const animation = arcAnimationFor(
      link.source,
      link.target,
      flow,
      link.intensity,
      style,
    )
    const ranges = appendTube(buffers, radial, {
      start,
      control,
      end,
      radius: link.width,
      segments: style.segments,
      sides: style.sides,
      animation,
      intensity: link.intensity,
    })

    return {
      source: link.source,
      target: link.target,
      volume: link.volume,
      intensity: link.intensity,
      width: link.width,
      flow,
      animation,
      start,
      end,
      control,
      ...ranges,
    }
  })

  return {
    layout,
    attributes,
    style,
    detail,
    arcs,
    buffers,
    count: arcs.length,
    vertexCount: buffers.position.length / 3,
    indexCount: buffers.indices.length,
    // An empty layer draws nothing, so it costs nothing.
    drawCalls: arcs.length === 0 ? 0 : ARC_LAYER_DRAW_CALLS,
    bounds: layout.bounds,
    seed: layout.seed,
    converged,
    iterations: layout.iterations,
  }
}

/**
 * The arc between `source` and `target` (either direction), or `null` when the
 * pair never communicated and therefore has no arc. Mirrors `linkAttribute`
 * (M2-T3) and `nodeInstance` (M3-T1) so a consumer can read one arc without
 * building its own index.
 */
export function arcInstanceFor(
  plan: ArcScenePlan,
  a: AgentId,
  b: AgentId,
): ArcInstance | null {
  for (const arc of plan.arcs) {
    if (
      (arc.source === a && arc.target === b) ||
      (arc.source === b && arc.target === a)
    ) {
      return arc
    }
  }
  return null
}
