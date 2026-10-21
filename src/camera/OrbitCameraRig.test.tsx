import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import * as THREE from 'three'
import { buildFixture } from '../fixtures/index.ts'
import { buildScenePlan, directionFromAngles } from '../scene/scenePlan.ts'
import { createOrbitCamera, orbitBy, orbitCameraPose, zoomBy } from './orbit.ts'
import OrbitCameraRig, { ORBITING_CLASS } from './OrbitCameraRig.tsx'

/**
 * Wiring tests for the orbit camera rig (M4-T2).
 *
 * This component owns exactly two things the pure model cannot: applying a pose
 * to the renderer's `PerspectiveCamera`, and measuring pointer/wheel input. jsdom
 * has no WebGL, so instead of a Canvas the R3F context is stubbed with a real
 * `PerspectiveCamera` (a plain math object) and a plain element as the renderer's
 * canvas — enough to prove the pose lands, the drag delta is measured, the wheel
 * becomes dolly steps, and the listeners come off on unmount. The arithmetic
 * behind every number here is gated in `orbit.test.ts`; the look is human-held
 * (M5-T5).
 */

const PLAN = buildScenePlan(buildFixture('fan-out').run)
const OPENING = createOrbitCamera(PLAN.camera, PLAN.environment.extentRadius)

const context = {
  camera: undefined as unknown as THREE.PerspectiveCamera,
  gl: undefined as unknown as { domElement: HTMLElement },
}

vi.mock('@react-three/fiber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-three/fiber')>()
  return {
    ...actual,
    // The rig reads only these two pieces of the R3F store.
    useThree: (selector: (state: typeof context) => unknown) => selector(context),
  }
})

/** A DOM element standing in for the renderer's canvas. */
let canvas: HTMLElement

beforeEach(() => {
  canvas = document.createElement('div')
  context.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100)
  context.gl = { domElement: canvas }
})

afterEach(() => {
  cleanup()
})

/** A pointer event with the fields the rig reads (jsdom has no PointerEvent). */
function pointerEvent(
  type: string,
  init: {
    button?: number
    pointerId?: number
    clientX?: number
    clientY?: number
  } = {},
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { button: 0, pointerId: 1, clientX: 0, clientY: 0 }, init)
  return event
}

function renderRig(
  pose = orbitCameraPose(OPENING),
  onOrbit = vi.fn(),
  onZoom = vi.fn(),
): {
  onOrbit: ReturnType<typeof vi.fn>
  onZoom: ReturnType<typeof vi.fn>
  rerender: (node: ReactElement) => void
} {
  const { rerender } = render(
    <OrbitCameraRig camera={pose} onOrbit={onOrbit} onZoom={onZoom} />,
  )
  return { onOrbit, onZoom, rerender }
}

describe('OrbitCameraRig — applying the pose (M4-T2)', () => {
  it('copies the pose onto the renderer camera', () => {
    const pose = orbitCameraPose(zoomBy(orbitBy(OPENING, { dxPx: 40, dyPx: -20 }), 1))
    renderRig(pose)
    const camera = context.camera
    expect(camera.position.x).toBeCloseTo(pose.position.x, 9)
    expect(camera.position.y).toBeCloseTo(pose.position.y, 9)
    expect(camera.position.z).toBeCloseTo(pose.position.z, 9)
    expect(camera.fov).toBe(pose.fov)
    expect(camera.near).toBe(pose.near)
    expect(camera.far).toBe(pose.far)
  })

  it('aims the camera at the pose’s target', () => {
    const pose = orbitCameraPose(orbitBy(OPENING, { dxPx: 120, dyPx: 0 }))
    renderRig(pose)
    const camera = context.camera
    camera.updateMatrixWorld()
    const forward = new THREE.Vector3()
    camera.getWorldDirection(forward)
    const expected = new THREE.Vector3(
      pose.target.x - pose.position.x,
      pose.target.y - pose.position.y,
      pose.target.z - pose.position.z,
    ).normalize()
    expect(forward.x).toBeCloseTo(expected.x, 6)
    expect(forward.y).toBeCloseTo(expected.y, 6)
    expect(forward.z).toBeCloseTo(expected.z, 6)
  })

  it('re-applies the camera when the pose changes', () => {
    const first = orbitCameraPose(OPENING)
    const second = orbitCameraPose(orbitBy(OPENING, { dxPx: 300, dyPx: 0 }))
    const { rerender } = render(
      <OrbitCameraRig camera={first} onOrbit={vi.fn()} onZoom={vi.fn()} />,
    )
    const before = context.camera.position.z
    rerender(<OrbitCameraRig camera={second} onOrbit={vi.fn()} onZoom={vi.fn()} />)
    expect(context.camera.position.z).not.toBe(before)
    expect(context.camera.position.z).toBeCloseTo(second.position.z, 9)
  })

  it('frames the eye on the pose’s own direction', () => {
    const pose = orbitCameraPose(orbitBy(OPENING, { dxPx: 90, dyPx: -60 }))
    renderRig(pose)
    const direction = directionFromAngles(
      OPENING.azimuthDeg - 90 * 0.28,
      OPENING.elevationDeg - 60 * 0.28,
    )
    const camera = context.camera
    expect(camera.position.x - pose.target.x).toBeCloseTo(
      direction.x * pose.distance,
      9,
    )
    expect(camera.position.y - pose.target.y).toBeCloseTo(
      direction.y * pose.distance,
      9,
    )
    expect(camera.position.z - pose.target.z).toBeCloseTo(
      direction.z * pose.distance,
      9,
    )
  })
})

