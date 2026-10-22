import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { buildFixture } from '../fixtures/index.ts'
import { buildScenePlan } from '../scene/scenePlan.ts'
import { cameraAngles, modeCameraPose } from './cameraState.ts'
import { createFlyCamera, flyCameraPose, flyLookBy, flyMove } from './fly.ts'
import { createOrbitCamera, orbitCameraPose } from './orbit.ts'
import { useCamera } from './useCamera.ts'

/**
 * Wiring tests for the camera controller hook (M4-T3).
 *
 * The hook owns what the pure models cannot: the React state, the mode switch's
 * seeding (into fly, from the pose the viewer is looking at), the reframe when a run
 * is replaced, and stable callback identities for the rigs' listeners. The
 * arithmetic it delegates is gated in `orbit.test.ts`, `fly.test.ts` and
 * `cameraState.test.ts`; what is asserted here is that a control really reaches the
 * pose the viewport applies, and that a switch really changes modes.
 */

const PLAN = buildScenePlan(buildFixture('fan-out').run)
const OPENING = PLAN.camera
const EXTENT = PLAN.environment.extentRadius

/** The hook, for one framed scene. */
function cameraHook(camera = OPENING, extentRadius = EXTENT) {
  return renderHook(() => useCamera(camera, extentRadius))
}

describe('useCamera — the two modes (M4-T3)', () => {
  it('starts in orbit, on the scene plan’s opening shot', () => {
    const { result } = cameraHook()
    expect(result.current.mode).toBe('orbit')
    expect(result.current.readout.mode).toBe('orbit')
    expect(result.current.camera.position.x).toBeCloseTo(OPENING.position.x, 9)
    expect(result.current.camera.distance).toBe(OPENING.distance)
    expect(result.current.orbit.zoom).toBe(1)
    expect(result.current.hint).toMatch(/orbit/i)
  })

  it('switches to fly, seeded from the pose the viewer is looking at', () => {
    const { result } = cameraHook()
    act(() => {
      result.current.toggleMode()
    })
    expect(result.current.mode).toBe('fly')
    expect(result.current.readout.mode).toBe('fly')
    expect(result.current.hint).toMatch(/fly/i)
    // The eye did not move: flying starts where the camera already was.
    expect(result.current.fly.position.x).toBeCloseTo(OPENING.position.x, 9)
    expect(result.current.fly.position.y).toBeCloseTo(OPENING.position.y, 9)
    expect(result.current.fly.position.z).toBeCloseTo(OPENING.position.z, 9)
    // And the pose is the fly rule's, not the orbit's.
    expect(result.current.camera).toEqual(flyCameraPose(result.current.fly))
  })

  it('seeds from the live orbit, not from the opening shot', () => {
    const { result } = cameraHook()
    act(() => {
      result.current.orbitBy(200, 0)
    })
    const movedPose = orbitCameraPose(result.current.orbit)
    act(() => {
      result.current.toggleMode()
    })
    expect(result.current.fly.position.x).toBeCloseTo(movedPose.position.x, 9)
    expect(result.current.fly.position.z).toBeCloseTo(movedPose.position.z, 9)
    expect(result.current.fly.yawDeg).toBeCloseTo(
      result.current.orbit.azimuthDeg + 180,
      6,
    )
  })

  it('keeps the survey across an excursion and back', () => {
    const { result } = cameraHook()
    act(() => {
      result.current.orbitBy(120, 0)
    })
    const azimuth = result.current.orbit.azimuthDeg
    act(() => {
      result.current.toggleMode()
    })
    act(() => {
      result.current.lookBy(80, 0)
      result.current.move({ forward: 1, right: 0, up: 0 }, 100, false)
    })
    act(() => {
      result.current.toggleMode()
    })
    expect(result.current.mode).toBe('orbit')
    expect(result.current.orbit.azimuthDeg).toBe(azimuth)
    expect(result.current.camera).toEqual(orbitCameraPose(result.current.orbit))
  })

  it('switches to a mode by name, and does nothing when it is already active', () => {
    const { result } = cameraHook()
    act(() => {
      result.current.setMode('fly')
    })
    expect(result.current.mode).toBe('fly')
    const before = result.current.fly
    act(() => {
      result.current.setMode('fly')
    })
    expect(result.current.fly).toBe(before)
    expect(result.current.mode).toBe('fly')
  })
})

