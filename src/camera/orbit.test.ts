import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildFixture } from '../fixtures/index.ts'
import {
  CAMERA_AZIMUTH_DEG,
  CAMERA_ELEVATION_DEG,
  CAMERA_NEAR,
  buildScenePlan,
  cameraFar,
  directionFromAngles,
} from '../scene/scenePlan.ts'
import { findHandAuthoredCoordinates } from '../layout/index.ts'
import {
  ORBIT_DEGREES_PER_PIXEL,
  ORBIT_MAX_ELEVATION_DEG,
  ORBIT_MAX_ZOOM,
  ORBIT_MIN_ELEVATION_DEG,
  ORBIT_MIN_ZOOM,
  ORBIT_WHEEL_MAX_STEPS,
  ORBIT_ZOOM_STEP,
  canZoomIn,
  canZoomOut,
  clampElevation,
  createOrbitCamera,
  describeOrbit,
  normalizeAzimuth,
  orbitBy,
  orbitCameraPose,
  orbitDistance,
  orbitDistanceRange,
  resetOrbit,
  setOrbitZoom,
  sphericalFromOffset,
  wheelZoomSteps,
  zoomBy,
} from './orbit.ts'
import type { OrbitCamera } from './orbit.ts'

/**
 * Tests for the pure orbit camera (M4-T2).
 *
 * The camera is geometry, not pixels: every number it produces — the eye
 * position, the angles, the distance, the clipping planes — is arithmetic on the
 * scene plan's own framing, so it is gated here exactly as hard as the data layer
 * (PRD §5). Nothing about the rendered *look* is asserted; that is human-held
 * (M5-T5).
 *
 * The base camera is the REAL fan-out scene plan (data → layout → scene), not a
 * hand-written literal, so "landing the orbit mode does not change the opening
 * shot" is proven against the thing the app actually draws.
 */

const PLAN = buildScenePlan(buildFixture('fan-out').run)
const BASE = PLAN.camera
const EXTENT = PLAN.environment.extentRadius
const ORBIT = createOrbitCamera(BASE, EXTENT)

/** Every component of an eye position, for closeness assertions. */
function expectEyeCloseTo(
  actual: { x: number; y: number; z: number },
  expected: { x: number; y: number; z: number },
): void {
  expect(actual.x).toBeCloseTo(expected.x, 9)
  expect(actual.y).toBeCloseTo(expected.y, 9)
  expect(actual.z).toBeCloseTo(expected.z, 9)
}

describe('createOrbitCamera — the opening shot is the scene plan (M4-T2)', () => {
  it('reads the plan’s eye as an orbit and keeps its framing', () => {
    expect(ORBIT.azimuthDeg).toBeCloseTo(CAMERA_AZIMUTH_DEG, 6)
    expect(ORBIT.elevationDeg).toBeCloseTo(CAMERA_ELEVATION_DEG, 6)
    // The opening shot is not zoomed: dolly 1 = the rig's own framing distance.
    expect(ORBIT.zoom).toBe(1)
    expect(ORBIT.baseDistance).toBe(BASE.distance)
    expect(ORBIT.fov).toBe(BASE.fov)
    expect(ORBIT.near).toBe(BASE.near)
    expect(ORBIT.extentRadius).toBe(EXTENT)
    expect(ORBIT.baseAzimuthDeg).toBe(ORBIT.azimuthDeg)
    expect(ORBIT.baseElevationDeg).toBe(ORBIT.elevationDeg)
  })

  it('copies the look-at target instead of aliasing the scene plan', () => {
    expect(ORBIT.target.x).toBe(BASE.target.x)
    expect(ORBIT.target.y).toBe(BASE.target.y)
    expect(ORBIT.target.z).toBe(BASE.target.z)
    expect(ORBIT.target).not.toBe(BASE.target)
  })

  it('reproduces the scene plan’s camera exactly at the opening shot', () => {
    // Landing the mode must not move the shot: pose(create(plan.camera)) === plan.camera.
    const pose = orbitCameraPose(ORBIT)
    expectEyeCloseTo(pose.position, BASE.position)
    expect(pose.target.x).toBe(BASE.target.x)
    expect(pose.target.y).toBe(BASE.target.y)
    expect(pose.target.z).toBe(BASE.target.z)
    expect(pose.fov).toBe(BASE.fov)
    expect(pose.near).toBe(BASE.near)
    expect(pose.far).toBe(BASE.far)
    expect(pose.distance).toBe(BASE.distance)
  })

  it('starts from the plan’s distance, not from the eye offset length alone', () => {
    // The plan's own `distance` field is the rig's framing distance; the eye
    // offset is that same length, and the two must agree on a real plan.
    expect(
      sphericalFromOffset({
        x: BASE.position.x - BASE.target.x,
        y: BASE.position.y - BASE.target.y,
        z: BASE.position.z - BASE.target.z,
      }).distance,
    ).toBeCloseTo(BASE.distance, 9)
  })

  it('survives a degenerate plan without NaN', () => {
    const degenerate = createOrbitCamera(
      {
        position: { x: 0, y: 0, z: 0 },
        target: { x: 0, y: 0, z: 0 },
        fov: Number.NaN,
        near: Number.NaN,
        far: 0,
        distance: 0,
      },
      0,
    )
    expect(degenerate.baseDistance).toBe(1)
    expect(degenerate.azimuthDeg).toBe(normalizeAzimuth(CAMERA_AZIMUTH_DEG))
    expect(degenerate.elevationDeg).toBe(clampElevation(CAMERA_ELEVATION_DEG))
    expect(degenerate.fov).toBe(55)
    expect(degenerate.near).toBe(CAMERA_NEAR)
    expect(degenerate.extentRadius).toBe(0)
    const pose = orbitCameraPose(degenerate)
    for (const value of Object.values(pose.position)) {
      expect(Number.isFinite(value)).toBe(true)
    }
    expect(pose.far).toBeGreaterThan(0)
  })

  it('clamps an explicit starting zoom into the dolly range', () => {
    expect(createOrbitCamera(BASE, EXTENT, { zoom: 99 }).zoom).toBe(ORBIT_MAX_ZOOM)
    expect(createOrbitCamera(BASE, EXTENT, { zoom: 0.001 }).zoom).toBe(ORBIT_MIN_ZOOM)
    expect(createOrbitCamera(BASE, EXTENT, { zoom: 2 }).zoom).toBe(2)
  })
})

