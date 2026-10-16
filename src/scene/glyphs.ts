/**
 * Tool-call glyph scene plan (M3-T3).
 *
 * The third piece of the M3 "Scene Construction & Rendering" milestone, and —
 * like the node plan (M3-T1) and the arc plan (M3-T2) — the **pure half** of
 * it. The PRD (§5 architectural rule) splits the app into a pure, vitest-gated
 * data layer and a thin render layer: this module is the last data step for the
 * glyph layer and `GlyphLayer.tsx` is the thin consumer that draws it. Nothing
 * here touches three.js, the DOM or the clock, so it is fully unit-testable in
 * jsdom — and, per the rule, **nothing about the look is asserted in tests**
 * (jsdom has no GPU; the look is human-reviewed, M5-T5).
 *
 * ## What it does
 *
 * A run's tool calls become **glyphs**: one small mark orbiting the agent node
 * that made the call. A tool call is the unit of "this agent *did* something" —
 * it is derived by the adapter (M1-T4) from an action-bearing message — so the
 * glyph layer is where the run's *actions* become visible spatially, around the
 * agent that took them.
 *
 * For each tool call this module produces the whole of what the render layer
 * needs and decides none of it: the orbit (centre, radius, angle, rate, plane),
 * the glyph's size and colour, and — the piece the render layer must not own —
 * the **4×4 instance matrix** at any given time, composed by
 * {@link glyphMatrixAt}. Building the matrix here is what keeps
 * `GlyphLayer.tsx` a dumb applier that copies numbers onto the GPU.
 *
 * ## Derived, never decorative
 *
 * Every number here comes from the trace, and none of it is a random draw:
 *
 * - **which node** — the agent that made the call (`ToolCall.agentId`), at its
 *   settled layout position (M2-T1/M2-T2): a glyph can only ever orbit its own
 *   caller;
 * - **orbit radius** — the node's own radius (M2-T3's `size`) plus the glyph's
 *   own size plus a clearance, so a glyph's inner edge always clears the node
 *   surface; several calls on one agent stack into concentric rings
 *   ({@link DEFAULT_GLYPHS_PER_RING});
 * - **orbit rate** — the calling agent's normalized activity (M2-T3's
 *   `intensity`, the same channel the arcs key their pulse rate off): a busier
 *   agent's marks circle faster;
 * - **kind** — the **relationship kind** M2-T4 classifies the call's action as
 *   ({@link classifyAction}): a `spawn` call, a `handoff` call or an ordinary
 *   `message` call. This is why this task depends on M2-T4: the glyph's *size*
 *   encodes the kind, so a coordination act reads differently from chatter;
 * - **colour** — that kind's hue, scaled by the caller's own emissive (M2-T3),
 *   so a hot agent's glyphs read hotter.
 *
 * The only hash-derived values are the **phase** (which angle a ring starts at)
 * and the **tilt** of an agent's orbit plane. Both exist purely to keep two
 * agents' rings from reading as one synchronised disc. They are
 * de-synchronisation, not a claim about the trace — exactly the role a hash
 * plays for the arc pulse's phase (M3-T2).
 *
 * ## One instanced mesh, one draw call (the PRD's geometry budget)
 *
 * *"One instanced mesh for nodes, one batched geometry for arcs, one for
 * glyphs. Every repeated element is instanced; the draw-call ceiling is a
 * gate."* So the batch unit is the **glyph**: every tool call in the run is one
 * instance of a single glyph geometry, drawn in **one** call
 * ({@link GLYPH_LAYER_DRAW_CALLS}, reported as {@link GlyphScenePlan.drawCalls}
 * so M3-T5 can aggregate the ceiling without re-deriving it). A run with a
 * thousand calls costs one more draw call than a run with one. A run with no
 * tool calls costs nothing at all (the layer renders nothing), which is why the
 * count is `0`, not `1`, for such a run.
 *
 * ## Determinism + purity (PRD §5)
 *
 * Pure and deterministic: no three.js, no DOM, no clock, no `Math.random`, no
 * mutation of the model or of the layout/attribute results it reads. Glyphs come
 * out in canonical order (agent id, then call time, then call id) whatever order
 * the model's arrays arrive in, so the same trace yields a byte-identical plan —
 * and the plan owns its own copies of the positions it reads, so a later layout
 * re-use cannot mutate a plan that has already been handed out. No coordinate is
 * authored here: the orbit centre is the settled layout position and the offset
 * is the documented circle-in-a-derived-plane rule, which is what
 * `findHandAuthoredCoordinates` (M2-T5) re-checks over this module. **The clock
 * is a parameter** ({@link glyphOrbitAngle} takes `timeMs`), never read — the
 * render layer owns the tick, exactly as it does for the arc pulse.
 *
 * ## Scope
 *
 * Deliberately NOT here: the lighting / bloom rig and the emissive calibration
 * that makes bright read as "hot" (M3-T4) — the colours and sizes below are
 * tunable placeholders for that pass, not a calibration — the draw-call ceiling
 * itself (M3-T5), and the mounting of a fixture trace into the app (M3-T6).
 * Glyph *shapes* are one geometry for the whole layer: with a single instanced
 * mesh, per-call shape variation would need per-instance geometry, which is a
 * different (and pricier) draw strategy than instancing — the kind is encoded by
 * **size** (the channel that survives additive bloom) and, secondarily, by the
 * per-instance colour.
 */

