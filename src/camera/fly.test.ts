import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildFixture } from '../fixtures/index.ts'
import { findHandAuthoredCoordinates } from '../layout/index.ts'
import { buildScenePlan, cameraFar } from '../scene/scenePlan.ts'
import {
  FLY_ADVANCE_RADII_PER_STEP,
  FLY_BOOST,
  FLY_DEGREES_PER_PIXEL,
  FLY_KEYS,
  FLY_MAX_FRAME_MS,
  FLY_MAX_PITCH_DEG,
  FLY_MIN_ENVELOPE,
  FLY_MIN_LOOKAHEAD,
  FLY_MIN_PITCH_DEG,
  FLY_SPEED_RADII_PER_SEC,
  clampPitch,
  createFlyCamera,
  describeFly,
  flyAdvance,
  flyAxisForKey,
  flyCameraPose,
  flyForward,
  flyInputFromKeys,
  flyIsMoving,
  flyLookAhead,
  flyLookBy,
  flyMove,
  flyRight,
  flyScale,
  flySpeed,
  flyVelocity,
  resetFly,
} from './fly.ts'
import type { FlyAxes, FlyCamera } from './fly.ts'
import { normalizeAzimuth } from './orbit.ts'

/**
 * Tests for the pure fly camera (M4-T3).
 *
 * The camera is geometry, not pixels: the eye, the look-at target, the clipping
 * planes and every per-frame displacement are arithmetic on the scene plan's own
 * framing, so they are gated here as hard as the data layer (PRD §5). Nothing about
 * the rendered *look* is asserted — that is human-held (M5-T5).
 *
 * The base camera is the REAL fan-out scene plan (data → layout → scene), not a
 * hand-written literal, so "flying starts where the camera already was" and "the
 * speed is the run's own scale" are proven against the thing the app actually draws.
 */

const PLAN = buildScenePlan(buildFixture('fan-out').run)
const BASE = PLAN.camera
const EXTENT = PLAN.environment.extentRadius
const FLY = createFlyCamera(BASE, EXTENT)

/** A zero movement reading. */
const STILL: FlyAxes = { forward: 0, right: 0, up: 0 }

/** Forward, strafe-right and rise readings. */
const AHEAD: FlyAxes = { forward: 1, right: 0, up: 0 }
const SIDEWAYS: FlyAxes = { forward: 0, right: 1, up: 0 }
const RISING: FlyAxes = { forward: 0, right: 0, up: 1 }

/** The unit vector from the eye to the pose's target — what "forward" must mean. */
function poseLook(pose: { position: Vec3Like; target: Vec3Like }): {
  x: number
  y: number
  z: number
} {
  const dx = pose.target.x - pose.position.x
  const dy = pose.target.y - pose.position.y
  const dz = pose.target.z - pose.position.z
  const length = Math.hypot(dx, dy, dz)
  return { x: dx / length, y: dy / length, z: dz / length }
}

interface Vec3Like {
  x: number
  y: number
  z: number
}

/** The eye's displacement between two states. */
function displacement(from: FlyCamera, to: FlyCamera): Vec3Like {
  return {
    x: to.position.x - from.position.x,
    y: to.position.y - from.position.y,
    z: to.position.z - from.position.z,
  }
}

/** Length of a vector. */
function length(v: Vec3Like): number {
  return Math.hypot(v.x, v.y, v.z)
}

/** Every finite-position assertion in one place. */
function expectFinitePosition(fly: FlyCamera): void {
  expect(Number.isFinite(fly.position.x)).toBe(true)
  expect(Number.isFinite(fly.position.y)).toBe(true)
  expect(Number.isFinite(fly.position.z)).toBe(true)
}

