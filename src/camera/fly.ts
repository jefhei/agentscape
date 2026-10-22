/**
 * Fly camera model (M4-T3) — the *pure half* of "move inside the run".
 *
 * Orbit (M4-T2) is the outside view: the camera rides a sphere around the settled
 * cloud and the viewer turns it. That is how you read a run's *shape*. It is not
 * how you read a run's *proximity* — whether a worker's arcs land on the
 * orchestrator's node or miss it by a wide margin, how far a dead branch hangs off
 * the trunk, what the inside of a fan-out looks like from the middle. For that the
 * camera has to go **into** the cloud, which means a first-person camera: an eye
 * position plus a look direction, with nothing constraining it to a sphere.
 *
 * So this module is the fly camera's whole *rule*, as plain data:
 *
 * - **the state** — a {@link FlyCamera} is an eye (**the** state, in first person)
 *   and a yaw/pitch. Unlike orbit, which stores angles and derives the eye, here
 *   the eye *is* the state and the look direction is derived
 *   ({@link flyForward}) — one spherical→cartesian rule, borrowed from the scene
 *   layer, so a fly heading and an orbit azimuth mean the same thing.
 * - **the transitions** — {@link flyLookBy} (a drag, in pixels),
 *   {@link flyMove} (a held key, in axes × real elapsed ms), {@link flyAdvance}
 *   (a wheel notch along the look direction), {@link resetFly} (back to the
 *   opening shot). All pure, all clamped, all deterministic.
 * - **the limits** — pitch stops short of the poles (the same up-vector
 *   degeneracy orbit guards against), and the camera is confined to a **flight
 *   envelope** around the cloud's centre: you can leave the cloud, you cannot get
 *   lost in empty space and lose the run you came to look at.
 * - **the input mappings** — {@link flyInputFromKeys} (WASD / arrows / Q-E /
 *   shift-boost) is a rule, so it lives here where vitest can pin it rather than
 *   inside a DOM handler.
 *
 * ## The three things scaled to the run, never to an absolute number
 *
 * The layout, the fog band, the orbit dolly and the far plane are all expressed
 * against the settled cloud's extent. So are these:
 *
 * 1. **speed** — {@link flySpeed} is radii-per-second, so crossing a 6-agent
 *    fixture and a 400-agent fleet takes the same gesture;
 * 2. **the envelope** — a multiple of the cloud's radius, so "too far out" means
 *    the same thing at every scale;
 * 3. **the far plane** — {@link flyCameraPose} derives it from the envelope, not
 *    from the look distance, so turning around inside a big cloud never clips it.
 *
 * ## Two conventions, both pinned by tests
 *
 * - **A drag means the same thing as in orbit: grab the world.** Dragging right
 *   turns the run right (yaw *decreases*), dragging down tips its top toward you
 *   (pitch *increases*). The frame of reference changed — you are inside the cloud
 *   now — but the gesture did not, so a viewer who learned to orbit does not have
 *   to relearn to fly.
 * - **A diagonal is not faster.** `forward + right` is normalized, so holding W
 *   and D crosses the cloud at the same speed as W alone (the classic
 *   first-person diagonal bug, pinned by a test).
 *
 * ## No clock
 *
 * Time arrives as `deltaMs` (exactly like M4-T1's playback reducer), so the
 * render layer owns the frame clock and this module owns the physics. A single
 * frame's delta is capped ({@link FLY_MAX_FRAME_MS}): a backgrounded tab can
 * report a multi-second gap, and without the cap one frame would fling the camera
 * across the cloud — the same reasoning as the per-event wheel cap in `orbit.ts`.
 *
 * ## Purity (PRD §5)
 *
 * Pure and deterministic: no three.js, no DOM, no clock, no `Math.random`, no
 * mutation of any input. Every function returns either the same object (an
 * identity transition) or a fresh one. Nothing about the rendered *look* is
 * asserted — jsdom has no GPU, and the look is human-reviewed (M5-T5) — but every
 * number the renderer consumes (eye, target, distance, clipping planes, per-frame
 * displacement) is arithmetic and is gated hard.
 */