import type { AgentId, MessageId, ToolCallId } from '../types/index.ts'
import { compareModelIds } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import {
  EDGE_KINDS,
  classifyAction,
  isSettled,
  mapTraceAttributes,
  settleLayout,
} from '../layout/index.ts'
import type {
  AttributeOptions,
  EdgeKind,
  ForceLayout,
  LayoutBounds,
  SettlementOptions,
  TraceAttributes,
  Vec3,
} from '../layout/index.ts'
import { perpendicularOf } from './arcs.ts'
import { ScenePlanError, composeNodeMatrix } from './nodes.ts'
import type { Matrix16, Rgb } from './nodes.ts'

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * The kinds of relationship a glyph can encode — M2-T4's edge kinds, reused
 * rather than re-invented: a tool call's kind *is* the classification of the
 * action that produced it. Order is M2-T4's canonical order.
 */
export const GLYPH_KINDS = EDGE_KINDS

/** One of the {@link GLYPH_KINDS} tags. */
export type GlyphKind = EdgeKind

/**
 * Linear RGB the glyph material is drawn with (the lit surface). The per-glyph
 * *hue* arrives as the instanced colour; this is the neutral the material is
 * configured with. Deliberate but **not calibrated** — the hue and the bloom
 * response are M3-T4's, and the look is human-reviewed (M5-T5).
 */
export const DEFAULT_GLYPH_BASE_COLOR: Rgb = [0.92, 0.96, 1]

/**
 * Uniform emissive strength the glyph material is configured with (`1` = the
 * base colour *is* the emissive reading). Only M3-T4 should move this once the
 * bloom rig exists to justify it.
 */
export const DEFAULT_GLYPH_EMISSIVE_INTENSITY = 1

/**
 * Glyph radius as a fraction of its calling node's radius, so a mark is always
 * proportionate to the node it orbits (a busy agent's node is bigger, so its
 * glyphs are too). Well below `1` on purpose: the glyph must not swallow its own
 * node.
 */
export const DEFAULT_GLYPH_SIZE_RATIO = 0.16

/**
 * Size multiplier per kind: a **spawn** (a coordination act that put another
 * agent to work) reads largest, a **handoff** (the baton passing on) next, and
 * ordinary chatter smallest. Size is the primary channel because it survives
 * additive bloom, where a hue does not.
 */
export const DEFAULT_GLYPH_KIND_SCALE: Readonly<Record<GlyphKind, number>> = {
  spawn: 1.35,
  handoff: 1.15,
  message: 0.85,
}