describe('createFlyCamera — the mode switch hands over a pose (M4-T3)', () => {
  it('starts with the eye exactly where the pose had it', () => {
    expect(FLY.position.x).toBe(BASE.position.x)
    expect(FLY.position.y).toBe(BASE.position.y)
    expect(FLY.position.z).toBe(BASE.position.z)
  })

  it('reads the pose’s look direction as yaw and pitch', () => {
    const forward = flyForward(FLY)
    const look = poseLook(BASE)
    expect(forward.x).toBeCloseTo(look.x, 9)
    expect(forward.y).toBeCloseTo(look.y, 9)
    expect(forward.z).toBeCloseTo(look.z, 9)
    // The survey shot looks back down the eye direction, i.e. 180° round and the
    // negated elevation: 90° azimuth / 18° above the horizon → 270° / -18°.
    expect(FLY.yawDeg).toBeCloseTo(270, 6)
    expect(FLY.pitchDeg).toBeCloseTo(-18, 6)
    expect(FLY.yawDeg).toBe(normalizeAzimuth(FLY.yawDeg))
  })

  it('copies the eye, the home and the base shot instead of aliasing them', () => {
    expect(FLY.position).not.toBe(BASE.position)
    expect(FLY.home).not.toBe(BASE.target)
    expect(FLY.basePosition).not.toBe(FLY.position)
    expect(FLY.home.x).toBe(BASE.target.x)
    expect(FLY.home.y).toBe(BASE.target.y)
    expect(FLY.home.z).toBe(BASE.target.z)
    expect(FLY.baseYawDeg).toBe(FLY.yawDeg)
    expect(FLY.basePitchDeg).toBe(FLY.pitchDeg)
  })

  it('carries the rig’s fov, near plane and cloud extent', () => {
    expect(FLY.fov).toBe(BASE.fov)
    expect(FLY.near).toBe(BASE.near)
    expect(FLY.extentRadius).toBe(EXTENT)
    expect(flyScale(FLY)).toBe(EXTENT)
  })

  it('sizes the envelope from the cloud, and always contains the opening eye', () => {
    // 3 radii of room, or the opening eye plus a radius if the shot is further out
    // than that — never less than the opening eye, or the first move would snap in.
    const openingDistance = length({
      x: FLY.position.x - FLY.home.x,
      y: FLY.position.y - FLY.home.y,
      z: FLY.position.z - FLY.home.z,
    })
    expect(FLY.envelopeRadius).toBeGreaterThanOrEqual(openingDistance)
    expect(FLY.envelopeRadius).toBeGreaterThanOrEqual(EXTENT * 3)
    // And a move straight after creation does not have to be clamped inward.
    expect(length(displacement(FLY, flyMove(FLY, AHEAD, 16)))).toBeGreaterThan(0)
  })

  it('survives a degenerate pose without NaN', () => {
    const degenerate = createFlyCamera(
      {
        position: { x: Number.NaN, y: 0, z: 0 },
        target: { x: 0, y: 0, z: 0 },
        fov: Number.NaN,
        near: Number.NaN,
        far: 0,
        distance: 0,
      },
      0,
    )
    expectFinitePosition(degenerate)
    expect(degenerate.fov).toBe(55)
    expect(degenerate.near).toBe(0.1)
    expect(degenerate.extentRadius).toBe(0)
    expect(degenerate.envelopeRadius).toBe(FLY_MIN_ENVELOPE)
    expect(Number.isFinite(degenerate.yawDeg)).toBe(true)
    expect(Number.isFinite(degenerate.pitchDeg)).toBe(true)
    // A degenerate scale still moves the camera, by one world unit per second.
    expect(flyScale(degenerate)).toBe(1)
    expect(flyLookAhead(degenerate)).toBe(FLY_MIN_LOOKAHEAD)
    expectFinitePosition(flyMove(degenerate, AHEAD, 100))
  })
})

