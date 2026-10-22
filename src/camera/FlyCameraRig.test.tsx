import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import * as THREE from 'three'
import { buildFixture } from '../fixtures/index.ts'
import { buildScenePlan } from '../scene/scenePlan.ts'
import {
  createFlyCamera,
  flyAdvance,
  flyCameraPose,
  flyLookBy,
  flyMove,
} from './fly.ts'
import FlyCameraRig, { FLYING_CLASS } from './FlyCameraRig.tsx'

/**
 * Wiring tests for the fly camera rig (M4-T3).
 *
 * This component owns what the pure model cannot: applying a pose to the
 * renderer's `PerspectiveCamera`, measuring pointer/wheel/keys, and holding the
 * frame clock while a movement key is down. jsdom has no WebGL, so instead of a
 * Canvas the R3F context is stubbed with a real `PerspectiveCamera` (a plain math
 * object) and a plain element as the renderer's canvas — enough to prove the pose
 * lands, a drag measures into a look delta, a wheel becomes advance steps, a held key
 * really starts a frame loop that dispatches movement, and every listener and frame
 * comes off on unmount. The arithmetic behind the numbers is gated in `fly.test.ts`;
 * the look is human-held (M5-T5).
 */

const PLAN = buildScenePlan(buildFixture('fan-out').run)
const OPENING = createFlyCamera(PLAN.camera, PLAN.environment.extentRadius)

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

/** Queued animation frames — the rig under test is the only consumer. */
let frames: FrameRequestCallback[] = []
let nextHandle = 1

/** Run every queued frame callback at `now` (the loop re-queues inside a tick). */
function flushFrames(now: number): void {
  const pending = frames
  frames = []
  for (const callback of pending) callback(now)
}

/** A DOM element standing in for the renderer's canvas. */
let canvas: HTMLElement

beforeEach(() => {
  frames = []
  nextHandle = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const handle = nextHandle
    nextHandle += 1
    frames.push(callback)
    return handle
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    // Handles are positional in this stub: drop everything (a single loop is live at
    // a time), which is exactly what cancelling the last request does.
    if (handle > 0) frames = []
  })
  canvas = document.createElement('div')
  context.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100)
  context.gl = { domElement: canvas }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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

