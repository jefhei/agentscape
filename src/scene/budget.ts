/**
 * Scene draw-call budget (M3-T5) — the *measurement* half of the PRD's geometry
 * budget, and the gate that keeps it true.
 *
 * The PRD states the budget as a promise about the renderer: *"one instanced mesh
 * for nodes, one batched geometry for arcs, one for glyphs. Every repeated
 * element is instanced; the draw-call ceiling is a gate."* A promise like that is
 * worth nothing unless something measures it, so this module measures the **real
 * plans** — the same `build*ScenePlan` calls the render layer consumes — and
 * totals the draw calls they report:
 *
 * | layer | cost | why |
 * |---|---|---|
 * | nodes | `NODE_LAYER_DRAW_CALLS` (1) | one `InstancedMesh`, one instance per agent |
 * | arcs | `ARC_LAYER_DRAW_CALLS` (1) | one batched geometry, one tube per link, all in one buffer |
 * | glyphs | `GLYPH_LAYER_DRAW_CALLS` (1) | one `InstancedMesh`, one instance per tool call |
 * | environment | `ENVIRONMENT_DRAW_CALLS` (0) | lights/fog/clear colour are not geometry |
 *
 * {@link DRAW_CALL_CEILING} is the sum of those declared constants, so the
 * ceiling is **derived from the layers rather than restated**, and a layer that
 * started drawing a second mesh would move the ceiling with it only if its own
 * constant did — which is exactly the thing `sceneComponents` in
 * `budget.test.ts` checks against the components' source.
 *
 * The property that actually matters is **trace-size independence**: a run with
 * two agents and one with two hundred cost the *same* number of draw calls.
 * {@link measureSceneBudget} proves that per run by reporting both the totals and
 * the element counts that grew while the totals did not.
 *
 * ## Measured, not claimed
 *
 * Nothing here trusts a constant alone. Each layer's number is read from that
 * layer's own plan (`plan.drawCalls`), which is `0` for an empty layer and the
 * layer's declared cost otherwise. So an empty run measures **0** draw calls, a
 * node-only run measures 1, and a fully populated run measures 3 — and the
 * ceiling comparison is against plans that were really built.
 *
 * ## One settle per scene (the double settle, paid down)
 *
 * Measuring four layers naively would settle the layout four times. Here the
 * layout and the attribute map are derived **once** and passed to every layer
 * through the reuse seam all three scene plans expose
 * (`options.layout` / `options.attributeMap`), so the measurement is also the
 * cheap path — and `budget.test.ts` asserts the plans share one layout object,
 * which is what makes "one settle" a fact rather than an intention.
 *
 * ## Post-processing is not a draw call
 *
 * Bloom's mip chain is a fixed full-screen cost per frame that does not grow with
 * the trace, and the rig's lights/fog are uniforms and clear state. Both are
 * reported via {@link SceneBudget.postProcessPasses} and deliberately kept out of
 * the geometry ceiling, so the gate stays about *instancing* (this module) and
 * M5-T2 can measure the frame budget as its own thing.
 *
 * Pure and deterministic (PRD §5): no three.js, no DOM, no clock, no
 * `Math.random`, no mutation of the model or of the plans. The same trace yields
 * a byte-identical budget whatever order its arrays arrive in. Nothing about the
 * rendered look is asserted here — jsdom has no GPU; the look is human-reviewed
 * (M5-T5).
 */

import type { TraceModel } from '../model/index.ts'
import { mapTraceAttributes, settleLayout } from '../layout/index.ts'
import type { AttributeOptions, SettlementOptions } from '../layout/index.ts'
import { NODE_LAYER_DRAW_CALLS, buildNodeScenePlan } from './nodes.ts'
import type { NodeScenePlan, NodeSceneStyle } from './nodes.ts'
import { ARC_LAYER_DRAW_CALLS, buildArcScenePlan } from './arcs.ts'
import type { ArcScenePlan, ArcSceneStyle } from './arcs.ts'
import { GLYPH_LAYER_DRAW_CALLS, buildGlyphScenePlan } from './glyphs.ts'
import type { GlyphScenePlan, GlyphSceneStyleOverrides } from './glyphs.ts'
import { ENVIRONMENT_DRAW_CALLS, buildEnvironmentPlan } from './environment.ts'
import type {
  CalibrationOverrides,
  EnvironmentPlan,
  EnvironmentRigOverrides,
} from './environment.ts'

