/**
 * Orbit camera model (M4-T2) — the *pure half* of "survey the run shape".
 *
 * M3-T6 framed the scene once, from a fixed survey direction: azimuth 90°,
 * elevation 18°, at the rig's own framing distance. That is the right *opening*
 * shot and a bad *only* shot — a force-directed cloud is a volume, and the
 * structural facts the product exists to show (a fan-out's width, a loop's
 * closure, a dead branch hanging off to one side) are partly facts about its
 * depth. Orbiting the cloud is how a viewer reads them.
 *
 * So this module is the orbit camera's whole *rule*, as plain data:
 *
 * - **the pose** — an {@link OrbitCamera} is a look-at target, two angles and a
 *   zoom; {@link orbitCameraPose} turns it into the `SceneCamera` the renderer
 *   applies (`position`, `target`, fov, near, far). The camera never stores an
 *   eye position, so "orbit" cannot drift into "wander": every pose is
 *   `target + direction(azimuth, elevation) · distance`.
 * - **the transitions** — {@link orbitBy} (a pointer drag in pixels),
 *   {@link zoomBy} (dolly steps), {@link resetOrbit} (back to the opening shot),
 *   all pure and clamped.
 * - **the limits** — elevation is clamped short of the poles (a camera exactly
 *   above its target has an undefined up vector), and the dolly range is
 *   expressed as a multiple of the *scene's own framing distance* rather than an
 *   absolute number, so it scales with the run exactly as the layout and the fog
 *   band do.
 * - **the input mappings** — {@link wheelZoomSteps} turns a wheel event into
 *   dolly steps (pixels / lines / pages, clamped per event) and
 *   {@link describeOrbit} formats the readout. Both are rules, so both live here
 *   where vitest can pin them, not inside a DOM handler.
 *
 * ## The drag convention is "grab the cloud"
 *
 * Dragging **right** turns the cloud right (the camera moves left around it, so
 * azimuth *decreases*); dragging **down** tips the cloud's top toward you (the
 * camera rises, so elevation *increases*). That is the convention every map and
 * model viewer uses, and it is pinned by tests so a later refactor cannot quietly
 * invert the scene under the user's hand.
 *
 * ## Purity (PRD §5)
 *
 * Pure and deterministic: no three.js, no DOM, no clock, no `Math.random`, no
 * mutation of any argument. The pointer and wheel events themselves are read in
 * the render layer (`OrbitCameraRig.tsx`) and only their *numbers* arrive here, so
 * the same base camera plus the same drag sequence always yields a byte-identical
 * pose. Nothing about the rendered *look* is asserted — jsdom has no GPU, and the
 * look is human-reviewed (M5-T5) — but the geometry (angles, distance, clipping
 * planes, round-trips) is arithmetic and is gated hard.
 *
 * ## Scope
 *
 * One mode: **orbit**. The fly camera and the mode switch landed in M4-T3
 * (`./fly.ts` + `./modes.ts` + `./cameraState.ts`); this module still owns only
 * the outside view, and the *lookups* the detail panel needs (M4-T4) are not here
 * either.
 */

import type { Vec3 } from '../layout/index.ts'
import {
  CAMERA_AZIMUTH_DEG,
  CAMERA_ELEVATION_DEG,
  CAMERA_NEAR,
  cameraFar,
  directionFromAngles,
} from '../scene/scenePlan.ts'
import type { SceneCamera } from '../scene/scenePlan.ts'
import { CAMERA_MODE_LABELS } from './modes.ts'

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Degrees of rotation per pixel dragged. A 500 px drag turns the cloud ~140°,
 * which is a half-turn on a laptop trackpad without a second gesture.
 */
export const ORBIT_DEGREES_PER_PIXEL = 0.28

/**
 * How far the camera may tilt, degrees above (positive) or below (negative) the
 * horizon. Deliberately short of ±90: at the poles the look-at direction is
 * parallel to the default up vector and the view spins. 80° still lets a viewer
 * look almost straight down the y axis, which is enough to read a fan-out's
 * spread.
 */
