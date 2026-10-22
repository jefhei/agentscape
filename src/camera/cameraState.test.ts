import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildFixture } from '../fixtures/index.ts'
import { findHandAuthoredCoordinates } from '../layout/index.ts'
import { buildScenePlan } from '../scene/scenePlan.ts'
import {
  cameraAngles,
  describeCamera,
  modeCameraPose,
  switchCameraMode,
} from './cameraState.ts'
import { createFlyCamera, flyCameraPose, flyForward } from './fly.ts'
import { createOrbitCamera, orbitBy, orbitCameraPose } from './orbit.ts'

/**
 * Tests for the active-mode seam (M4-T3).
 *
 * This module is the only place that knows both pose rules, so it is where the
 * switch's two rules are pinned: a switch **into** fly starts from the camera's
 * current pose (never teleports the view), and a switch **back** to orbit leaves the
 * survey exactly where it was (an excursion is a detour, not a re-frame). The pose
 * and readout dispatch are checked against the two models' own functions, so the
 * seam can never disagree with what each mode does on its own.
 */

const PLAN = buildScenePlan(buildFixture('fan-out').run)
const EXTENT = PLAN.environment.extentRadius
const ORBIT = createOrbitCamera(PLAN.camera, EXTENT)
const FLY = createFlyCamera(PLAN.camera, EXTENT)
const SEED = (pose: Parameters<typeof createFlyCamera>[0]) =>
  createFlyCamera(pose, EXTENT)

/** The unit vector a pose looks along. */
function lookOf(pose: {
  position: { x: number; y: number; z: number }
  target: { x: number; y: number; z: number }
}): { x: number; y: number; z: number } {
  const dx = pose.target.x - pose.position.x
  const dy = pose.target.y - pose.position.y
  const dz = pose.target.z - pose.position.z
  const length = Math.hypot(dx, dy, dz)
  return { x: dx / length, y: dy / length, z: dz / length }
}

describe('modeCameraPose (M4-T3)', () => {
  it('applies the orbit rule in orbit mode', () => {
    expect(modeCameraPose('orbit', ORBIT, FLY)).toEqual(orbitCameraPose(ORBIT))
  })

  it('applies the fly rule in fly mode', () => {
    const flyPose = modeCameraPose('fly', ORBIT, FLY)
    expect(flyPose).toEqual(flyCameraPose(FLY))
    // The eye is the state's, not the orbit's.
    expect(flyPose.position.x).toBe(FLY.position.x)
    expect(flyPose.position.y).toBe(FLY.position.y)
    expect(flyPose.position.z).toBe(FLY.position.z)
    expect(flyPose.distance).toBe(EXTENT)
  })

  it('ignores the other mode’s state entirely', () => {
    // A wildly different orbit must not leak into the fly pose, and vice versa.
    const flown = orbitBy(ORBIT, { dxPx: 400, dyPx: 0 })
    expect(modeCameraPose('fly', flown, FLY).position).toEqual(FLY.position)
    expect(modeCameraPose('orbit', ORBIT, FLY)).toEqual(orbitCameraPose(ORBIT))
  })
})

describe('cameraAngles (M4-T3)', () => {
  it('reads the orbit’s azimuth and elevation in orbit mode', () => {
    expect(cameraAngles('orbit', ORBIT, FLY)).toEqual({
      azimuthDeg: ORBIT.azimuthDeg,
      elevationDeg: ORBIT.elevationDeg,
    })
  })

  it('reads the fly camera’s yaw and pitch in fly mode', () => {
    expect(cameraAngles('fly', ORBIT, FLY)).toEqual({
      azimuthDeg: FLY.yawDeg,
      elevationDeg: FLY.pitchDeg,
    })
  })

  it('prints the same numbers the readout rounds', () => {
    for (const mode of ['orbit', 'fly'] as const) {
      const angles = cameraAngles(mode, ORBIT, FLY)
      const readout = describeCamera(mode, ORBIT, FLY)
      const printed =
        readout.mode === 'orbit'
          ? [readout.azimuthLabel, readout.elevationLabel]
          : [readout.headingLabel, readout.pitchLabel]
      expect(printed).toEqual([
        `${Math.round(angles.azimuthDeg)}°`,
        `${Math.round(angles.elevationDeg)}°`,
      ])
    }
  })
})

describe('describeCamera (M4-T3)', () => {
  it('returns the orbit readout in orbit mode', () => {
    const readout = describeCamera('orbit', ORBIT, FLY)
    expect(readout.mode).toBe('orbit')
    if (readout.mode !== 'orbit') throw new Error('expected the orbit arm')
    expect(readout.modeLabel).toBe('Orbit')
    expect(readout.azimuthLabel).toBe('90°')
    expect(readout.elevationLabel).toBe('18°')
    expect(readout.zoomLabel).toBe('1.00×')
  })

  it('returns the fly readout in fly mode', () => {
    const readout = describeCamera('fly', ORBIT, FLY)
    expect(readout.mode).toBe('fly')
    if (readout.mode !== 'fly') throw new Error('expected the fly arm')
    expect(readout.modeLabel).toBe('Fly')
    expect(readout.headingLabel).toBe('270°')
    expect(readout.pitchLabel).toBe('-18°')
    expect(readout.altitudeLabel).toMatch(/^-?\d+\.\d$/)
  })

  it('is a discriminated union: each arm carries only its own numbers', () => {
    const orbit = describeCamera('orbit', ORBIT, FLY)
    const fly = describeCamera('fly', ORBIT, FLY)
    expect('azimuthLabel' in orbit).toBe(true)
    expect('headingLabel' in orbit).toBe(false)
    expect('headingLabel' in fly).toBe(true)
    expect('azimuthLabel' in fly).toBe(false)
  })
})

