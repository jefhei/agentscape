/**
 * Tests for restoring a saved view onto a run (M6-T1).
 *
 * The rule under test is the one that makes the autosave safe: a snapshot is a view
 * of **one** trace, and restoring it is a question about *this* run. So the tests
 * are mostly negative — a different run restores nothing, a ghost agent is pruned,
 * a window past the end is clamped — plus the positive half: a view saved for this
 * run comes back, camera and all, anchored to the scene's own opening shot.
 */

import { describe, expect, it } from 'vitest'
import { createFlyCamera } from '../camera/fly.ts'
import { createOrbitCamera } from '../camera/orbit.ts'
import { IDENTITY_FILTER } from '../filter/filter.ts'
import { buildFixture } from '../fixtures/index.ts'
import { buildScenePlan } from '../scene/scenePlan.ts'
import type { CameraSnapshot } from './snapshot.ts'
import { restoreCameraPlan, restoreView } from './restore.ts'
import type { ViewSnapshot } from './snapshot.ts'

const FAN_OUT = buildFixture('fan-out').run
const LOOP = buildFixture('loop').run
const SCENE = buildScenePlan(FAN_OUT)
const OPENING = SCENE.camera

const SPAN_MS = FAN_OUT.endedAt - FAN_OUT.startedAt

/** The settled cloud's radius — the number every camera limit is expressed against. */
const EXTENT_RADIUS = SCENE.environment.extentRadius

const CAMERA: CameraSnapshot = {
  mode: 'orbit',
  orbit: { azimuthDeg: 45, elevationDeg: 20, zoom: 1.5 },
  fly: { position: { x: 1, y: 2, z: 3 }, yawDeg: 90, pitchDeg: -10 },
}

/** A valid snapshot for `model`, with overridable view state. */
function snapshot(overrides: Partial<ViewSnapshot> = {}, run = FAN_OUT): ViewSnapshot {
  return {
    version: 1,
    savedAt: 1_700_000_000_000,
    run: { id: run.id, trace: null },
    playback: { elapsedMs: 1200, speed: 1 },
    filter: { agentIds: [], kinds: ['message', 'tool_call'], window: null },
    selection: null,
    camera: CAMERA,
    ...overrides,
  }
}

describe('restoreView (M6-T1)', () => {
  it('restores nothing when nothing was saved', () => {
    expect(restoreView(null, FAN_OUT)).toBeNull()
  })

  it('restores nothing onto a different run', () => {
    // Same schema, different trace: the id is the guard.
    expect(restoreView(snapshot({}, LOOP), FAN_OUT)).toBeNull()
  })

  it('restores the playhead and the speed for the run it was saved on', () => {
    const restored = restoreView(
      snapshot({ playback: { elapsedMs: 900, speed: 2 } }),
      FAN_OUT,
    )
    expect(restored?.playback).toEqual({ elapsedMs: 900, speed: 2 })
  })

  it('clamps a saved position to the run’s span', () => {
    const restored = restoreView(
      snapshot({ playback: { elapsedMs: SPAN_MS + 60_000, speed: 1 } }),
      FAN_OUT,
    )
    expect(restored?.playback.elapsedMs).toBe(SPAN_MS)
  })

  it('never restores a negative position', () => {
    const restored = restoreView(
      snapshot({ playback: { elapsedMs: -5, speed: 1 } }),
      FAN_OUT,
    )
    expect(restored?.playback.elapsedMs).toBe(0)
  })

  it('keeps a lens that this run still supports', () => {
    const restored = restoreView(
      snapshot({
        filter: {
          agentIds: ['a_worker_alpha'],
          kinds: ['message'],
          window: { startMs: 0, endMs: SPAN_MS },
        },
      }),
      FAN_OUT,
    )
    expect(restored?.filter.agentIds).toEqual(['a_worker_alpha'])
    expect(restored?.filter.kinds).toEqual(['message'])
    expect(restored?.filter.window).toEqual({ startMs: 0, endMs: SPAN_MS })
  })

  it('drops agents the run does not have', () => {
    const restored = restoreView(
      snapshot({
        filter: {
          agentIds: ['a_ghost', 'a_orchestrator'],
          kinds: ['message', 'tool_call'],
          window: null,
        },
      }),
      FAN_OUT,
    )
    expect(restored?.filter.agentIds).toEqual(['a_orchestrator'])
  })

  it('clamps a saved window to the run’s span', () => {
    const restored = restoreView(
      snapshot({
        filter: {
          agentIds: [],
          kinds: ['message', 'tool_call'],
          window: { startMs: 0, endMs: SPAN_MS * 4 },
        },
      }),
      FAN_OUT,
    )
    expect(restored?.filter.window).toEqual({ startMs: 0, endMs: SPAN_MS })
  })

  it('restores the identity lens as the identity filter itself', () => {
    const restored = restoreView(snapshot(), FAN_OUT)
    // The lens is not merely *equal* to "no restriction" — it is the shared value,
    // so the scene's identity-filter no-op still holds after a restore.
    expect(restored?.filter).toBe(IDENTITY_FILTER)
  })

  it('keeps a selection the run has, and drops a ghost', () => {
    expect(
      restoreView(snapshot({ selection: 'a_worker_alpha' }), FAN_OUT)?.selection,
    ).toBe('a_worker_alpha')
    expect(
      restoreView(snapshot({ selection: 'a_ghost' }), FAN_OUT)?.selection,
    ).toBeNull()
    expect(restoreView(snapshot({ selection: null }), FAN_OUT)?.selection).toBeNull()
  })

  it('carries the saved camera through untouched (the plan decides how to apply it)', () => {
    expect(restoreView(snapshot(), FAN_OUT)?.camera).toEqual(CAMERA)
    expect(restoreView(snapshot({ camera: null }), FAN_OUT)?.camera).toBeNull()
  })
})