describe('spherical helpers (M4-T2)', () => {
  it('reads an offset as azimuth/elevation and back again', () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [45, 30],
      [90, 18],
      [200, -40],
      [359, 79],
      [15, -79],
    ]
    for (const [azimuthDeg, elevationDeg] of cases) {
      const direction = directionFromAngles(azimuthDeg, elevationDeg)
      const spherical = sphericalFromOffset(direction)
      expect(spherical.azimuthDeg).toBeCloseTo(azimuthDeg, 6)
      expect(spherical.elevationDeg).toBeCloseTo(elevationDeg, 6)
      expect(spherical.distance).toBeCloseTo(1, 12)
    }
  })

  it('normalizes azimuth into [0, 360) without a negative zero', () => {
    expect(normalizeAzimuth(0)).toBe(0)
    expect(normalizeAzimuth(360)).toBe(0)
    expect(normalizeAzimuth(-360)).toBe(0)
    expect(normalizeAzimuth(-10)).toBe(350)
    expect(normalizeAzimuth(730)).toBe(10)
    expect(Object.is(normalizeAzimuth(720), -0)).toBe(false)
    expect(normalizeAzimuth(Number.NaN)).toBe(0)
  })

  it('clamps elevation short of the poles and tolerates garbage', () => {
    expect(clampElevation(500)).toBe(ORBIT_MAX_ELEVATION_DEG)
    expect(clampElevation(-500)).toBe(ORBIT_MIN_ELEVATION_DEG)
    expect(clampElevation(Number.NaN)).toBe(0)
    expect(ORBIT_MAX_ELEVATION_DEG).toBeLessThan(90)
    expect(ORBIT_MIN_ELEVATION_DEG).toBeGreaterThan(-90)
  })
})

