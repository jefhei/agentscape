/**
 * Restoring a saved view onto a run (M6-T1) — the *rules* half of the autosave.
 *
 * A snapshot describes a view of **one** run. Restoring it is therefore not a copy
 * of saved numbers into live state; it is a *question about this run*: does the
 * saved view still describe the trace that is mounted, and which parts of it still
 * make sense? The answer is computed here, purely, so the hooks and the shell only
 * consume a verdict.
 *
 * ## The run id is the guard
 *
 * A run's id is a hash of its normalized messages (M1-T4), so it changes whenever
 * the trace does — a different export, a rebuilt fixture, a recovered snapshot of a
 * *different* fleet run. Equality is therefore the honest test for "this view was
 * saved for exactly this trace", and everything else follows: a mismatch restores
 * **nothing at all**, rather than a camera aimed at a cloud that has moved and a
 * lens naming agents that may no longer exist.
 *
 * ## What survives, and what is pruned
 *
 * - **the playhead** — clamped to the run's span. A snapshot from a longer trace
 *   would otherwise restore past the end (the transport clamps anyway; doing it
 *   here means the restored value is already the value that will be shown).
 * - **the filter** — re-read through the run with the same `retainFilter` the live
 *   hook uses, so a selected agent the run no longer has is dropped and a window
 *   past its end is clamped. Corrupt-facet repair already happened in
 *   `parseSnapshot`; this is the *run* half.
 * - **the selection** — kept only when the run has that agent. A panel describing
 *   a ghost is worse than no panel.
 * - **the camera** — restored onto the scene's own opening shot: the orbit pose is
 *   re-created from the plan's camera (same target, fov, near, dolly base) with
 *   the saved angles and zoom, and the fly pose is restored into a camera seeded
 *   from that same plan, so both modes stay anchored to *this* run's cloud.
 * - **`playing`** — never restored. There is no field for it: a reload opens
 *   paused at the saved position.
 */

import { createFlyCamera, restoreFlyPose } from '../camera/fly.ts'
import type { FlyCamera } from '../camera/fly.ts'
import type { CameraMode } from '../camera/modes.ts'
import { createOrbitCamera } from '../camera/orbit.ts'
import type { OrbitCamera } from '../camera/orbit.ts'
import { IDENTITY_FILTER, reduceFilter, retainFilter } from '../filter/filter.ts'
import type { FilterState } from '../filter/filter.ts'
import type { TraceModel } from '../model/index.ts'
import type { SceneCamera } from '../scene/scenePlan.ts'
import type { PlaybackSpeed } from '../timeline/index.ts'
import type { AgentId } from '../types/index.ts'
import type { CameraSnapshot, ViewSnapshot } from './snapshot.ts'

/** The view state a snapshot restores onto a run. */
export interface RestoredView {
  /** Where the playhead was (already clamped to this run) and how fast it ran. */
  playback: { elapsedMs: number; speed: PlaybackSpeed }
  /** The lens, pruned against this run's agents and span. */
  filter: FilterState
  /** The inspected agent, or `null` when this run does not have it. */
  selection: AgentId | null
  /**
   * The saved camera, still in snapshot form; `restoreCameraPlan` turns it into
   * state. `null` when the save carried no readable camera — keep the opening shot.
   */
  camera: CameraSnapshot | null
}

/**
 * The camera state a saved camera restores for a scene: both modes are seeded from
 * the scene's own opening shot, so the target, fov, near plane, dolly base and
 * flight envelope all belong to *this* run — only the live pose comes from the
 * save.
 */
export interface RestoredCamera {
  mode: CameraMode
  orbit: OrbitCamera
  fly: FlyCamera
}

/**
 * Restore `snapshot`'s view onto `model`, or `null` when it was not saved for this
 * run (or there is no snapshot). Pure: the model is read, never mutated, and a
 * snapshot that needs no pruning lands as an equal value, not a rewritten one.
 */
export function restoreView(
  snapshot: ViewSnapshot | null,
  model: TraceModel,
): RestoredView | null {
  if (snapshot === null) return null
  if (snapshot.run.id !== model.id) return null

  const spanMs = Math.max(0, model.endedAt - model.startedAt)
  const elapsedMs = Math.min(Math.max(0, snapshot.playback.elapsedMs), spanMs)
  const knownIds = model.agents.map((agent) => agent.id)
  // Two normalizations, in the order the live app performs them: the saved facets
  // become a canonical filter (an identity one becomes the shared identity value,
  // so the scene's no-op lens still holds), and then the *run* prunes what it
  // cannot support.
  const canonical = reduceFilter(IDENTITY_FILTER, {
    type: 'replace',
    filter: {
      agentIds: snapshot.filter.agentIds,
      kinds: snapshot.filter.kinds,
      window: snapshot.filter.window,
    },
  })
  const filter = retainFilter(canonical, knownIds, spanMs)
  const selection =
    snapshot.selection !== null && knownIds.includes(snapshot.selection)
      ? snapshot.selection
      : null

  return {
    playback: { elapsedMs, speed: snapshot.playback.speed },
    filter,
    selection,
    camera: snapshot.camera,
  }
}

/**
 * Turn a saved camera into live camera state for `opening` (the scene plan's own
 * camera) at `extentRadius` (the settled cloud's radius).
 *
 * Both modes are *created from the plan* first — that is what makes a restored
 * view still belong to the scene it is drawn in — and then moved to the saved
 * pose through the camera modules' own clamped setters. A snapshot with no
 * readable fly pose (`fly: null`) keeps the seeded fly camera, which is the pose
 * the viewer was already looking at, i.e. the right thing to hand a mode switch.
 */
export function restoreCameraPlan(
  camera: CameraSnapshot,
  opening: SceneCamera,
  extentRadius: number,
): RestoredCamera {
  const orbit = createOrbitCamera(opening, extentRadius, {
    azimuthDeg: camera.orbit.azimuthDeg,
    elevationDeg: camera.orbit.elevationDeg,
    zoom: camera.orbit.zoom,
  })
  const seeded = createFlyCamera(opening, extentRadius)
  return {
    mode: camera.mode,
    orbit,
    fly: camera.fly === null ? seeded : restoreFlyPose(seeded, camera.fly),
  }
}