describe('restoreCameraPlan (M6-T1)', () => {
  it('applies the saved orbit pose to the scene’s own opening shot', () => {
    const restored = restoreCameraPlan(CAMERA, OPENING, EXTENT_RADIUS)
    const fresh = createOrbitCamera(OPENING, EXTENT_RADIUS)
    expect(restored.mode).toBe('orbit')
    expect(restored.orbit.azimuthDeg).toBe(45)
    expect(restored.orbit.elevationDeg).toBe(20)
    expect(restored.orbit.zoom).toBe(1.5)
    // Everything that places the camera *in this scene* stays the scene's:
    expect(restored.orbit.target).toEqual(fresh.target)
    expect(restored.orbit.baseDistance).toBe(fresh.baseDistance)
    expect(restored.orbit.baseAzimuthDeg).toBe(fresh.baseAzimuthDeg)
    expect(restored.orbit.fov).toBe(fresh.fov)
    expect(restored.orbit.extentRadius).toBe(fresh.extentRadius)
  })

  it('restores the fly eye and angles on a camera seeded from the scene', () => {
    const restored = restoreCameraPlan(
      { ...CAMERA, mode: 'fly' },
      OPENING,
      EXTENT_RADIUS,
    )
    expect(restored.mode).toBe('fly')
    expect(restored.fly.position).toEqual({ x: 1, y: 2, z: 3 })
    expect(restored.fly.yawDeg).toBe(90)
    expect(restored.fly.pitchDeg).toBe(-10)
    // The envelope and home still belong to this run, not to the save.
    const seeded = createFlyCamera(OPENING, EXTENT_RADIUS)
    expect(restored.fly.home).toEqual(seeded.home)
    expect(restored.fly.envelopeRadius).toBe(seeded.envelopeRadius)
  })

  it('keeps the seeded fly camera when the save carried no readable pose', () => {
    const restored = restoreCameraPlan({ ...CAMERA, fly: null }, OPENING, EXTENT_RADIUS)
    expect(restored.fly).toEqual(createFlyCamera(OPENING, EXTENT_RADIUS))
  })

  it('confines a saved eye that is outside the flight envelope', () => {
    const restored = restoreCameraPlan(
      {
        mode: 'fly',
        orbit: { azimuthDeg: 0, elevationDeg: 0, zoom: 1 },
        fly: { position: { x: 500, y: 0, z: 0 }, yawDeg: 0, pitchDeg: 0 },
      },
      OPENING,
      EXTENT_RADIUS,
    )
    const seeded = createFlyCamera(OPENING, EXTENT_RADIUS)
    const distance = Math.hypot(
      restored.fly.position.x - restored.fly.home.x,
      restored.fly.position.y - restored.fly.home.y,
      restored.fly.position.z - restored.fly.home.z,
    )
    expect(distance).toBeCloseTo(seeded.envelopeRadius, 6)
  })

  it('clamps a hand-edited pose to the camera models’ limits', () => {
    const restored = restoreCameraPlan(
      {
        mode: 'orbit',
        orbit: { azimuthDeg: 400, elevationDeg: 179, zoom: 9 },
        fly: { position: { x: 0, y: 0, z: 0 }, yawDeg: 720, pitchDeg: 179 },
      },
      OPENING,
      EXTENT_RADIUS,
    )
    expect(restored.orbit.azimuthDeg).toBe(40)
    expect(restored.orbit.elevationDeg).toBe(80)
    expect(restored.orbit.zoom).toBe(3)
    expect(restored.fly.yawDeg).toBe(0)
    expect(restored.fly.pitchDeg).toBe(85)
  })
})