describe('orbitCameraPose (M4-T2)', () => {
  it('keeps the eye exactly one distance from the target on the orbit sphere', () => {
    const states = [
      ORBIT,
      orbitBy(ORBIT, { dxPx: 120, dyPx: -45 }),
      orbitBy(ORBIT, { dxPx: -340, dyPx: 900 }),
      zoomBy(ORBIT, 3),
      zoomBy(ORBIT, -3),
    ]
    for (const state of states) {
      const pose = orbitCameraPose(state)
      const offset = {
        x: pose.position.x - pose.target.x,
        y: pose.position.y - pose.target.y,
        z: pose.position.z - pose.target.z,
      }
      const length = Math.hypot(offset.x, offset.y, offset.z)
      expect(length).toBeCloseTo(pose.distance, 9)
    }
  })

  it('places the eye along the spherical direction at the dolly distance', () => {
    const state = orbitBy(zoomBy(ORBIT, 1), { dxPx: 77, dyPx: -13 })
    const pose = orbitCameraPose(state)
    const direction = directionFromAngles(state.azimuthDeg, state.elevationDeg)
    const distance = orbitDistance(state)
    expect(pose.position.x).toBeCloseTo(state.target.x + direction.x * distance, 9)
    expect(pose.position.y).toBeCloseTo(state.target.y + direction.y * distance, 9)
    expect(pose.position.z).toBeCloseTo(state.target.z + direction.z * distance, 9)
    expect(pose.distance).toBeCloseTo(distance, 12)
  })

  it('looks at the settled cloud’s centre, always', () => {
    const state = orbitBy(ORBIT, { dxPx: 400, dyPx: 60 })
    const pose = orbitCameraPose(state)
    expect(pose.target.x).toBe(ORBIT.target.x)
    expect(pose.target.y).toBe(ORBIT.target.y)
    expect(pose.target.z).toBe(ORBIT.target.z)
  })

  it('re-derives the far plane as the viewer dollies (nothing clips)', () => {
    for (const steps of [-ORBIT_WHEEL_MAX_STEPS, 0, 2]) {
      const pose = orbitCameraPose(zoomBy(ORBIT, steps))
      expect(pose.far).toBe(cameraFar(pose.distance, EXTENT))
      // The far edge of the cloud stays inside the frustum...
      expect(pose.far).toBeGreaterThan(pose.distance + EXTENT)
      // ...and the near edge stays in front of the near plane at every zoom.
      expect(pose.distance - EXTENT).toBeGreaterThan(pose.near)
    }
    // Dollying out pushes the far plane out with the camera.
    const out = orbitCameraPose(zoomBy(ORBIT, -1))
    const at = orbitCameraPose(ORBIT)
    const inClose = orbitCameraPose(zoomBy(ORBIT, 1))
    expect(out.far).toBeGreaterThan(at.far)
    expect(inClose.far).toBeLessThan(at.far)
  })

  it('expresses the far plane against the cloud even with no extent', () => {
    const pose = orbitCameraPose(createOrbitCamera(BASE, 0))
    expect(pose.far).toBe(Math.max(pose.distance, CAMERA_NEAR * 2))
  })

  it('derives distance from the dolly, not the other way round', () => {
    expect(orbitDistance(ORBIT)).toBeCloseTo(ORBIT.baseDistance, 12)
    expect(orbitDistance(setOrbitZoom(ORBIT, 2))).toBeCloseTo(
      ORBIT.baseDistance / 2,
      12,
    )
    expect(orbitDistance(setOrbitZoom(ORBIT, ORBIT_MAX_ZOOM))).toBeCloseTo(
      orbitDistanceRange(ORBIT).min,
      12,
    )
    expect(orbitDistance(setOrbitZoom(ORBIT, ORBIT_MIN_ZOOM))).toBeCloseTo(
      orbitDistanceRange(ORBIT).max,
      12,
    )
  })

  it('returns fresh objects: a pose cannot corrupt the state or a later pose', () => {
    const first = orbitCameraPose(ORBIT)
    first.position.x = 999
    first.target.y = 999
    const second = orbitCameraPose(ORBIT)
    expect(second.position.x).not.toBe(999)
    expect(second.target.y).toBe(ORBIT.target.y)
    expect(ORBIT.target.y).not.toBe(999)
  })
})

