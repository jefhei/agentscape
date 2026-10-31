/**
 * The autosave snapshot (M6-T1) — the *pure* half of "the view survives a reload".
 *
 * A reload throws away every React state holder the app has: the playhead, the
 * lens, the inspected agent and the camera. The product is a *view of a run*, and
 * a viewer who spent a minute orbiting a fan-out and narrowing it to two agents
 * does not want to re-earn that. So the app writes one small JSON value to
 * `localStorage` while it is used and reads it back on boot.
 *
 * This module owns **the value**: its schema, its version, how it is captured
 * from live state and how text is turned back into a validated snapshot. It knows
 * nothing about React, `localStorage`, timers or the clock — `savedAt` is passed
 * *in*, exactly like the transport's `deltaMs` — so every rule here is a plain
 * function a test can call.
 *
 * ## What is saved, and what is deliberately not
 *
 * **Saved:** which run was mounted (a re-parseable `?trace=` fragment *and* the
 * run's own id), the playhead position and speed, the three filter facets, the
 * inspected agent, and the camera (mode + orbit pose + fly pose).
 *
 * **Not saved:** the run's rows. v1 mounts runs from a fixture registry or a URL
 * scheme (M5-T3), so a run is *reproducible from its reference* — storing a
 * 2000-agent synthetic run's rows would duplicate the reference, risk the ~5 MB
 * quota, and be a second ingest path by the back door. The reference plus the run
 * **id** is therefore the whole "loaded run" part of the autosave: the id is the
 * guard that says whether the saved view state still describes the run on screen.
 *
 * **Never saved:** `playing`. A reload must not start a clock unbidden — the run
 * opens paused wherever the playhead was left.
 *
 * ## Validation is salvage, not trust
 *
 * Stored text is user-editable and outlives code: a hand-edited value, a
 * half-written one from a killed tab, a schema from an older build. {@link
 * parseSnapshot} therefore never throws and never returns a half-trusted value:
 *
 * - the **version** must match exactly — an unknown schema is not interpreted;
 * - the **run id** is required — without it nothing can be restored against a run;
 * - each view-state field is read defensively: a non-finite number falls back to
 *   the run's opening value, an unknown camera mode to `'orbit'`, an unknown
 *   filter kind is dropped;
 * - a **camera block that is not fully readable reads as `null`** (keep the
 *   opening shot) rather than as a partial pose — a corrupt camera must not
 *   teleport the view somewhere arbitrary;
 * - a filter facet whose array contains anything unreadable is treated as corrupt
 *   and restored to "no restriction" for that facet, so a mangled value can never
 *   silently hide the whole run.
 *
 * Ordinary game saves are lenient; this one has to be, because the alternative is
 * a blank scene on boot caused by a byte in `localStorage`.
 */

import { clampPitch } from '../camera/fly.ts'
import type { FlyCamera } from '../camera/fly.ts'
import { isCameraMode } from '../camera/modes.ts'
import type { CameraMode } from '../camera/modes.ts'
import {
  ORBIT_MAX_ZOOM,
  ORBIT_MIN_ZOOM,
  clampElevation,
  normalizeAzimuth,
} from '../camera/orbit.ts'
import type { OrbitCamera } from '../camera/orbit.ts'
import {
  FILTER_KINDS,
  normalizeAgentIds,
  normalizeKinds,
  normalizeWindow,
} from '../filter/filter.ts'
import type { FilterKind, FilterState, FilterWindow } from '../filter/filter.ts'
import { DEFAULT_SPEED, PLAYBACK_SPEEDS } from '../timeline/index.ts'
import type { PlaybackSpeed } from '../timeline/index.ts'
import type { AgentId, RunId } from '../types/index.ts'

// ── Schema ──────────────────────────────────────────────────────────────────

/**
 * The snapshot schema's version. Bumped whenever the shape changes in a way an
 * older reader would misread; a snapshot whose version is not exactly this is
 * ignored rather than migrated (there is nothing to migrate yet, and a silent
 * half-migration is worse than a fresh view).
 */