// ── The declared costs ──────────────────────────────────────────────────────

/** The layers a scene is composed of, in draw order. */
export const SCENE_LAYER_NAMES = ['nodes', 'arcs', 'glyphs', 'environment'] as const

/** One of the {@link SCENE_LAYER_NAMES}. */
export type SceneLayerName = (typeof SCENE_LAYER_NAMES)[number]

/**
 * What each layer costs when it has anything to draw, read from the layer's own
 * exported constant — the single source of truth lives with the layer, and this
 * table only joins them so the ceiling can be summed.
 */
export const SCENE_LAYER_DRAW_CALLS: Readonly<Record<SceneLayerName, number>> = {
  nodes: NODE_LAYER_DRAW_CALLS,
  arcs: ARC_LAYER_DRAW_CALLS,
  glyphs: GLYPH_LAYER_DRAW_CALLS,
  environment: ENVIRONMENT_DRAW_CALLS,
}

/**
 * The geometry draw-call ceiling for a fully populated scene: the sum of every
 * layer's declared cost (`1 + 1 + 1 + 0 = 3`). It is **constant**, not
 * trace-scaled — that is the whole point of instancing, and the number a test
 * enforces.
 */
export const DRAW_CALL_CEILING = SCENE_LAYER_NAMES.reduce(
  (total, layer) => total + SCENE_LAYER_DRAW_CALLS[layer],
  0,
)

/**
 * The most drawable objects one render-layer component may create. A layer that
 * needs more than one is not instancing, and a component that creates one *per
 * element* (a mesh per message, per agent, per glyph) breaks the budget this
 * module exists to hold.
 */
export const MAX_MESH_SITES_PER_COMPONENT = 1

// ── Public shapes ───────────────────────────────────────────────────────────

/** One layer's measured cost for one run. */
export interface LayerBudget {
  /** Which layer this is. */
  layer: SceneLayerName
  /** Draw calls the layer's own plan reports for this run (`0` when empty). */
  drawCalls: number
  /** The layer's declared cost when active — its share of the ceiling. */
  maxDrawCalls: number
  /** Elements the layer draws: agents, arcs, glyphs; `0` for the rig. */
  elements: number
  /** Whether the layer has anything to draw at all. */
  active: boolean
}

/** The four plans a measurement built — one scene pass, shared layout. */
export interface ScenePlans {
  nodes: NodeScenePlan
  arcs: ArcScenePlan
  glyphs: GlyphScenePlan
  environment: EnvironmentPlan
}

/** The measured budget for one run: per-layer costs, totals and the verdict. */
export interface SceneBudget {
  /** Per-layer measurements, in draw order ({@link SCENE_LAYER_NAMES}). */
  layers: LayerBudget[]
  /** The plans the measurement built, in case a caller wants to draw them. */
  plans: ScenePlans
  /** Total geometry draw calls across every layer. */
  drawCalls: number
  /**
   * Full-screen post-processing passes (bloom), reported **separately**: they are
   * a fixed per-frame cost, not trace-scaled geometry, so they are not in the
   * draw-call ceiling.
   */
  postProcessPasses: number
  /** Total drawn elements (nodes + arcs + glyphs) — what grew without costing a call. */
  elements: number
  /** The ceiling this budget was judged against. */
  ceiling: number
  /** `ceiling − drawCalls`; negative when over budget. */
  headroom: number
  /** Whether `drawCalls <= ceiling`. */
  withinBudget: boolean
  /** The run's layout seed (all layers were composed from one layout). */
  seed: number
  /** Whether that layout settled (M2-T2) before the iteration cap. */
  converged: boolean
  /** Relaxation iterations that one settlement ran. */
  iterations: number
}

/** Thrown when a measured scene exceeds its draw-call ceiling. */
export class DrawCallBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DrawCallBudgetError'
  }
}