describe('flyCameraPose (M4-T3)', () => {
  it('puts the eye at the state’s position and looks one look-ahead ahead', () => {
    const pose = flyCameraPose(FLY)
    const forward = flyForward(FLY)
    const lookAhead = flyLookAhead(FLY)
    expect(pose.position.x).toBe(FLY.position.x)
    expect(pose.position.y).toBe(FLY.position.y)
    expect(pose.position.z).toBe(FLY.position.z)
    expect(pose.target.x).toBeCloseTo(FLY.position.x + forward.x * lookAhead, 9)
    expect(pose.target.y).toBeCloseTo(FLY.position.y + forward.y * lookAhead, 9)
    expect(pose.target.z).toBeCloseTo(FLY.position.z + forward.z * lookAhead, 9)
    expect(pose.distance).toBe(lookAhead)
    expect(lookAhead).toBe(EXTENT)
  })

  it('carries the fov and the small near plane a camera inside the cloud needs', () => {
    const pose = flyCameraPose(FLY)
    expect(pose.fov).toBe(BASE.fov)
    expect(pose.near).toBe(BASE.near)
    expect(pose.near).toBeLessThan(EXTENT / 2)
  })

  it('derives the far plane from the envelope, not from the look distance', () => {
    const pose = flyCameraPose(FLY)
    expect(pose.far).toBe(cameraFar(FLY.envelopeRadius, EXTENT))
    // The whole cloud is inside the frustum from anywhere in the envelope...
    expect(pose.far).toBeGreaterThan(FLY.envelopeRadius + EXTENT)
    // ...and turning around does not change it (no popping when you look the other way).
    const turned = flyCameraPose(flyLookBy(FLY, { dxPx: 900, dyPx: 0 }))
    expect(turned.far).toBe(pose.far)
    expect(turned.position).toEqual(pose.position)
  })

  it('returns fresh objects: a pose cannot corrupt the state', () => {
    const first = flyCameraPose(FLY)
    first.position.x = 999
    first.target.y = 999
    const second = flyCameraPose(FLY)
    expect(second.position.x).not.toBe(999)
    expect(second.target.y).not.toBe(999)
    expect(FLY.position.x).not.toBe(999)
  })
})

describe('flyLookBy — drag to look (M4-T3)', () => {
  it('turns the run right when dragged right (grab-the-world, as in orbit)', () => {
    const moved = flyLookBy(FLY, { dxPx: 100, dyPx: 0 })
    expect(moved.yawDeg).toBeCloseTo(
      normalizeAzimuth(FLY.yawDeg - 100 * FLY_DEGREES_PER_PIXEL),
      9,
    )
    expect(moved.pitchDeg).toBe(FLY.pitchDeg)
    expect(moved.position).toEqual(FLY.position)
  })

  it('turns the run left when dragged left', () => {
    expect(flyLookBy(FLY, { dxPx: -100, dyPx: 0 }).yawDeg).toBeCloseTo(
      normalizeAzimuth(FLY.yawDeg + 100 * FLY_DEGREES_PER_PIXEL),
      9,
    )
  })

  it('tips the top toward the viewer when dragged down, away when dragged up', () => {
    expect(flyLookBy(FLY, { dxPx: 0, dyPx: 100 }).pitchDeg).toBeCloseTo(
      FLY.pitchDeg + 100 * FLY_DEGREES_PER_PIXEL,
      9,
    )
    expect(flyLookBy(FLY, { dxPx: 0, dyPx: -100 }).pitchDeg).toBeCloseTo(
      FLY.pitchDeg - 100 * FLY_DEGREES_PER_PIXEL,
      9,
    )
  })

  it('moves both angles on a diagonal drag', () => {
    const moved = flyLookBy(FLY, { dxPx: 50, dyPx: 50 })
    expect(moved.yawDeg).toBeCloseTo(
      normalizeAzimuth(FLY.yawDeg - 50 * FLY_DEGREES_PER_PIXEL),
      9,
    )
    expect(moved.pitchDeg).toBeCloseTo(FLY.pitchDeg + 50 * FLY_DEGREES_PER_PIXEL, 9)
  })

  it('clamps pitch short of the poles and stays there', () => {
    expect(flyLookBy(FLY, { dxPx: 0, dyPx: 10_000 }).pitchDeg).toBe(FLY_MAX_PITCH_DEG)
    expect(flyLookBy(FLY, { dxPx: 0, dyPx: -10_000 }).pitchDeg).toBe(FLY_MIN_PITCH_DEG)
    const top = flyLookBy(FLY, { dxPx: 0, dyPx: 10_000 })
    expect(flyLookBy(top, { dxPx: 0, dyPx: 100 })).toBe(top)
    expect(FLY_MAX_PITCH_DEG).toBeLessThan(90)
    expect(FLY_MIN_PITCH_DEG).toBeGreaterThan(-90)
  })

  it('wraps yaw into [0, 360) across north', () => {
    const moved = flyLookBy(FLY, { dxPx: 2000, dyPx: 0 })
    expect(moved.yawDeg).toBeGreaterThanOrEqual(0)
    expect(moved.yawDeg).toBeLessThan(360)
    expect(moved.yawDeg).toBeCloseTo(normalizeAzimuth(270 - 400), 9)
    expect(Object.is(moved.yawDeg, -0)).toBe(false)
  })

  it('is an identity for a zero or non-finite drag, and never mutates', () => {
    expect(flyLookBy(FLY, { dxPx: 0, dyPx: 0 })).toBe(FLY)
    expect(flyLookBy(FLY, { dxPx: Number.NaN, dyPx: 0 })).toBe(FLY)
    expect(flyLookBy(FLY, { dxPx: 0, dyPx: Number.POSITIVE_INFINITY })).toBe(FLY)
    const before = JSON.stringify(FLY)
    const moved = flyLookBy(FLY, { dxPx: 33, dyPx: 44 })
    expect(JSON.stringify(FLY)).toBe(before)
    expect(moved.baseYawDeg).toBe(FLY.baseYawDeg)
    expect(moved.basePosition).toEqual(FLY.basePosition)
    expect(moved.home).toEqual(FLY.home)
    expect(moved.envelopeRadius).toBe(FLY.envelopeRadius)
  })
})