describe('useCamera — fly controls (M4-T3)', () => {
  it('looks around, keeping the eye where it is', () => {
    const { result } = cameraHook()
    act(() => {
      result.current.setMode('fly')
    })
    const eye = { ...result.current.fly.position }
    act(() => {
      result.current.lookBy(100, 40)
    })
    expect(result.current.fly.yawDeg).toBeCloseTo(
      result.current.fly.baseYawDeg - 100 * 0.2,
      9,
    )
    expect(result.current.fly.position).toEqual(eye)
    expect(result.current.camera.position).toEqual(eye)
  })

  it('moves on a held-key frame and on a wheel advance', () => {
    const { result } = cameraHook()
    act(() => {
      result.current.setMode('fly')
    })
    const start = result.current.fly
    act(() => {
      result.current.move({ forward: 1, right: 0, up: 0 }, 100, false)
    })
    expect(result.current.fly).toEqual(
      flyMove(start, { forward: 1, right: 0, up: 0 }, 100),
    )
    expect(result.current.fly.position).not.toEqual(start.position)

    const beforeAdvance = result.current.fly
    act(() => {
      result.current.advance(1)
    })
    expect(result.current.fly.position).not.toEqual(beforeAdvance.position)
    expect(result.current.camera.position).toEqual(result.current.fly.position)
  })

  it('resets the active mode: fly to its handed-over shot, orbit to the opening', () => {
    const { result } = cameraHook()
    act(() => {
      result.current.setMode('fly')
      result.current.move({ forward: 1, right: 1, up: 1 }, 100, true)
      result.current.lookBy(90, -30)
    })
    expect(result.current.fly.position).not.toEqual(result.current.fly.basePosition)
    act(() => {
      result.current.reset()
    })
    expect(result.current.fly.position).toEqual(result.current.fly.basePosition)
    expect(result.current.fly.yawDeg).toBe(result.current.fly.baseYawDeg)

    act(() => {
      result.current.setMode('orbit')
      result.current.orbitBy(240, -90)
      result.current.zoomBy(2)
    })
    act(() => {
      result.current.reset()
    })
    expect(result.current.orbit).toEqual(createOrbitCamera(OPENING, EXTENT))
    expect(result.current.camera.position.x).toBeCloseTo(OPENING.position.x, 9)
  })

  it('exposes resetFly without changing the mode', () => {
    const { result } = cameraHook()
    act(() => {
      result.current.setMode('fly')
      result.current.advance(2)
    })
    act(() => {
      result.current.resetFly()
    })
    expect(result.current.mode).toBe('fly')
    expect(result.current.fly.position).toEqual(result.current.fly.basePosition)
  })

  it('keeps the fly state itself as the source of the pose', () => {
    const { result } = cameraHook()
    act(() => {
      result.current.setMode('fly')
      result.current.lookBy(-40, 12)
    })
    expect(result.current.fly).toEqual(
      flyLookBy(createFlyCamera(OPENING, EXTENT), { dxPx: -40, dyPx: 12 }),
    )
    expect(result.current.angles).toEqual(
      cameraAngles('fly', result.current.orbit, result.current.fly),
    )
    expect(result.current.camera).toEqual(
      modeCameraPose('fly', result.current.orbit, result.current.fly),
    )
  })
})

describe('useCamera — reframing and identities (M4-T3)', () => {
  it('returns to orbit and re-frames both modes when the run changes', () => {
    const otherPlan = buildScenePlan(buildFixture('handoff-chain').run)
    const { result, rerender } = renderHook(
      ({ camera, extent }) => useCamera(camera, extent),
      { initialProps: { camera: OPENING, extent: EXTENT } },
    )
    act(() => {
      result.current.setMode('fly')
      result.current.move({ forward: 1, right: 0, up: 0 }, 100, false)
    })
    expect(result.current.mode).toBe('fly')

    rerender({
      camera: otherPlan.camera,
      extent: otherPlan.environment.extentRadius,
    })
    expect(result.current.mode).toBe('orbit')
    expect(result.current.camera.position.x).toBeCloseTo(otherPlan.camera.position.x, 9)
    expect(result.current.fly.position.x).toBeCloseTo(otherPlan.camera.position.x, 9)
    expect(result.current.fly.basePosition).toEqual(otherPlan.camera.position)
  })

  it('does not re-frame when re-rendered with the same framing', () => {
    const { result, rerender } = cameraHook()
    act(() => {
      result.current.orbitBy(120, 0)
    })
    const azimuth = result.current.orbit.azimuthDeg
    rerender()
    expect(result.current.orbit.azimuthDeg).toBe(azimuth)
  })

  it('keeps the orbit and fly callbacks stable across state changes', () => {
    const { result } = cameraHook()
    const before = {
      orbitBy: result.current.orbitBy,
      zoomBy: result.current.zoomBy,
      lookBy: result.current.lookBy,
      advance: result.current.advance,
      move: result.current.move,
      resetFly: result.current.resetFly,
    }
    act(() => {
      result.current.orbitBy(10, 10)
      result.current.setMode('fly')
      result.current.lookBy(5, 5)
      result.current.move({ forward: 1, right: 0, up: 0 }, 16, false)
    })
    expect(result.current.lookBy).toBe(before.lookBy)
    expect(result.current.advance).toBe(before.advance)
    expect(result.current.move).toBe(before.move)
    expect(result.current.resetFly).toBe(before.resetFly)
    expect(result.current.zoomBy).toBe(before.zoomBy)
  })

  it('frames a degenerate scene without NaN in either mode', () => {
    const degenerate = {
      position: { x: 0, y: 0, z: 0 },
      target: { x: 0, y: 0, z: 0 },
      fov: 55,
      near: 0.1,
      far: 1,
      distance: 0,
    }
    const { result } = cameraHook(degenerate, 0)
    act(() => {
      result.current.setMode('fly')
      result.current.move({ forward: 1, right: 1, up: 1 }, 16, true)
    })
    for (const value of Object.values(result.current.camera.position)) {
      expect(Number.isFinite(value)).toBe(true)
    }
    expect(Number.isFinite(result.current.camera.distance)).toBe(true)
  })
})