describe('switchCameraMode (M4-T3)', () => {
  it('seeds the fly camera from the orbit’s current pose', () => {
    const switched = switchCameraMode('orbit', ORBIT, FLY, 'fly', SEED)
    expect(switched.mode).toBe('fly')
    const pose = orbitCameraPose(ORBIT)
    expect(switched.fly.position.x).toBe(pose.position.x)
    expect(switched.fly.position.y).toBe(pose.position.y)
    expect(switched.fly.position.z).toBe(pose.position.z)
    // ...looking where the orbit was looking, so the switch does not move the view.
    const forward = flyForward(switched.fly)
    const look = lookOf(pose)
    expect(forward.x).toBeCloseTo(look.x, 9)
    expect(forward.y).toBeCloseTo(look.y, 9)
    expect(forward.z).toBeCloseTo(look.z, 9)
  })

  it('seeds from the live orbit, not from the opening shot', () => {
    const moved = orbitBy(ORBIT, { dxPx: 200, dyPx: 0 })
    const base = switchCameraMode('orbit', ORBIT, FLY, 'fly', SEED).fly
    const live = switchCameraMode('orbit', moved, FLY, 'fly', SEED).fly
    expect(live.yawDeg).not.toBe(base.yawDeg)
    expect(live.position).not.toEqual(base.position)
    expect(live.yawDeg).toBeCloseTo(moved.azimuthDeg + 180, 6)
  })

  it('calls the seed exactly once, with the orbit pose', () => {
    const seed = vi.fn(SEED)
    switchCameraMode('orbit', ORBIT, FLY, 'fly', seed)
    expect(seed).toHaveBeenCalledTimes(1)
    expect(seed).toHaveBeenCalledWith(orbitCameraPose(ORBIT))
  })

  it('does not alias the pose’s vectors', () => {
    const pose = orbitCameraPose(ORBIT)
    const seed = (p: typeof pose) => {
      const fly = createFlyCamera(p, EXTENT)
      p.position.x = 999
      p.target.y = 999
      return fly
    }
    const switched = switchCameraMode('orbit', ORBIT, FLY, 'fly', seed)
    expect(switched.fly.position.x).not.toBe(999)
    expect(switched.fly.home.y).not.toBe(999)
  })

  it('keeps the orbit untouched and the fly camera as it was on the way back', () => {
    const flown = createFlyCamera(
      { ...orbitCameraPose(ORBIT), position: { x: 1, y: 2, z: 3 } },
      EXTENT,
    )
    const seed = vi.fn(SEED)
    const switched = switchCameraMode('fly', ORBIT, flown, 'orbit', seed)
    expect(switched.mode).toBe('orbit')
    expect(switched.fly).toBe(flown)
    // Coming back is not a re-seed: the excursion's state is retained.
    expect(seed).not.toHaveBeenCalled()
  })

  it('is an identity when the target mode is already active', () => {
    expect(switchCameraMode('orbit', ORBIT, FLY, 'orbit', SEED)).toEqual({
      mode: 'orbit',
      fly: FLY,
    })
    const flySwitch = switchCameraMode('fly', ORBIT, FLY, 'fly', SEED)
    expect(flySwitch.mode).toBe('fly')
    expect(flySwitch.fly).toBe(FLY)
  })

  it('round-trips without moving the survey', () => {
    const survey = orbitBy(ORBIT, { dxPx: -77, dyPx: 12 })
    const before = JSON.stringify(survey)
    const intoFly = switchCameraMode('orbit', survey, FLY, 'fly', SEED)
    const back = switchCameraMode(intoFly.mode, survey, intoFly.fly, 'orbit', SEED)
    expect(back.mode).toBe('orbit')
    // The excursion's camera is carried back, and the survey state is untouched —
    // so returning to orbit lands on the survey the viewer left.
    expect(back.fly).toBe(intoFly.fly)
    expect(JSON.stringify(survey)).toBe(before)
    expect(survey.azimuthDeg).toBeCloseTo(ORBIT.azimuthDeg + 77 * 0.28, 9)
  })
})

describe('purity (M4-T3)', () => {
  it('reads no clock, randomness, three.js, DOM or coordinates', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/camera/cameraState.ts'),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\bDate\.now\s*\(/)
    expect(code).not.toMatch(/\bMath\.random\s*\(/)
    expect(code).not.toMatch(/from\s+'three'/)
    expect(code).not.toMatch(/\bdocument\./)
    expect(code).not.toMatch(/\bwindow\./)
    // It is the *seam*: it must dispatch to the two models' own rules rather than
    // re-deriving either pose.
    expect(code).toMatch(/\borbitCameraPose\b/)
    expect(code).toMatch(/\bflyCameraPose\b/)
    expect(code).toMatch(/\bdescribeOrbit\b/)
    expect(code).toMatch(/\bdescribeFly\b/)
    expect(findHandAuthoredCoordinates(code)).toEqual([])
  })
})