describe('flyVelocity — camera-relative movement (M4-T3)', () => {
  it('moves along the look direction on the forward axis', () => {
    const velocity = flyVelocity(FLY, AHEAD)
    const forward = flyForward(FLY)
    const speed = flySpeed(FLY)
    expect(velocity.x).toBeCloseTo(forward.x * speed, 9)
    expect(velocity.y).toBeCloseTo(forward.y * speed, 9)
    expect(velocity.z).toBeCloseTo(forward.z * speed, 9)
    expect(length(velocity)).toBeCloseTo(speed, 9)
  })

  it('strafes horizontally, perpendicular to the look direction', () => {
    const velocity = flyVelocity(FLY, SIDEWAYS)
    const forward = flyForward(FLY)
    const right = flyRight(FLY)
    expect(velocity.y).toBe(0)
    expect(velocity.x).toBeCloseTo(right.x * flySpeed(FLY), 9)
    expect(velocity.z).toBeCloseTo(right.z * flySpeed(FLY), 9)
    expect(velocity.x * forward.x + velocity.z * forward.z).toBeCloseTo(0, 9)
  })

  it('puts right on the viewer’s right-hand side', () => {
    // Looking along +Z with Y up, the viewer's right is -X (a right-handed frame):
    // pinned so a later sign flip cannot silently mirror the strafe.
    const lookingNorth = flyLookBy(createFlyCamera(BASE, EXTENT), {
      dxPx: (FLY.yawDeg - 90) / FLY_DEGREES_PER_PIXEL,
      dyPx: 0,
    })
    expect(lookingNorth.yawDeg).toBeCloseTo(90, 6)
    const right = flyRight(lookingNorth)
    expect(right.x).toBeCloseTo(-1, 9)
    expect(right.y).toBe(0)
    expect(right.z).toBeCloseTo(0, 9)
  })

  it('rises along world up on the up axis', () => {
    const velocity = flyVelocity(FLY, RISING)
    expect(velocity.x).toBeCloseTo(0, 12)
    expect(velocity.y).toBeCloseTo(flySpeed(FLY), 9)
    expect(velocity.z).toBeCloseTo(0, 12)
  })

  it('does not let a diagonal be faster than a straight line', () => {
    const straight = length(flyVelocity(FLY, AHEAD))
    const diagonal = length(flyVelocity(FLY, { forward: 1, right: 1, up: 0 }))
    const threeWay = length(flyVelocity(FLY, { forward: 1, right: 1, up: 1 }))
    expect(diagonal).toBeCloseTo(straight, 9)
    expect(threeWay).toBeCloseTo(straight, 9)
  })

  it('scales the speed to the run, not to an absolute number', () => {
    const twice = createFlyCamera(
      { ...BASE, position: BASE.position, target: BASE.target },
      EXTENT * 2,
    )
    expect(flySpeed(twice)).toBeCloseTo(flySpeed(FLY) * 2, 9)
    expect(flySpeed(FLY)).toBeCloseTo(EXTENT * FLY_SPEED_RADII_PER_SEC, 9)
  })

  it('boosts with shift', () => {
    expect(flySpeed(FLY, true)).toBeCloseTo(flySpeed(FLY) * FLY_BOOST, 9)
    const boosted = displacement(FLY, flyMove(FLY, AHEAD, 100, true))
    const plain = displacement(FLY, flyMove(FLY, AHEAD, 100))
    expect(length(boosted)).toBeCloseTo(length(plain) * FLY_BOOST, 9)
  })

  it('is a zero vector for a parked camera, and never NaN', () => {
    expect(flyVelocity(FLY, STILL)).toEqual({ x: 0, y: 0, z: 0 })
    expect(flyIsMoving(STILL)).toBe(false)
    const garbage = flyVelocity(FLY, {
      forward: Number.NaN,
      right: 0,
      up: Number.POSITIVE_INFINITY,
    })
    for (const value of Object.values(garbage))
      expect(Number.isFinite(value)).toBe(true)
  })

  it('ignores axes beyond full deflection', () => {
    const huge = displacement(FLY, flyMove(FLY, { forward: 5, right: 0, up: 0 }, 100))
    const one = displacement(FLY, flyMove(FLY, AHEAD, 100))
    expect(length(huge)).toBeCloseTo(length(one), 9)
  })
})