import type { Vec3 } from '../layout/index.ts'
import { CAMERA_NEAR, cameraFar, directionFromAngles } from '../scene/scenePlan.ts'
import type { SceneCamera } from '../scene/scenePlan.ts'
import { CAMERA_MODE_LABELS } from './modes.ts'
import { normalizeAzimuth, sphericalFromOffset } from './orbit.ts'

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Degrees of yaw/pitch per pixel dragged. Coarser than the orbit's 0.28°/px on
 * purpose: a first-person look is a big move, and a 500 px drag is a ~100° turn —
 * enough to look over your shoulder in one gesture without a second one.
 */
export const FLY_DEGREES_PER_PIXEL = 0.2

/**
 * Pitch limits, degrees above (positive) or below (negative) the horizon. Short
 * of ±90 for the same reason orbit stops at ±80: at the pole the look direction is
 * parallel to the up vector and the view spins. 85° is steeper than orbit's 80°
 * because from inside the cloud a viewer needs to look almost straight up to see a
 * node overhead.
 */
export const FLY_MIN_PITCH_DEG = -85
export const FLY_MAX_PITCH_DEG = 85

/**
 * Flight speed, in cloud radii per second. 0.9 crosses the cloud in about two
 * seconds — slow enough to keep your bearings, fast enough not to feel like a
 * cutscene.
 */
export const FLY_SPEED_RADII_PER_SEC = 0.9

/** Multiplier while shift is held (held keys give no pressure, so this is a button). */
export const FLY_BOOST = 3.5

/**
 * Most real time one frame may contribute, milliseconds. A backgrounded tab
 * reports multi-second deltas; without this cap one such frame would teleport the
 * camera through the cloud instead of moving it.
 */
export const FLY_MAX_FRAME_MS = 100

/** Radii travelled along the look direction per wheel step (a notch is 0.35). */
export const FLY_ADVANCE_RADII_PER_STEP = 0.35

/**
 * How many cloud radii from the centre the camera may fly. Wide enough to back
 * out and see the whole cloud, tight enough that the run is still in front of you.
 */
export const FLY_ENVELOPE_RADII = 3

/** Scale used when the scene has no extent (an empty run): one world unit. */
export const FLY_MIN_SCALE = 1

/** Floor for the flight envelope, world units, so an empty scene still has room. */
export const FLY_MIN_ENVELOPE = 2

/**
 * Floor for the look-ahead distance (the distance to the derived look-at point),
 * world units. A degenerate scene still needs a target in front of the eye rather
 * than at the eye.
 */
export const FLY_MIN_LOOKAHEAD = 1

/** Tolerance for float comparisons that should be exact-but-for-rounding. */
const EPSILON = 1e-9

/**
 * World up, as a unit vector — the spherical rule's own reading of straight up,
 * so this module owns no direction math of its own (and authors no coordinate).
 */
const WORLD_UP: Vec3 = Object.freeze(directionFromAngles(0, 90))

/** The origin, as a named all-zero sentinel (a run with no extent). */
const ORIGIN: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 })

// ── State ───────────────────────────────────────────────────────────────────

/**
 * A flying camera: **where the eye is**, **where it looks** (yaw + pitch), and the
 * opening shot to return to. The eye is the state here — in first person there is
 * no sphere to derive it from — and it is always *earned*: seeded from the pose
 * the mode switch left, then moved only by {@link flyMove} / {@link flyAdvance}.
 */
