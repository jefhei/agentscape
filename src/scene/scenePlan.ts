/**
 * The scene plan (M3-T6) — one run, composed into one whole scene.
 *
 * M3-T1..T5 each landed a *layer*: nodes, arcs, glyphs, the lighting rig and the
 * draw-call measurement. Every one of them is a pure plan plus a thin mesh, and
 * every one of them can derive the layout it needs from the run by itself — which
 * is right for a layer and wrong for a *scene*: mounting four layers naively
 * settles the layout four times and maps the attributes four times, and the four
 * copies only agree by determinism rather than by construction.
 *
 * This module is the seam that fixes that. {@link buildScenePlan} composes the
 * whole scene from **one** settled layout and **one** attribute map, and returns
 * every layer's finished plan together with the things only the *scene* knows:
 *
 * - **what is being drawn** — {@link ScenePlan.counts}, read from the trace's own
 *   facts (agents / messages / tool calls) and each layer's element count, plus the
 *   run's identity (`runId`, `label`, `seed`);
 * - **how the camera frames it** — {@link ScenePlan.camera}, derived from the rig's
 *   own framing distance and field of view (M3-T4) and aimed at the settled
 *   cloud's centre rather than blindly at the origin;
 * - **whether it fits the geometry budget** — {@link ScenePlan.drawCalls} against
 *   the ceiling, plus the post-processing passes reported separately.
 *
 * ## The gate measures the plans the renderer draws
 *
 * The composition is deliberately *not* a second derivation: it goes through
 * {@link measureSceneBudget} (M3-T5), the module whose job is to build the four
 * plans from one layout and total their draw calls. So the numbers a test asserts
 * (`drawCalls <= ceiling`) are the numbers behind the objects the render layer
 * receives — there is no parallel path where the gate could measure a scene the
 * app does not draw. `scenePlan.test.ts` pins that: the plan's layer plans are the
 * measurement's plans, object for object, and one `layout` object is shared by all
 * of them.
 *
 * ## Where the camera comes from, and where it must not
 *
 * The framing distance is the rig's decision, not this module's: `environment.ts`
 * places the fog band around `viewDistance` and documents that the camera sits at
 * that distance, so taking any other number here would put the camera inside a fog
 * band built for a different view. This module only adds the two things the rig
 * cannot know: the **target** (the settled cloud's centre) and the **depth range**
 * (near/far bracketing the cloud), plus a deterministic view **direction** derived
 * from spherical angles — the same idiom `environment.ts` uses for the light
 * offsets, and the reason neither module contains a hand-placed coordinate.
 *
 * ## Purity (PRD §5)
 *
 * Pure and deterministic: no three.js, no DOM, no clock, no `Math.random`, no
 * mutation of the model or of any plan. Every number the plan *derives* — the
 * layout, the attributes, the counts, the camera, the measured budget — is a
 * byte-identical function of the run whatever order its arrays arrive in, which is
 * what lets the render layer build it during a React render and memoize it on the
 * run. (The plan also carries the run itself, by reference, for its consumers; the
 * run's own arrays keep the order they arrived in, and nothing downstream reads
 * them positionally.) Nothing about the rendered *look* is asserted here — jsdom
 * has no GPU, and the look is human-reviewed (M5-T5).
 *
 * ## Scope
 *
 * Deliberately NOT here: the mounting itself (`Scene.tsx` is the thin consumer),
 * the app-level run choice (`App.tsx` mounts a fixture; choosing a real export is
 * M5-T3's dogfood and a loader/picker is post-M4), and the camera *controls* —
 * the orbit mode (M4-T2) consumes this camera as its starting frame via
 * `src/camera/`, and the fly mode (M4-T3) will consume the orbit mode's output.
 */

import type { TraceModel } from '../model/index.ts'
import type { LayoutBounds, Vec3 } from '../layout/index.ts'
import { DRAW_CALL_CEILING, measureSceneBudget } from './budget.ts'
import type { SceneBudgetOptions, ScenePlans } from './budget.ts'
import type { EnvironmentPlan } from './environment.ts'

// ── Camera tunables ─────────────────────────────────────────────────────────

/**
 * Near clip plane, in world units. Small on purpose: M4-T3's fly camera moves
 * *inside* the cloud, so a near plane clipped to the viewing distance of the
 * survey shot would cut the scene open the moment the camera left it. Nothing is
 * ever drawn between the camera and the cloud at the default framing distance, so
 * a small near plane costs only the depth precision the far plane does not need.
 */
export const CAMERA_NEAR = 0.1

/**
 * How many cloud radii of depth the far plane adds past the camera's framing
 * distance. Four is comfortably more than the cloud's own radius (the far edge is
 * one radius past the centre) and still shallow enough that the fog band — which
 * the rig builds out to `viewDistance + 3 × radius` — ends *before* the far plane,
 * so fog fades the cloud out instead of being cut by the frustum.
 */
export const CAMERA_FAR_MARGIN = 4