/**
 * Optional overrides for {@link measureSceneBudget}. Each is passed to the layer
 * that owns it, so a measurement never has to restate a layer's defaults.
 */
export interface SceneBudgetOptions {
  /** Passed through to the one settlement (M2-T2). */
  settlement?: SettlementOptions
  /** Passed through to the one attribute mapping (M2-T3). */
  attributes?: AttributeOptions
  /** Node-layer style overrides (M3-T1). */
  nodeStyle?: Partial<NodeSceneStyle>
  /** Arc-layer style overrides (M3-T2). */
  arcStyle?: Partial<ArcSceneStyle>
  /** Glyph-layer style overrides (M3-T3). */
  glyphStyle?: GlyphSceneStyleOverrides
  /** Rig overrides (M3-T4). */
  rig?: EnvironmentRigOverrides
  /** Emissive-calibration overrides (M3-T4). */
  calibration?: CalibrationOverrides
  /** A tighter or looser ceiling than {@link DRAW_CALL_CEILING} (sanitized). */
  ceiling?: number
}

// ── The measurement ─────────────────────────────────────────────────────────

/** A finite, non-negative integer ceiling, or {@link DRAW_CALL_CEILING}. */
function resolveCeiling(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DRAW_CALL_CEILING
  }
  return Math.floor(value)
}

/**
 * Measure the draw-call cost of rendering `model` as a scene: build every layer's
 * plan from **one** settled layout and **one** attribute map, then total the draw
 * calls those plans report.
 *
 * Pure and deterministic — the same model yields a byte-identical budget
 * whatever order its arrays arrive in, and neither the model nor the plans are
 * mutated. A degenerate run is well-formed: an empty run measures zero draw
 * calls and zero elements; a run with agents but no messages measures one.
 *
 * @param model a normalized trace (M1-T5).
 * @param options per-layer style overrides and an optional ceiling override.
 * @throws ScenePlanError when a layer's plan cannot be built (a dangling agent
 *         reference — impossible for a coherent model).
 * @throws EnvironmentRigError when the calibration anchors cannot be satisfied.
 */
export function measureSceneBudget(
  model: TraceModel,
  options: SceneBudgetOptions = {},
): SceneBudget {
  // One scene pass: settle once, map once, and hand both to every layer.
  const settled = settleLayout(model, options.settlement)
  const layout = settled.layout
  const attributeMap = mapTraceAttributes(model, options.attributes)
  const shared = { settlement: options.settlement, layout, attributeMap }

  const nodes = buildNodeScenePlan(model, { ...shared, style: options.nodeStyle })
  const arcs = buildArcScenePlan(model, { ...shared, style: options.arcStyle })
  const glyphs = buildGlyphScenePlan(model, { ...shared, style: options.glyphStyle })
  const environment = buildEnvironmentPlan(model, {
    layout,
    rig: options.rig,
    calibration: options.calibration,
  })

  const layers: LayerBudget[] = [
    {
      layer: 'nodes',
      drawCalls: nodes.drawCalls,
      maxDrawCalls: SCENE_LAYER_DRAW_CALLS.nodes,
      elements: nodes.count,
      active: nodes.count > 0,
    },
    {
      layer: 'arcs',
      drawCalls: arcs.drawCalls,
      maxDrawCalls: SCENE_LAYER_DRAW_CALLS.arcs,
      elements: arcs.count,
      active: arcs.count > 0,
    },
    {
      layer: 'glyphs',
      drawCalls: glyphs.drawCalls,
      maxDrawCalls: SCENE_LAYER_DRAW_CALLS.glyphs,
      elements: glyphs.count,
      active: glyphs.count > 0,
    },
    {
      layer: 'environment',
      drawCalls: environment.drawCalls,
      maxDrawCalls: SCENE_LAYER_DRAW_CALLS.environment,
      elements: 0,
      active: false,
    },
  ]

  const drawCalls = layers.reduce((total, layer) => total + layer.drawCalls, 0)
  const elements = layers.reduce((total, layer) => total + layer.elements, 0)
  const ceiling = resolveCeiling(options.ceiling)

  return {
    layers,
    plans: { nodes, arcs, glyphs, environment },
    drawCalls,
    postProcessPasses: environment.postProcessPasses,
    elements,
    ceiling,
    headroom: ceiling - drawCalls,
    withinBudget: drawCalls <= ceiling,
    seed: layout.seed,
    converged: settled.converged,
    iterations: layout.iterations,
  }
}