/**
 * Per-kind hues (linear RGB), multiplied by the caller's own emissive. Working
 * placeholders for M3-T4's calibration.
 */
export const DEFAULT_GLYPH_KIND_COLORS: Readonly<Record<GlyphKind, Rgb>> = {
  spawn: [1, 0.78, 0.4],
  handoff: [0.72, 0.6, 1],
  message: [0.4, 0.92, 1],
}

/**
 * Clearance between a node's surface and the inner edge of its first orbit ring,
 * in the layout's scene units (the layout's ideal edge length is `1`).
 */
export const DEFAULT_GLYPH_ORBIT_GAP = 0.05

/** Radial spacing between an agent's concentric orbit rings, in scene units. */
export const DEFAULT_GLYPH_RING_GAP = 0.1

/**
 * Glyphs per ring before the next ring out is used — so several calls on one
 * agent read as evenly spaced marks around it rather than as one crowded orbit.
 */
export const DEFAULT_GLYPHS_PER_RING = 6

/** Orbit rate (revolutions/second) on the quietest agent. */
export const DEFAULT_MIN_ORBIT_HZ = 0.02

/** Orbit rate (revolutions/second) on the busiest agent. */
export const DEFAULT_MAX_ORBIT_HZ = 0.12

/** Octahedron subdivision level for the glyph geometry (M5-T1 may lower it). */
export const DEFAULT_GLYPH_DETAIL = 0

/**
 * Tilt of an agent's orbit plane away from horizontal, in radians: at least
 * {@link DEFAULT_MIN_TILT} (so no ring lies flat in the scene's own plane and
 * reads as one disc) and at most {@link DEFAULT_MAX_TILT} (so no ring stands
 * vertical and reads as a wall).
 */
export const DEFAULT_MIN_TILT = 0.15

/** Upper bound of the orbit-plane tilt; see {@link DEFAULT_MIN_TILT}. */
export const DEFAULT_MAX_TILT = 0.7

/**
 * Draw calls the glyph layer costs when it has anything to draw: exactly one,
 * for the single `InstancedMesh` every glyph is an instance of. Exported so the
 * draw-call gate (M3-T5) can account for the layer without re-deriving it.
 */
export const GLYPH_LAYER_DRAW_CALLS = 1

/** Two pi, as a constant (the ring's angle step). */
const TAU = Math.PI * 2

// ── Public shapes ───────────────────────────────────────────────────────────

/** The geometry/material scalars the render layer applies to the glyph mesh. */
export interface GlyphSceneStyle {
  /** Base linear RGB of the glyph surface (see {@link DEFAULT_GLYPH_BASE_COLOR}). */
  baseColor: Rgb
  /** Uniform emissive strength (see {@link DEFAULT_GLYPH_EMISSIVE_INTENSITY}). */
  emissiveIntensity: number
  /** Glyph radius as a fraction of the calling node's radius. */
  sizeRatio: number
  /** Size multiplier per relationship kind. */
  kindScale: Record<GlyphKind, number>
  /** Hue per relationship kind, scaled by the caller's emissive. */
  kindColors: Record<GlyphKind, Rgb>
  /** Clearance between the node surface and the first ring, in scene units. */
  orbitGap: number
  /** Radial spacing between rings, in scene units. */
  ringGap: number
  /** Glyphs per ring before the next ring out is used. */
  perRing: number
  /** Orbit rate on the quietest agent, revolutions/second. */
  minOrbitHz: number
  /** Orbit rate on the busiest agent, revolutions/second. */
  maxOrbitHz: number
  /** Octahedron subdivision level. */
  detail: number
  /** Lower bound of the orbit-plane tilt, radians. */
  minTilt: number
  /** Upper bound of the orbit-plane tilt, radians. */
  maxTilt: number
}

