import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { buildFixture } from '../fixtures/index.ts'
import { buildScenePlan, directionFromAngles } from '../scene/scenePlan.ts'
import {
  ORBIT_DEGREES_PER_PIXEL,
  ORBIT_MAX_ZOOM,
  createOrbitCamera,
  orbitCameraPose,
} from './orbit.ts'
import { useOrbitCamera } from './useOrbitCamera.ts'

/**
 * Wiring tests for the orbit controller hook (M4-T2).
 *
 * The hook owns two things the pure model cannot: the React state, and resetting
 * it when the scene it was framed for is replaced. The arithmetic it delegates is
 * gated in `orbit.test.ts`; what is asserted here is that a drag/zoom/reset
 * really reaches the camera the viewport applies, and that a new run re-frames.
 */

const PLAN = buildScenePlan(buildFixture('fan-out').run)
const OPENING = PLAN.camera
const EXTENT = PLAN.environment.extentRadius

/** The hook, for one framed scene. */
function orbitHook(camera = OPENING, extentRadius = EXTENT) {
  return renderHook(() => useOrbitCamera(camera, extentRadius))
}

describe('useOrbitCamera — state (M4-T2)', () => {
  it('starts on the scene plan’s opening shot', () => {
    const { result } = orbitHook()
    expect(result.current.mode).toBe('orbit')
    expect(result.current.camera.position.x).toBeCloseTo(OPENING.position.x, 9)
    expect(result.current.camera.position.z).toBeCloseTo(OPENING.position.z, 9)
    expect(result.current.camera.distance).toBe(OPENING.distance)
    expect(result.current.orbit.zoom).toBe(1)
  })

  it('rotates the camera on a drag and preserves the dolly', () => {
    const { result } = orbitHook()
    act(() => {
      result.current.orbitBy(100, 0)
    })
    expect(result.current.orbit.azimuthDeg).toBeCloseTo(
      result.current.orbit.baseAzimuthDeg - 100 * ORBIT_DEGREES_PER_PIXEL,
      9,
    )
    expect(result.current.camera.distance).toBe(OPENING.distance)

    act(() => {
      result.current.orbitBy(0, 100)
    })
    expect(result.current.orbit.elevationDeg).toBeCloseTo(
      result.current.orbit.baseElevationDeg + 100 * ORBIT_DEGREES_PER_PIXEL,
      9,
    )
  })

  it('dollies the camera in and out and reports the limits', () => {
    const { result } = orbitHook()
    expect(result.current.canZoomIn).toBe(true)
    expect(result.current.canZoomOut).toBe(true)

    act(() => {
      result.current.zoomBy(2)
    })
    expect(result.current.orbit.zoom).toBeGreaterThan(1)
    expect(result.current.camera.distance).toBeLessThan(OPENING.distance)
    expect(result.current.camera.position.z).not.toBe(OPENING.position.z)

    act(() => {
      result.current.zoomBy(-2)
    })
    expect(result.current.camera.distance).toBeCloseTo(OPENING.distance, 9)

    act(() => {
      for (let i = 0; i < 100; i += 1) result.current.zoomBy(1)
    })
    expect(result.current.orbit.zoom).toBe(ORBIT_MAX_ZOOM)
    expect(result.current.canZoomIn).toBe(false)
  })

  it('resets to the opening shot after a drag and a dolly', () => {
    const { result } = orbitHook()
    act(() => {
      result.current.orbitBy(240, -90)
      result.current.zoomBy(3)
    })
    expect(result.current.orbit.azimuthDeg).not.toBe(
      result.current.orbit.baseAzimuthDeg,
    )

    act(() => {
      result.current.reset()
    })
    expect(result.current.orbit).toEqual(createOrbitCamera(OPENING, EXTENT))
    expect(result.current.camera.position.x).toBeCloseTo(OPENING.position.x, 9)
    expect(result.current.camera.position.z).toBeCloseTo(OPENING.position.z, 9)
  })

  it('applies the pose the pure model derives', () => {
    const { result } = orbitHook()
    act(() => {
      result.current.orbitBy(-40, 25)
    })
    const expected = orbitCameraPose(result.current.orbit)
    expect(result.current.camera.position.x).toBeCloseTo(expected.position.x, 9)
    expect(result.current.camera.position.y).toBeCloseTo(expected.position.y, 9)
    expect(result.current.camera.position.z).toBeCloseTo(expected.position.z, 9)
    expect(result.current.camera.far).toBe(expected.far)
  })

  it('keeps the callbacks stable across state changes', () => {
    const { result } = orbitHook()
    const before = {
      orbitBy: result.current.orbitBy,
      zoomBy: result.current.zoomBy,
      reset: result.current.reset,
    }
    act(() => {
      result.current.orbitBy(10, 10)
    })
    expect(result.current.orbitBy).toBe(before.orbitBy)
    expect(result.current.zoomBy).toBe(before.zoomBy)
    expect(result.current.reset).toBe(before.reset)
  })
})

describe('useOrbitCamera — reframing (M4-T2)', () => {
  it('resets to the new scene’s opening shot when the run changes', () => {
    const otherPlan = buildScenePlan(buildFixture('handoff-chain').run)
    const { result, rerender } = renderHook(
      ({ camera, extent }) => useOrbitCamera(camera, extent),
      { initialProps: { camera: OPENING, extent: EXTENT } },
    )
    act(() => {
      result.current.orbitBy(200, 40)
      result.current.zoomBy(2)
    })
    expect(result.current.orbit.azimuthDeg).not.toBe(
      result.current.orbit.baseAzimuthDeg,
    )

    rerender({
      camera: otherPlan.camera,
      extent: otherPlan.environment.extentRadius,
    })
    expect(result.current.camera.position.x).toBeCloseTo(otherPlan.camera.position.x, 9)
    expect(result.current.camera.position.z).toBeCloseTo(otherPlan.camera.position.z, 9)
    expect(result.current.orbit.zoom).toBe(1)
    expect(result.current.orbit.baseDistance).toBe(otherPlan.camera.distance)
  })

  it('does not reset when re-rendered with the same framing', () => {
    const { result, rerender } = orbitHook()
    act(() => {
      result.current.orbitBy(120, 0)
    })
    const azimuth = result.current.orbit.azimuthDeg
    rerender()
    expect(result.current.orbit.azimuthDeg).toBe(azimuth)
  })

  it('frames a degenerate scene without NaN', () => {
    const { result } = orbitHook(
      {
        position: { x: 0, y: 0, z: 0 },
        target: { x: 0, y: 0, z: 0 },
        fov: 55,
        near: 0.1,
        far: 1,
        distance: 0,
      },
      0,
    )
    expect(Number.isFinite(result.current.camera.position.x)).toBe(true)
    expect(Number.isFinite(result.current.camera.distance)).toBe(true)
    // The eye really sits on the orbit sphere for the fallback distance.
    const direction = directionFromAngles(
      result.current.orbit.azimuthDeg,
      result.current.orbit.elevationDeg,
    )
    expect(result.current.camera.position.x).toBeCloseTo(
      direction.x * result.current.orbit.baseDistance,
      9,
    )
  })
})