describe('orbitBy — drag to orbit (M4-T2)', () => {
  it('turns the cloud right when dragged right (grab-the-cloud)', () => {
    const moved = orbitBy(ORBIT, { dxPx: 100, dyPx: 0 })
    expect(moved.azimuthDeg).toBeCloseTo(
      ORBIT.azimuthDeg - 100 * ORBIT_DEGREES_PER_PIXEL,
      9,
    )
    expect(moved.elevationDeg).toBe(ORBIT.elevationDeg)
  })

  it('turns the cloud left when dragged left', () => {
    const moved = orbitBy(ORBIT, { dxPx: -100, dyPx: 0 })
    expect(moved.azimuthDeg).toBeCloseTo(
      ORBIT.azimuthDeg + 100 * ORBIT_DEGREES_PER_PIXEL,
      9,
    )
  })

  it('raises the camera when dragged down and lowers it when dragged up', () => {
    expect(orbitBy(ORBIT, { dxPx: 0, dyPx: 100 }).elevationDeg).toBeCloseTo(
      ORBIT.elevationDeg + 100 * ORBIT_DEGREES_PER_PIXEL,
      9,
    )
    expect(orbitBy(ORBIT, { dxPx: 0, dyPx: -100 }).elevationDeg).toBeCloseTo(
      ORBIT.elevationDeg - 100 * ORBIT_DEGREES_PER_PIXEL,
      9,
    )
  })

  it('moves both angles independently on a diagonal drag', () => {
    const moved = orbitBy(ORBIT, { dxPx: 50, dyPx: 50 })
    expect(moved.azimuthDeg).toBeCloseTo(
      ORBIT.azimuthDeg - 50 * ORBIT_DEGREES_PER_PIXEL,
      9,
    )
    expect(moved.elevationDeg).toBeCloseTo(
      ORBIT.elevationDeg + 50 * ORBIT_DEGREES_PER_PIXEL,
      9,
    )
  })

  it('is an identity for a zero or non-finite drag (same object)', () => {
    expect(orbitBy(ORBIT, { dxPx: 0, dyPx: 0 })).toBe(ORBIT)
    expect(orbitBy(ORBIT, { dxPx: Number.NaN, dyPx: 0 })).toBe(ORBIT)
    expect(orbitBy(ORBIT, { dxPx: 0, dyPx: Number.POSITIVE_INFINITY })).toBe(ORBIT)
  })

  it('wraps azimuth across north instead of accumulating past 360', () => {
    const moved = orbitBy(ORBIT, { dxPx: 1000, dyPx: 0 })
    // 90 - 280 = -190 → 170
    expect(moved.azimuthDeg).toBeCloseTo(170, 9)
    expect(moved.azimuthDeg).toBeGreaterThanOrEqual(0)
    expect(moved.azimuthDeg).toBeLessThan(360)
    const wrapped = orbitBy(createOrbitCamera(BASE, EXTENT, {}), {
      dxPx: -100000,
      dyPx: 0,
    })
    expect(wrapped.azimuthDeg).toBeGreaterThanOrEqual(0)
    expect(wrapped.azimuthDeg).toBeLessThan(360)
  })

  it('clamps elevation at the tilt limits', () => {
    expect(orbitBy(ORBIT, { dxPx: 0, dyPx: 10_000 }).elevationDeg).toBe(
      ORBIT_MAX_ELEVATION_DEG,
    )
    expect(orbitBy(ORBIT, { dxPx: 0, dyPx: -10_000 }).elevationDeg).toBe(
      ORBIT_MIN_ELEVATION_DEG,
    )
    // Already at a limit: dragging further is an identity, not a jitter.
    const top = orbitBy(ORBIT, { dxPx: 0, dyPx: 10_000 })
    expect(orbitBy(top, { dxPx: 0, dyPx: 100 })).toBe(top)
  })

  it('does not mutate the state it was given, and keeps framing fields put', () => {
    const before = JSON.stringify(ORBIT)
    const moved = orbitBy(ORBIT, { dxPx: 33, dyPx: 44 })
    expect(JSON.stringify(ORBIT)).toBe(before)
    expect(moved.baseDistance).toBe(ORBIT.baseDistance)
    expect(moved.zoom).toBe(ORBIT.zoom)
    expect(moved.target).toEqual(ORBIT.target)
    expect(moved.fov).toBe(ORBIT.fov)
    expect(moved.baseAzimuthDeg).toBe(ORBIT.baseAzimuthDeg)
    expect(moved.baseElevationDeg).toBe(ORBIT.baseElevationDeg)
  })
})