/**
 * Throw {@link DrawCallBudgetError} when a measured scene is over its ceiling.
 * Returns normally otherwise, so it composes as a gate:
 * `assertDrawCallBudget(measureSceneBudget(run))`.
 */
export function assertDrawCallBudget(budget: SceneBudget): void {
  if (budget.withinBudget) return
  const detail = budget.layers
    .map((layer) => `${layer.layer}: ${layer.drawCalls}/${layer.maxDrawCalls}`)
    .join(', ')
  throw new DrawCallBudgetError(
    `draw-call budget exceeded: ${budget.drawCalls} > ${budget.ceiling} (${detail})`,
  )
}

/**
 * The measured budget for one layer, or `null` when the layer is not part of a
 * scene. Mirrors `nodeInstance` / `arcInstanceFor` so a consumer can read one
 * layer's cost without scanning the array.
 */
export function layerBudget(
  budget: SceneBudget,
  layer: SceneLayerName,
): LayerBudget | null {
  for (const entry of budget.layers) {
    if (entry.layer === layer) return entry
  }
  return null
}

// ── Structural gate: "no per-message mesh anywhere" ─────────────────────────

/** The kinds of drawable object a mesh-construction site can create. */
export type MeshSiteTag = 'mesh' | 'instancedMesh' | 'Mesh' | 'InstancedMesh'

/**
 * A place in source that creates a drawable object — the unit the "every
 * repeated element is instanced" rule counts. `kind` separates JSX
 * (`<mesh>` / `<instancedMesh>`) from the imperative constructor
 * (`new THREE.Mesh(...)`); `line` makes a failing gate readable.
 */
export interface MeshConstructionSite {
  kind: 'jsx' | 'constructor'
  tag: MeshSiteTag
  line: number
}

/** JSX `<mesh ...>` / `<instancedMesh ...>` — but never `<meshBasicMaterial>`. */
const JSX_MESH_SITE = /<(instancedMesh|mesh)(?=[\s/>])/g

/** `new Mesh(` / `new THREE.Mesh(` / `new InstancedMesh(` / `new THREE.InstancedMesh(`. */
const CONSTRUCTOR_MESH_SITE = /\bnew\s+(?:THREE\.)?(InstancedMesh|Mesh)\s*\(/g

/** Remove block and line comments so the module's prose cannot trip a scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 1-based line number of `index` in `text`. */
function lineOf(text: string, index: number): number {
  let line = 1
  for (let at = 0; at < index; at += 1) {
    if (text.charCodeAt(at) === 10) line += 1
  }
  return line
}

/**
 * Find every drawable-object construction site in a source string, in source
 * order. Pure: a function of its argument only.
 *
 * This is the machine half of *"no per-message mesh anywhere"*. Counting sites —
 * not rendered objects — is what makes the rule checkable in jsdom: a component
 * that builds one mesh inside a loop over messages still declares exactly one
 * construction site, so a *second* mesh can only appear by adding a site, which
 * fails the per-component limit. A per-message mesh written as
 * `messages.map(... <mesh> ...)` adds a site, so it is caught.
 */
export function findMeshConstructionSites(source: string): MeshConstructionSite[] {
  const text = stripComments(source)
  const found: { index: number; site: MeshConstructionSite }[] = []

  for (const match of text.matchAll(JSX_MESH_SITE)) {
    const index = match.index ?? 0
    found.push({
      index,
      site: { kind: 'jsx', tag: match[1] as MeshSiteTag, line: lineOf(text, index) },
    })
  }
  for (const match of text.matchAll(CONSTRUCTOR_MESH_SITE)) {
    const index = match.index ?? 0
    found.push({
      index,
      site: {
        kind: 'constructor',
        tag: match[1] as MeshSiteTag,
        line: lineOf(text, index),
      },
    })
  }

  return found.sort((a, b) => a.index - b.index).map((entry) => entry.site)
}
