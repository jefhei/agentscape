import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, renderHook } from '@testing-library/react'
import { buildFixture } from '../fixtures/index.ts'
import { usePlayback } from './usePlayback.ts'

/**
 * Wiring tests for the playback controller hook (M4-T1).
 *
 * The hook owns exactly three things the pure layer cannot: the state, the
 * `requestAnimationFrame` clock and the key listener. The clock is stubbed here
 * (a real rAF loop would dispatch between assertions and there is nothing to
 * *see* in jsdom anyway), so what is asserted is the wiring around it: the
 * initial state, that dispatch reaches the reducer, that the derived frame and
 * scrubber follow it, that playing requests a frame, and that transport keys are
 * mapped — but not stolen from a text field.
 */

const FAN_OUT = buildFixture('fan-out').run
const LOOP = buildFixture('loop').run
const MINUTE = 60_000

beforeEach(() => {
  // A frame request that never fires: the loop is proven to be *requested*, not
  // to run in the middle of an assertion.
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('usePlayback — state and derivation (M4-T1)', () => {
  it('starts paused at the beginning of the run', () => {
    const { result } = renderHook(() => usePlayback(FAN_OUT))
    expect(result.current.state.playhead).toEqual({
      elapsedMs: 0,
      speed: 1,
      playing: false,
    })
    expect(result.current.frame.elapsedMs).toBe(0)
    expect(result.current.frame.progress).toBe(0)
    expect(result.current.scrubber.stopCount).toBe(5)
  })

  it('follows the reducer through dispatch', () => {
    const { result } = renderHook(() => usePlayback(FAN_OUT))
    act(() => {
      result.current.dispatch({ type: 'seek', elapsedMs: 2 * MINUTE })
    })
    expect(result.current.frame.elapsedMs).toBe(2 * MINUTE)
    expect(result.current.frame.progress).toBe(0.5)

    act(() => {
      result.current.dispatch({ type: 'stepForward' })
    })
    expect(result.current.frame.elapsedMs).toBe(3 * MINUTE)
  })

  it('advances on a tick without needing the clock', () => {
    const { result } = renderHook(() => usePlayback(FAN_OUT))
    act(() => {
      result.current.dispatch({ type: 'play' })
      result.current.dispatch({ type: 'tick', deltaMs: 500 })
    })
    expect(result.current.frame.elapsedMs).toBe(500)
  })

  it('keeps the scrubber memoized on the timeline, not on the playhead', () => {
    const { result } = renderHook(() => usePlayback(FAN_OUT))
    const before = result.current.scrubber
    act(() => {
      result.current.dispatch({ type: 'seek', elapsedMs: MINUTE })
    })
    expect(result.current.scrubber).toBe(before)
  })

  it('requests a frame while playing and cancels it when paused', () => {
    const { result } = renderHook(() => usePlayback(FAN_OUT))
    act(() => {
      result.current.dispatch({ type: 'play' })
    })
    expect(result.current.state.playhead.playing).toBe(true)
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.dispatch({ type: 'pause' })
    })
    expect(cancelAnimationFrame).toHaveBeenCalled()
  })

  it('resets to a paused playhead when the run changes', () => {
    const { result, rerender } = renderHook(({ run }) => usePlayback(run), {
      initialProps: { run: FAN_OUT },
    })
    act(() => {
      result.current.dispatch({ type: 'seek', elapsedMs: 3 * MINUTE })
    })
    expect(result.current.frame.elapsedMs).toBe(3 * MINUTE)

    rerender({ run: LOOP })
    expect(result.current.state.playhead.elapsedMs).toBe(0)
    expect(result.current.state.playhead.playing).toBe(false)
    expect(result.current.state.timeline.spanMs).toBe(LOOP.endedAt - LOOP.startedAt)
  })
})

describe('usePlayback — transport keys (M4-T1)', () => {
  it('toggles on space and steps on the arrows', () => {
    const { result } = renderHook(() => usePlayback(FAN_OUT))
    act(() => {
      fireEvent.keyDown(window, { key: ' ' })
    })
    expect(result.current.state.playhead.playing).toBe(true)

    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowRight' })
    })
    // A step is inspection: it pauses.
    expect(result.current.state.playhead.playing).toBe(false)
    expect(result.current.frame.elapsedMs).toBe(MINUTE)

    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowLeft' })
    })
    expect(result.current.frame.elapsedMs).toBe(0)
  })

  it('jumps to the ends on Home and End', () => {
    const { result } = renderHook(() => usePlayback(FAN_OUT))
    act(() => {
      fireEvent.keyDown(window, { key: 'End' })
    })
    expect(result.current.frame.atEnd).toBe(true)

    act(() => {
      fireEvent.keyDown(window, { key: 'Home' })
    })
    expect(result.current.frame.elapsedMs).toBe(0)
  })

  it('does not steal keys typed into a field', () => {
    const { result } = renderHook(() => usePlayback(FAN_OUT))
    const input = document.createElement('input')
    document.body.append(input)
    act(() => {
      fireEvent.keyDown(input, { key: ' ' })
      fireEvent.keyDown(input, { key: 'ArrowRight' })
    })
    expect(result.current.state.playhead.playing).toBe(false)
    expect(result.current.frame.elapsedMs).toBe(0)
    input.remove()
  })
})
