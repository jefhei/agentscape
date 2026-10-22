/**
 * The camera controller hook (M4-T3) — the render layer's half of *both* camera
 * modes and the switch between them.
 *
 * Everything with a *rule* in it lives in the pure modules: `orbit.ts` (the survey
 * view), `fly.ts` (the first-person view), `modes.ts` (the vocabulary) and
 * `cameraState.ts` (the dispatch between them). This module owns only what a pure
 * module cannot:
 *
 * 1. **holding the state** — the orbit half is held by {@link useOrbitCamera}, which
 *    M4-T2 already landed and tested, so the fly camera is composed *around* it
 *    rather than reimplementing it. The active mode and the fly state are one
 *    `useState` object, so a switch is a single transition and there is never a
 *    frame where the mode says `fly` and the fly camera belongs to the previous
 *    scene;
 * 2. **seeding on the way into fly** — the switch seeds the fly camera from the
 *    orbit's **current** pose (M4-T3's requirement: flying starts where the camera
 *    already is), via the pure {@link switchCameraMode};
 * 3. **reframing on a new run** — a different run is a different cloud, so both
 *    modes reset to that run's opening shot and the mode returns to orbit. Carrying
 *    a fly position across traces would leave the viewer inside a cloud that no
 *    longer exists.
 *
 * Every callback has a stable identity (`updateFly` does the functional-update
 * dance so a per-frame movement call re-renders only when the camera really
 * moved), because the fly rig binds window listeners and a re-created callback
 * would tear them down once per frame.
 *
 * ## Why the orbit state persists across an excursion
 *
 * Switching to fly does not touch the orbit. Flying in and back out returns to the
 * survey you left — an excursion is a detour, not a re-frame. The asymmetry is
 * deliberate and pinned in `cameraState.ts`'s doc + tests.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SceneCamera } from '../scene/scenePlan.ts'
import {
  cameraAngles,
  describeCamera,
  modeCameraPose,
  switchCameraMode,
} from './cameraState.ts'
import type { CameraAngles, CameraReadout } from './cameraState.ts'
import { createFlyCamera, flyAdvance, flyLookBy, flyMove, resetFly } from './fly.ts'
import type { FlyAxes, FlyCamera } from './fly.ts'
import { cameraModeHint, nextCameraMode } from './modes.ts'
import type { CameraMode } from './modes.ts'
import type { OrbitCamera } from './orbit.ts'
import { useOrbitCamera } from './useOrbitCamera.ts'

/** What a camera control surface (and the viewport) gets from {@link useCamera}. */
export interface CameraController {
  /** The active mode. */
  mode: CameraMode
  /** The orbit state (live even while flying — it is where a return lands). */
  orbit: OrbitCamera
  /** The fly state (always seeded, so a switch has a camera to hand over to). */
  fly: FlyCamera
  /** The renderer-ready pose for the active mode. */
  camera: SceneCamera
  /** The active mode's heading/pitch, unformatted (the headless `data-*` attrs). */
  angles: CameraAngles
  /** The active mode's readout, for the camera bar. */
  readout: CameraReadout
  /** The active mode's one-line pointer hint. */
  hint: string
  /** Switch to a specific mode (an identity when it is already active). */
  setMode: (mode: CameraMode) => void
  /** Switch to the other mode (what the bar's button does). */
  toggleMode: () => void
  /** Orbit: rotate by a pointer drag, in CSS pixels. */
  orbitBy: (dxPx: number, dyPx: number) => void
  /** Orbit: dolly by `steps` (positive = closer). */
  zoomBy: (steps: number) => void
  /** Fly: look around by a pointer drag, in CSS pixels. */
  lookBy: (dxPx: number, dyPx: number) => void
  /** Fly: advance along the look direction by wheel `steps` (positive = forward). */
  advance: (steps: number) => void
  /** Fly: move for one frame (`axes` × real elapsed ms). */
  move: (axes: FlyAxes, deltaMs: number, boost: boolean) => void
  /** Fly: back to the pose the mode switch handed over. */
  resetFly: () => void
  /** Return the active mode to its opening shot (orbit or fly). */
  reset: () => void
  /** Orbit: whether the dolly can still come closer. */
  canZoomIn: boolean
  /** Orbit: whether the dolly can still go further out. */
  canZoomOut: boolean
}