describe('flyMove — held keys, real elapsed time (M4-T3)', () => {
  it('moves by speed × seconds', () => {
    const moved = flyMove(FLY, AHEAD, 100)
    const distance = length(displacement(FLY, moved))
    expect(distance).toBeCloseTo((flySpeed(FLY) * 100) / 1000, 9)
    // The look angles and the base shot are untouched by a move.
    expect(moved.yawDeg).toBe(FLY.yawDeg)
    expect(moved.pitchDeg).toBe(FLY.pitchDeg)
    expect(moved.basePosition).toEqual(FLY.basePosition)
  })

  it('moves backwards on a negative forward axis', () => {
    const back = flyMove(FLY, { forward: -1, right: 0, up: 0 }, 100)
    const ahead = flyMove(FLY, AHEAD, 100)
    const forward = flyForward(FLY)
    // The two displacements are opposite along the look direction, same length.
    const alongAhead = displacement(FLY, ahead)
    const alongBack = displacement(FLY, back)
    expect(
      alongAhead.x * forward.x + alongAhead.y * forward.y + alongAhead.z * forward.z,
    ).toBeGreaterThan(0)
    expect(
      alongBack.x * forward.x + alongBack.y * forward.y + alongBack.z * forward.z,
    ).toBeLessThan(0)
    expect(length(alongBack)).toBeCloseTo(length(alongAhead), 9)
  })

  it('caps one frame’s delta so a stalled tab cannot teleport the camera', () => {
    const long = flyMove(FLY, AHEAD, 5000)
    const capped = flyMove(FLY, AHEAD, FLY_MAX_FRAME_MS)
    expect(displacement(long, capped)).toEqual({ x: 0, y: 0, z: 0 })
    expect(length(displacement(FLY, long))).toBeLessThan(EXTENT)
  })

  it('is an identity for a parked camera, zero time or garbage time', () => {
    expect(flyMove(FLY, STILL, 16)).toBe(FLY)
    expect(flyMove(FLY, AHEAD, 0)).toBe(FLY)
    expect(flyMove(FLY, AHEAD, -5)).toBe(FLY)
    expect(flyMove(FLY, AHEAD, Number.NaN)).toBe(FLY)
    expect(flyMove(FLY, STILL, Number.POSITIVE_INFINITY)).toBe(FLY)
  })

  it('does not mutate the state it was given', () => {
    const before = JSON.stringify(FLY)
    flyMove(FLY, { forward: 1, right: 1, up: 1 }, 16, true)
    expect(JSON.stringify(FLY)).toBe(before)
  })

  it('confines the camera to the flight envelope, however long you hold the key', () => {
    let state = FLY
    for (let i = 0; i < 500; i += 1) state = flyMove(state, AHEAD, FLY_MAX_FRAME_MS)
    const fromHome = length({
      x: state.position.x - state.home.x,
      y: state.position.y - state.home.y,
      z: state.position.z - state.home.z,
    })
    expect(fromHome).toBeLessThanOrEqual(state.envelopeRadius + 1e-9)
    // It really did reach the boundary (the move is not silently clamped to zero).
    expect(fromHome).toBeGreaterThan(state.envelopeRadius * 0.99)
    expectFinitePosition(state)
  })

  it('slides along the envelope instead of stopping dead', () => {
    // Hold forward until the boundary, then strafe: the camera keeps moving.
    let state = FLY
    for (let i = 0; i < 200; i += 1) state = flyMove(state, AHEAD, FLY_MAX_FRAME_MS)
    const atEdge = state
    const sidled = flyMove(atEdge, SIDEWAYS, FLY_MAX_FRAME_MS)
    expect(length(displacement(atEdge, sidled))).toBeGreaterThan(0)
  })
})