describe('zoomBy — dolly in and out (M4-T2)', () => {
  it('steps multiplicatively, so a step is the same proportion at any zoom', () => {
    const once = zoomBy(ORBIT, 1)
    expect(once.zoom).toBeCloseTo(ORBIT_ZOOM_STEP, 12)
    expect(orbitDistance(once)).toBeCloseTo(ORBIT.baseDistance / ORBIT_ZOOM_STEP, 12)
    const twice = zoomBy(once, 1)
    expect(twice.zoom / once.zoom).toBeCloseTo(once.zoom / ORBIT.zoom, 12)
  })

  it('round-trips a step in and a step out', () => {
    const roundTripped = zoomBy(zoomBy(ORBIT, 1), -1)
    expect(roundTripped.zoom).toBeCloseTo(1, 12)
    expect(orbitDistance(roundTripped)).toBeCloseTo(ORBIT.baseDistance, 9)
  })

  it('clamps at both ends of the dolly range and stays there', () => {
    let close = ORBIT
    for (let i = 0; i < 200; i += 1) close = zoomBy(close, 1)
    expect(close.zoom).toBe(ORBIT_MAX_ZOOM)
    expect(zoomBy(close, 1)).toBe(close)

    let far = ORBIT
    for (let i = 0; i < 200; i += 1) far = zoomBy(far, -1)
    expect(far.zoom).toBe(ORBIT_MIN_ZOOM)
    expect(zoomBy(far, -1)).toBe(far)
  })

  it('is an identity for zero and non-finite steps', () => {
    expect(zoomBy(ORBIT, 0)).toBe(ORBIT)
    expect(zoomBy(ORBIT, Number.NaN)).toBe(ORBIT)
    expect(zoomBy(ORBIT, Number.NEGATIVE_INFINITY)).toBe(ORBIT)
  })

  it('reports the limits the buttons disable on', () => {
    expect(canZoomIn(ORBIT)).toBe(true)
    expect(canZoomOut(ORBIT)).toBe(true)
    expect(canZoomIn(setOrbitZoom(ORBIT, ORBIT_MAX_ZOOM))).toBe(false)
    expect(canZoomOut(setOrbitZoom(ORBIT, ORBIT_MIN_ZOOM))).toBe(false)
    expect(canZoomIn(setOrbitZoom(ORBIT, ORBIT_MAX_ZOOM - 0.01))).toBe(true)
    expect(canZoomOut(setOrbitZoom(ORBIT, ORBIT_MIN_ZOOM + 0.01))).toBe(true)
  })

  it('clamps a directly set zoom and keeps identity when unchanged', () => {
    expect(setOrbitZoom(ORBIT, 99).zoom).toBe(ORBIT_MAX_ZOOM)
    expect(setOrbitZoom(ORBIT, 0).zoom).toBe(ORBIT_MIN_ZOOM)
    expect(setOrbitZoom(ORBIT, Number.NaN)).toBe(ORBIT)
    expect(setOrbitZoom(ORBIT, 1)).toBe(ORBIT)
  })

  it('frames a distance range scaled to the scene, not to an absolute number', () => {
    const range = orbitDistanceRange(ORBIT)
    expect(range.min).toBeCloseTo(ORBIT.baseDistance / ORBIT_MAX_ZOOM, 12)
    expect(range.max).toBeCloseTo(ORBIT.baseDistance / ORBIT_MIN_ZOOM, 12)
    expect(range.min).toBeLessThan(range.max)
    // A run framed twice as far orbits in a range twice as far out.
    const wider = createOrbitCamera({ ...BASE, distance: BASE.distance * 2 }, EXTENT)
    expect(orbitDistanceRange(wider).max).toBeCloseTo(range.max * 2, 9)
  })
})

describe('resetOrbit (M4-T2)', () => {
  it('returns to the scene plan’s opening shot, byte for byte', () => {
    const moved = zoomBy(orbitBy(ORBIT, { dxPx: 240, dyPx: -90 }), 3)
    expect(resetOrbit(moved)).toEqual(createOrbitCamera(BASE, EXTENT))
    expect(JSON.stringify(resetOrbit(moved))).toBe(JSON.stringify(ORBIT))
  })

  it('keeps the scene’s own base angles rather than the survey constants', () => {
    const offSurvey = createOrbitCamera(
      {
        ...BASE,
        position: {
          x: BASE.target.x + Math.cos((200 * Math.PI) / 180) * BASE.distance,
          y: BASE.target.y,
          z: BASE.target.z + Math.sin((200 * Math.PI) / 180) * BASE.distance,
        },
      },
      EXTENT,
    )
    expect(offSurvey.azimuthDeg).toBeCloseTo(200, 6)
    const moved = orbitBy(offSurvey, { dxPx: 300, dyPx: 0 })
    expect(resetOrbit(moved).azimuthDeg).toBeCloseTo(200, 6)
    expect(resetOrbit(moved).elevationDeg).toBeCloseTo(offSurvey.baseElevationDeg, 9)
  })

  it('is an identity on an untouched orbit', () => {
    expect(resetOrbit(ORBIT)).toBe(ORBIT)
  })
})