export const ORBIT_MIN_ELEVATION_DEG = -80
export const ORBIT_MAX_ELEVATION_DEG = 80

/**
 * Dolly range as a multiple of the scene's own framing distance. Below ~0.35 the
 * camera is inside the cloud's near edge for a typical fixture (orbit is the
 * *outside* view; M4-T3's fly mode is how you go inside); above 3× the fog band
 * has already faded the cloud out, so more distance only adds emptiness.
 */
export const ORBIT_MIN_ZOOM = 0.35
export const ORBIT_MAX_ZOOM = 3

/** Multiplier one dolly step applies to the zoom (`> 1` = closer). */
export const ORBIT_ZOOM_STEP = 1.15

/** Wheel delta (in pixels) that counts as one dolly step. */
export const ORBIT_WHEEL_PIXELS_PER_STEP = 120

/** Pixels a wheel event in LINE mode is worth (`deltaMode === 1`). */
export const ORBIT_WHEEL_LINE_PIXELS = 16

/** Pixels a wheel event in PAGE mode is worth (`deltaMode === 2`). */
export const ORBIT_WHEEL_PAGE_PIXELS = 800

/**
 * Most dolly steps one wheel event may apply. A single flick on a trackpad can
 * report hundreds of pixels; without a cap a stray event would slam the camera
 * from one clamp to the other.
 */
export const ORBIT_WHEEL_MAX_STEPS = 3

/** Tolerance for reading a zoom as "at its limit" (float dolly arithmetic). */
const EPSILON = 1e-9

// ── State ───────────────────────────────────────────────────────────────────

/**
 * An orbiting camera: **where it looks**, **from which direction** and **how
 * close**. The eye position is derived ({@link orbitCameraPose}), never stored —
 * that is what keeps every pose on the orbit sphere.
 *
 * The `base*` fields are the opening shot (the scene plan's own framing, M3-T6):
 * they define the reset pose and the dolly range. `azimuthDeg` / `elevationDeg` /
 * `zoom` are the live state.
 */
export interface OrbitCamera {
  /** Look-at point in world space — the settled cloud's centre. */
  target: Vec3
  /** Opening azimuth, degrees around +Y, `[0, 360)`. */
  baseAzimuthDeg: number
  /** Opening elevation, degrees above the horizon, clamped. */
  baseElevationDeg: number
  /** Live azimuth, degrees around +Y, `[0, 360)`. */
  azimuthDeg: number
  /** Live elevation, degrees above the horizon, clamped. */
  elevationDeg: number
  /** Live dolly: `1` = the opening framing distance; `> 1` is closer. */
  zoom: number
  /** Eye-to-target distance of the opening shot, world units. */
  baseDistance: number
  /** Vertical field of view, from the scene plan (the rig's own). */
  fov: number
  /** Near clip plane, from the scene plan. */
  near: number
  /** Settled cloud radius — what the far plane is expressed against. */
  extentRadius: number
}

/** A pointer drag, in CSS pixels (positive `dx` = right, positive `dy` = down). */
export interface OrbitDelta {
  dxPx: number
  dyPx: number
}

/** Optional starting state for {@link createOrbitCamera}. */
export interface OrbitOptions {
  /** Starting dolly; clamped to the range. Default `1` (the opening shot). */
  zoom?: number
}

/** What the camera bar prints — the same derivation the controls act on. */
export interface OrbitReadout {
  /** Literal, so an `OrbitReadout` is one arm of a discriminated union (M4-T3). */
  mode: 'orbit'
  modeLabel: string
  /** Normalized azimuth, rounded: `'90°'`. */
  azimuthLabel: string
  /** Elevation, rounded: `'18°'`. */
  elevationLabel: string
  /** Dolly-framed distance, one decimal: `'12.0'`. */
  distanceLabel: string
  /** `'1.00×'`. */
  zoomLabel: string
  /** Whole-percent zoom (`100` at the opening shot). */
  zoomPercent: number
}