/**
 * How one glyph moves: the angle it sits at when time is `0` and the rate it
 * turns at. Both are derived — the phase from a stable hash of the agent (so
 * two agents' rings are not synchronised), the rate from the agent's normalized
 * activity (M2-T3).
 */
export interface GlyphOrbit {
  /** Angle at `timeMs === 0`, radians. */
  angle: number
  /** Angular rate, radians/second. */
  angularSpeed: number
}

/**
 * One tool-call glyph, ready to be an instance of the glyph `InstancedMesh`:
 * the call it marks, the node it orbits, the circle it travels, its derived
 * size and colour, and the orbit-plane basis its offset is measured in.
 */
export interface GlyphInstance {
  /** The tool call this glyph marks. */
  toolCallId: ToolCallId
  /** The message the call was derived from, or `null` if standalone. */
  messageId: MessageId | null
  /** The agent that made the call — the node this glyph orbits. */
  agentId: AgentId
  /** The call's tool / action name, as recorded (`ToolCall.name`). */
  name: string
  /** The relationship kind of the call's action, per M2-T4. */
  kind: GlyphKind
  /** The calling node's settled position (copied) — the orbit centre. */
  center: Vec3
  /** Distance from the centre to the glyph, in scene units. */
  orbitRadius: number
  /** Ring index, `0` being the innermost. */
  ring: number
  /** Position within its ring, `0 … perRing - 1`. */
  slot: number
  /** The orbit: start angle and angular rate. */
  orbit: GlyphOrbit
  /**
   * First orbit-plane basis vector (unit, ⟂ {@link normal}) — the offset at
   * angle `0`.
   */
  basisU: Vec3
  /** Second orbit-plane basis vector (unit, ⟂ `basisU` and {@link normal}). */
  basisV: Vec3
  /** Orbit-plane unit normal — the ring's tilt. */
  normal: Vec3
  /** Glyph radius in scene units. */
  size: number
  /** Linear RGB the glyph is drawn with (kind hue × the caller's emissive). */
  color: Rgb
}

/**
 * The complete glyph-layer plan for one run: the layout + attributes it was
 * composed from, the style to draw with, and one {@link GlyphInstance} per tool
 * call. This is the whole input the render layer needs — nothing visual is
 * decided downstream.
 */
export interface GlyphScenePlan {
  /** The settled layout the positions came from. */
  layout: ForceLayout
  /** The attribute mapping the node radii/emissives came from. */
  attributes: TraceAttributes
  /** The geometry/material scalars to draw with. */
  style: GlyphSceneStyle
  /** One glyph per tool call, in canonical order. */
  glyphs: GlyphInstance[]
  /** `glyphs.length` — the InstancedMesh count. */
  count: number
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
 * Optional overrides for {@link buildGlyphScenePlan}. All deterministically
 * defaulted.
 */
export interface GlyphSceneOptions {
  /** Passed through to the settlement pass (M2-T2) when no layout is given. */
  settlement?: SettlementOptions
  /** Passed through to the attribute mapper (M2-T3) when no map is given. */
  attributes?: AttributeOptions
  /** Style overrides; each field independently defaults (see the `DEFAULT_*`). */
  style?: GlyphSceneStyleOverrides
  /**
   * A layout to reuse instead of settling again — the same shape the node layer
   * drew, so glyphs orbit exactly the nodes on screen and the relaxation is paid
   * for once per scene rather than once per layer.
   */
  layout?: ForceLayout
  /** An attribute map to reuse instead of re-mapping (see `layout`). */
  attributeMap?: TraceAttributes
}

/**
 * Style overrides for {@link buildGlyphScenePlan}: every field optional, and the
 * two per-kind tables partial — a caller may retune one kind's scale or hue
 * without restating the others. Each supplied value is sanitized (see
 * {@link resolveStyle}); each omitted one falls back to its default.
 */
export interface GlyphSceneStyleOverrides extends Omit<
  Partial<GlyphSceneStyle>,
  'kindScale' | 'kindColors'
> {
  /** Per-kind size multipliers; unspecified kinds keep their default. */
  kindScale?: Partial<Record<GlyphKind, number>>
  /** Per-kind hues; unspecified kinds keep their default. */
  kindColors?: Partial<Record<GlyphKind, Rgb>>
}

// ── Vector helpers (plain numbers — no three.js here) ───────────────────────

/** `a + b` as a fresh vector. */
function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

/** `a × b`. */
function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

/** `v * scale` as a fresh vector. */
function scaled(v: Vec3, factor: number): Vec3 {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor }
}

