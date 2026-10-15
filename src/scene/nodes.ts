/**
 * Agent-node scene plan (M3-T1).
 *
 * The first piece of the M3 "Scene Construction & Rendering" milestone, and the
 * *pure half* of it. The PRD (§5 architectural rule) splits the app into a pure,
 * vitest-gated data layer and a thin render layer: this module is the last data
 * step for the node layer, and `AgentNodeLayer.tsx` is the thin consumer that
 * draws it. Nothing here touches three.js, the DOM or the clock, so it is fully
 * unit-testable in jsdom — and, per the rule, **nothing about the look is
 * asserted in tests** (jsdom has no GPU; the look is human-reviewed, M5-T5).
 *
 * ## What it does
 *
 * It answers the one question the node mesh needs: *for this agent, where is it,
 * how big is it, and how hot does it glow?* — by composing the two M2 passes
 * that already know those answers:
 *
 * - **where** — {@link settleLayout} (M2-T1 + M2-T2), the deterministic seeded
 *   force layout, run to convergence so the shape is stable;
 * - **how big / how hot** — {@link mapTraceAttributes} (M2-T3), which maps an
 *   agent's activity to a node size and an emissive multiplier.
 *
 * Those two are joined by `agentId` into one {@link NodeInstance} per agent:
 * the settled position, the radius, the normalized intensity, the per-instance
 * glow colour, and — the piece the render layer must not own — the **4×4
 * instance matrix** (translation × uniform scale) as a plain 16-number tuple.
 * Building the matrix here, in the pure layer, is what keeps
 * `AgentNodeLayer.tsx` a dumb applier: it copies numbers into the InstancedMesh
 * and decides nothing.
 *
 * ## One InstancedMesh, one draw call
 *
 * The PRD's geometry budget is explicit: *"one instanced mesh for nodes, one
 * batched geometry for arcs, one for glyphs. Every repeated element is
 * instanced; the draw-call ceiling is a gate."* So the plan is shaped around
 * that: **all** agent nodes are one {@link NodeInstance} array destined for a
 * single `InstancedMesh`, and {@link NodeScenePlan.drawCalls} reports that
 * layer's cost. A run with no agents costs no draw call at all (the layer
 * renders nothing), which is why the count is `0`, not `1`, for an empty run.
 * M3-T5 aggregates these per-layer costs into the enforced ceiling.
 *
 * ## Determinism + purity (PRD §5)
 *
 * Pure and deterministic: no three.js, no DOM, no clock, no `Math.random`, no
 * mutation of the model or of the layout/attribute results it reads. Instances
 * come out in **canonical (id-sorted) order** whatever order the model's arrays
 * arrive in, so the same trace yields a byte-identical plan — the property the
 * M2 determinism gate (and the "same trace renders the same shape" requirement)
 * rests on. Positions and sizes are never authored here: every number is either
 * read from the layout/attributes or derived from them by the documented
 * mapping below.
 *
 * ## Scope
 *
 * Deliberately NOT here: the arcs (M3-T2), the tool-call glyphs (M3-T3), the
 * lighting / bloom rig and the final emissive calibration that makes bright read
 * as "hot, not blown out" (M3-T4) — the base colour + emissive intensity below
 * are tunable placeholders for that pass, not a calibration — and the mounting
 * of a fixture trace into the app (M3-T6). This task is the node instancing
 * plan and the mesh that draws it.
 */

