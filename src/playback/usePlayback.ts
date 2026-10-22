/**
 * The playback controller hook (M4-T1) — the render layer's half of the
 * transport.
 *
 * Everything with a *rule* in it lives in `playback.ts` (pure, unit-tested): the
 * state machine, the scrubber geometry, the keyboard map, the readout. This
 * module owns exactly the three things a pure module cannot:
 *
 * 1. **holding the state** — one `useState` over an immutable `PlaybackState`,
 *    driven through the reducer;
 * 2. **the clock** — `requestAnimationFrame` while playing, feeding the reducer
 *    a `{ type: 'tick', deltaMs }` of *real* elapsed time. The delta comes from
 *    the frame timestamps, not from a fixed step, so playback runs at real speed
 *    whatever the display refresh rate is;
 * 3. **the key listener** — window-level transport keys (space, arrows, Home,
 *    End), mapped by `actionForKey` and ignored while the user is typing.
 *
 * ## Why the effect is keyed on `playing`, not on the state
 *
 * The frame callback dispatches through the *functional* updater, so it never
 * needs to close over the current state. If the effect depended on the state it
 * would tear down and re-request a frame every tick; keyed on `playing` alone it
 * starts one loop when playback starts and cancels it when it stops — including
 * when `advance` auto-pauses at the end (M1-T7), because that flips `playing`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TraceModel } from '../model/index.ts'
import type { TimelineFrame } from '../timeline/index.ts'
import { isTypingTarget } from '../ui/keyboard.ts'
import {
  actionForKey,
  buildScrubber,
  createPlayback,
  playbackFrame,
  reducePlayback,
} from './playback.ts'
import type { PlaybackAction, PlaybackState, Scrubber } from './playback.ts'

/** What a component gets from {@link usePlayback}. */
export interface PlaybackController {
  /** The transport state (timeline + playhead). */
  state: PlaybackState
  /** The run's frame at the current position — what the scene reveals. */
  frame: TimelineFrame
  /** The scrubber's geometry (marks + density), memoized on the timeline. */
  scrubber: Scrubber
  /** Apply one transport action. Stable identity, safe in effect deps. */
  dispatch: (action: PlaybackAction) => void
}

/**
 * Hold and drive a run's transport. The run is the only dependency: changing it
 * resets the transport to a paused playhead at `0`, which is what loading a new
 * trace should do.
 */
export function usePlayback(model: TraceModel): PlaybackController {
  const [state, setState] = useState<PlaybackState>(() => createPlayback(model))

  const dispatch = useCallback((action: PlaybackAction) => {
    setState((current) => reducePlayback(current, action))
  }, [])

  // A different run is a different timeline: reset rather than carry a position
  // across traces. (The app mounts one fixture today; the loader lands post-M4.)
  const mountedRun = useRef(model)
  useEffect(() => {
    if (mountedRun.current === model) return
    mountedRun.current = model
    setState(createPlayback(model))
  }, [model])

  const playing = state.playhead.playing

  // The clock. One loop per play session; `performance.now()` is read here and
  // only here, and only as a *delta* — the pure layer never sees a clock.
  useEffect(() => {
    if (!playing) return undefined
    let frame = 0
    let last = performance.now()
    const tick = (now: number): void => {
      const deltaMs = now - last
      last = now
      setState((current) => reducePlayback(current, { type: 'tick', deltaMs }))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  // Transport keys, once for the component's life. `dispatch` is stable.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return
      const action = actionForKey(event.key, {
        shift: event.shiftKey,
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
      })
      if (action === null) return
      event.preventDefault()
      dispatch(action)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dispatch])

  const frame = useMemo(() => playbackFrame(state), [state])
  const scrubber = useMemo(() => buildScrubber(state.timeline), [state.timeline])

  return { state, frame, scrubber, dispatch }
}