/** Linear interpolation `a → b` by `t`. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// ── Stable hashing (the same derivation the adapter and arc layer use) ──────

/** Deterministic 32-bit FNV-1a hash — never a source of randomness. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** A stable value in `[0, 1)` derived from a string — a phase, never a roll. */
function hashUnit(value: string): number {
  return fnv1a(value) / 4294967296
}

// ── Style resolution ────────────────────────────────────────────────────────

/** A finite, non-negative override, or its deterministic default. */
function component(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback
}

/** A finite, strictly-positive override, or its deterministic default. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

/** A linear RGB triple, each component sanitized back to its default. */
function color(value: Rgb | undefined, fallback: Rgb): Rgb {
  return [
    component(value?.[0], fallback[0]),
    component(value?.[1], fallback[1]),
    component(value?.[2], fallback[2]),
  ]
}

/** A per-kind table, each entry sanitized (scale `> 0`, colour per component). */
function perKind<T>(
  overrides: Partial<Record<GlyphKind, T>> | undefined,
  defaults: Readonly<Record<GlyphKind, T>>,
  sanitize: (value: T | undefined, fallback: T) => T,
): Record<GlyphKind, T> {
  const table = {} as Record<GlyphKind, T>
  for (const kind of GLYPH_KINDS)
    table[kind] = sanitize(overrides?.[kind], defaults[kind])
  return table
}

/**
 * Resolve the style, defaulting every field deterministically and sanitizing a
 * caller's overrides: a non-finite or negative number falls back, the ring
 * capacity is floored to at least one glyph, an orbit range is tolerated
 * swapped (`min ≤ max` always holds), and every per-kind scale stays strictly
 * positive so no glyph can vanish. Fresh tuples/objects are returned each call
 * (no shared mutable state).
 */
function resolveStyle(
  overrides: GlyphSceneStyleOverrides | undefined,
): GlyphSceneStyle {
  const minOrbitHz = component(overrides?.minOrbitHz, DEFAULT_MIN_ORBIT_HZ)
  const maxOrbitHz = component(overrides?.maxOrbitHz, DEFAULT_MAX_ORBIT_HZ)
  const minTilt = Math.abs(component(overrides?.minTilt, DEFAULT_MIN_TILT))
  const maxTilt = Math.abs(component(overrides?.maxTilt, DEFAULT_MAX_TILT))
  return {
    baseColor: color(overrides?.baseColor, DEFAULT_GLYPH_BASE_COLOR),
    emissiveIntensity: component(
      overrides?.emissiveIntensity,
      DEFAULT_GLYPH_EMISSIVE_INTENSITY,
    ),
    sizeRatio: positive(overrides?.sizeRatio, DEFAULT_GLYPH_SIZE_RATIO),
    kindScale: perKind(overrides?.kindScale, DEFAULT_GLYPH_KIND_SCALE, positive),
    kindColors: perKind(overrides?.kindColors, DEFAULT_GLYPH_KIND_COLORS, color),
    orbitGap: component(overrides?.orbitGap, DEFAULT_GLYPH_ORBIT_GAP),
    ringGap: component(overrides?.ringGap, DEFAULT_GLYPH_RING_GAP),
    perRing: Math.max(
      1,
      Math.floor(positive(overrides?.perRing, DEFAULT_GLYPHS_PER_RING)),
    ),
    minOrbitHz: Math.min(minOrbitHz, maxOrbitHz),
    maxOrbitHz: Math.max(minOrbitHz, maxOrbitHz),
    detail: Math.max(0, Math.floor(component(overrides?.detail, DEFAULT_GLYPH_DETAIL))),
    // The tilt window is ordered so the min can never exceed the max, and is
    // capped below a right angle so a ring can never stand vertical.
    minTilt: Math.min(minTilt, maxTilt),
    maxTilt: Math.min(Math.max(minTilt, maxTilt), Math.PI / 2),
  }
}