/**
 * Azimuth of the survey view, degrees around +Y from +X. Ninety degrees puts the
 * camera on the +Z axis, which is the direction the rig's fog band and the shadowless
 * key/rim lights were laid out around — the view the lighting was built for.
 */
export const CAMERA_AZIMUTH_DEG = 90

/**
 * Elevation of the survey view, degrees above the horizon. A slight elevation makes
 * a force-directed cloud read as a volume (its z-spread stays visible) instead of as
 * a flat wall of nodes, which is the whole reason the layout is 3D.
 */
export const CAMERA_ELEVATION_DEG = 18

/** The camera the scene is framed with — what the renderer's `PerspectiveCamera` becomes. */
export interface SceneCamera {
  /** Eye position in world space. */
  position: Vec3
  /** Look-at point: the settled cloud's centre (the origin for an empty scene). */
  target: Vec3
  /** Vertical field of view, from the rig plan (M3-T4). */
  fov: number
  /** Near clip plane (always {@link CAMERA_NEAR}). */
  near: number
  /** Far clip plane — the framing distance plus {@link CAMERA_FAR_MARGIN} cloud radii. */
  far: number
  /** Eye-to-target distance: the rig's own `viewDistance`. */
  distance: number
}

/**
 * What the scene will actually draw, and the trace facts behind it. Split into
 * *trace* counts (`agents`, `messages`, `toolCalls` — read from `model.meta`) and
 * *plan* counts (`nodes`, `arcs`, `glyphs` — read from each layer's plan), so a
 * mismatch between the two is visible rather than assumed away.
 */
export interface SceneCounts {
  /** Agents in the run. */
  agents: number
  /** Messages in the run (a link aggregates one or more of them). */
  messages: number
  /** Tool calls in the run — one glyph each. */
  toolCalls: number
  /** Communication links the layout derived — one arc each. */
  links: number
  /** Node instances drawn (`agents`, unless a layer is degenerate). */
  nodes: number
  /** Arc tubes in the one batched geometry. */
  arcs: number
  /** Glyph instances drawn. */
  glyphs: number
  /** Total drawn elements (`nodes + arcs + glyphs`) — the thing draw calls did NOT track. */
  elements: number
}

/**
 * The whole scene for one run: every layer's finished plan, the shared inputs they
 * were built from, the camera, and the measured budget.
 *
 * A render layer needs nothing else: `Scene.tsx` hands each layer its own sub-plan,
 * and the shell reads `camera` for the renderer and `environment` for tone mapping.
 */
export interface ScenePlan {
  /** The normalized run being drawn (M1-T5). */
  run: TraceModel
  /** The run's id — carried so a mount can be identified headlessly. */
  runId: string
  /** The run's human-readable label. */
  label: string
  /** The layout seed the shape was pinned to. */
  seed: number
  /** The outcome of the one settlement (M2-T2). */
  settled: { converged: boolean; iterations: number }
  /** The one settled layout **shared by every layer** (M2-T1/T2). */
  layout: ScenePlans['nodes']['layout']
  /** The one attribute mapping **shared by every layer** (M2-T3). */
  attributeMap: ScenePlans['nodes']['attributes']
  /** Agent nodes (M3-T1). */
  nodes: ScenePlans['nodes']
  /** Message arcs (M3-T2). */
  arcs: ScenePlans['arcs']
  /** Tool-call glyphs (M3-T3). */
  glyphs: ScenePlans['glyphs']
  /** Environment / lighting / bloom rig (M3-T4). */
  environment: EnvironmentPlan
  /** What is being drawn, and the trace facts behind it. */
  counts: SceneCounts
  /** The framing the shell applies to the renderer's camera. */
  camera: SceneCamera
  /** Total geometry draw calls across every layer. */
  drawCalls: number
  /** The ceiling those calls were judged against. */
  ceiling: number
  /** Whether the scene fits the geometry budget. */
  withinBudget: boolean
  /** Full-screen post-processing passes (bloom), reported outside the geometry ceiling. */
  postProcessPasses: number
  /** Whether the rig enables bloom for this run. */
  bloom: boolean
}

/** Options for {@link buildScenePlan} — the measurement's own per-layer overrides. */
export type SceneOptions = SceneBudgetOptions

// ── Camera ──────────────────────────────────────────────────────────────────

/**
 * A unit direction from spherical angles: azimuth around +Y, elevation above the
 * plane. Shared with the orbit camera (M4-T2), which expresses its eye direction
 * the same way — one spherical→cartesian rule in the codebase, not two.
 */
export function directionFromAngles(azimuthDeg: number, elevationDeg: number): Vec3 {
  const azimuth = (azimuthDeg * Math.PI) / 180
  const elevation = (elevationDeg * Math.PI) / 180
  const horizontal = Math.cos(elevation)
  return {
    x: horizontal * Math.cos(azimuth),
    y: Math.sin(elevation),
    z: horizontal * Math.sin(azimuth),
  }
}