import type { AgentId } from '../types/index.ts'
import type { TraceModel } from '../model/index.ts'
import { mapTraceAttributes, settleLayout } from '../layout/index.ts'
import type {
  AttributeOptions,
  ForceLayout,
  LayoutBounds,
  SettlementOptions,
  TraceAttributes,
  Vec3,
} from '../layout/index.ts'

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Base linear RGB the per-instance glow multiplies. A cool, near-white blue —
 * deliberate but **not calibrated**: picking the hue and the bloom response so
 * that bright reads as "hot" is M3-T4's job (`environment and lighting rig with
 * bloom-honest emissive calibration`), and the look itself is human-reviewed
 * (M5-T5). Values are in linear RGB and may exceed `1` for bloom headroom.
 */
export const DEFAULT_BASE_COLOR: Rgb = [0.62, 0.82, 1]

/**
 * Uniform emissive strength the material is configured with. `1` means the base
 * colour *is* the emissive reading; only M3-T4 should move this once the bloom
 * rig exists to justify it. The per-node variation comes from the per-instance
 * glow colour, not from this scalar.
 */
export const DEFAULT_EMISSIVE_INTENSITY = 1

/**
 * Sphere geometry width/height segments. Low enough to stay cheap for thousands
 * of instances, high enough that a lone node does not read as a faceted blob;
 * M5-T1 (level-of-detail) may lower it for scale.
 */
export const DEFAULT_SEGMENTS = 24

/**
 * Draw calls the node layer costs when it has anything to draw: exactly one, for
 * the single `InstancedMesh` every agent node is an instance of. Exported so the
 * draw-call gate (M3-T5) can account for the layer without re-deriving it.
 */
export const NODE_LAYER_DRAW_CALLS = 1

// ── Public shapes ───────────────────────────────────────────────────────────

/** A linear RGB colour as a `[r, g, b]` tuple (plain numbers — no three.js). */
export type Rgb = [number, number, number]

/**
 * A column-major 4×4 transform, in the same element order three.js
 * (`Matrix4.elements`) and WebGL use, so the render layer can copy it straight
 * into an `InstancedMesh` with `Matrix4.fromArray` and no conversion. The last
 * row is `(translation, 1)`; the leading 3×3 block is the scale.
 */
export type Matrix16 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]

/** The geometry/material scalars the render layer applies to the node mesh. */
export interface NodeSceneStyle {
  /** Base linear RGB the per-instance glow multiplies. */
  baseColor: Rgb
  /** Uniform emissive strength (see {@link DEFAULT_EMISSIVE_INTENSITY}). */
  emissiveIntensity: number
  /** Sphere geometry width/height segments. */
  segments: number
}

/**
 * One agent node, ready to be an instance of the node `InstancedMesh`: its
 * settled position, its derived visuals and its finished instance matrix.
 */
export interface NodeInstance {
  /** The agent this instance draws. */
  agentId: AgentId
  /** Settled position from the layout (M2-T1/M2-T2). */
  position: Vec3
  /** Node radius in scene units — the attribute mapper's `size` (M2-T3). */
  radius: number
  /** Normalized activity in `[0, 1]` — the attribute mapper's `intensity`. */
  intensity: number
  /** Emissive multiplier — the attribute mapper's `emissive` (M2-T3). */
  emissive: number
  /**
   * Per-instance glow colour: the style's base colour scaled by `emissive`, so
   * a busier node is brighter (toward the base hue) and a quiet one dimmer.
   * This is the only per-instance channel a standard material exposes, which is
   * why the glow gradient rides on colour; M3-T4 owns the final calibration.
   */
  color: Rgb
  /** Column-major transform (translation × uniform scale) for the InstancedMesh. */
  matrix: Matrix16
}

/**
 * The complete node-layer plan for one run: the layout + attributes it was
 * composed from, the style to draw with, and one instance per agent. This is
 * the whole input the render layer needs — nothing visual is decided downstream.
 */
export interface NodeScenePlan {
  /** The settled layout the positions came from. */
  layout: ForceLayout
  /** The attribute mapping the sizes/emissives came from. */
  attributes: TraceAttributes
  /** The geometry/material scalars to draw with. */
  style: NodeSceneStyle
  /** One instance per agent, in canonical (id-sorted) order. */
  instances: NodeInstance[]
  /** `instances.length` — the InstancedMesh count. */
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

/** Optional overrides for {@link buildNodeScenePlan}. All deterministically defaulted. */
export interface NodeSceneOptions {
  /** Passed through to the settlement pass (M2-T2). */
  settlement?: SettlementOptions
  /** Passed through to the attribute mapper (M2-T3). */
  attributes?: AttributeOptions
  /** Style overrides; each field independently defaults (see the `DEFAULT_*` above). */
  style?: Partial<NodeSceneStyle>
}

/**
 * Thrown when a scene plan cannot be built coherently — the layout and the
 * attributes disagree about the agent set (M3-T1), or an element the plan needs
 * to draw (a node, an arc) references an agent the layout never placed. Shared
 * by the whole scene layer so a caller can branch on one type.
 */
export class ScenePlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScenePlanError'
  }
}

// ── Style resolution ────────────────────────────────────────────────────────

/** A finite, non-negative override, or its deterministic default. */
function component(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback
}

/**
 * Resolve the style, defaulting each field deterministically and sanitizing a
 * caller-supplied base colour: a non-finite or negative component falls back to
 * the default, so a bad override can never put `NaN` into an instance matrix's
 * sibling colour. A fresh tuple is returned each call (no shared mutable state).
 */
function resolveStyle(overrides: Partial<NodeSceneStyle> | undefined): NodeSceneStyle {
  const provided = overrides?.baseColor
  const baseColor: Rgb = [
    component(provided?.[0], DEFAULT_BASE_COLOR[0]),
    component(provided?.[1], DEFAULT_BASE_COLOR[1]),
    component(provided?.[2], DEFAULT_BASE_COLOR[2]),
  ]
  return {
    baseColor,
    emissiveIntensity: component(
      overrides?.emissiveIntensity,
      DEFAULT_EMISSIVE_INTENSITY,
    ),
    segments: Math.max(3, Math.floor(component(overrides?.segments, DEFAULT_SEGMENTS))),
  }
}

// ── Instance transform ──────────────────────────────────────────────────────

/**
 * Compose an agent node's instance transform: **translate to `position`, scale
 * uniformly by `radius`** — the matrix for a unit-radius sphere geometry
 * (`sphereGeometry args={[1, …]}`) drawn at that position and size. Column-major
 * element order, matching three.js `Matrix4.elements`, so the render layer can
 * hand the tuple straight to `Matrix4.fromArray`.
 *
 * Pure: it only reads its arguments and returns a fresh tuple.
 */
export function composeNodeMatrix(position: Vec3, radius: number): Matrix16 {
  const s = radius
  return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, position.x, position.y, position.z, 1]
}

// ── The plan ────────────────────────────────────────────────────────────────

/**
 * Build the node-layer scene plan for a normalized {@link TraceModel}: settle
 * the layout, map the visual attributes, and join them into one
 * {@link NodeInstance} per agent (canonical id order) with a finished instance
 * matrix.
 *
 * Pure and deterministic — the same model yields a byte-identical plan whatever
 * order its arrays arrive in, and neither the model nor the intermediate
 * layout/attribute results are mutated (positions are copied into the
 * instances). A degenerate run is well-formed: an empty run yields zero
 * instances and `drawCalls: 0`; a single-agent run yields one instance at the
 * origin.
 *
 * @param model a normalized trace (M1-T5).
 * @param options settlement / attribute / style overrides — all deterministically
 *        defaulted.
 * @throws ScenePlanError when the settled layout has no position for an agent
 *         the attribute mapper produced — impossible for a coherent model, so
 *         it fails loudly rather than silently dropping a node.
 */
export function buildNodeScenePlan(
  model: TraceModel,
  options: NodeSceneOptions = {},
): NodeScenePlan {
  const style = resolveStyle(options.style)
  const { layout, converged, iterations } = settleLayout(model, options.settlement)
  const attributes = mapTraceAttributes(model, options.attributes)

  // Positions by agent: the layout is the sole owner of "where".
  const positionById = new Map<AgentId, Vec3>()
  for (const node of layout.nodes) positionById.set(node.agentId, node.position)

  // `attributes.nodes` is already canonical (id-sorted) — M2-T3 guarantees it —
  // so iterating it gives instances in canonical order without a second sort.
  const instances: NodeInstance[] = attributes.nodes.map((node) => {
    const position = positionById.get(node.agentId)
    if (position === undefined) {
      throw new ScenePlanError(`no layout position for agent ${node.agentId}`)
    }
    // Copy the position: the plan owns its own numbers, so a later layout
    // re-use can never mutate a plan that has already been handed out.
    const point: Vec3 = { x: position.x, y: position.y, z: position.z }
    const emissive = node.emissive
    const color: Rgb = [
      style.baseColor[0] * emissive,
      style.baseColor[1] * emissive,
      style.baseColor[2] * emissive,
    ]
    return {
      agentId: node.agentId,
      position: point,
      radius: node.size,
      intensity: node.intensity,
      emissive,
      color,
      matrix: composeNodeMatrix(point, node.size),
    }
  })

  return {
    layout,
    attributes,
    style,
    instances,
    count: instances.length,
    // An empty layer draws nothing, so it costs nothing.
    drawCalls: instances.length === 0 ? 0 : NODE_LAYER_DRAW_CALLS,
    bounds: layout.bounds,
    seed: layout.seed,
    converged,
    iterations,
  }
}

/**
 * The instance for `agentId`, or `null` when the agent has none (an absent
 * agent). Mirrors `nodeAttribute` (M2-T3) and `positionById` (M2-T1) so a
 * consumer can read one node without building its own index.
 */
export function nodeInstance(
  plan: NodeScenePlan,
  agentId: AgentId,
): NodeInstance | null {
  for (const instance of plan.instances) {
    if (instance.agentId === agentId) return instance
  }
  return null
}