describe('flyAdvance — wheel along the look direction (M4-T3)', () => {
  it('advances by radii-per-step, scaled to the run', () => {
    const forward = flyForward(FLY)
    const moved = flyAdvance(FLY, 1)
    const step = EXTENT * FLY_ADVANCE_RADII_PER_STEP
    expect(moved.position.x).toBeCloseTo(FLY.position.x + forward.x * step, 9)
    expect(moved.position.y).toBeCloseTo(FLY.position.y + forward.y * step, 9)
    expect(moved.position.z).toBeCloseTo(FLY.position.z + forward.z * step, 9)
    expect(length(displacement(FLY, moved))).toBeCloseTo(step, 9)
  })

  it('goes backwards on a negative step and further on a bigger one', () => {
    const forward = flyForward(FLY)
    const back = flyAdvance(FLY, -1)
    expect(back.position.x).toBeCloseTo(FLY.position.x - forward.x * EXTENT * 0.35, 9)
    expect(length(displacement(FLY, flyAdvance(FLY, 3)))).toBeCloseTo(
      3 * length(displacement(FLY, flyAdvance(FLY, 1))),
      9,
    )
  })

  it('is an identity for zero, non-finite and no-op steps', () => {
    expect(flyAdvance(FLY, 0)).toBe(FLY)
    expect(flyAdvance(FLY, Number.NaN)).toBe(FLY)
    expect(flyAdvance(FLY, Number.NEGATIVE_INFINITY)).toBe(FLY)
  })

  it('is confined to the envelope like any other movement', () => {
    let state = FLY
    for (let i = 0; i < 100; i += 1) state = flyAdvance(state, 3)
    const fromHome = length({
      x: state.position.x - state.home.x,
      y: state.position.y - state.home.y,
      z: state.position.z - state.home.z,
    })
    expect(fromHome).toBeLessThanOrEqual(state.envelopeRadius + 1e-9)
  })
})