/** The mode state and the fly camera, as one value so a switch is atomic. */
interface ViewState {
  mode: CameraMode
  fly: FlyCamera
}

/**
 * Hold and drive the camera for one framed scene.
 *
 * `camera` is the scene plan's opening shot (M3-T6) and `extentRadius` the settled
 * cloud's radius; together they are the only inputs, and changing either (a new
 * run) re-frames both modes.
 */
export function useCamera(camera: SceneCamera, extentRadius: number): CameraController {
  const orbit = useOrbitCamera(camera, extentRadius)
  const [view, setView] = useState<ViewState>(() => ({
    mode: 'orbit',
    fly: createFlyCamera(camera, extentRadius),
  }))

  // A fly camera is seeded from a *pose*; the scene's extent is the other input,
  // so it is bound here once and the pure transition stays generic.
  const seedFly = useCallback(
    (pose: SceneCamera) => createFlyCamera(pose, extentRadius),
    [extentRadius],
  )

  const setMode = useCallback(
    (next: CameraMode) => {
      setView((current) => {
        const switched = switchCameraMode(
          current.mode,
          orbit.orbit,
          current.fly,
          next,
          seedFly,
        )
        if (switched.mode === current.mode && switched.fly === current.fly)
          return current
        return switched
      })
    },
    [orbit.orbit, seedFly],
  )

  const toggleMode = useCallback(() => {
    setMode(nextCameraMode(view.mode))
  }, [setMode, view.mode])

  // A different run is a different cloud: re-frame both modes and go back to the
  // survey. Identity comparison is right — the scene plan memoizes its camera per
  // run, so the same run never re-frames the camera.
  const framed = useRef({ camera, extentRadius })
  useEffect(() => {
    if (
      framed.current.camera === camera &&
      framed.current.extentRadius === extentRadius
    ) {
      return
    }
    framed.current = { camera, extentRadius }
    setView({ mode: 'orbit', fly: createFlyCamera(camera, extentRadius) })
  }, [camera, extentRadius])

  /** Apply a pure fly transition, keeping the state object when nothing moved. */
  const updateFly = useCallback((transition: (fly: FlyCamera) => FlyCamera) => {
    setView((current) => {
      const fly = transition(current.fly)
      if (fly === current.fly) return current
      return { mode: current.mode, fly }
    })
  }, [])

  const lookBy = useCallback(
    (dxPx: number, dyPx: number) => {
      updateFly((fly) => flyLookBy(fly, { dxPx, dyPx }))
    },
    [updateFly],
  )

  const advance = useCallback(
    (steps: number) => {
      updateFly((fly) => flyAdvance(fly, steps))
    },
    [updateFly],
  )

  const move = useCallback(
    (axes: FlyAxes, deltaMs: number, boost: boolean) => {
      updateFly((fly) => flyMove(fly, axes, deltaMs, boost))
    },
    [updateFly],
  )

  const resetFlyCamera = useCallback(() => {
    updateFly(resetFly)
  }, [updateFly])

  const orbitReset = orbit.reset
  const reset = useCallback(() => {
    if (view.mode === 'fly') {
      updateFly(resetFly)
      return
    }
    orbitReset()
  }, [view.mode, updateFly, orbitReset])

  const pose = useMemo(
    () => modeCameraPose(view.mode, orbit.orbit, view.fly),
    [view.mode, orbit.orbit, view.fly],
  )
  const angles = useMemo(
    () => cameraAngles(view.mode, orbit.orbit, view.fly),
    [view.mode, orbit.orbit, view.fly],
  )
  const readout = useMemo(
    () => describeCamera(view.mode, orbit.orbit, view.fly),
    [view.mode, orbit.orbit, view.fly],
  )
  const hint = useMemo(() => cameraModeHint(view.mode), [view.mode])

  return {
    mode: view.mode,
    orbit: orbit.orbit,
    fly: view.fly,
    camera: pose,
    angles,
    readout,
    hint,
    setMode,
    toggleMode,
    orbitBy: orbit.orbitBy,
    zoomBy: orbit.zoomBy,
    lookBy,
    advance,
    move,
    resetFly: resetFlyCamera,
    reset,
    canZoomIn: orbit.canZoomIn,
    canZoomOut: orbit.canZoomOut,
  }
}