// ── Scalar helpers ──────────────────────────────────────────────────────────

/** A finite number, or the fallback. */
function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/** `value` inside `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * An angle in degrees wrapped into `[0, 360)`. `-0` and `360` both normalize to
 * `0`, so the state never carries two representations of "north".
 */
export function normalizeAzimuth(deg: number): number {
  const wrapped = ((finite(deg, 0) % 360) + 360) % 360
  return wrapped === 0 ? 0 : wrapped
}

/** An elevation inside the tilt limits. */
export function clampElevation(deg: number): number {
  return clamp(finite(deg, 0), ORBIT_MIN_ELEVATION_DEG, ORBIT_MAX_ELEVATION_DEG)
}

/**
 * The spherical reading of an eye **offset** (eye − target): the direction the
 * camera looks *from*, as azimuth/elevation in degrees, plus its length.
 *
 * This is how {@link createOrbitCamera} starts from the scene plan's hand-off
 * camera without re-deciding the opening shot: the plan says where the eye is,
 * and this says what that means as an orbit. A zero offset (a degenerate plan)
 * reads as the +X horizon rather than `NaN`.
 */
export function sphericalFromOffset(offset: Vec3): {
  azimuthDeg: number
  elevationDeg: number
  distance: number
} {
  const x = finite(offset.x, 0)
  const y = finite(offset.y, 0)
  const z = finite(offset.z, 0)
  const distance = Math.sqrt(x * x + y * y + z * z)
  if (!(distance > 0)) {
    return { azimuthDeg: 0, elevationDeg: 0, distance: 0 }
  }
  return {
    azimuthDeg: normalizeAzimuth((Math.atan2(z, x) * 180) / Math.PI),
    elevationDeg: clampElevation(
      (Math.asin(clamp(y / distance, -1, 1)) * 180) / Math.PI,
    ),
    distance,
  }
}

// ── Creation ────────────────────────────────────────────────────────────────

/**
 * Start orbiting from the scene plan's own camera (M3-T6).
 *
 * The opening pose **is** that camera: `createOrbitCamera(plan.camera, …)` then
 * `orbitCameraPose` reproduces `plan.camera` (position, target, fov, near, far)
 * for a normal plan — pinned by a test — so landing this mode changes the shot
 * only when the viewer moves it. `extentRadius` is the settled cloud's radius
 * (the rig's own number) and is what the far plane is derived against as the
 * viewer dollies.
 *
 * Pure. The target is copied, never aliased, so a later pose cannot mutate the
 * scene plan.
 */
export function createOrbitCamera(
  camera: SceneCamera,
  extentRadius: number,
  options: OrbitOptions = {},
): OrbitCamera {
  const target: Vec3 = {
    x: finite(camera.target.x, 0),
    y: finite(camera.target.y, 0),
    z: finite(camera.target.z, 0),
  }
  const offset: Vec3 = {
    x: finite(camera.position.x, 0) - target.x,
    y: finite(camera.position.y, 0) - target.y,
    z: finite(camera.position.z, 0) - target.z,
  }
  const spherical = sphericalFromOffset(offset)
  // The plan's own `distance` is the rig's framing distance (M3-T6 documents it as
  // `viewDistance`), so it is authoritative when present: the eye offset measured
  // back from the position is the same length only to within rounding, and the
  // opening pose must reproduce the plan *exactly*. The offset remains the
  // fallback for a camera that only carries a position.
  const declared = finite(camera.distance, 0)
  const baseDistance =
    declared > 0 ? declared : spherical.distance > 0 ? spherical.distance : 1
  const azimuthDeg =
    spherical.distance > 0 ? spherical.azimuthDeg : normalizeAzimuth(CAMERA_AZIMUTH_DEG)
  const elevationDeg =
    spherical.distance > 0
      ? spherical.elevationDeg
      : clampElevation(CAMERA_ELEVATION_DEG)
  const fovValue = finite(camera.fov, 0)
  const fov = fovValue > 0 ? fovValue : 55
  const nearValue = finite(camera.near, CAMERA_NEAR)
  const near = nearValue > 0 ? nearValue : CAMERA_NEAR

  return {
    target,
    baseAzimuthDeg: azimuthDeg,
    baseElevationDeg: elevationDeg,
    azimuthDeg,
    elevationDeg,
    zoom: clamp(finite(options.zoom ?? 1, 1), ORBIT_MIN_ZOOM, ORBIT_MAX_ZOOM),
    baseDistance,
    fov,
    near,
    extentRadius: finite(extentRadius, 0) > 0 ? extentRadius : 0,
  }
}

