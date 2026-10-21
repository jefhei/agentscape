/**
 * The orbit camera controller hook (M4-T2) — the render layer's half of the
 * camera mode.
 *
 * Everything with a *rule* in it lives in `orbit.ts` (pure, unit-tested): the
 * pose, the drag/dolly transitions, the clamps, the wheel mapping, the readout.
 * This module owns only what a pure module cannot: **holding the state** and
 * **resetting it when the scene it was framed for is replaced** (a different run
 * is a different cloud, so carrying an orbit across traces would aim at a centre
 * that no longer exists).
 *
 * The hook takes the scene plan's own opening camera and the settled cloud's
 * radius and returns the live `SceneCamera` to apply plus the three controls the
 * camera bar dispatches. Every callback has a stable identity, so the pointer
 * listeners in `OrbitCameraRig.tsx` are bound once per scene rather than once per
 * frame.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SceneCamera } from '../scene/scenePlan.ts'
import {
  canZoomIn,
  canZoomOut,
  createOrbitCamera,
  orbitBy as orbitByDelta,
  orbitCameraPose,
  resetOrbit as resetOrbitPose,
  zoomBy as zoomOrbitBy,
} from './orbit.ts'
import type { CameraMode, OrbitCamera } from './orbit.ts'

/** What a camera control surface gets from {@link useOrbitCamera}. */
export interface OrbitController {
  /** The active camera mode (`'orbit'` in this build; M4-T3 widens it). */
  mode: CameraMode
  /** The orbit state itself — the numbers the readout and the limits read. */
  orbit: OrbitCamera
  /** The renderer-ready pose for the current state. */
  camera: SceneCamera
  /** Rotate by a pointer drag, in CSS pixels. */
  orbitBy: (dxPx: number, dyPx: number) => void
  /** Dolly by `steps` (positive = closer). */
  zoomBy: (steps: number) => void
  /** Return to the scene plan's opening shot. */
  reset: () => void
  /** Whether the dolly can still come closer. */
  canZoomIn: boolean
  /** Whether the dolly can still go further out. */
  canZoomOut: boolean
}

/**
 * Hold and drive the camera for one framed scene.
 *
 * `camera` is the scene plan's opening shot (M3-T6) and `extentRadius` the
 * settled cloud's radius; together they are the only inputs. Changing either
 * (a new run, a re-framed scene) resets the orbit to that scene's opening shot —
 * the same rule the transport follows when its run changes.
 */
export function useOrbitCamera(
  camera: SceneCamera,
  extentRadius: number,
): OrbitController {
  const [orbit, setOrbit] = useState<OrbitCamera>(() =>
    createOrbitCamera(camera, extentRadius),
  )

  // The framing this orbit was created for. Identity comparison is right here:
  // the scene plan memoizes its camera per run, so the same run never resets it.
  const framed = useRef({ camera, extentRadius })
  useEffect(() => {
    if (
      framed.current.camera === camera &&
      framed.current.extentRadius === extentRadius
    ) {
      return
    }
    framed.current = { camera, extentRadius }
    setOrbit(createOrbitCamera(camera, extentRadius))
  }, [camera, extentRadius])

  const orbitBy = useCallback((dxPx: number, dyPx: number) => {
    setOrbit((current) => orbitByDelta(current, { dxPx, dyPx }))
  }, [])

  const zoomBy = useCallback((steps: number) => {
    setOrbit((current) => zoomOrbitBy(current, steps))
  }, [])

  const reset = useCallback(() => {
    setOrbit((current) => resetOrbitPose(current))
  }, [])

  const pose = useMemo(() => orbitCameraPose(orbit), [orbit])

  return {
    mode: 'orbit',
    orbit,
    camera: pose,
    orbitBy,
    zoomBy,
    reset,
    canZoomIn: canZoomIn(orbit),
    canZoomOut: canZoomOut(orbit),
  }
}