/**
 * Far clip plane for a camera `distance` from a cloud of `extentRadius`:
 * {@link CAMERA_FAR_MARGIN} radii past the camera at minimum, so the far edge of
 * the cloud is never clipped. Shared with the orbit camera (M4-T2), which
 * re-derives it as the viewer dollies in and out — a fixed `far` would clip the
 * cloud the moment you zoomed out past the framing distance.
 */
export function cameraFar(distance: number, extentRadius: number): number {
  const radius = Number.isFinite(extentRadius) && extentRadius > 0 ? extentRadius : 0
  const near = Number.isFinite(distance) ? distance : 0
  return Math.max(near + radius * CAMERA_FAR_MARGIN, CAMERA_NEAR * 2)
}

/** The origin, as a named all-zero sentinel (an empty scene's look-at point). */
const ORIGIN: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 })

/**
 * Frame a cloud with the rig's own framing distance and field of view (M3-T4).
 *
 * `bounds` is the settled cloud's extent (`null` for an empty scene, which is
 * framed as the default extent around the origin). The camera is placed on the
 * survey direction at the rig's `viewDistance` from the cloud's **centre** and
 * looks at that centre, so a cloud that settled off-origin is still centred in the
 * frame — the previous shell aimed at the origin unconditionally, which only
 * happened to be right. Near/far bracket the cloud: the near plane is a fixed
 * small value (the fly camera will need it) and the far plane sits
 * {@link CAMERA_FAR_MARGIN} cloud radii past the camera, beyond both the cloud and
 * the fog band.
 *
 * Pure: a function of the rig plan and the bounds only.
 */
export function sceneCamera(
  environment: EnvironmentPlan,
  bounds: LayoutBounds | null,
): SceneCamera {
  const target: Vec3 =
    bounds === null
      ? { x: ORIGIN.x, y: ORIGIN.y, z: ORIGIN.z }
      : { x: bounds.center.x, y: bounds.center.y, z: bounds.center.z }
  const distance = environment.viewDistance
  const direction = directionFromAngles(CAMERA_AZIMUTH_DEG, CAMERA_ELEVATION_DEG)
  const extentRadius =
    Number.isFinite(environment.extentRadius) && environment.extentRadius > 0
      ? environment.extentRadius
      : 0

  return {
    position: {
      x: target.x + direction.x * distance,
      y: target.y + direction.y * distance,
      z: target.z + direction.z * distance,
    },
    target,
    fov: environment.fov,
    near: CAMERA_NEAR,
    far: cameraFar(distance, extentRadius),
    distance,
  }
}

// ── The scene ───────────────────────────────────────────────────────────────

/**
 * Compose the whole scene for `model`: one settlement, one attribute mapping, four
 * layer plans, one camera, one measured budget.
 *
 * Pure and deterministic — the same model yields a byte-identical plan whatever
 * order its arrays arrive in, and neither the model nor the plans are mutated. A
 * degenerate run is well-formed: an empty run composes a scene of zero draw calls
 * with bloom off and a camera framed on the origin; a lone agent composes one node
 * and no arcs/glyphs.
 *
 * @param model a normalized trace (M1-T5) — the only v1 ingest path's output (M1-T4).
 * @param options per-layer style overrides, rig/calibration overrides and an
 *        optional ceiling (see {@link SceneBudgetOptions}).
 * @throws ScenePlanError when a layer cannot be built coherently (a dangling agent
 *         reference — impossible for a normalized model).
 * @throws EnvironmentRigError when the calibration anchors cannot be satisfied.
 */
export function buildScenePlan(
  model: TraceModel,
  options: SceneOptions = {},
): ScenePlan {
  // One measurement = one settle + one map + the four layer plans built from them.
  // Composing on top of it (rather than re-deriving) is what keeps the gate and
  // the renderer on the same objects.
  const budget = measureSceneBudget(model, options)
  const { nodes, arcs, glyphs, environment } = budget.plans
  const layout = nodes.layout
  const attributeMap = nodes.attributes

  const counts: SceneCounts = {
    agents: model.meta.agentCount,
    messages: model.meta.messageCount,
    toolCalls: model.meta.toolCallCount,
    links: arcs.count,
    nodes: nodes.count,
    arcs: arcs.count,
    glyphs: glyphs.count,
    elements: nodes.count + arcs.count + glyphs.count,
  }

  return {
    run: model,
    runId: model.id,
    label: model.label,
    seed: layout.seed,
    settled: { converged: budget.converged, iterations: budget.iterations },
    layout,
    attributeMap,
    nodes,
    arcs,
    glyphs,
    environment,
    counts,
    camera: sceneCamera(environment, layout.bounds),
    drawCalls: budget.drawCalls,
    ceiling: budget.ceiling,
    withinBudget: budget.withinBudget,
    postProcessPasses: budget.postProcessPasses,
    bloom: environment.bloom.enabled,
  }
}

/**
 * The scene's geometry ceiling, re-exported so a consumer of {@link ScenePlan} can
 * compare `plan.drawCalls` without importing the budget module too.
 */
export { DRAW_CALL_CEILING }