describe('OrbitCameraRig — pointer drag (M4-T2)', () => {
  it('measures the drag delta between moves and dispatches it', () => {
    const { onOrbit } = renderRig()
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 110, clientY: 95 }))
    expect(onOrbit).toHaveBeenCalledTimes(1)
    expect(onOrbit).toHaveBeenLastCalledWith(10, -5)

    window.dispatchEvent(pointerEvent('pointermove', { clientX: 104, clientY: 100 }))
    expect(onOrbit).toHaveBeenLastCalledWith(-6, 5)
    expect(onOrbit).toHaveBeenCalledTimes(2)
  })

  it('ignores moves before a drag starts', () => {
    const { onOrbit } = renderRig()
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 50, clientY: 50 }))
    expect(onOrbit).not.toHaveBeenCalled()
  })

  it('only orbits on the primary button', () => {
    const { onOrbit } = renderRig()
    canvas.dispatchEvent(
      pointerEvent('pointerdown', { button: 2, clientX: 10, clientY: 10 }),
    )
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 40, clientY: 40 }))
    expect(onOrbit).not.toHaveBeenCalled()
  })

  it('stops orbiting on pointerup and on pointercancel', () => {
    const { onOrbit } = renderRig()
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 0, clientY: 0 }))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 5, clientY: 5 }))
    expect(onOrbit).toHaveBeenCalledTimes(1)

    window.dispatchEvent(pointerEvent('pointerup'))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 40, clientY: 40 }))
    expect(onOrbit).toHaveBeenCalledTimes(1)

    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 0, clientY: 0 }))
    window.dispatchEvent(pointerEvent('pointercancel'))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 60, clientY: 60 }))
    expect(onOrbit).toHaveBeenCalledTimes(1)
  })

  it('drops sub-pixel moves instead of re-rendering for them', () => {
    const { onOrbit } = renderRig()
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 20 }))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 20, clientY: 20 }))
    expect(onOrbit).not.toHaveBeenCalled()
  })

  it('marks the canvas as orbiting only while the drag lasts', () => {
    renderRig()
    expect(canvas.classList.contains(ORBITING_CLASS)).toBe(false)
    canvas.dispatchEvent(pointerEvent('pointerdown'))
    expect(canvas.classList.contains(ORBITING_CLASS)).toBe(true)
    window.dispatchEvent(pointerEvent('pointerup'))
    expect(canvas.classList.contains(ORBITING_CLASS)).toBe(false)
  })
})

describe('OrbitCameraRig — wheel dolly (M4-T2)', () => {
  it('turns scroll up into a zoom-in step and scroll down into zoom-out', () => {
    const { onZoom } = renderRig()
    const up = new WheelEvent('wheel', {
      deltaY: -120,
      bubbles: true,
      cancelable: true,
    })
    canvas.dispatchEvent(up)
    expect(onZoom).toHaveBeenLastCalledWith(1)
    expect(up.defaultPrevented).toBe(true)

    canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }),
    )
    expect(onZoom).toHaveBeenLastCalledWith(-1)
    expect(onZoom).toHaveBeenCalledTimes(2)
  })

  it('leaves a zero delta to the page (no dispatch, no preventDefault)', () => {
    const { onZoom } = renderRig()
    const event = new WheelEvent('wheel', {
      deltaY: 0,
      bubbles: true,
      cancelable: true,
    })
    canvas.dispatchEvent(event)
    expect(onZoom).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('OrbitCameraRig — lifecycle (M4-T2)', () => {
  it('removes every listener on unmount', () => {
    const onOrbit = vi.fn()
    const onZoom = vi.fn()
    const { unmount } = render(
      <OrbitCameraRig
        camera={orbitCameraPose(OPENING)}
        onOrbit={onOrbit}
        onZoom={onZoom}
      />,
    )
    unmount()
    canvas.dispatchEvent(pointerEvent('pointerdown'))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 30, clientY: 30 }))
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }))
    expect(onOrbit).not.toHaveBeenCalled()
    expect(onZoom).not.toHaveBeenCalled()
    expect(canvas.classList.contains(ORBITING_CLASS)).toBe(false)
  })
})