export const SNAPSHOT_VERSION = 1

/** An orbit pose: the two angles and the dolly the viewer left the camera at. */
export interface OrbitPoseSnapshot {
  /** Azimuth around +Y, degrees, `[0, 360)`. */
  azimuthDeg: number
  /** Elevation above the horizon, degrees, inside the tilt limits. */
  elevationDeg: number
  /** Dolly multiple (`1` = the scene's opening framing distance). */
  zoom: number
}

/** A first-person pose: the eye and the two look angles. */
export interface FlyPoseSnapshot {
  /** Eye position in world space. */
  position: { x: number; y: number; z: number }
  /** Yaw around +Y, degrees, `[0, 360)`. */
  yawDeg: number
  /** Pitch above the horizon, degrees, inside the tilt limits. */
  pitchDeg: number
}

/**
 * The camera as saved. `fly` is `null` when the stored block was not readable —
 * restoring the seeded fly camera (the pose the viewer is looking at) is always
 * a valid answer, whereas restoring half a pose is not.
 */
export interface CameraSnapshot {
  /** The active camera mode. */
  mode: CameraMode
  /** The orbit pose (kept live even while flying — it is where a return lands). */
  orbit: OrbitPoseSnapshot
  /** The fly pose, or `null` to keep the camera the scene was framed with. */
  fly: FlyPoseSnapshot | null
}

/** The playhead as saved. `playing` is deliberately absent — see the module doc. */
export interface PlaybackSnapshot {
  /** Position from the run's start, ms (clamped to the run on restore). */
  elapsedMs: number
  /** Playback speed multiplier. */
  speed: PlaybackSpeed
}

/** The lens as saved — the same three facets the filter model holds. */
export interface FilterSnapshot {
  agentIds: AgentId[]
  kinds: FilterKind[]
  window: FilterWindow | null
}

/** Which run the view state belongs to. */
export interface RunSnapshot {
  /** The normalized run's id — the guard that ties the view to a trace. */
  id: RunId
  /** The canonical `?trace=` fragment that rebuilds it, or `null` for the default mount. */
  trace: string | null
}

/** Everything one autosave writes. */
export interface ViewSnapshot {
  /** {@link SNAPSHOT_VERSION}; a reader rejects anything else. */
  version: typeof SNAPSHOT_VERSION
  /** When it was captured, epoch ms (informational — never used for a rule). */
  savedAt: number
  /** The run the view state describes. */
  run: RunSnapshot
  /** Where the playhead was, and how fast it was running. */
  playback: PlaybackSnapshot
  /** The lens. */
  filter: FilterSnapshot
  /** The inspected agent, or `null`. */
  selection: AgentId | null
  /**
   * The camera, or `null` when the stored block was not readable — a corrupt
   * camera reads as "keep the scene's opening shot" rather than as a partial pose.
   */
  camera: CameraSnapshot | null
}

/** The live state one capture reads. */
export interface SnapshotSource {
  /** Id of the mounted run. */
  runId: RunId
  /** The canonical `?trace=` fragment for it, or `null` for the default mount. */
  trace: string | null
  /** Playhead position, ms. */
  elapsedMs: number
  /** Playback speed. */
  speed: PlaybackSpeed
  /** The filter as it stands. */
  filter: FilterState
  /** The inspected agent, or `null`. */
  selection: AgentId | null
  /** The camera as the viewport last reported it. */
  camera: CameraSnapshot
  /** Capture time, epoch ms (passed in — the pure layer owns no clock). */
  savedAt: number
}

// ── Scalars ─────────────────────────────────────────────────────────────────

/** A finite number, or the fallback. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** `value` inside `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** Whether `value` is one of the transport's speeds. */
export function isPlaybackSpeed(value: unknown): value is PlaybackSpeed {
  return (
    typeof value === 'number' && (PLAYBACK_SPEEDS as readonly number[]).includes(value)
  )
}

/** Whether `value` is one of the filterable event kinds. */
function isFilterKind(value: unknown): value is FilterKind {
  return (
    typeof value === 'string' && (FILTER_KINDS as readonly string[]).includes(value)
  )
}

