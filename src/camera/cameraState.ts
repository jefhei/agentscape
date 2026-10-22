/**
 * The active-mode seam of the camera layer (M4-T3) — the only module that knows
 * *both* pose rules.
 *
 * `modes.ts` is the vocabulary (which modes exist, what they are called);
 * `orbit.ts` and `fly.ts` are the two pose rules; this module is where they meet:
 * given both states and the active mode it answers the three questions a caller
 * actually has —
 *
 * 1. **what pose do I apply?** ({@link modeCameraPose}),
 * 2. **what does the bar print?** ({@link describeCamera}, a discriminated union of
 *    the two already-tested readouts),
 * 3. **what happens when the viewer switches?** ({@link switchCameraMode}).
 *
 * Keeping the dispatch here rather than in `modes.ts` is what makes the import
 * graph a DAG: `modes.ts` is a leaf, the two pose modules import it, and this
 * module sits on top. Nothing imports *it* except the hook and the UI.
 *
 * ## The switch's one asymmetry, and why
 *
 * - **orbit → fly seeds the fly camera from the orbit's current pose** (M4-T3's
 *   requirement): you start flying from where you were standing, so the switch
 *   does not teleport the view.
 * - **fly → orbit keeps the orbit state untouched**: an excursion inside the cloud
 *   is a detour, not a re-frame, so returning to the survey view returns to the
 *   survey you left. The alternative — re-deriving an orbit from the fly position —
 *   would silently fire the camera back out to a sphere it never asked for.
 *
 * ## Purity (PRD §5)
 *
 * Pure and deterministic: no three.js, no DOM, no clock, no `Math.random`, no
 * mutation of any argument. The seed function is a parameter so the transition can
 * be tested without a renderer (and so the hook can bind the scene's extent once).
 */

import type { SceneCamera } from '../scene/scenePlan.ts'
import { describeFly, flyCameraPose } from './fly.ts'
import type { FlyCamera, FlyReadout } from './fly.ts'
import type { CameraMode } from './modes.ts'
import { describeOrbit, orbitCameraPose } from './orbit.ts'
import type { OrbitCamera, OrbitReadout } from './orbit.ts'

/** What the camera bar prints: one arm per mode, discriminated by `mode`. */
export type CameraReadout = OrbitReadout | FlyReadout

/**
 * The renderer-ready camera for the active mode. Both modes own their pose rule;
 * this only chooses, so a caller holding both states never branches on the mode.
 */
export function modeCameraPose(
  mode: CameraMode,
  orbit: OrbitCamera,
  fly: FlyCamera,
): SceneCamera {
  return mode === 'fly' ? flyCameraPose(fly) : orbitCameraPose(orbit)
}

/** The mode's heading and pitch, in degrees — the numbers the headless `data-*` attrs print. */
export interface CameraAngles {
  /** Around +Y: an orbit azimuth or a fly yaw. */
  azimuthDeg: number
  /** Above the horizon: an orbit elevation or a fly pitch. */
  elevationDeg: number
}

/**
 * The active mode's angles, unformatted. The viewport's `data-camera-azimuth` /
 * `data-camera-elevation` attributes and the bar's readout must print the same
 * numbers, so both come from here (and from the mode's own state, not from a pose
 * read back off a look-at vector).
 */
export function cameraAngles(
  mode: CameraMode,
  orbit: OrbitCamera,
  fly: FlyCamera,
): CameraAngles {
  return mode === 'fly'
    ? { azimuthDeg: fly.yawDeg, elevationDeg: fly.pitchDeg }
    : { azimuthDeg: orbit.azimuthDeg, elevationDeg: orbit.elevationDeg }
}

/** The active mode's readout. */
export function describeCamera(
  mode: CameraMode,
  orbit: OrbitCamera,
  fly: FlyCamera,
): CameraReadout {
  return mode === 'fly' ? describeFly(fly) : describeOrbit(orbit)
}

/** What a mode switch has to hand over. */
export interface CameraSwitch {
  /** The mode after the switch. */
  mode: CameraMode
  /** The fly camera to carry after the switch (re-seeded on the way in). */
  fly: FlyCamera
}

/**
 * Apply one camera transition, purely. `seed` builds a fly camera from a pose — the
 * hook binds the scene's extent into it (`(pose) => createFlyCamera(pose, extent)`),
 * tests pass `createFlyCamera` itself.
 *
 * `orbit` is read only for its pose, which is the only thing the switch needs: the
 * orbit state itself is untouched, so the survey survives the excursion.
 */
export function switchCameraMode(
  mode: CameraMode,
  orbit: OrbitCamera,
  fly: FlyCamera,
  next: CameraMode,
  seed: (pose: SceneCamera) => FlyCamera,
): CameraSwitch {
  if (next === mode) return { mode, fly }
  if (next === 'fly') return { mode: next, fly: seed(orbitCameraPose(orbit)) }
  return { mode: next, fly }
}
