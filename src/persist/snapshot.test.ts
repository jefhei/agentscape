/**
 * Tests for the autosave snapshot (M6-T1) — capture, serialize, parse.
 *
 * The value under test is the boundary between the app and `localStorage`, so the
 * assertions are about **what a hostile or stale value does**, not only about the
 * happy path: the whole point of `parseSnapshot` is that nothing it reads can
 * blank the scene, teleport the camera or throw.
 */

import { describe, expect, it } from 'vitest'
import { buildFixture } from '../fixtures/index.ts'
import { IDENTITY_FILTER } from '../filter/filter.ts'
import type { PlaybackSpeed } from '../timeline/index.ts'
import {
  SNAPSHOT_VERSION,
  cameraSnapshotOf,
  captureSnapshot,
  isPlaybackSpeed,
  normalizeSnapshot,
  parseSnapshot,
  serializeSnapshot,
} from './snapshot.ts'
import type { CameraSnapshot, SnapshotSource } from './snapshot.ts'

const FAN_OUT = buildFixture('fan-out').run
const SPAN_MS = FAN_OUT.endedAt - FAN_OUT.startedAt

/** A complete, valid camera block (plain data — a camera state is just numbers). */
const CAMERA: CameraSnapshot = {
  mode: 'orbit',
  orbit: { azimuthDeg: 45, elevationDeg: 20, zoom: 1.5 },
  fly: { position: { x: 1, y: 2, z: 3 }, yawDeg: 90, pitchDeg: -10 },
}

