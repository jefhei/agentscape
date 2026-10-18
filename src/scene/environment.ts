/**
 * Environment, lighting and bloom rig (M3-T4) — the *pure half*.
 *
 * Every M3 task has the same shape (PRD §5): a pure module under `src/scene/` that
 * decides *what to draw* as plain data, plus a thin `.tsx` that copies those
 * numbers onto the GPU. This module is the rig's pure half, and it answers two
 * questions the renderer must not decide for itself:
 *
 * 1. **What is the surrounding scene?** — background, distance fog, the four-light
 *    rig and the tone-mapping/exposure the renderer is configured with. All of it
 *    derived from the settled cloud's extent, so the rig scales with the trace
 *    instead of being hand-placed for one run.
 * 2. **What radiance does a node emit?** — the *bloom-honest emissive
 *    calibration*. The PRD's requirement is that bright nodes read as "hot, not
 *    blown out": that is a statement about what the tone mapper does to a linear
 *    value, so it cannot be expressed as a hand-picked material constant. It is
 *    solved here, against a real tone-mapping curve ({@link acesFilmic}), from
 *    four stated appearance anchors:
 *
 *    - the quietest node in a run displays at {@link QUIET_DISPLAY_LUMINANCE},
 *    - the hottest displays at {@link HOT_DISPLAY_LUMINANCE} — bright, and still
 *      short of clipping, so it never blows out,
 *    - the bloom knee (the brightness at which a halo starts) sits at
 *      {@link BLOOM_KNEE_DISPLAY_LUMINANCE} on screen, and
 *    - it is reached at {@link BLOOM_KNEE_ACTIVITY} of the activity range, so only
 *      the genuinely hot part of a run blooms.
 *
 *    From those anchors the module inverts the tone curve to get the two
 *    radiances, places the bloom threshold at exactly the knee's radiance, and
 *    solves the exponent of the activity→radiance curve so the knee lands where
 *    the anchors say. Nothing is hand-tuned: change an anchor and the whole curve
 *    re-solves. Because the threshold is defined *in radiance derived from a
 *    display value*, bloom follows what the viewer sees rather than the raw HDR
 *    numbers — that is what "bloom-honest" means here.
 *
 * Pure and deterministic (PRD §5): no three.js, no DOM, no clock, no
 * `Math.random`, no mutation of the model, the layout or an options object. The
 * same trace yields a byte-identical plan whatever order its arrays arrive in.
 * **Nothing about the look is asserted in tests** — jsdom has no GPU; the look is
 * human-reviewed (M5-T5). What *is* gated is the arithmetic above: monotonicity,
 * the anchor values, the knee, the no-clipping bound and determinism.
 */

import type { LayoutBounds, SettlementOptions, Vec3 } from '../layout/index.ts'
import type { ForceLayout } from '../layout/index.ts'
import { DEFAULT_MAX_EMISSIVE, DEFAULT_MIN_EMISSIVE } from '../layout/index.ts'
import { settleLayout } from '../layout/index.ts'
import type { TraceModel } from '../model/index.ts'
import { hexToLinearRgb, isHexColor, scaleToLuminance } from './color.ts'
import type { Rgb } from './color.ts'
import { acesFilmic, inverseAcesFilmic } from './toneMapping.ts'

// ── Appearance anchors (the calibration's inputs) ───────────────────────────

/**
 * Display luminance of the quietest node in a run (the attribute mapper's
 * `minEmissive`). Low enough that quiet agents recede, high enough that they are
 * still findable in the cloud.
 */
export const QUIET_DISPLAY_LUMINANCE = 0.22

/**
 * Display luminance of the hottest node in a run. Deliberately below `1`: ACES
 * approaches white asymptotically, so pinning the hot end here is what guarantees
 * "hot, not blown out" — there is always roll-off left above it.
 */
export const HOT_DISPLAY_LUMINANCE = 0.9