// ── Pose ────────────────────────────────────────────────────────────────────

/** Eye-to-target distance for the current dolly. */
export function orbitDistance(orbit: OrbitCamera): number {
  const zoom = finite(orbit.zoom, 1)
  const distance = orbit.baseDistance / (zoom > 0 ? zoom : 1)
  return Number.isFinite(distance) && distance > 0 ? distance : orbit.baseDistance
}

/**
 * The renderer-ready camera for an orbit state: the eye on the orbit sphere, the
 * cloud's centre as the look-at point, and clipping planes that follow the dolly
 * (the far plane is re-derived at every distance, so zooming out never clips the
 * cloud).
 *
 * Pure; returns fresh objects only.
 */
export function orbitCameraPose(orbit: OrbitCamera): SceneCamera {
  const distance = orbitDistance(orbit)
  const direction = directionFromAngles(orbit.azimuthDeg, orbit.elevationDeg)
  return {
    position: {
      x: orbit.target.x + direction.x * distance,
      y: orbit.target.y + direction.y * distance,
      z: orbit.target.z + direction.z * distance,
    },
    target: { x: orbit.target.x, y: orbit.target.y, z: orbit.target.z },
    fov: orbit.fov,
    near: orbit.near,
    far: cameraFar(distance, orbit.extentRadius),
    distance,
  }
}

// ── Transitions ─────────────────────────────────────────────────────────────

/**
 * Rotate the camera by a pointer drag, in pixels. **Grab-the-cloud** convention:
 * dragging right turns the cloud right (azimuth decreases), dragging down tips
 * its top toward the viewer (elevation increases). Elevation clamps at the tilt
 * limits; azimuth wraps. A zero or non-finite drag returns the *same object*, so
 * a fast pointer that reports sub-pixel jitter does not re-render the camera.
 */
export function orbitBy(orbit: OrbitCamera, delta: OrbitDelta): OrbitCamera {
  const dxPx = finite(delta.dxPx, 0)
  const dyPx = finite(delta.dyPx, 0)
  if (dxPx === 0 && dyPx === 0) return orbit
  const azimuthDeg = normalizeAzimuth(orbit.azimuthDeg - dxPx * ORBIT_DEGREES_PER_PIXEL)
  const elevationDeg = clampElevation(
    orbit.elevationDeg + dyPx * ORBIT_DEGREES_PER_PIXEL,
  )
  if (azimuthDeg === orbit.azimuthDeg && elevationDeg === orbit.elevationDeg) {
    return orbit
  }
  return { ...orbit, azimuthDeg, elevationDeg }
}

/**
 * Dolly by `steps` (positive = closer). Multiplicative, so a step is the same
 * proportion of the distance at any zoom, and the range is clamped. Non-finite
 * and zero steps are identities.
 */
export function zoomBy(orbit: OrbitCamera, steps: number): OrbitCamera {
  const safe = finite(steps, 0)
  if (safe === 0) return orbit
  const zoom = clamp(
    orbit.zoom * Math.pow(ORBIT_ZOOM_STEP, safe),
    ORBIT_MIN_ZOOM,
    ORBIT_MAX_ZOOM,
  )
  if (zoom === orbit.zoom) return orbit
  return { ...orbit, zoom }
}