/** A non-empty string, or `null`. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** A plain object (not `null`, not an array), or `null`. */
function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

// ── Camera ──────────────────────────────────────────────────────────────────

/** The camera, captured from the two camera states the viewport holds. */
export function cameraSnapshotOf(
  mode: CameraMode,
  orbit: OrbitCamera,
  fly: FlyCamera,
): CameraSnapshot {
  return {
    mode,
    orbit: {
      azimuthDeg: normalizeAzimuth(orbit.azimuthDeg),
      elevationDeg: clampElevation(orbit.elevationDeg),
      zoom: clamp(finite(orbit.zoom, 1), ORBIT_MIN_ZOOM, ORBIT_MAX_ZOOM),
    },
    fly: {
      position: {
        x: finite(fly.position.x, 0),
        y: finite(fly.position.y, 0),
        z: finite(fly.position.z, 0),
      },
      yawDeg: normalizeAzimuth(fly.yawDeg),
      pitchDeg: clampPitch(fly.pitchDeg),
    },
  }
}

/** A saved fly pose, read defensively, or `null` when it is not fully usable. */
function flyPose(value: unknown): FlyPoseSnapshot | null {
  const raw = record(value)
  if (raw === null) return null
  const position = record(raw.position)
  if (position === null) return null
  const x = position.x
  const y = position.y
  const z = position.z
  const yaw = raw.yawDeg
  const pitch = raw.pitchDeg
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof z !== 'number' ||
    !Number.isFinite(z) ||
    typeof yaw !== 'number' ||
    !Number.isFinite(yaw) ||
    typeof pitch !== 'number' ||
    !Number.isFinite(pitch)
  ) {
    return null
  }
  return {
    position: { x, y, z },
    yawDeg: normalizeAzimuth(yaw),
    pitchDeg: clampPitch(pitch),
  }
}

/**
 * A saved camera block, or `null` when it cannot be read whole. The orbit pose is
 * mandatory (every mode keeps it live) and the mode must be a known one; the fly
 * pose is optional and reads as "keep the seeded one" when absent or corrupt.
 */
function cameraSnapshot(value: unknown): CameraSnapshot | null {
  const raw = record(value)
  if (raw === null) return null
  if (!isCameraMode(raw.mode)) return null
  const orbit = record(raw.orbit)
  if (orbit === null) return null
  const azimuth = orbit.azimuthDeg
  const elevation = orbit.elevationDeg
  const zoom = orbit.zoom
  if (
    typeof azimuth !== 'number' ||
    !Number.isFinite(azimuth) ||
    typeof elevation !== 'number' ||
    !Number.isFinite(elevation) ||
    typeof zoom !== 'number' ||
    !Number.isFinite(zoom)
  ) {
    return null
  }
  return {
    mode: raw.mode,
    orbit: {
      azimuthDeg: normalizeAzimuth(azimuth),
      elevationDeg: clampElevation(elevation),
      zoom: clamp(zoom, ORBIT_MIN_ZOOM, ORBIT_MAX_ZOOM),
    },
    fly: flyPose(raw.fly),
  }
}

// ── Filter ──────────────────────────────────────────────────────────────────

/**
 * A saved filter, read facet by facet. A facet whose stored array holds anything
 * unreadable is corrupt, not narrow: it restores to "no restriction" so a mangled
 * value can never hide the whole run. (`kinds: []` — a viewer who unchecked both
 * kinds — is a real, readable value and is kept.)
 */