/** A capture source with every field valid; tests override one field at a time. */
function source(overrides: Partial<SnapshotSource> = {}): SnapshotSource {
  return {
    runId: FAN_OUT.id,
    trace: null,
    elapsedMs: 1200,
    speed: 1,
    filter: IDENTITY_FILTER,
    selection: null,
    camera: CAMERA,
    savedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/** Capture, serialize, parse — the round trip the app performs between visits. */
function roundTrip(overrides: Partial<SnapshotSource> = {}) {
  return parseSnapshot(serializeSnapshot(captureSnapshot(source(overrides))))
}

describe('captureSnapshot (M6-T1)', () => {
  it('captures the run reference, the view and the capture time', () => {
    const snapshot = captureSnapshot(source({ trace: 'trace=fleet' }))
    expect(snapshot.version).toBe(SNAPSHOT_VERSION)
    expect(snapshot.savedAt).toBe(1_700_000_000_000)
    expect(snapshot.run).toEqual({ id: FAN_OUT.id, trace: 'trace=fleet' })
    expect(snapshot.playback).toEqual({ elapsedMs: 1200, speed: 1 })
    expect(snapshot.filter).toEqual({
      agentIds: [],
      kinds: ['message', 'tool_call'],
      window: null,
    })
    expect(snapshot.selection).toBeNull()
    expect(snapshot.camera).toEqual(CAMERA)
  })

  it('never records a negative or non-finite playhead', () => {
    expect(captureSnapshot(source({ elapsedMs: -50 })).playback.elapsedMs).toBe(0)
    expect(captureSnapshot(source({ elapsedMs: Number.NaN })).playback.elapsedMs).toBe(
      0,
    )
    expect(
      captureSnapshot(source({ elapsedMs: Number.POSITIVE_INFINITY })).playback
        .elapsedMs,
    ).toBe(0)
  })

  it('falls back to real-time speed for a speed outside the transport set', () => {
    const bogus = 3 as unknown as PlaybackSpeed
    expect(captureSnapshot(source({ speed: bogus })).playback.speed).toBe(1)
  })

  it('normalizes the lens the way the filter model does', () => {
    const snapshot = captureSnapshot(
      source({
        filter: {
          agentIds: ['a_worker_beta', 'a_orchestrator', 'a_worker_beta'],
          kinds: ['tool_call'],
          window: { startMs: 900, endMs: 300 },
        },
      }),
    )
    // Canonical (sorted, deduped) ids and a reversed window read as the same window.
    expect(snapshot.filter.agentIds).toEqual(['a_orchestrator', 'a_worker_beta'])
    expect(snapshot.filter.kinds).toEqual(['tool_call'])
    expect(snapshot.filter.window).toEqual({ startMs: 300, endMs: 900 })
  })

  it('treats a blank selection as none, and keeps a real one', () => {
    expect(captureSnapshot(source({ selection: '' })).selection).toBeNull()
    expect(captureSnapshot(source({ selection: 'a_worker_alpha' })).selection).toBe(
      'a_worker_alpha',
    )
  })

  it('never plays on restore: there is no `playing` field at all', () => {
    expect(captureSnapshot(source())).not.toHaveProperty('playback.playing')
    expect(serializeSnapshot(captureSnapshot(source()))).not.toContain('playing')
  })

  it('serializes the same view to byte-identical text', () => {
    const a = serializeSnapshot(captureSnapshot(source()))
    const b = serializeSnapshot(captureSnapshot(source()))
    expect(a).toBe(b)
  })

  it('round-trips through text with no loss', () => {
    const captured = captureSnapshot(
      source({
        trace: 'trace=scale:12&mpa=2',
        filter: {
          agentIds: ['a_worker_alpha'],
          kinds: ['message'],
          window: { startMs: 0, endMs: 500 },
        },
        selection: 'a_worker_alpha',
        elapsedMs: 700,
        speed: 2,
      }),
    )
    expect(parseSnapshot(serializeSnapshot(captured))).toEqual(captured)
  })
})

describe('cameraSnapshotOf (M6-T1)', () => {
  it('clamps the pose to the same limits the camera models use', () => {
    const snapshot = cameraSnapshotOf(
      'fly',
      {
        target: { x: 0, y: 0, z: 0 },
        baseAzimuthDeg: 90,
        baseElevationDeg: 18,
        azimuthDeg: 405,
        elevationDeg: 140,
        zoom: 12,
        baseDistance: 10,
        fov: 55,
        near: 0.1,
        extentRadius: 3,
      },
      {
        position: { x: 1, y: 2, z: 3 },
        yawDeg: -90,
        pitchDeg: 120,
        basePosition: { x: 0, y: 0, z: 0 },
        baseYawDeg: 0,
        basePitchDeg: 0,
        home: { x: 0, y: 0, z: 0 },
        envelopeRadius: 9,
        fov: 55,
        near: 0.1,
        extentRadius: 3,
      },
    )
    expect(snapshot.mode).toBe('fly')
    expect(snapshot.orbit.azimuthDeg).toBe(45)
    expect(snapshot.orbit.elevationDeg).toBe(80)
    expect(snapshot.orbit.zoom).toBe(3)
    expect(snapshot.fly?.yawDeg).toBe(270)
    expect(snapshot.fly?.pitchDeg).toBe(85)
    expect(snapshot.fly?.position).toEqual({ x: 1, y: 2, z: 3 })
  })
})

describe('parseSnapshot (M6-T1)', () => {
  it('reads nothing from nothing', () => {
    expect(parseSnapshot(null)).toBeNull()
    expect(parseSnapshot(undefined)).toBeNull()
    expect(parseSnapshot('')).toBeNull()
  })

  it('rejects text that is not JSON, and JSON that is not an object', () => {
    expect(parseSnapshot('{ not json')).toBeNull()
    expect(parseSnapshot('"a string"')).toBeNull()
    expect(parseSnapshot('42')).toBeNull()
    expect(parseSnapshot('null')).toBeNull()
    expect(parseSnapshot('[1, 2, 3]')).toBeNull()
  })

  it('rejects a snapshot from another schema version', () => {
    const older = { ...captureSnapshot(source()), version: 0 }
    expect(normalizeSnapshot(older)).toBeNull()
    const newer = { ...captureSnapshot(source()), version: SNAPSHOT_VERSION + 1 }
    expect(normalizeSnapshot(newer)).toBeNull()
  })

  it('rejects a snapshot that does not name a run', () => {
    const captured = captureSnapshot(source())
    expect(normalizeSnapshot({ ...captured, run: undefined })).toBeNull()
    expect(normalizeSnapshot({ ...captured, run: { id: '' } })).toBeNull()
    expect(normalizeSnapshot({ ...captured, run: { id: 7 } })).toBeNull()
  })

  it('salvages a bad playhead and speed instead of trusting them', () => {
    const captured = captureSnapshot(source())
    const read = normalizeSnapshot({
      ...captured,
      playback: { elapsedMs: -20, speed: 'fast' },
    })
    expect(read?.playback).toEqual({ elapsedMs: 0, speed: 1 })
    const missing = normalizeSnapshot({ ...captured, playback: undefined })
    expect(missing?.playback).toEqual({ elapsedMs: 0, speed: 1 })
  })

  it('restores a corrupt filter facet to "no restriction", never to nothing', () => {
    const captured = captureSnapshot(source())
    // A garbage kind cannot silently hide every message in the run.
    const garbage = normalizeSnapshot({
      ...captured,
      filter: { agentIds: [], kinds: ['message', 'not-a-kind'], window: null },
    })
    expect(garbage?.filter.kinds).toEqual(['message', 'tool_call'])
    // A garbage agent list is not a lens naming agents that cannot exist.
    const agents = normalizeSnapshot({
      ...captured,
      filter: { agentIds: ['a_x', 3], kinds: ['message', 'tool_call'], window: null },
    })
    expect(agents?.filter.agentIds).toEqual([])
    // An empty kinds list IS a readable value (the viewer unchecked both).
    const none = normalizeSnapshot({
      ...captured,
      filter: { agentIds: [], kinds: [], window: null },
    })
    expect(none?.filter.kinds).toEqual([])
  })

  it('reads a missing filter as the identity lens', () => {
    const captured = captureSnapshot(source())
    const read = normalizeSnapshot({ ...captured, filter: undefined })
    expect(read?.filter).toEqual({
      agentIds: [],
      kinds: ['message', 'tool_call'],
      window: null,
    })
  })

  it('drops a window that is not two numbers', () => {
    const captured = captureSnapshot(source())
    const read = normalizeSnapshot({
      ...captured,
      filter: { agentIds: [], kinds: ['message'], window: { startMs: 'a', endMs: 10 } },
    })
    expect(read?.filter.window).toBeNull()
  })

  it('keeps a selection only when it is a non-empty string', () => {
    const captured = captureSnapshot(source())
    expect(normalizeSnapshot({ ...captured, selection: 42 })?.selection).toBeNull()
    expect(normalizeSnapshot({ ...captured, selection: '' })?.selection).toBeNull()
    expect(normalizeSnapshot({ ...captured, selection: 'a_x' })?.selection).toBe('a_x')
  })

  it('reads an unreadable camera block as "keep the opening shot"', () => {
    const captured = captureSnapshot(source())
    expect(normalizeSnapshot({ ...captured, camera: undefined })?.camera).toBeNull()
    expect(
      normalizeSnapshot({ ...captured, camera: { mode: 'orbit' } })?.camera,
    ).toBeNull()
    expect(
      normalizeSnapshot({ ...captured, camera: { ...CAMERA, mode: 'sideways' } })
        ?.camera,
    ).toBeNull()
    // A readable orbit with a corrupt fly pose keeps the orbit and drops the eye.
    const partial = normalizeSnapshot({
      ...captured,
      camera: {
        mode: 'orbit',
        orbit: { azimuthDeg: 10, elevationDeg: 5, zoom: 1 },
        fly: {},
      },
    })
    expect(partial?.camera?.orbit).toEqual({ azimuthDeg: 10, elevationDeg: 5, zoom: 1 })
    expect(partial?.camera?.fly).toBeNull()
  })

  it('clamps a hand-edited camera to the renderer limits', () => {
    const captured = captureSnapshot(source())
    const read = normalizeSnapshot({
      ...captured,
      camera: {
        mode: 'fly',
        orbit: { azimuthDeg: 720, elevationDeg: -400, zoom: 0.01 },
        fly: { position: { x: 4, y: 5, z: 6 }, yawDeg: 361, pitchDeg: -400 },
      },
    })
    expect(read?.camera?.orbit).toEqual({
      azimuthDeg: 0,
      elevationDeg: -80,
      zoom: 0.35,
    })
    expect(read?.camera?.fly).toEqual({
      position: { x: 4, y: 5, z: 6 },
      yawDeg: 1,
      pitchDeg: -85,
    })
  })

  it('ignores keys it does not know (a newer writer, a human edit)', () => {
    const captured = captureSnapshot(source())
    const read = normalizeSnapshot({
      ...captured,
      favouriteColour: 'green',
      playback: { ...captured.playback, loop: true },
    })
    expect(read?.run.id).toBe(FAN_OUT.id)
    expect(read?.playback).toEqual({ elapsedMs: 1200, speed: 1 })
  })
})

describe('isPlaybackSpeed (M6-T1)', () => {
  it('accepts exactly the transport speeds', () => {
    for (const speed of [0.25, 0.5, 1, 2, 4]) expect(isPlaybackSpeed(speed)).toBe(true)
    for (const speed of [0, 3, 8, '1', null, undefined, Number.NaN]) {
      expect(isPlaybackSpeed(speed)).toBe(false)
    }
  })
})

describe('round trip through text', () => {
  it('keeps a saved playhead position and the trace that names the run', () => {
    const read = roundTrip({ elapsedMs: 900, trace: 'trace=fleet' })
    expect(read?.playback.elapsedMs).toBe(900)
    expect(read?.run.trace).toBe('trace=fleet')
    expect(SPAN_MS).toBeGreaterThan(0)
  })
})