export interface FlyCamera {
  /** Eye position in world space — the live state of a first-person camera. */
  position: Vec3
  /** Live yaw, degrees around +Y, `[0, 360)`. */
  yawDeg: number
  /** Live pitch, degrees above the horizon, clamped to the tilt limits. */
  pitchDeg: number
  /** The eye the mode switch handed over — the reset position. */
  basePosition: Vec3
  /** The opening yaw (the pose the switch handed over). */
  baseYawDeg: number
  /** The opening pitch. */
  basePitchDeg: number
  /** The cloud's centre: what the envelope is measured from. */
  home: Vec3
  /** How far from {@link home} the eye may travel, world units. */
  envelopeRadius: number
  /** Vertical field of view, from the scene plan (the rig's own). */
  fov: number
  /** Near clip plane, from the scene plan. */
  near: number
  /** Settled cloud radius — what the speed and the far plane are expressed against. */
  extentRadius: number
}

/** One frame's movement intent: each axis in `[-1, 1]`, camera-relative. */
export interface FlyAxes {
  /** `+1` = along the look direction, `-1` = backwards. */
  forward: number
  /** `+1` = to the viewer's right. */
  right: number
  /** `+1` = world up. */
  up: number
}

/** A keyboard reading: the axes the held keys ask for, and whether shift is down. */
export interface FlyInput {
  axes: FlyAxes
  boost: boolean
}

/** A pointer drag, in CSS pixels (positive `dx` = right, positive `dy` = down). */
export interface FlyDelta {
  dxPx: number
  dyPx: number
}