/** A key event, dispatched at `target` (window by default). */
function keyEvent(
  type: 'keydown' | 'keyup',
  key: string,
  target: EventTarget = window,
): KeyboardEvent {
  const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

function renderRig(
  pose = flyCameraPose(OPENING),
  onLook = vi.fn(),
  onAdvance = vi.fn(),
  onMove = vi.fn(),
) {
  const { rerender, unmount } = render(
    <FlyCameraRig
      camera={pose}
      onLook={onLook}
      onAdvance={onAdvance}
      onMove={onMove}
    />,
  )
  return { onLook, onAdvance, onMove, rerender, unmount }
}

describe('FlyCameraRig — applying the pose (M4-T3)', () => {
  it('copies the pose onto the renderer camera', () => {
    const pose = flyCameraPose(
      flyAdvance(flyLookBy(OPENING, { dxPx: 40, dyPx: -20 }), 1),
    )
    renderRig(pose)
    const camera = context.camera
    expect(camera.position.x).toBeCloseTo(pose.position.x, 9)
    expect(camera.position.y).toBeCloseTo(pose.position.y, 9)
    expect(camera.position.z).toBeCloseTo(pose.position.z, 9)
    expect(camera.fov).toBe(pose.fov)
    expect(camera.near).toBe(pose.near)
    expect(camera.far).toBe(pose.far)
  })

  it('aims the camera along the fly heading', () => {
    const pose = flyCameraPose(flyLookBy(OPENING, { dxPx: 120, dyPx: 30 }))
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
    const first = flyCameraPose(OPENING)
    const second = flyCameraPose(flyAdvance(OPENING, 2))
    const { rerender } = renderRig(first)
    const before = context.camera.position.z
    rerender(
      <FlyCameraRig
        camera={second}
        onLook={vi.fn()}
        onAdvance={vi.fn()}
        onMove={vi.fn()}
      />,
    )
    expect(context.camera.position.z).not.toBe(before)
    expect(context.camera.position.z).toBeCloseTo(second.position.z, 9)
  })
})

describe('FlyCameraRig — drag to look (M4-T3)', () => {
  it('measures the drag delta between moves and dispatches it', () => {
    const { onLook } = renderRig()
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 110, clientY: 95 }))
    expect(onLook).toHaveBeenCalledTimes(1)
    expect(onLook).toHaveBeenLastCalledWith(10, -5)
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 104, clientY: 100 }))
    expect(onLook).toHaveBeenLastCalledWith(-6, 5)
  })

  it('ignores moves before a drag starts, and non-primary buttons', () => {
    const { onLook } = renderRig()
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 50, clientY: 50 }))
    expect(onLook).not.toHaveBeenCalled()
    canvas.dispatchEvent(pointerEvent('pointerdown', { button: 2 }))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 40, clientY: 40 }))
    expect(onLook).not.toHaveBeenCalled()
  })

  it('stops looking on pointerup and on pointercancel', () => {
    const { onLook } = renderRig()
    canvas.dispatchEvent(pointerEvent('pointerdown'))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 5, clientY: 5 }))
    expect(onLook).toHaveBeenCalledTimes(1)
    window.dispatchEvent(pointerEvent('pointerup'))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 40, clientY: 40 }))
    expect(onLook).toHaveBeenCalledTimes(1)
    canvas.dispatchEvent(pointerEvent('pointerdown'))
    window.dispatchEvent(pointerEvent('pointercancel'))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 60, clientY: 60 }))
    expect(onLook).toHaveBeenCalledTimes(1)
  })

  it('drops sub-pixel moves and marks the canvas only while dragging', () => {
    const { onLook } = renderRig()
    expect(canvas.classList.contains(FLYING_CLASS)).toBe(false)
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 20 }))
    expect(canvas.classList.contains(FLYING_CLASS)).toBe(true)
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 20, clientY: 20 }))
    expect(onLook).not.toHaveBeenCalled()
    window.dispatchEvent(pointerEvent('pointerup'))
    expect(canvas.classList.contains(FLYING_CLASS)).toBe(false)
  })
})