// ── Orbit geometry ──────────────────────────────────────────────────────────

/** An orbit plane's orthonormal frame. */
interface OrbitFrame {
  normal: Vec3
  basisU: Vec3
  basisV: Vec3
}

/**
 * The orbit plane of one agent's rings, derived deterministically from the
 * agent's id: a unit normal tilted between the style's two tilt bounds, then the
 * plane's own basis taken from it. **This is de-synchronisation, not a claim** —
 * two agents' rings are tilted differently only so that several agents' glyphs
 * do not read as a single synchronised disc (the same role a hash plays for the
 * arc pulse's phase, M3-T2). Perpendicularity is reused from the arc layer
 * ({@link perpendicularOf}, M3-T2) rather than re-derived, so the two layers
 * cannot disagree about what "perpendicular" means.
 */
function orbitPlane(
  agentId: AgentId,
  style: Pick<GlyphSceneStyle, 'minTilt' | 'maxTilt'>,
): OrbitFrame {
  const polar = lerp(style.minTilt, style.maxTilt, hashUnit(`${agentId}:tilt`))
  const azimuth = hashUnit(`${agentId}:spin`) * TAU
  const sinPolar = Math.sin(polar)
  const normal: Vec3 = {
    x: sinPolar * Math.cos(azimuth),
    y: Math.cos(polar),
    z: sinPolar * Math.sin(azimuth),
  }
  const basisU = perpendicularOf(normal)
  return { normal, basisU, basisV: cross(normal, basisU) }
}

// ── The animation rule ──────────────────────────────────────────────────────

/**
 * Where a glyph sits on its circle at `timeMs`, as an angle in radians. **This
 * is the reference implementation of the orbit rule** — the render layer rotates
 * the instanced glyphs by calling it (through {@link glyphMatrixAt}), so there
 * is exactly one definition of the motion.
 *
 * Pure: the clock is a *parameter*, never read — the render layer owns the clock
 * (`useFrame`) exactly as the PRD's split requires.
 */
export function glyphOrbitAngle(orbit: GlyphOrbit, timeMs: number): number {
  return orbit.angle + (timeMs / 1000) * orbit.angularSpeed
}

/**
 * The glyph's position at `timeMs`: its orbit centre plus the circle of radius
 * {@link GlyphInstance.orbitRadius} in the plane spanned by `basisU`/`basisV`.
 * The ring is a circle in a derived plane — nothing here is authored.
 */
export function glyphPositionAt(
  glyph: Pick<GlyphInstance, 'center' | 'orbitRadius' | 'basisU' | 'basisV' | 'orbit'>,
  timeMs: number,
): Vec3 {
  const theta = glyphOrbitAngle(glyph.orbit, timeMs)
  const offset = add(
    scaled(glyph.basisU, Math.cos(theta) * glyph.orbitRadius),
    scaled(glyph.basisV, Math.sin(theta) * glyph.orbitRadius),
  )
  return add(glyph.center, offset)
}

/**
 * The glyph's finished instance transform at `timeMs`: translate to its orbit
 * position, scale uniformly by its radius. Composed with the node layer's own
 * transform builder (M3-T1's `composeNodeMatrix`) rather than a second copy, so
 * a glyph's matrix can never drift from a node's convention — column-major, the
 * element order three.js `Matrix4.elements` and `Matrix4.fromArray` use.
 */