/** Set the dolly directly (clamped) — the seam a slider or a URL would use. */
export function setOrbitZoom(orbit: OrbitCamera, zoom: number): OrbitCamera {
  const next = clamp(finite(zoom, orbit.zoom), ORBIT_MIN_ZOOM, ORBIT_MAX_ZOOM)
  return next === orbit.zoom ? orbit : { ...orbit, zoom: next }
}

/**
 * Back to the opening shot: the scene plan's own framing, at the scene plan's own
 * distance. Byte-identical to a freshly created orbit for the same base camera
 * (pinned by a test), so "reset" cannot mean "some other default".
 */
export function resetOrbit(orbit: OrbitCamera): OrbitCamera {
  if (
    orbit.azimuthDeg === orbit.baseAzimuthDeg &&
    orbit.elevationDeg === orbit.baseElevationDeg &&
    orbit.zoom === 1
  ) {
    return orbit
  }
  return {
    ...orbit,
    azimuthDeg: orbit.baseAzimuthDeg,
    elevationDeg: orbit.baseElevationDeg,
    zoom: 1,
  }
}

/** Whether the dolly can still come closer. */
export function canZoomIn(orbit: OrbitCamera): boolean {
  return orbit.zoom < ORBIT_MAX_ZOOM - EPSILON
}

/** Whether the dolly can still go further out. */
export function canZoomOut(orbit: OrbitCamera): boolean {
  return orbit.zoom > ORBIT_MIN_ZOOM + EPSILON
}

/** The dolly range as distances, for a HUD or a test. */
export function orbitDistanceRange(orbit: OrbitCamera): { min: number; max: number } {
  return {
    min: orbit.baseDistance / ORBIT_MAX_ZOOM,
    max: orbit.baseDistance / ORBIT_MIN_ZOOM,
  }
}

// ── Input mappings ──────────────────────────────────────────────────────────

/**
 * Dolly steps for one wheel event. **Scroll up (negative `deltaY`) zooms in** —
 * the browser convention — and a line-mode or page-mode event is converted to
 * pixels first, so a logged mouse and a trackpad behave alike. The result is
 * clamped to {@link ORBIT_WHEEL_MAX_STEPS} per event, and non-finite deltas are
 * `0` (identity), never `NaN`.
 */
export function wheelZoomSteps(deltaY: number, deltaMode = 0): number {
  const raw = finite(deltaY, 0)
  if (raw === 0) return 0
  const pixels =
    raw *
    (deltaMode === 1
      ? ORBIT_WHEEL_LINE_PIXELS
      : deltaMode === 2
        ? ORBIT_WHEEL_PAGE_PIXELS
        : 1)
  const steps = clamp(
    -pixels / ORBIT_WHEEL_PIXELS_PER_STEP,
    -ORBIT_WHEEL_MAX_STEPS,
    ORBIT_WHEEL_MAX_STEPS,
  )
  return steps === 0 ? 0 : steps
}

/** The camera bar's readout: the same numbers the transitions act on. */
export function describeOrbit(orbit: OrbitCamera): OrbitReadout {
  const azimuth = normalizeAzimuth(orbit.azimuthDeg)
  const elevation = clampElevation(orbit.elevationDeg)
  const zoom = finite(orbit.zoom, 1) > 0 ? orbit.zoom : 1
  return {
    mode: 'orbit',
    modeLabel: CAMERA_MODE_LABELS.orbit,
    azimuthLabel: `${Math.round(azimuth)}°`,
    elevationLabel: `${Math.round(elevation)}°`,
    distanceLabel: orbitDistance(orbit).toFixed(1),
    zoomLabel: `${zoom.toFixed(2)}×`,
    zoomPercent: Math.round(zoom * 100),
  }
}
