import { useEffect, useLayoutEffect } from 'react'
import { useThree } from '@react-three/fiber'
import type { SceneCamera } from '../scene/scenePlan.ts'
import { applySceneCamera } from './applyPose.ts'
import { wheelZoomSteps } from './orbit.ts'

/**
 * Applies the orbit camera and binds the pointer/wheel input (M4-T2) — the
 * render half.
 *
 * Two jobs, both mechanical:
 *
 * 1. **Apply the pose.** The eye position, look-at target, fov, near and far are
 *    decided by the pure layer (`orbitCameraPose`, `./orbit.ts`); this component
 *    copies them onto the renderer's `PerspectiveCamera`. It is the same
 *    apply-only role `CameraRig` played in `Viewport.tsx` before M4-T2 — the
 *    camera *numbers* have never been the shell's to choose.
 * 2. **Read the input.** A primary-button drag on the canvas becomes a
 *    pixel delta handed to `onOrbit`; a wheel event becomes dolly steps handed to
 *    `onZoom`. Both mappings that carry a *rule* (degrees per pixel, wheel mode,
 *    per-event cap) live in the pure module; this component only measures the
 *    pointer and dispatches.
 *
 * ## Why the listeners are bound to the canvas, not to a full-screen mesh
 *
 * An invisible mesh with R3F `onPointerDown` would put the whole viewport through
 * the raycaster on every move, and would steal clicks from any future node-click
 * interaction (M4-T4). Listening on `gl.domElement` — and on `window` for the
 * move/up half so a drag survives leaving the canvas — keeps the camera out of
 * the scene graph entirely. Pointer capture does the same job inside a browser;
 * the window listeners cover the capture-unsupported case (and jsdom, which has
 * no pointer capture at all).
 *
 * ## Not gated, by design
 *
 * jsdom has no GPU and no pointer implementation, so the *look* of an orbit is
 * human-reviewed (M5-T5). What is tested here is the wiring — the pose lands on
 * the camera, a drag dispatches the measured delta, a wheel dispatches steps,
 * listeners come off on unmount — and the arithmetic behind it is gated in
 * `orbit.test.ts`.
 */
export interface OrbitCameraRigProps {
  /** The pose to apply (from {@link useOrbitCamera} / `orbitCameraPose`). */
  camera: SceneCamera
  /** A drag of `dxPx`/`dyPx` CSS pixels (positive = right / down). */
  onOrbit: (dxPx: number, dyPx: number) => void
  /** Dolly steps from a wheel event (positive = closer). */
  onZoom: (steps: number) => void
}

/** Class toggled on the canvas while a drag is in progress (see `App.css`). */
export const ORBITING_CLASS = 'is-orbiting'

export default function OrbitCameraRig({
  camera,
  onOrbit,
  onZoom,
}: OrbitCameraRigProps) {
  const three = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)

  // Apply the pose. `useLayoutEffect`: the camera must match the plan in the same
  // commit that renders the scene, or the first frame would be framed by R3F's
  // default camera looking at the origin. Since M4-T3 this is the shared
  // {@link applySceneCamera} the fly rig also uses — one pose applier, no drift.
  useLayoutEffect(() => {
    applySceneCamera(three, camera)
  }, [three, camera])

  useEffect(() => {
    const el = gl?.domElement as HTMLElement | undefined
    if (el === undefined || el === null) return undefined

    let dragging = false
    let pointerId = -1
    let lastX = 0
    let lastY = 0

    const onPointerDown = (event: PointerEvent): void => {
      // Primary button only: a right-drag is a context menu, not an orbit.
      if (event.button !== 0 || dragging) return
      dragging = true
      pointerId = event.pointerId
      lastX = event.clientX
      lastY = event.clientY
      el.setPointerCapture?.(event.pointerId)
      el.classList.add(ORBITING_CLASS)
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging) return
      const dxPx = event.clientX - lastX
      const dyPx = event.clientY - lastY
      lastX = event.clientX
      lastY = event.clientY
      // Sub-pixel moves are dropped: they would re-render with no visible change.
      if (dxPx === 0 && dyPx === 0) return
      onOrbit(dxPx, dyPx)
    }

    const endDrag = (): void => {
      if (!dragging) return
      dragging = false
      if (pointerId !== -1 && el.hasPointerCapture?.(pointerId) === true) {
        el.releasePointerCapture?.(pointerId)
      }
      pointerId = -1
      el.classList.remove(ORBITING_CLASS)
    }

    const onWheel = (event: WheelEvent): void => {
      const steps = wheelZoomSteps(event.deltaY, event.deltaMode)
      if (steps === 0) return
      // The canvas is the scroll surface while the pointer is over it: letting
      // the page scroll instead would move the transport bar under the cursor.
      event.preventDefault()
      onZoom(steps)
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      el.classList.remove(ORBITING_CLASS)
    }
  }, [gl, onOrbit, onZoom])

  return null
}