/**
 * Display luminance at which the bloom halo starts. Above the un-calibrated marks
 * (tool glyphs read around `0.95` linear, which displays near `0.79` here), so
 * annotations do not smear into bloom while the hot nodes do.
 */
export const BLOOM_KNEE_DISPLAY_LUMINANCE = 0.82

/**
 * Where the bloom knee sits in the activity range, `0..1` from the run's quietest
 * agent to its busiest. `0.72` means only the top ~28% of the activity range
 * blooms: fan-out and hot spots pop out of the cloud, ordinary traffic does not.
 */
export const BLOOM_KNEE_ACTIVITY = 0.72

/** Renderer exposure the calibration is solved at (`1` = the renderer's neutral). */
export const DEFAULT_EXPOSURE = 1

// ── Rig constants ───────────────────────────────────────────────────────────

/** Near-black blue the scene clears to — dark enough for additive marks to read. */
export const DEFAULT_BACKGROUND_HEX = '#05070d'

/** Fog colour: the background lifted a touch, so depth reads as haze, not a void. */
export const DEFAULT_FOG_HEX = '#070b14'

/**
 * Camera distance the rig frames for. Single-sourced here because the fog band is
 * expressed around it: the render layer's camera `position` is
 * `[0, 0, viewDistance]` and its `fov` comes from {@link DEFAULT_FOV}, so the two
 * halves cannot drift (M4 takes ownership when orbit/fly cameras land).
 */
export const DEFAULT_VIEW_DISTANCE = 12

/** Vertical field of view the framing distance assumes. */
export const DEFAULT_FOV = 55

/** Fog begins this many cloud-radii in front of the camera. */
export const DEFAULT_FOG_NEAR_MARGIN = 1.25

/** ...and is fully opaque this many cloud-radii behind it. */
export const DEFAULT_FOG_FAR_MARGIN = 3

/** How far each directional light sits from the cloud centre, in cloud radii. */
export const DEFAULT_LIGHT_DISTANCE_FACTOR = 3.5

/**
 * Draw calls the rig costs: **none**. Lights are uniforms, the background is a
 * clear colour and fog is per-fragment — none of them is geometry. Exported so
 * M3-T5's draw-call ceiling can account for the rig without re-deriving it.
 */
export const ENVIRONMENT_DRAW_CALLS = 0

/**
 * Post-processing passes the rig adds when bloom is on. These are **full-screen**
 * passes, not scene geometry, so they are reported separately from
 * {@link ENVIRONMENT_DRAW_CALLS}: the M3 draw-call budget is about instancing (no
 * per-message/per-agent mesh), while bloom's internal mip chain is a fixed cost
 * per frame that does not grow with the trace.
 */
export const ENVIRONMENT_POST_PROCESS_PASSES = 1

// ── Envelope / failure shapes ───────────────────────────────────────────────

/** Thrown when the rig's anchors cannot describe a coherent scene. */
export class EnvironmentRigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvironmentRigError'
  }
}

/**
 * The solved emissive calibration: the numbers that turn a node's normalized
 * activity into a linear HDR radiance, plus the bloom threshold that radiance is
 * judged against. Every field is derived from the anchors — none is hand-set.
 */
export interface EmissiveCalibration {
  /** Renderer exposure the radiances are solved at. */
  exposure: number
  /** Activity range the mapper normalizes into (M2-T3). */
  minEmissive: number
  maxEmissive: number
  /** Appearance anchors (see the module doc). */
  quietDisplay: number
  hotDisplay: number
  bloomKneeDisplay: number
  bloomKneeActivity: number
  /** Activity value at which the bloom knee is reached — `min + range · activity`. */
  bloomKneeEmissive: number
  /** Solved exponent of the activity → radiance curve. */
  gamma: number
  /** Linear HDR radiance of the quietest node. */
  quietRadiance: number
  /** Linear HDR radiance of the hottest node (the curve's ceiling). */
  hotRadiance: number
  /** Luminance a pixel must exceed to bloom — the knee's own radiance. */
  bloomThreshold: number
}