function filterSnapshot(value: unknown): FilterSnapshot {
  const raw = record(value) ?? {}
  const identity: FilterSnapshot = {
    agentIds: [],
    kinds: [...FILTER_KINDS],
    window: null,
  }

  const agentIds = raw.agentIds
  const agents =
    agentIds === undefined
      ? identity.agentIds
      : Array.isArray(agentIds) && agentIds.every((id) => typeof id === 'string')
        ? normalizeAgentIds(agentIds)
        : identity.agentIds

  const kinds = raw.kinds
  const kept =
    kinds === undefined
      ? identity.kinds
      : Array.isArray(kinds) && kinds.every(isFilterKind)
        ? normalizeKinds(kinds)
        : identity.kinds

  const window = record(raw.window)
  const savedWindow =
    window === null
      ? null
      : normalizeWindow({
          startMs: finite(window.startMs, Number.NaN),
          endMs: finite(window.endMs, Number.NaN),
        })

  return { agentIds: agents, kinds: kept, window: savedWindow }
}

// ── Capture ─────────────────────────────────────────────────────────────────

/**
 * The camera a capture falls back to when the caller's block is unreadable. It can
 * only be reached by a caller that hands {@link captureSnapshot} a hand-built
 * block (the viewport always reports one from {@link cameraSnapshotOf}); it names
 * a defined — if arbitrary — orbit, and `fly: null` keeps the seeded fly camera,
 * so even that case cannot produce a malformed save.
 */
export const DEFAULT_CAMERA_SNAPSHOT: CameraSnapshot = Object.freeze({
  mode: 'orbit',
  orbit: Object.freeze({ azimuthDeg: 0, elevationDeg: 0, zoom: 1 }),
  fly: null,
})

/**
 * Build the value to write from live state. Pure: the capture time is an input,
 * every number is normalized to the same limits the models use, and the object is
 * built in one canonical key order so {@link serializeSnapshot} is byte-identical
 * for the same view.
 */
export function captureSnapshot(source: SnapshotSource): ViewSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    savedAt: finite(source.savedAt, 0),
    run: { id: source.runId, trace: textOrNull(source.trace) },
    playback: {
      elapsedMs: Math.max(0, finite(source.elapsedMs, 0)),
      speed: isPlaybackSpeed(source.speed) ? source.speed : DEFAULT_SPEED,
    },
    filter: {
      agentIds: normalizeAgentIds(source.filter.agentIds),
      kinds: normalizeKinds(source.filter.kinds),
      window: normalizeWindow(source.filter.window),
    },
    selection: textOrNull(source.selection),
    camera: cameraSnapshot(source.camera) ?? DEFAULT_CAMERA_SNAPSHOT,
  }
}

// ── Serialize / parse ───────────────────────────────────────────────────────

/** The text one autosave stores: the snapshot as JSON, one canonical key order. */
export function serializeSnapshot(snapshot: ViewSnapshot): string {
  return JSON.stringify(snapshot)
}

/**
 * Read stored text back into a validated snapshot, or `null` when it is not one.
 *
 * Never throws: a missing value, malformed JSON, an unknown version, a missing run
 * id and every individual corrupt field are all handled (see the module doc for
 * which ones are salvaged and which ones reject the whole value).
 */
export function parseSnapshot(text: string | null | undefined): ViewSnapshot | null {
  if (typeof text !== 'string' || text.length === 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  return normalizeSnapshot(raw)
}

/**
 * Validate an already-parsed value. Exported so a caller holding JSON (a test, a
 * future URL payload) does not have to stringify it first.
 */
export function normalizeSnapshot(raw: unknown): ViewSnapshot | null {
  const value = record(raw)
  if (value === null) return null
  if (value.version !== SNAPSHOT_VERSION) return null

  const run = record(value.run)
  const id = run === null ? null : textOrNull(run.id)
  if (id === null) return null

  const playback = record(value.playback) ?? {}
  const speed = playback.speed
  const selection = textOrNull(value.selection)

  return {
    version: SNAPSHOT_VERSION,
    savedAt: Math.max(0, finite(value.savedAt, 0)),
    run: { id, trace: run === null ? null : textOrNull(run.trace) },
    playback: {
      elapsedMs: Math.max(0, finite(playback.elapsedMs, 0)),
      speed: isPlaybackSpeed(speed) ? speed : DEFAULT_SPEED,
    },
    filter: filterSnapshot(value.filter),
    selection,
    camera: cameraSnapshot(value.camera),
  }
}