describe('flyInputFromKeys — WASD and friends (M4-T3)', () => {
  it('reads the planar keys', () => {
    expect(flyInputFromKeys(['w']).axes).toEqual(AHEAD)
    expect(flyInputFromKeys(['ArrowUp']).axes).toEqual(AHEAD)
    expect(flyInputFromKeys(['s']).axes).toEqual({ forward: -1, right: 0, up: 0 })
    expect(flyInputFromKeys(['ArrowDown']).axes).toEqual({
      forward: -1,
      right: 0,
      up: 0,
    })
    expect(flyInputFromKeys(['d']).axes).toEqual(SIDEWAYS)
    expect(flyInputFromKeys(['ArrowRight']).axes).toEqual(SIDEWAYS)
    expect(flyInputFromKeys(['a']).axes).toEqual({ forward: 0, right: -1, up: 0 })
    expect(flyInputFromKeys(['ArrowLeft']).axes).toEqual({
      forward: 0,
      right: -1,
      up: 0,
    })
  })

  it('reads the vertical keys', () => {
    expect(flyInputFromKeys(['e']).axes).toEqual(RISING)
    expect(flyInputFromKeys(['PageUp']).axes).toEqual(RISING)
    expect(flyInputFromKeys(['q']).axes).toEqual({ forward: 0, right: 0, up: -1 })
    expect(flyInputFromKeys(['PageDown']).axes).toEqual({
      forward: 0,
      right: 0,
      up: -1,
    })
  })

  it('is case-insensitive, so a shifted key still flies', () => {
    expect(flyInputFromKeys(['W']).axes).toEqual(AHEAD)
    expect(flyInputFromKeys(['A']).axes).toEqual({ forward: 0, right: -1, up: 0 })
  })

  it('reads shift as the boost and contributes no axis of its own', () => {
    const input = flyInputFromKeys(['w', 'Shift'])
    expect(input.axes).toEqual(AHEAD)
    expect(input.boost).toBe(true)
    expect(flyInputFromKeys(['shift']).boost).toBe(true)
    expect(flyInputFromKeys(['w']).boost).toBe(false)
  })

  it('ignores keys that are not movement keys, including prototype names', () => {
    expect(flyInputFromKeys(['z', 'Enter', ' '])).toEqual({
      axes: STILL,
      boost: false,
    })
    expect(flyInputFromKeys(['constructor', 'toString'])).toEqual({
      axes: STILL,
      boost: false,
    })
    expect(flyAxisForKey('constructor')).toBeNull()
    expect(flyAxisForKey('toString')).toBeNull()
  })

  it('sums a held pair but clamps each axis to full deflection', () => {
    // W and ↑ both mean forward: still 1, not 2.
    expect(flyInputFromKeys(['w', 'ArrowUp']).axes).toEqual(AHEAD)
    // Opposite keys cancel rather than fight.
    const cancelled = flyInputFromKeys(['w', 's'])
    expect(cancelled.axes).toEqual(STILL)
    expect(flyIsMoving(cancelled.axes)).toBe(false)
  })

  it('reads a Set of held keys in any order', () => {
    const forward = flyInputFromKeys(new Set(['w', 'd'])).axes
    const reversed = flyInputFromKeys(new Set(['d', 'w'])).axes
    expect(forward).toEqual(reversed)
    expect(forward).toEqual({ forward: 1, right: 1, up: 0 })
  })

  it('hands out copies of the key table, so a caller cannot corrupt it', () => {
    const axis = flyAxisForKey('w')
    expect(axis).toEqual(AHEAD)
    if (axis === null) throw new Error('expected an axis for w')
    axis.forward = 99
    expect(FLY_KEYS.w).toEqual(AHEAD)
    expect(flyAxisForKey('w')).toEqual(AHEAD)
  })
})

describe('clampPitch and the scale rules (M4-T3)', () => {
  it('clamps, tolerates garbage and keeps the limits short of the poles', () => {
    expect(clampPitch(500)).toBe(FLY_MAX_PITCH_DEG)
    expect(clampPitch(-500)).toBe(FLY_MIN_PITCH_DEG)
    expect(clampPitch(Number.NaN)).toBe(0)
    expect(clampPitch(12)).toBe(12)
  })

  it('falls back to one world unit when the run has no extent', () => {
    const flat = createFlyCamera(BASE, 0)
    expect(flyScale(flat)).toBe(1)
    expect(flyLookAhead(flat)).toBe(FLY_MIN_LOOKAHEAD)
    expect(flySpeed(flat)).toBeCloseTo(FLY_SPEED_RADII_PER_SEC, 9)
    expect(flat.envelopeRadius).toBeGreaterThanOrEqual(FLY_MIN_ENVELOPE)
  })
})

describe('resetFly (M4-T3)', () => {
  it('returns to the pose the switch handed over, byte for byte', () => {
    const flown = flyMove(flyLookBy(FLY, { dxPx: 240, dyPx: -90 }), AHEAD, 100, true)
    expect(flown.position).not.toEqual(FLY.position)
    expect(resetFly(flown)).toEqual(createFlyCamera(BASE, EXTENT))
    expect(JSON.stringify(resetFly(flown))).toBe(JSON.stringify(FLY))
  })

  it('restores the eye as well as the angles', () => {
    const flown = flyAdvance(flyLookBy(FLY, { dxPx: 60, dyPx: 20 }), 2)
    const reset = resetFly(flown)
    expect(reset.position.x).toBe(FLY.basePosition.x)
    expect(reset.position.y).toBe(FLY.basePosition.y)
    expect(reset.position.z).toBe(FLY.basePosition.z)
    expect(reset.yawDeg).toBe(FLY.baseYawDeg)
    expect(reset.pitchDeg).toBe(FLY.basePitchDeg)
  })

  it('is an identity when nothing has moved', () => {
    expect(resetFly(FLY)).toBe(FLY)
  })
})