/** What the camera bar prints while flying. */
export interface FlyReadout {
  mode: 'fly'
  modeLabel: string
  /** Normalized yaw, rounded: `'270°'`. */
  headingLabel: string
  /** Pitch, rounded: `'-18°'`. */
  pitchLabel: string
  /** Height above the cloud's centre, one decimal: `'1.4'`. */
  altitudeLabel: string
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

/** An axis component: finite and inside `[-1, 1]`. */
function unitAxis(value: number): number {
  return clamp(finite(value, 0), -1, 1)
}

/** Euclidean length of two points' offset. */
function distanceBetween(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

// ── Scalar rules ────────────────────────────────────────────────────────────

/** A pitch inside the tilt limits. */
export function clampPitch(deg: number): number {
  return clamp(finite(deg, 0), FLY_MIN_PITCH_DEG, FLY_MAX_PITCH_DEG)
}

/**
 * The scale a fly camera's speed and wheel advance are expressed in: the settled
 * cloud's radius, or {@link FLY_MIN_SCALE} for a degenerate (empty) run.
 */
export function flyScale(fly: FlyCamera): number {
  const radius = finite(fly.extentRadius, 0)
  return radius > 0 ? radius : FLY_MIN_SCALE
}

/** World units per second at the current scale (and boost). */
export function flySpeed(fly: FlyCamera, boost = false): number {
  return flyScale(fly) * FLY_SPEED_RADII_PER_SEC * (boost ? FLY_BOOST : 1)
}

/** How far in front of the eye the derived look-at point sits. */
export function flyLookAhead(fly: FlyCamera): number {
  const radius = finite(fly.extentRadius, 0)
  return radius > 0 ? radius : FLY_MIN_LOOKAHEAD
}

/** The unit vector the camera looks along — the one spherical→cartesian rule. */
export function flyForward(fly: FlyCamera): Vec3 {
  return directionFromAngles(fly.yawDeg, fly.pitchDeg)
}

/**
 * The viewer's right, as a unit horizontal vector: the look direction crossed with
 * world up, written out ({@link WORLD_UP} is (0,1,0), so the cross product is
 * `(-forward.z, 0, forward.x)` normalized). Kept horizontal so a strafe never
 * drifts vertically and a look almost straight up does not invert it; at the pole
 * (`|horizontal| ≈ 0`, unreachable because pitch is clamped short of ±90) it falls
 * back to the horizontal right of the yaw.
 */
export function flyRight(fly: FlyCamera): Vec3 {
  const forward = flyForward(fly)
  const horizontal = Math.hypot(forward.x, forward.z)
  if (!(horizontal > EPSILON)) {
    return directionFromAngles(normalizeAzimuth(fly.yawDeg + 90), 0)
  }
  return { x: -forward.z / horizontal, y: 0, z: forward.x / horizontal }
}

// ── Creation ────────────────────────────────────────────────────────────────

/**
 * Start flying from a camera pose — the pose the viewer is already looking at.
 *
 * That pose is the orbit's current pose when the mode switch fires (M4-T3
 * consumes it, so switching does not teleport the view), or the scene plan's
 * opening shot on first mount. Two consequences worth knowing:
 *
 * - **the eye is taken as-is**, so the fly camera starts exactly where the camera
 *   was. The look angles are read back off the pose with
 *   {@link sphericalFromOffset} — the *inverse* spherical reading orbit already
 *   uses, so the two modes cannot disagree about what a heading means;
 * - **`home` is the pose's target**, which for every scene plan is the settled
 *   cloud's centre (M3-T6). The flight envelope is measured from it, and it is
 *   widened to contain the opening eye plus one radius, so the very first move
 *   never snaps the camera inward.
 *
 * Pure; copies every vector, so a later move cannot mutate the scene plan.
 */
export function createFlyCamera(camera: SceneCamera, extentRadius: number): FlyCamera {
  const position: Vec3 = {
    x: finite(camera.position.x, 0),
    y: finite(camera.position.y, 0),
    z: finite(camera.position.z, 0),
  }
  const home: Vec3 = {
    x: finite(camera.target.x, 0),
    y: finite(camera.target.y, 0),
    z: finite(camera.target.z, 0),
  }
  // The look direction is target − eye, i.e. the negated eye offset: reading the
  // offset from the *target* to the eye is the direction to look from, its
  // negation is the direction to look along.
  const spherical = sphericalFromOffset({
    x: position.x - home.x,
    y: position.y - home.y,
    z: position.z - home.z,
  })
  const yawDeg = normalizeAzimuth(spherical.azimuthDeg + 180)
  const pitchDeg = clampPitch(-spherical.elevationDeg)
  const radius = finite(extentRadius, 0) > 0 ? extentRadius : 0
  const openingDistance = distanceBetween(position, home)
  // The envelope must contain the shot we open on, plus one radius of room, or
  // the first move would clamp the camera back toward the centre.
  const envelopeRadius = Math.max(
    radius * FLY_ENVELOPE_RADII,
    openingDistance + radius,
    FLY_MIN_ENVELOPE,
  )
  const fovValue = finite(camera.fov, 0)
  const nearValue = finite(camera.near, CAMERA_NEAR)

  return {
    position,
    yawDeg,
    pitchDeg,
    basePosition: { x: position.x, y: position.y, z: position.z },
    baseYawDeg: yawDeg,
    basePitchDeg: pitchDeg,
    home,
    envelopeRadius,
    fov: fovValue > 0 ? fovValue : 55,
    near: nearValue > 0 ? nearValue : CAMERA_NEAR,
    extentRadius: radius,
  }
}

// ── Pose ────────────────────────────────────────────────────────────────────

/**
 * The renderer-ready camera for a fly state.
 *
 * The eye is the state; the look-at point is one look-ahead in front of it
 * (`max(extentRadius, FLY_MIN_LOOKAHEAD)`), so the derived target sits at the
 * cloud's own scale rather than at an arbitrary probe distance.
 *
 * **The far plane is derived from the flight envelope, not from the look-ahead.**
 * A fly camera can sit at one edge of the envelope and look across the whole
 * cloud; deriving `far` from the distance to the look-at point would clip the far
 * side the moment the viewer turned around. The envelope plus
 * {@link CAMERA_FAR_MARGIN} radii covers every point of the cloud from anywhere
 * the camera is allowed to be. Near stays the plan's small value (M3-T6 chose
 * 0.1 precisely so a camera *inside* the cloud is not clipped open).
 *
 * Pure; returns fresh objects only.
 */
export function flyCameraPose(fly: FlyCamera): SceneCamera {
  const lookAhead = flyLookAhead(fly)
  const forward = flyForward(fly)
  return {
    position: { x: fly.position.x, y: fly.position.y, z: fly.position.z },
    target: {
      x: fly.position.x + forward.x * lookAhead,
      y: fly.position.y + forward.y * lookAhead,
      z: fly.position.z + forward.z * lookAhead,
    },
    fov: fly.fov,
    near: fly.near,
    far: cameraFar(fly.envelopeRadius, fly.extentRadius),
    distance: lookAhead,
  }
}

// ── Transitions ─────────────────────────────────────────────────────────────

/**
 * Look around with a drag, in pixels. **Grab-the-world**, the same convention as
 * orbit: dragging right turns the run right (yaw decreases, the view swings left),
 * dragging down tips the run's top toward the viewer (pitch increases). Pitch
 * clamps at the tilt limits, yaw wraps. A zero or non-finite drag returns the
 * *same object*, so pointer jitter does not re-render the camera.
 */
export function flyLookBy(fly: FlyCamera, delta: FlyDelta): FlyCamera {
  const dxPx = finite(delta.dxPx, 0)
  const dyPx = finite(delta.dyPx, 0)
  if (dxPx === 0 && dyPx === 0) return fly
  const yawDeg = normalizeAzimuth(fly.yawDeg - dxPx * FLY_DEGREES_PER_PIXEL)
  const pitchDeg = clampPitch(fly.pitchDeg + dyPx * FLY_DEGREES_PER_PIXEL)
  if (yawDeg === fly.yawDeg && pitchDeg === fly.pitchDeg) return fly
  return { ...fly, yawDeg, pitchDeg }
}

/** The axes as movement intent: each component finite and inside `[-1, 1]`. */
function clampAxes(axes: FlyAxes): FlyAxes {
  return {
    forward: unitAxis(axes.forward),
    right: unitAxis(axes.right),
    up: unitAxis(axes.up),
  }
}

/** Whether an axes reading asks the camera to move at all. */
export function flyIsMoving(axes: FlyAxes): boolean {
  return (
    unitAxis(axes.forward) !== 0 ||
    unitAxis(axes.right) !== 0 ||
    unitAxis(axes.up) !== 0
  )
}

/**
 * The world-space velocity an axes reading asks for, units per second. Camera
 * relative: `forward` along the look direction, `right` along {@link flyRight},
 * `up` along world up.
 *
 * **The composed direction is normalized, and the speed is fixed.** So a diagonal
 * is not faster than a straight line (the classic first-person diagonal bug), and
 * because world up is *not* perpendicular to a pitched look direction, "forward +
 * rise" is not accidentally slower either — the axes choose *where* to go, the run's
 * scale chooses *how fast*. A zero reading is a zero vector (never `NaN`).
 */
export function flyVelocity(fly: FlyCamera, axes: FlyAxes, boost = false): Vec3 {
  const want = clampAxes(axes)
  if (!flyIsMoving(want)) return { x: ORIGIN.x, y: ORIGIN.y, z: ORIGIN.z }
  const forward = flyForward(fly)
  const right = flyRight(fly)
  const direction: Vec3 = {
    x: forward.x * want.forward + right.x * want.right + WORLD_UP.x * want.up,
    y: forward.y * want.forward + right.y * want.right + WORLD_UP.y * want.up,
    z: forward.z * want.forward + right.z * want.right + WORLD_UP.z * want.up,
  }
  const magnitude = Math.hypot(direction.x, direction.y, direction.z)
  if (!(magnitude > 0)) return { x: ORIGIN.x, y: ORIGIN.y, z: ORIGIN.z }
  const speed = flySpeed(fly, boost) / magnitude
  return { x: direction.x * speed, y: direction.y * speed, z: direction.z * speed }
}

/**
 * Move the eye by a world-space offset, confined to the flight envelope.
 *
 * The one path every movement takes (held keys, wheel advance), so the envelope
 * cannot be enforced in one of them and forgotten in the other. Outside the
 * envelope the camera is pulled back onto its surface along the offset direction —
 * it slides around the boundary instead of stopping dead, which is what keeps a
 * held key from feeling like a wall. A zero offset is an identity (same object).
 */
function translated(fly: FlyCamera, offset: Vec3): FlyCamera {
  const dx = finite(offset.x, 0)
  const dy = finite(offset.y, 0)
  const dz = finite(offset.z, 0)
  if (dx === 0 && dy === 0 && dz === 0) return fly
  const wanted: Vec3 = {
    x: fly.position.x + dx,
    y: fly.position.y + dy,
    z: fly.position.z + dz,
  }
  const fromHome = distanceBetween(wanted, fly.home)
  const envelope = finite(fly.envelopeRadius, FLY_MIN_ENVELOPE)
  if (fromHome <= envelope || !(fromHome > 0)) {
    return { ...fly, position: wanted }
  }
  const pull = envelope / fromHome
  return {
    ...fly,
    position: {
      x: fly.home.x + (wanted.x - fly.home.x) * pull,
      y: fly.home.y + (wanted.y - fly.home.y) * pull,
      z: fly.home.z + (wanted.z - fly.home.z) * pull,
    },
  }
}

/**
 * Fly for one frame: `axes` × `deltaMs` of real time, at the run's own speed
 * (× {@link FLY_BOOST} with shift). The frame delta is capped at
 * {@link FLY_MAX_FRAME_MS} so a stalled tab cannot fling the camera across the
 * cloud. A zero reading, a non-positive delta or a non-finite delta is an identity
 * (same object), so a parked camera costs no re-render.
 */
export function flyMove(
  fly: FlyCamera,
  axes: FlyAxes,
  deltaMs: number,
  boost = false,
): FlyCamera {
  const elapsed = finite(deltaMs, 0)
  if (!(elapsed > 0)) return fly
  const velocity = flyVelocity(fly, axes, boost)
  if (velocity.x === 0 && velocity.y === 0 && velocity.z === 0) return fly
  const seconds = Math.min(elapsed, FLY_MAX_FRAME_MS) / 1000
  return translated(fly, {
    x: velocity.x * seconds,
    y: velocity.y * seconds,
    z: velocity.z * seconds,
  })
}

/**
 * Advance along the look direction by wheel `steps` (positive = forward, the same
 * sign convention as orbit's dolly: scroll up moves you in). A step is
 * {@link FLY_ADVANCE_RADII_PER_STEP} cloud radii — scaled to the run like the
 * speed — and the move is confined to the envelope. Zero and non-finite steps are
 * identities.
 */
export function flyAdvance(fly: FlyCamera, steps: number): FlyCamera {
  const safe = finite(steps, 0)
  if (safe === 0) return fly
  const forward = flyForward(fly)
  const distance = safe * flyScale(fly) * FLY_ADVANCE_RADII_PER_STEP
  return translated(fly, {
    x: forward.x * distance,
    y: forward.y * distance,
    z: forward.z * distance,
  })
}

/**
 * Back to the shot the mode switch handed over — the eye, yaw and pitch the fly
 * camera was created with. Byte-identical to a fresh {@link createFlyCamera} for
 * the same pose (pinned by a test), and an identity when already there.
 */
export function resetFly(fly: FlyCamera): FlyCamera {
  const atBase =
    fly.position.x === fly.basePosition.x &&
    fly.position.y === fly.basePosition.y &&
    fly.position.z === fly.basePosition.z &&
    fly.yawDeg === fly.baseYawDeg &&
    fly.pitchDeg === fly.basePitchDeg
  if (atBase) return fly
  return {
    ...fly,
    position: {
      x: fly.basePosition.x,
      y: fly.basePosition.y,
      z: fly.basePosition.z,
    },
    yawDeg: fly.baseYawDeg,
    pitchDeg: fly.basePitchDeg,
  }
}

// ── Input mappings ──────────────────────────────────────────────────────────

/**
 * The movement keys and what each contributes. WASD and the arrows move in the
 * horizontal plane (forward/back, strafe), Q/E (and PageDown/PageUp) move along
 * world up. Shift is the boost and is handled by {@link flyInputFromKeys}, not
 * here — it contributes no axis of its own.
 *
 * Named keys are lowercase because a key event's `key` for an arrow is
 * `'ArrowUp'`; the lookup lowercases, so one table covers both.
 */
export const FLY_KEYS: Readonly<Record<string, FlyAxes>> = Object.freeze({
  w: { forward: 1, right: 0, up: 0 },
  arrowup: { forward: 1, right: 0, up: 0 },
  s: { forward: -1, right: 0, up: 0 },
  arrowdown: { forward: -1, right: 0, up: 0 },
  d: { forward: 0, right: 1, up: 0 },
  arrowright: { forward: 0, right: 1, up: 0 },
  a: { forward: 0, right: -1, up: 0 },
  arrowleft: { forward: 0, right: -1, up: 0 },
  e: { forward: 0, right: 0, up: 1 },
  pageup: { forward: 0, right: 0, up: 1 },
  q: { forward: 0, right: 0, up: -1 },
  pagedown: { forward: 0, right: 0, up: -1 },
})

/**
 * What one key contributes, or `null` if it is not a movement key. `Object.hasOwn`
 * guards the table: a key called `'constructor'` must not read a prototype method
 * and be mistaken for a direction.
 */
export function flyAxisForKey(key: string): FlyAxes | null {
  const lowered = key.toLowerCase()
  if (!Object.hasOwn(FLY_KEYS, lowered)) return null
  const axis = FLY_KEYS[lowered]
  return { forward: axis.forward, right: axis.right, up: axis.up }
}

/**
 * Read a set of held keys as movement intent: every key's contribution summed, each
 * axis clamped to `[-1, 1]` (W *and* ↑ is still "forward", not twice as fast —
 * {@link flyMove} also normalizes, so an analogue input behaves the same way), and
 * shift (either case) read as the boost.
 *
 * Keys are looked up case-insensitively, so `'W'` from a shifted keyboard works,
 * and unknown keys are ignored rather than throwing: a viewer may hold anything.
 */
export function flyInputFromKeys(keys: Iterable<string>): FlyInput {
  let forward = 0
  let right = 0
  let up = 0
  let boost = false
  for (const key of keys) {
    if (key.toLowerCase() === 'shift') {
      boost = true
      continue
    }
    const axis = flyAxisForKey(key)
    if (axis === null) continue
    forward += axis.forward
    right += axis.right
    up += axis.up
  }
  return {
    axes: {
      forward: clamp(forward, -1, 1),
      right: clamp(right, -1, 1),
      up: clamp(up, -1, 1),
    },
    boost,
  }
}

// ── Readout ─────────────────────────────────────────────────────────────────

/** The camera bar's readout: the same numbers the transitions act on. */
export function describeFly(fly: FlyCamera): FlyReadout {
  const heading = normalizeAzimuth(fly.yawDeg)
  const pitch = clampPitch(fly.pitchDeg)
  const altitude = finite(fly.position.y, 0) - finite(fly.home.y, 0)
  return {
    mode: 'fly',
    modeLabel: CAMERA_MODE_LABELS.fly,
    headingLabel: `${Math.round(heading)}°`,
    pitchLabel: `${Math.round(pitch)}°`,
    altitudeLabel: altitude.toFixed(1),
  }
}