describe('FlyCameraRig — wheel to advance (M4-T3)', () => {
  it('advances forward on scroll up and back on scroll down', () => {
    const { onAdvance } = renderRig()
    const up = new WheelEvent('wheel', {
      deltaY: -120,
      bubbles: true,
      cancelable: true,
    })
    canvas.dispatchEvent(up)
    expect(onAdvance).toHaveBeenLastCalledWith(1)
    expect(up.defaultPrevented).toBe(true)
    canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }),
    )
    expect(onAdvance).toHaveBeenLastCalledWith(-1)
    expect(onAdvance).toHaveBeenCalledTimes(2)
  })

  it('leaves a zero delta to the page (no dispatch, no preventDefault)', () => {
    const { onAdvance } = renderRig()
    const event = new WheelEvent('wheel', {
      deltaY: 0,
      bubbles: true,
      cancelable: true,
    })
    canvas.dispatchEvent(event)
    expect(onAdvance).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('FlyCameraRig — held keys fly (M4-T3)', () => {
  it('starts one frame loop on a movement key and stops it on release', () => {
    const { onMove } = renderRig()
    expect(frames).toHaveLength(0)
    const down = keyEvent('keydown', 'w')
    expect(down.defaultPrevented).toBe(true)
    expect(frames).toHaveLength(1)

    flushFrames(performance.now() + 16)
    expect(onMove).toHaveBeenCalledTimes(1)
    const [axes, deltaMs, boost] = onMove.mock.calls[0]
    expect(axes).toEqual({ forward: 1, right: 0, up: 0 })
    expect(deltaMs).toBeGreaterThan(0)
    expect(deltaMs).toBeLessThan(1000)
    expect(boost).toBe(false)
    // The loop re-queues itself while the key is down.
    expect(frames).toHaveLength(1)

    flushFrames(performance.now() + 32)
    expect(onMove).toHaveBeenCalledTimes(2)

    keyEvent('keyup', 'w')
    expect(frames).toHaveLength(0)
    flushFrames(performance.now() + 48)
    expect(onMove).toHaveBeenCalledTimes(2)
  })

  it('reads the boost from shift and keeps flying when it is released', () => {
    const { onMove } = renderRig()
    keyEvent('keydown', 'Shift')
    keyEvent('keydown', 'd')
    flushFrames(performance.now() + 16)
    expect(onMove.mock.calls.at(-1)?.[0]).toEqual({ forward: 0, right: 1, up: 0 })
    expect(onMove.mock.calls.at(-1)?.[2]).toBe(true)

    keyEvent('keyup', 'Shift')
    flushFrames(performance.now() + 32)
    expect(onMove.mock.calls.at(-1)?.[2]).toBe(false)
    expect(frames).toHaveLength(1)
  })

  it('keeps one loop for several held keys and ignores repeat keydowns', () => {
    renderRig()
    keyEvent('keydown', 'w')
    keyEvent('keydown', 'd')
    keyEvent('keydown', 'd')
    expect(frames).toHaveLength(1)
  })

  it('ignores keys that do not move the camera', () => {
    const { onMove } = renderRig()
    const event = keyEvent('keydown', 'z')
    expect(event.defaultPrevented).toBe(false)
    expect(frames).toHaveLength(0)
    flushFrames(performance.now() + 16)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('leaves the keys alone while the viewer is typing', () => {
    const { onMove } = renderRig()
    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      const event = keyEvent('keydown', 'w', input)
      expect(event.defaultPrevented).toBe(false)
      expect(frames).toHaveLength(0)
      // ...but a movement key delivered to the page still flies.
      keyEvent('keydown', 'w')
      expect(frames).toHaveLength(1)
      flushFrames(performance.now() + 16)
      expect(onMove).toHaveBeenCalledTimes(1)
    } finally {
      input.remove()
    }
  })

  it('stops flying when the window loses focus (a tab switch eats the keyup)', () => {
    const { onMove } = renderRig()
    keyEvent('keydown', 'w')
    flushFrames(performance.now() + 16)
    expect(onMove).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('blur'))
    expect(frames).toHaveLength(0)
    flushFrames(performance.now() + 32)
    expect(onMove).toHaveBeenCalledTimes(1)
  })

  it('dispatches the movement the pure model derives', () => {
    const { onMove } = renderRig()
    keyEvent('keydown', 'w')
    flushFrames(performance.now() + 16)
    const [axes, deltaMs] = onMove.mock.calls[0]
    const moved = flyMove(OPENING, axes, deltaMs as number)
    expect(moved.position).not.toEqual(OPENING.position)
  })
})

describe('FlyCameraRig — lifecycle (M4-T3)', () => {
  it('removes every listener and cancels the frame on unmount', () => {
    const onLook = vi.fn()
    const onAdvance = vi.fn()
    const onMove = vi.fn()
    const { unmount } = render(
      <FlyCameraRig
        camera={flyCameraPose(OPENING)}
        onLook={onLook}
        onAdvance={onAdvance}
        onMove={onMove}
      />,
    )
    keyEvent('keydown', 'w')
    expect(frames).toHaveLength(1)
    unmount()
    expect(frames).toHaveLength(0)
    canvas.dispatchEvent(pointerEvent('pointerdown'))
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 30, clientY: 30 }))
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }))
    keyEvent('keydown', 'w')
    expect(onLook).not.toHaveBeenCalled()
    expect(onAdvance).not.toHaveBeenCalled()
    expect(onMove).not.toHaveBeenCalled()
    expect(canvas.classList.contains(FLYING_CLASS)).toBe(false)
  })
})