/** Optional overrides for the calibration anchors (all deterministically defaulted). */
export interface CalibrationOverrides {
  exposure?: number
  minEmissive?: number
  maxEmissive?: number
  quietDisplay?: number
  hotDisplay?: number
  bloomKneeDisplay?: number
  bloomKneeActivity?: number
}

// ── Calibration ─────────────────────────────────────────────────────────────

/** A finite override inside `[min, max]`, else the fallback. */
function clampOption(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

/**
 * Solve the emissive calibration from its appearance anchors.
 *
 * The two radiances come straight from inverting the tone curve at the quiet and
 * hot display anchors; the bloom threshold is the knee's radiance; and the
 * activity→radiance exponent is solved so the curve passes through
 * `(bloomKneeEmissive, bloomThreshold)` exactly. That last step is what makes the
 * knee *mean* something: it is a statement about the run's activity distribution,
 * not a magic constant.
 *
 * @throws EnvironmentRigError when the anchors cannot describe a calibration —
 *         a quiet anchor that is not below the knee, a knee that is not below the
 *         hot anchor, or an exposure that is not positive. Failing loudly beats
 *         silently emitting a curve that never blooms or always blooms.
 */
export function resolveCalibration(
  overrides: CalibrationOverrides = {},
): EmissiveCalibration {
  const exposure = clampOption(overrides.exposure, DEFAULT_EXPOSURE, 1e-3, 1e3)
  const minEmissive = clampOption(overrides.minEmissive, DEFAULT_MIN_EMISSIVE, 0, 1)
  const maxEmissive = clampOption(
    overrides.maxEmissive,
    DEFAULT_MAX_EMISSIVE,
    minEmissive + 1e-6,
    10,
  )
  const quietDisplay = clampOption(
    overrides.quietDisplay,
    QUIET_DISPLAY_LUMINANCE,
    0,
    0.99,
  )
  const hotDisplay = clampOption(overrides.hotDisplay, HOT_DISPLAY_LUMINANCE, 0, 0.999)
  const bloomKneeDisplay = clampOption(
    overrides.bloomKneeDisplay,
    BLOOM_KNEE_DISPLAY_LUMINANCE,
    0,
    1,
  )
  const bloomKneeActivity = clampOption(
    overrides.bloomKneeActivity,
    BLOOM_KNEE_ACTIVITY,
    1e-3,
    1 - 1e-3,
  )

  if (!(quietDisplay < bloomKneeDisplay && bloomKneeDisplay < hotDisplay)) {
    throw new EnvironmentRigError(
      'calibration anchors must satisfy quietDisplay < bloomKneeDisplay < hotDisplay ' +
        `(got ${quietDisplay}, ${bloomKneeDisplay}, ${hotDisplay})`,
    )
  }

  const quietRadiance = inverseAcesFilmic(quietDisplay) / exposure
  const hotRadiance = inverseAcesFilmic(hotDisplay) / exposure
  const bloomThreshold = inverseAcesFilmic(bloomKneeDisplay) / exposure
  const bloomKneeEmissive =
    minEmissive + (maxEmissive - minEmissive) * bloomKneeActivity

  // `fraction` is where the knee sits between the quiet and hot radiances, in
  // (0, 1) because the anchor check above ordered the three display values and
  // the tone curve is monotone.
  const fraction = (bloomThreshold - quietRadiance) / (hotRadiance - quietRadiance)
  if (!(fraction > 0 && fraction < 1)) {
    throw new EnvironmentRigError(
      `bloom knee radiance ${bloomThreshold} is not between the quiet ${quietRadiance} ` +
        `and hot ${hotRadiance} radiances`,
    )
  }
  // Solve curve(kneeActivity) = fraction: gamma = ln(fraction) / ln(kneeActivity).
  const gamma = Math.log(fraction) / Math.log(bloomKneeActivity)
  if (!Number.isFinite(gamma) || gamma <= 0) {
    throw new EnvironmentRigError(
      `solved calibration exponent is not positive (${gamma})`,
    )
  }

  return {
    exposure,
    minEmissive,
    maxEmissive,
    quietDisplay,
    hotDisplay,
    bloomKneeDisplay,
    bloomKneeActivity,
    bloomKneeEmissive,
    gamma,
    quietRadiance,
    hotRadiance,
    bloomThreshold,
  }
}

/**
 * The calibration every scene uses unless it overrides the anchors. Frozen because
 * it is shared by the node plan and the rig plan, and the two must agree: the
 * node's radiance and the bloom threshold are only comparable if they come from
 * the same solve.
 */
export const DEFAULT_EMISSIVE_CALIBRATION: EmissiveCalibration =
  Object.freeze(resolveCalibration())

/**
 * The linear HDR radiance (luminance) a node with `emissive` emits.
 *
 * `0` of the activity range is the quiet anchor and `1` is the hot anchor; the
 * curve between them is `quiet + (hot − quiet)·t^gamma`, convex, so quiet agents
 * recede and busy agents carry the eye. Values outside the range clamp — an
 * attribute mapper that hands over something unexpected still produces a finite,
 * in-range radiance rather than `NaN` or a black node.
 */
export function glowRadiance(
  calibration: EmissiveCalibration,
  emissive: number,
): number {
  const span = calibration.maxEmissive - calibration.minEmissive
  if (!(span > 0)) return calibration.quietRadiance
  const t = Math.min(
    1,
    Math.max(
      0,
      ((Number.isFinite(emissive) ? emissive : calibration.minEmissive) -
        calibration.minEmissive) /
        span,
    ),
  )
  const shaped = t === 0 ? 0 : Math.pow(t, calibration.gamma)
  return (
    calibration.quietRadiance +
    (calibration.hotRadiance - calibration.quietRadiance) * shaped
  )
}

/**
 * The glow *colour* for a node: the style's base hue rescaled to the calibrated
 * radiance, so brightness encodes activity while hue stays the run's identity. At
 * every `emissive` the returned colour's luminance is exactly
 * {@link glowRadiance} — the test that pins "brightness is activity, not hue".
 */
export function glowColor(
  calibration: EmissiveCalibration,
  baseColor: Rgb,
  emissive: number,
): Rgb {
  return scaleToLuminance(baseColor, glowRadiance(calibration, emissive))
}

/**
 * The display luminance the calibration predicts for a node — the model's own
 * answer to "how bright will that look". The renderer's tone mapping is the same
 * ACES family; this is the number the anchors are stated in, and what the tests
 * assert (hot under `1`, quiet at its anchor, monotone in between).
 */
export function displayLuminance(
  calibration: EmissiveCalibration,
  emissive: number,
): number {
  return acesFilmic(glowRadiance(calibration, emissive) * calibration.exposure)
}

/** Whether a node at `emissive` crosses the bloom knee (gets a halo). */
export function blooms(calibration: EmissiveCalibration, emissive: number): boolean {
  return glowRadiance(calibration, emissive) > calibration.bloomThreshold
}

// ── Rig style ───────────────────────────────────────────────────────────────

/** A single-colour light. */
export interface LightSpec {
  hex: string
  color: Rgb
  intensity: number
}

/** A two-colour hemisphere light (sky above, bounce below). */
export interface HemisphereLightSpec {
  skyHex: string
  sky: Rgb
  groundHex: string
  ground: Rgb
  intensity: number
}

/** A directional light: its unit direction plus the offset it is placed at. */
export interface DirectionalLightSpec extends LightSpec {
  /** Unit vector the light shines *along* (from its offset toward the cloud). */
  direction: Vec3
  /** Where the light sits, `direction × extentRadius × distanceFactor`. */
  offset: Vec3
}

/** The four-light rig: a soft base, a sky/ground gradient, a key and a rim. */
export interface LightRig {
  ambient: LightSpec
  hemisphere: HemisphereLightSpec
  key: DirectionalLightSpec
  rim: DirectionalLightSpec
}

/** Distance fog for depth cueing. */
export interface FogSpec {
  enabled: boolean
  hex: string
  color: Rgb
  near: number
  far: number
}

/** Bloom settings; `luminanceThreshold` is the calibrated knee, never hand-set. */
export interface BloomSpec {
  enabled: boolean
  intensity: number
  luminanceThreshold: number
  luminanceSmoothing: number
  radius: number
  mipmapBlur: boolean
}

/** Tone-mapping mode the renderer is configured with (see `toneMapping.ts`). */
export type ToneMappingName = 'ACESFilmic'

/** The whole rig, ready for the thin `EnvironmentRig.tsx` to apply. */
export interface EnvironmentPlan {
  backgroundHex: string
  background: Rgb
  fog: FogSpec
  toneMapping: ToneMappingName
  exposure: number
  /** Framing distance the fog band and camera assume. */
  viewDistance: number
  /** Vertical field of view the framing assumes. */
  fov: number
  lights: LightRig
  bloom: BloomSpec
  calibration: EmissiveCalibration
  /** Extent of the settled cloud, or `null` for an empty scene. */
  bounds: LayoutBounds | null
  /** Cloud radius the rig was framed to (a default when there is no run). */
  extentRadius: number
  /** Draw calls the rig costs (always {@link ENVIRONMENT_DRAW_CALLS}). */
  drawCalls: number
  /** Post-processing passes (0 when bloom is off). */
  postProcessPasses: number
  /** Settlement outcome, or `null` when no model was given / a layout was passed in. */
  settlement: { converged: boolean; iterations: number } | null
  /** The run's layout seed, or `null` for an empty scene. */
  seed: number | null
}

/** Per-light intensity/colour overrides. */
export interface AmbientOverrides {
  hex?: string
  intensity?: number
}

export interface HemisphereOverrides {
  skyHex?: string
  groundHex?: string
  intensity?: number
}

export interface DirectionalOverrides {
  hex?: string
  intensity?: number
  azimuthDeg?: number
  elevationDeg?: number
}

/** Rig overrides — every field independently defaulted and sanitized. */
export interface EnvironmentRigOverrides {
  backgroundHex?: string
  fogHex?: string
  fogNearMargin?: number
  fogFarMargin?: number
  viewDistance?: number
  fov?: number
  exposure?: number
  lightDistanceFactor?: number
  ambient?: AmbientOverrides
  hemisphere?: HemisphereOverrides
  key?: DirectionalOverrides
  rim?: DirectionalOverrides
  bloom?: {
    intensity?: number
    radius?: number
    luminanceSmoothing?: number
    mipmapBlur?: boolean
  }
}

/** Options for {@link buildEnvironmentPlan}. */
export interface EnvironmentOptions {
  /** A layout already settled by another layer — reuse it instead of settling again. */
  layout?: ForceLayout
  /** Passed through to the settlement pass (M2-T2) when no layout is supplied. */
  settlement?: SettlementOptions
  rig?: EnvironmentRigOverrides
  calibration?: CalibrationOverrides
}

// ── Derived geometry ────────────────────────────────────────────────────────

/** Cloud radius assumed when there is no run to frame. */
const DEFAULT_EXTENT_RADIUS = 2

/** A unit direction from spherical angles: azimuth around +Y, elevation above the plane. */
function directionFromAngles(azimuthDeg: number, elevationDeg: number): Vec3 {
  const azimuth = (azimuthDeg * Math.PI) / 180
  const elevation = (elevationDeg * Math.PI) / 180
  const horizontal = Math.cos(elevation)
  return {
    x: horizontal * Math.cos(azimuth),
    y: Math.sin(elevation),
    z: horizontal * Math.sin(azimuth),
  }
}

/** Scale a unit direction into a placement offset (a fresh object, never aliased). */
function offsetAlong(direction: Vec3, distance: number): Vec3 {
  return {
    x: direction.x * distance,
    y: direction.y * distance,
    z: direction.z * distance,
  }
}

/** A sanitized hex + its linear RGB reading. */
function colorOf(
  value: string | undefined,
  fallback: string,
): { hex: string; color: Rgb } {
  const hex = isHexColor(value) ? value : fallback
  return { hex, color: hexToLinearRgb(hex) }
}

/** Resolve a directional light: colour, intensity and a derived unit direction. */
function directional(
  overrides: DirectionalOverrides | undefined,
  fallback: {
    hex: string
    intensity: number
    azimuthDeg: number
    elevationDeg: number
  },
  extentRadius: number,
  distanceFactor: number,
): DirectionalLightSpec {
  const { hex, color } = colorOf(overrides?.hex, fallback.hex)
  const direction = directionFromAngles(
    clampOption(overrides?.azimuthDeg, fallback.azimuthDeg, -360, 360),
    clampOption(overrides?.elevationDeg, fallback.elevationDeg, -89, 89),
  )
  return {
    hex,
    color,
    intensity: clampOption(overrides?.intensity, fallback.intensity, 0, 100),
    direction,
    offset: offsetAlong(direction, extentRadius * distanceFactor),
  }
}

// ── The plan ────────────────────────────────────────────────────────────────

/**
 * Build the environment/lighting/bloom plan.
 *
 * With a `model`, the settled layout's bounds frame the rig: the fog band is
 * placed around {@link DEFAULT_VIEW_DISTANCE} relative to the cloud's radius, and
 * the lights sit `distanceFactor` radii out — so a wide run and a tight one are lit
 * and fogged proportionately, and nothing is hand-placed for one trace. With no
 * model (the empty scene the app boots on) the rig still describes a valid, dark,
 * unfogged environment: background plus lights, no bloom pass.
 *
 * Pass `options.layout` to reuse a layout another layer already settled; the
 * per-layer double settle is consolidated in M3-T6.
 *
 * @throws EnvironmentRigError when the calibration anchors cannot be satisfied.
 */
export function buildEnvironmentPlan(
  model?: TraceModel,
  options: EnvironmentOptions = {},
): EnvironmentPlan {
  const rig = options.rig ?? {}
  // `rig.exposure` is the convenient shorthand; an explicit calibration override
  // wins over it, and an undefined field never clobbers a defined one.
  const calibrationOverrides: CalibrationOverrides = { ...options.calibration }
  if (calibrationOverrides.exposure === undefined && rig.exposure !== undefined) {
    calibrationOverrides.exposure = rig.exposure
  }
  const calibration = resolveCalibration(calibrationOverrides)

  // ── extent ──
  let bounds: LayoutBounds | null = null
  let settlement: { converged: boolean; iterations: number } | null = null
  let seed: number | null = null
  if (options.layout !== undefined) {
    bounds = options.layout.bounds
    seed = options.layout.seed
  } else if (model !== undefined) {
    const settled = settleLayout(model, options.settlement)
    bounds = settled.layout.bounds
    seed = settled.layout.seed
    settlement = { converged: settled.converged, iterations: settled.iterations }
  }
  const extentRadius =
    bounds !== null && Number.isFinite(bounds.radius) && bounds.radius > 0
      ? bounds.radius
      : DEFAULT_EXTENT_RADIUS

  // ── framing ──
  const viewDistance = clampOption(rig.viewDistance, DEFAULT_VIEW_DISTANCE, 1, 1e4)
  const fov = clampOption(rig.fov, DEFAULT_FOV, 1, 179)

  // ── background + fog ──
  const background = colorOf(rig.backgroundHex, DEFAULT_BACKGROUND_HEX)
  const fogColor = colorOf(rig.fogHex, DEFAULT_FOG_HEX)
  const nearMargin = clampOption(rig.fogNearMargin, DEFAULT_FOG_NEAR_MARGIN, 0, 100)
  const farMargin = clampOption(rig.fogFarMargin, DEFAULT_FOG_FAR_MARGIN, 0, 100)
  const fogNear = Math.max(0.1, viewDistance - extentRadius * nearMargin)
  // Keep the band at least one unit deep, otherwise the fog is a hard edge.
  const fogFar = Math.max(fogNear + 1, viewDistance + extentRadius * farMargin)

  // ── lights ──
  const distanceFactor = clampOption(
    rig.lightDistanceFactor,
    DEFAULT_LIGHT_DISTANCE_FACTOR,
    0,
    100,
  )
  const ambientColor = colorOf(rig.ambient?.hex, '#4a5b7a')
  const hemisphereSky = colorOf(rig.hemisphere?.skyHex, '#2a3d63')
  const hemisphereGround = colorOf(rig.hemisphere?.groundHex, '#05070a')
  const lights: LightRig = {
    ambient: {
      hex: ambientColor.hex,
      color: ambientColor.color,
      intensity: clampOption(rig.ambient?.intensity, 0.18, 0, 100),
    },
    hemisphere: {
      skyHex: hemisphereSky.hex,
      sky: hemisphereSky.color,
      groundHex: hemisphereGround.hex,
      ground: hemisphereGround.color,
      intensity: clampOption(rig.hemisphere?.intensity, 0.55, 0, 100),
    },
    // Key: high and front-right, cool white — the light that shapes a sphere.
    key: directional(
      rig.key,
      { hex: '#dfe9ff', intensity: 1.6, azimuthDeg: 35, elevationDeg: 45 },
      extentRadius,
      distanceFactor,
    ),
    // Rim: low and behind-left — separates the cloud from the background.
    rim: directional(
      rig.rim,
      { hex: '#7fb2ff', intensity: 0.8, azimuthDeg: 215, elevationDeg: 18 },
      extentRadius,
      distanceFactor,
    ),
  }

  // ── bloom ──
  // Bloom needs something that can cross the knee: a cloud with no extent — an
  // empty run, or a lone agent parked at the origin — has no hot region, so the
  // pass would be a full-screen cost that can never fire. Requiring a positive
  // radius is what keeps an empty scene (including one whose layout was reused,
  // M3-T5) from paying for a pass with nothing to bloom.
  const bloomEnabled = bounds !== null && bounds.radius > 0
  const bloom: BloomSpec = {
    enabled: bloomEnabled,
    intensity: clampOption(rig.bloom?.intensity, 1.15, 0, 100),
    luminanceThreshold: calibration.bloomThreshold,
    luminanceSmoothing: clampOption(rig.bloom?.luminanceSmoothing, 0.12, 0, 1),
    radius: clampOption(rig.bloom?.radius, 0.72, 0, 1),
    mipmapBlur: rig.bloom?.mipmapBlur ?? true,
  }

  return {
    backgroundHex: background.hex,
    background: background.color,
    fog: {
      enabled: true,
      hex: fogColor.hex,
      color: fogColor.color,
      near: fogNear,
      far: fogFar,
    },
    toneMapping: 'ACESFilmic',
    exposure: calibration.exposure,
    viewDistance,
    fov,
    lights,
    bloom,
    calibration,
    bounds,
    extentRadius,
    drawCalls: ENVIRONMENT_DRAW_CALLS,
    postProcessPasses: bloomEnabled ? ENVIRONMENT_POST_PROCESS_PASSES : 0,
    settlement,
    seed,
  }
}