describe('describeFly — the camera bar’s readout (M4-T3)', () => {
  it('prints the opening shot', () => {
    const readout = describeFly(FLY)
    expect(readout.mode).toBe('fly')
    expect(readout.modeLabel).toBe('Fly')
    expect(readout.headingLabel).toBe('270°')
    expect(readout.pitchLabel).toBe('-18°')
    expect(readout.altitudeLabel).toBe((FLY.position.y - FLY.home.y).toFixed(1))
  })

  it('follows the state it is given', () => {
    const readout = describeFly(flyLookBy(FLY, { dxPx: -50, dyPx: -25 }))
    expect(readout.headingLabel).toBe('280°')
    expect(readout.pitchLabel).toBe('-23°')
  })

  it('normalizes the heading and never prints NaN', () => {
    const pathological: FlyCamera = {
      ...FLY,
      yawDeg: Number.NaN,
      pitchDeg: Number.NaN,
      position: { x: Number.NaN, y: Number.NaN, z: Number.NaN },
    }
    const readout = describeFly(pathological)
    expect(readout.headingLabel).toBe('0°')
    expect(readout.pitchLabel).toBe('0°')
    expect(readout.altitudeLabel).not.toMatch(/NaN/)
  })
})

describe('determinism and purity (M4-T3)', () => {
  const MOVES = [
    (state: FlyCamera) => flyLookBy(state, { dxPx: 21, dyPx: -13 }),
    (state: FlyCamera) => flyMove(state, AHEAD, 16),
    (state: FlyCamera) => flyMove(state, { forward: 1, right: 1, up: 0 }, 33, true),
    (state: FlyCamera) => flyAdvance(state, -2),
  ]

  it('is byte-identical for the same pose and the same input sequence', () => {
    const run = (): { state: FlyCamera; pose: string } => {
      let state = createFlyCamera(BASE, EXTENT)
      for (const move of MOVES) state = move(state)
      return { state, pose: JSON.stringify(flyCameraPose(state)) }
    }
    const first = run()
    const second = run()
    expect(JSON.stringify(first.state)).toBe(JSON.stringify(second.state))
    expect(first.pose).toBe(second.pose)
  })

  it('does not depend on the identity of the pose it was created from', () => {
    const copy = {
      ...BASE,
      position: { ...BASE.position },
      target: { ...BASE.target },
    }
    expect(createFlyCamera(BASE, EXTENT)).toEqual(createFlyCamera(copy, EXTENT))
  })

  it('reads no clock, no randomness, no three.js and no DOM', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/camera/fly.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(source).not.toMatch(/\bDate\.now\s*\(/)
    expect(source).not.toMatch(/\bperformance\.now\s*\(/)
    expect(source).not.toMatch(/\bMath\.random\s*\(/)
    expect(source).not.toMatch(/from\s+'three'/)
    expect(source).not.toMatch(/\bdocument\./)
    expect(source).not.toMatch(/\bwindow\./)
    expect(findHandAuthoredCoordinates(source)).toEqual([])
  })

  it('owns no second spherical→cartesian rule (it borrows the scene layer’s)', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/camera/fly.ts'), 'utf8')
    expect(source).toMatch(/\bdirectionFromAngles\b/)
    // Trigonometry lives in `directionFromAngles`; a second angle implementation in
    // the camera layer is exactly the drift M4-T2's "no second camera math" rule
    // forbids. Lengths (hypot/sqrt) are arithmetic and allowed.
    expect(source).not.toMatch(/\bMath\.(cos|sin|tan|asin|acos|atan2)\s*\(/)
  })
})
