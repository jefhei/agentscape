import { useEffect, useLayoutEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import type { SceneCamera } from '../scene/scenePlan.ts'
import { isTypingTarget } from '../ui/keyboard.ts'
import { applySceneCamera } from './applyPose.ts'
import { flyAxisForKey, flyInputFromKeys, flyIsMoving } from './fly.ts'
import type { FlyAxes } from './fly.ts'
import { wheelZoomSteps } from './orbit.ts'

/**
 * Applies the fly camera and binds its input (M4-T3) — the render half.
 *
 * Three mechanical jobs:
 *
 * 1. **Apply the pose.** Eye, look-at target, fov, near and far are decided by the
 *    pure layer (`flyCameraPose` in `./fly.ts`); this copies them onto the
 *    renderer's camera through {@link applySceneCamera}, the same helper the orbit
 *    rig uses. A second copy of that code would be a second chance to forget
 *    `updateProjectionMatrix`.
 * 2. **Measure the moment-to-moment input** — a drag (which becomes a look delta),
 *    a wheel event (which becomes advance steps) and the held movement keys.
 * 3. **Own the clock for held keys.** Movement is continuous, so it needs a frame
 *    loop; the loop lives here (render layer) and the *rule* that turns a real
 *    elapsed time into a displacement lives in `./fly.ts`, exactly as the playback
 *    transport splits its clock from its reducer. The clock starts on the first
 *    movement key and stops when the last one is released, so a parked camera costs
 *    no frames — and the delta is measured between frame timestamps, so the speed
 *    is real time whatever the display refresh rate.
 *
 * ## Listeners, and why they are on the canvas / window
 *
 * The drag starts on `gl.domElement` and continues on `window`, so it survives a
 * fast pointer leaving the canvas (with pointer capture where the browser has it,
 * and without it in jsdom). Keys are bound to `window` because there is nothing to
 * focus: the whole viewport is the fly surface. They are ignored while the target is
 * a form field ({@link isTypingTarget}), so the scrubber's arrows still scrub
 * instead of strafing. `wheel` is registered `{ passive: false }` so the canvas can
 * claim the scroll.
 *
 * ## Not gated, by design
 *
 * jsdom has no GPU, so the *look* of flying is human-reviewed (M5-T5). What is
 * tested here is the wiring — the pose lands, a drag dispatches the measured delta,
 * a wheel dispatches steps, a held key really starts a frame loop that dispatches
 * movement (and releasing it stops the loop) — and the arithmetic behind it is gated
 * in `fly.test.ts`.
 */
export interface FlyCameraRigProps {
  /** The pose to apply (from {@link modeCameraPose} / `flyCameraPose`). */
  camera: SceneCamera
  /** A look drag of `dxPx`/`dyPx` CSS pixels (positive = right / down). */
  onLook: (dxPx: number, dyPx: number) => void
  /** Advance steps from a wheel event (positive = forward). */
  onAdvance: (steps: number) => void
  /** One frame of movement: the held axes, the elapsed ms, and whether shift is down. */
  onMove: (axes: FlyAxes, deltaMs: number, boost: boolean) => void
}

/** Class toggled on the canvas while a look drag is in progress (see `App.css`). */
export const FLYING_CLASS = 'is-flying'

/** Whether any held key still asks for movement (a lone shift does not). */
function hasMovementKey(held: ReadonlySet<string>): boolean {
  for (const key of held) {
    if (flyAxisForKey(key) !== null) return true
  }
  return false
}

export default function FlyCameraRig({
  camera,
  onLook,
  onAdvance,
  onMove,
}: FlyCameraRigProps) {
  const three = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)

  // Apply the pose in the same commit that renders the scene, or the first frame
  // would be framed by whatever the previous mode/camera left behind.
  useLayoutEffect(() => {
    applySceneCamera(three, camera)
  }, [three, camera])

  // The frame loop reads the callbacks through a ref: re-binding the window
  // listeners on every callback identity change would restart the clock, and the
  // hook's callbacks are stable anyway — this just makes that non-load-bearing.
  const dispatch = useRef({ onMove })
  dispatch.current = { onMove }

  useEffect(() => {
    const el = gl?.domElement as HTMLElement | undefined
    if (el === undefined || el === null) return undefined

    // ── drag to look ────────────────────────────────────────────────────────
    let dragging = false
    let pointerId = -1
    let lastX = 0
    let lastY = 0

    const onPointerDown = (event: PointerEvent): void => {
      // Primary button only: a right-drag is a context menu, not a look.
      if (event.button !== 0 || dragging) return
      dragging = true
      pointerId = event.pointerId
      lastX = event.clientX
      lastY = event.clientY
      el.setPointerCapture?.(event.pointerId)
      el.classList.add(FLYING_CLASS)
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging) return
      const dxPx = event.clientX - lastX
      const dyPx = event.clientY - lastY
      lastX = event.clientX
      lastY = event.clientY
      if (dxPx === 0 && dyPx === 0) return
      onLook(dxPx, dyPx)
    }

    const endDrag = (): void => {
      if (!dragging) return
      dragging = false
      if (pointerId !== -1 && el.hasPointerCapture?.(pointerId) === true) {
        el.releasePointerCapture?.(pointerId)
      }
      pointerId = -1
      el.classList.remove(FLYING_CLASS)
    }

    // ── wheel to advance ────────────────────────────────────────────────────
    const onWheel = (event: WheelEvent): void => {
      const steps = wheelZoomSteps(event.deltaY, event.deltaMode)
      if (steps === 0) return
      // The canvas is the scroll surface while the pointer is over it.
      event.preventDefault()
      onAdvance(steps)
    }

    // ── held keys → one frame loop ──────────────────────────────────────────
    const held = new Set<string>()
    let frame = 0
    let running = false
    let last = 0

    const tick = (now: number): void => {
      const deltaMs = now - last
      last = now
      const input = flyInputFromKeys(held)
      if (flyIsMoving(input.axes)) {
        dispatch.current.onMove(input.axes, deltaMs, input.boost)
      }
      frame = requestAnimationFrame(tick)
    }

    const startClock = (): void => {
      if (running) return
      running = true
      last = performance.now()
      frame = requestAnimationFrame(tick)
    }

    const stopClock = (): void => {
      if (!running) return
      running = false
      cancelAnimationFrame(frame)
      frame = 0
      last = 0
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return
      const key = event.key.toLowerCase()
      if (key === 'shift') {
        held.add('shift')
        return
      }
      if (flyAxisForKey(key) === null) return
      // A movement key: the viewport owns it while it is held, so an arrow does not
      // also scroll the page. Repeated keydowns keep being swallowed.
      event.preventDefault()
      if (held.has(key)) return
      held.add(key)
      startClock()
    }

    const onKeyUp = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      if (!held.delete(key)) return
      if (!hasMovementKey(held)) stopClock()
    }

    // A tab switch eats the keyup events: release everything, or the camera would
    // keep flying while the viewer is looking at another window.
    const onBlur = (): void => {
      held.clear()
      stopClock()
      endDrag()
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      stopClock()
      el.classList.remove(FLYING_CLASS)
    }
  }, [gl, onLook, onAdvance])

  return null
}