export function glyphMatrixAt(
  glyph: Pick<
    GlyphInstance,
    'center' | 'orbitRadius' | 'basisU' | 'basisV' | 'orbit' | 'size'
  >,
  timeMs: number,
): Matrix16 {
  return composeNodeMatrix(glyphPositionAt(glyph, timeMs), glyph.size)
}

/**
 * Write every glyph's instance matrix at `timeMs` into a flat column-major
 * buffer (`16` numbers per glyph, in plan order) — the form an `InstancedMesh`
 * uploads directly. Returns the number of matrices written, which is the plan's
 * count unless the target is too small (a typed array silently drops
 * out-of-range writes, so the bound is applied here instead).
 *
 * The buffer is an **output**: mutating it is the point. Nothing else is
 * mutated, and the same `(glyphs, timeMs)` always writes the same bytes.
 */
export function writeGlyphMatrices(
  glyphs: readonly Pick<
    GlyphInstance,
    'center' | 'orbitRadius' | 'basisU' | 'basisV' | 'orbit' | 'size'
  >[],
  timeMs: number,
  target: Float32Array,
  offset = 0,
): number {
  const capacity = Math.floor((target.length - offset) / 16)
  const count = Math.min(glyphs.length, Math.max(0, capacity))
  for (let index = 0; index < count; index += 1) {
    const matrix = glyphMatrixAt(glyphs[index], timeMs)
    const base = offset + index * 16
    for (let element = 0; element < 16; element += 1) {
      target[base + element] = matrix[element]
    }
  }
  return count
}

// ── The plan ────────────────────────────────────────────────────────────────

/**
 * Build the glyph-layer scene plan for a normalized {@link TraceModel}: settle
 * the layout (or reuse one), map the visual attributes (or reuse them), and
 * place one glyph per tool call on a derived orbit around the agent that made
 * the call.
 *
 * Pure and deterministic — the same model yields a byte-identical plan whatever
 * order its arrays arrive in, and neither the model nor the intermediate
 * layout/attribute results are mutated (the glyphs copy the positions and radii
 * they need). A degenerate run is well-formed: a run with no tool calls yields
 * no glyphs and `drawCalls: 0`.
 *
 * @param model a normalized trace (M1-T5).
 * @param options settlement / attribute / style overrides, plus an optional
 *        already-computed `layout` / `attributeMap` to reuse — the shapes a
 *        sibling layer drew, so the glyphs orbit the nodes on screen exactly.
 * @throws ScenePlanError when the layout has no position for an agent a glyph
 *         orbits — impossible for a coherent model, so it fails loudly rather
 *         than silently dropping a glyph.
 */
