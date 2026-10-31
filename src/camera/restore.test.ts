/**
 * Tests for the camera layer's restore seam (M6-T1).
 *
 * Restoring a view needs two things the gestures never did: an orbit that starts at
 * a given pose while its *opening shot* stays the scene's, and a fly camera that can
 * be placed at a saved eye. Both are rules — they clamp, wrap and confine like every
 * other camera transition — so they are tested here, in the camera layer, rather
 * than through the autosave.
 */

import { describe, expect, it } from 'vitest'
import { buildFixture } from '../fixtures/index.ts'
import { buildScenePlan } from '../scene/scenePlan.ts'
import {
  confineToEnvelope,
  createFlyCamera,
  flyMoveTo,
  resetFly,
  restoreFlyPose,
} from './fly.ts'
import {
  ORBIT_MAX_ZOOM,
  ORBIT_MIN_ZOOM,
  createOrbitCamera,
  orbitCameraPose,
  resetOrbit,
} from './orbit.ts'

const RUN = buildFixture('fan-out').run
const SCENE = buildScenePlan(RUN)
const OPENING = SCENE.camera
const EXTENT = SCENE.environment.extentRadius

describe('createOrbitCamera with a restored pose (M6-T1)', () => {
  it('keeps the plan’s opening shot as the base', () => {
    const fresh = createOrbitCamera(OPENING, EXTENT)
    const restored = createOrbitCamera(OPENING, EXTENT, {
      azimuthDeg: 45,
      elevationDeg: 20,
      zoom: 1.5,
    })
    expect(restored.azimuthDeg).toBe(45)
    expect(restored.elevationDeg).toBe(20)
    expect(restored.zoom).toBe(1.5)
    expect(restored.baseAzimuthDeg).toBe(fresh.baseAzimuthDeg)
    expect(restored.baseElevationDeg).toBe(fresh.baseElevationDeg)
    expect(restored.baseDistance).toBe(fresh.baseDistance)
  })

  it('resets to the opening shot, not to the restored pose', () => {
    const fresh = createOrbitCamera(OPENING, EXTENT)
    const restored = createOrbitCamera(OPENING, EXTENT, { azimuthDeg: 45, zoom: 2 })
    const reset = resetOrbit(restored)
    expect(reset.azimuthDeg).toBe(fresh.azimuthDeg)
    expect(reset.zoom).toBe(1)
    expect(orbitCameraPose(reset)).toEqual(orbitCameraPose(fresh))
  })

  it('clamps a hand-edited pose to the orbit limits', () => {
    const restored = createOrbitCamera(OPENING, EXTENT, {
      azimuthDeg: 725,
      elevationDeg: -400,
      zoom: 99,
    })
    expect(restored.azimuthDeg).toBe(5)
    expect(restored.elevationDeg).toBe(-80)
    expect(restored.zoom).toBe(ORBIT_MAX_ZOOM)
    expect(createOrbitCamera(OPENING, EXTENT, { zoom: 0.0001 }).zoom).toBe(
      ORBIT_MIN_ZOOM,
    )
  })
})

describe('fly camera restore (M6-T1)', () => {
  it('starts from the pose the scene hands over, unchanged by default', () => {
    const fly = createFlyCamera(OPENING, EXTENT)
    expect(confineToEnvelope(fly, fly.position)).toEqual(fly.position)
    expect(flyMoveTo(fly, fly.position)).toBe(fly)
  })

  it('confines an eye outside the envelope to its surface', () => {
    const fly = createFlyCamera(OPENING, EXTENT)
    const far = { x: fly.home.x + 1000, y: fly.home.y, z: fly.home.z }
    const confined = confineToEnvelope(fly, far)
    const distance = Math.hypot(
      confined.x - fly.home.x,
      confined.y - fly.home.y,
      confined.z - fly.home.z,
    )
    expect(distance).toBeCloseTo(fly.envelopeRadius, 6)
    // ...and keeps the direction it was asked for.
    expect(confined.y).toBeCloseTo(fly.home.y, 9)
    expect(confined.z).toBeCloseTo(fly.home.z, 9)
  })

  it('restores a saved eye and angles', () => {
    const fly = createFlyCamera(OPENING, EXTENT)
    const restored = restoreFlyPose(fly, {
      position: { x: fly.home.x + 0.2, y: fly.home.y + 0.1, z: fly.home.z },
      yawDeg: 270,
      pitchDeg: -15,
    })
    expect(restored.position).toEqual({
      x: fly.home.x + 0.2,
      y: fly.home.y + 0.1,
      z: fly.home.z,
    })
    expect(restored.yawDeg).toBe(270)
    expect(restored.pitchDeg).toBe(-15)
    // The opening pose survives, so reset is still reset.
    expect(restored.basePosition).toEqual(fly.basePosition)
    expect(restored.baseYawDeg).toBe(fly.baseYawDeg)
  })

  it('wraps yaw, clamps pitch and is an identity for an unchanged pose', () => {
    const fly = createFlyCamera(OPENING, EXTENT)
    const clamped = restoreFlyPose(fly, {
      position: fly.position,
      yawDeg: 725,
      pitchDeg: 200,
    })
    expect(clamped.yawDeg).toBe(5)
    expect(clamped.pitchDeg).toBe(85)
    expect(
      restoreFlyPose(fly, {
        position: fly.position,
        yawDeg: fly.yawDeg,
        pitchDeg: fly.pitchDeg,
      }),
    ).toBe(fly)
  })

  it('resets back to the pose the scene handed over after a restore', () => {
    const fly = createFlyCamera(OPENING, EXTENT)
    const restored = restoreFlyPose(fly, {
      position: { x: fly.home.x + 0.1, y: fly.home.y, z: fly.home.z },
      yawDeg: 10,
      pitchDeg: 5,
    })
    const reset = resetFly(restored)
    expect(reset.position).toEqual(fly.position)
    expect(reset.yawDeg).toBe(fly.yawDeg)
  })
})