describe('determinism and purity (M4-T2)', () => {
  const MOVES = [
    (state: OrbitCamera) => orbitBy(state, { dxPx: 17, dyPx: -9 }),
    (state: OrbitCamera) => zoomBy(state, 2),
    (state: OrbitCamera) => orbitBy(state, { dxPx: -230, dyPx: 40 }),
    (state: OrbitCamera) => zoomBy(state, -1),
  ]

  it('is byte-identical for the same camera and the same input sequence', () => {
    const run = (): { state: OrbitCamera; pose: string } => {
      let state = createOrbitCamera(BASE, EXTENT)
      for (const move of MOVES) state = move(state)
      return { state, pose: JSON.stringify(orbitCameraPose(state)) }
    }
    const first = run()
    const second = run()
    expect(JSON.stringify(first.state)).toBe(JSON.stringify(second.state))
    expect(first.pose).toBe(second.pose)
  })

  it('does not depend on the identity of the base camera object', () => {
    const copy = {
      ...BASE,
      position: { ...BASE.position },
      target: { ...BASE.target },
    }
    expect(createOrbitCamera(BASE, EXTENT)).toEqual(createOrbitCamera(copy, EXTENT))
  })

  it('leaves the distance alone while orbiting', () => {
    const rotated = orbitBy(ORBIT, { dxPx: 300, dyPx: 120 })
    expect(orbitDistance(rotated)).toBe(orbitDistance(ORBIT))
    expect(orbitCameraPose(rotated).distance).toBe(orbitCameraPose(ORBIT).distance)
  })

  it('reads no clock, no randomness, no three.js and no DOM', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/camera/orbit.ts'), 'utf8')
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
})

describe('wheelZoomSteps (M4-T2)', () => {
  it('zooms in on scroll up and out on scroll down', () => {
    expect(wheelZoomSteps(-120)).toBe(1)
    expect(wheelZoomSteps(120)).toBe(-1)
  })

  it('handles fractional trackpad deltas', () => {
    expect(wheelZoomSteps(-60)).toBeCloseTo(0.5, 12)
    expect(wheelZoomSteps(30)).toBeCloseTo(-0.25, 12)
  })

  it('converts line and page deltas to pixels first', () => {
    expect(wheelZoomSteps(-3, 1)).toBeCloseTo((3 * 16) / 120, 12)
    expect(wheelZoomSteps(1, 2)).toBe(-ORBIT_WHEEL_MAX_STEPS)
  })

  it('caps one event and rejects garbage', () => {
    expect(wheelZoomSteps(-10_000)).toBe(ORBIT_WHEEL_MAX_STEPS)
    expect(wheelZoomSteps(10_000)).toBe(-ORBIT_WHEEL_MAX_STEPS)
    expect(wheelZoomSteps(0)).toBe(0)
    expect(wheelZoomSteps(Number.NaN)).toBe(0)
    expect(Object.is(wheelZoomSteps(-0), -0)).toBe(false)
  })
})

describe('describeOrbit — the camera bar’s readout (M4-T2)', () => {
  it('prints the opening shot', () => {
    const readout = describeOrbit(ORBIT)
    expect(readout.mode).toBe('orbit')
    expect(readout.modeLabel).toBe('Orbit')
    expect(readout.azimuthLabel).toBe('90°')
    expect(readout.elevationLabel).toBe('18°')
    expect(readout.distanceLabel).toBe(BASE.distance.toFixed(1))
    expect(readout.zoomLabel).toBe('1.00×')
    expect(readout.zoomPercent).toBe(100)
  })

  it('rounds angles, distance and zoom the same way everywhere', () => {
    const readout = describeOrbit(
      setOrbitZoom(orbitBy(ORBIT, { dxPx: -18, dyPx: -7 }), 1.5),
    )
    expect(readout.azimuthLabel).toBe('95°')
    expect(readout.elevationLabel).toBe('16°')
    expect(readout.distanceLabel).toBe((BASE.distance / 1.5).toFixed(1))
    expect(readout.zoomLabel).toBe('1.50×')
    expect(readout.zoomPercent).toBe(150)
  })

  it('normalizes azimuth and never prints NaN', () => {
    expect(
      describeOrbit(orbitBy(ORBIT, { dxPx: 100_000, dyPx: 0 })).azimuthLabel,
    ).not.toMatch(/NaN/)
    const pathological: OrbitCamera = {
      ...ORBIT,
      azimuthDeg: Number.NaN,
      elevationDeg: Number.NaN,
      zoom: 0,
    }
    const readout = describeOrbit(pathological)
    expect(readout.azimuthLabel).toBe('0°')
    expect(readout.elevationLabel).toBe('0°')
    expect(readout.zoomLabel).toBe('1.00×')
    expect(readout.distanceLabel).not.toMatch(/NaN/)
  })
})