export function buildGlyphScenePlan(
  model: TraceModel,
  options: GlyphSceneOptions = {},
): GlyphScenePlan {
  const style = resolveStyle(options.style)

  // Reuse a supplied layout/attribute map when there is one (the relaxation and
  // the mapping are the caller's to pay for once), otherwise derive them.
  let layout: ForceLayout
  let converged: boolean
  if (options.layout !== undefined) {
    layout = options.layout
    converged = isSettled(layout, options.settlement?.energyTolerance)
  } else {
    const settled = settleLayout(model, options.settlement)
    layout = settled.layout
    converged = settled.converged
  }
  const attributes =
    options.attributeMap ?? mapTraceAttributes(model, options.attributes)

  // Positions by agent: the layout is the sole owner of "where".
  const positionById = new Map<AgentId, Vec3>()
  for (const node of layout.nodes) positionById.set(node.agentId, node.position)

  // The node's own mapped visuals: its radius sizes the orbit, its emissive
  // scales the glyph hue.
  const nodeByAgent = new Map<
    AgentId,
    { size: number; emissive: number; intensity: number }
  >()
  for (const node of attributes.nodes) {
    nodeByAgent.set(node.agentId, {
      size: node.size,
      emissive: node.emissive,
      intensity: node.intensity,
    })
  }

  // Canonical order: by calling agent, then call time, then call id — a total
  // order, so the plan is byte-identical whatever order the model's arrays
  // arrive in. Grouping by agent makes the ring/slot assignment below obvious.
  const calls = [...model.toolCalls].sort(
    (a, b) =>
      compareModelIds(a.agentId, b.agentId) ||
      a.at - b.at ||
      compareModelIds(a.id, b.id),
  )

  const seenByAgent = new Map<AgentId, number>()
  const glyphs: GlyphInstance[] = calls.map((call) => {
    const agentId = call.agentId
    const position = positionById.get(agentId)
    const node = nodeByAgent.get(agentId)
    if (position === undefined || node === undefined) {
      throw new ScenePlanError(`no layout position for agent ${agentId}`)
    }

    const kind = classifyAction(call.name)
    const size = node.size * style.sizeRatio * style.kindScale[kind]

    // Where this call sits within its agent's own list of calls: the ring index
    // (how many rings out) and the slot (its evenly spaced place on that ring).
    const indexWithinAgent = seenByAgent.get(agentId) ?? 0
    seenByAgent.set(agentId, indexWithinAgent + 1)
    const ring = Math.floor(indexWithinAgent / style.perRing)
    const slot = indexWithinAgent % style.perRing

    const frame = orbitPlane(agentId, style)
    const phase = hashUnit(`${agentId}:phase`) * TAU
    const angle = phase + (slot / style.perRing) * TAU

    // Clearance: the glyph's inner edge (radius minus its own half-width) sits
    // `orbitGap` clear of the node's surface, and each further ring steps out by
    // `ringGap`. Derived entirely from the node's mapped size.
    const orbitRadius = node.size + style.orbitGap + size / 2 + ring * style.ringGap

    const kindColor = style.kindColors[kind]
    const color: Rgb = [
      kindColor[0] * node.emissive,
      kindColor[1] * node.emissive,
      kindColor[2] * node.emissive,
    ]

    return {
      toolCallId: call.id,
      messageId: call.messageId,
      agentId,
      name: call.name,
      kind,
      // Copy the position: the plan owns its own numbers, so a later layout
      // re-use can never mutate a glyph that has already been handed out.
      center: { x: position.x, y: position.y, z: position.z },
      orbitRadius,
      ring,
      slot,
      orbit: {
        angle,
        // Rate from the caller's normalized activity (M2-T3) — the same channel
        // the arc pulse keys off, so "busier" means faster everywhere.
        angularSpeed: lerp(style.minOrbitHz, style.maxOrbitHz, node.intensity) * TAU,
      },
      basisU: frame.basisU,
      basisV: frame.basisV,
      normal: frame.normal,
      size,
      color,
    }
  })

  return {
    layout,
    attributes,
    style,
    glyphs,
    count: glyphs.length,
    // An empty layer draws nothing, so it costs nothing.
    drawCalls: glyphs.length === 0 ? 0 : GLYPH_LAYER_DRAW_CALLS,
    bounds: layout.bounds,
    seed: layout.seed,
    converged,
    iterations: layout.iterations,
  }
}

/**
 * The glyph for `toolCallId`, or `null` when the run has no such call. Mirrors
 * `nodeInstance` (M3-T1) and `arcInstanceFor` (M3-T2) so a consumer can read one
 * glyph without building its own index.
 */
export function glyphInstance(
  plan: GlyphScenePlan,
  toolCallId: ToolCallId,
): GlyphInstance | null {
  for (const glyph of plan.glyphs) {
    if (glyph.toolCallId === toolCallId) return glyph
  }
  return null
}

/**
 * Every glyph orbiting `agentId`, in plan (canonical) order — what a detail
 * panel (M4-T4) lists for a clicked node, and what the invariant checks read one
 * agent at a time.
 */
export function glyphsForAgent(
  plan: GlyphScenePlan,
  agentId: AgentId,
): GlyphInstance[] {
  return plan.glyphs.filter((glyph) => glyph.agentId === agentId)
}
