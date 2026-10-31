/**
 * The autosave controller hook (M6-T1) — the render layer's half of persistence.
 *
 * The rules live in `snapshot.ts` (what a snapshot is), `restore.ts` (what it
 * restores onto a run) and `storage.ts` (where it goes). This module owns only
 * what those cannot: **when to write**, and holding the latest live state between
 * renders.
 *
 * ## Why a throttled write, not a write per change
 *
 * The camera reports a new pose on every drag frame and the transport moves every
 * frame while playing: writing on each change would put a `localStorage`
 * round-trip in the frame loop for no gain. One trailing timer per burst is enough
 * — the value that lands is the value at the end of the burst, which is the one
 * worth keeping — and {@link AUTOSAVE_DEBOUNCE_MS} is short enough that a reload a
 * second later still finds the view.
 *
 * ## Why the camera arrives through a callback
 *
 * The camera state is the *viewport's* (only it can bind the pointer and the keys
 * to the canvas), so the shell cannot read it. Handing it up as React state would
 * re-render the whole shell on every drag frame; {@link
 * AutosaveController.onCameraChange} is a stable callback into a ref, plus a
 * schedule — no state, no frame-loop re-render.
 *
 * ## Endings count
 *
 * A timer is not guaranteed to fire: closing a tab, navigating away or hiding a
 * page can end the session inside one debounce window. `pagehide` and
 * `visibilitychange → hidden` therefore flush immediately, so the *last* view is
 * what survives — not the one from up to half a second earlier.
 *
 * ## Failure is silent
 *
 * `writeStoredSnapshot` reports `'failed'` for a full disk or a locked-down
 * browser, and this hook ignores it on purpose: autosave is a convenience, the app
 * is fully usable without it, and a viewer cannot act on a quota error. What must
 * not happen — an exception reaching the React tree — cannot.
 */

import { useCallback, useEffect, useRef } from 'react'
import type { FilterState } from '../filter/filter.ts'
import type { TraceModel } from '../model/index.ts'
import type { PlaybackSpeed } from '../timeline/index.ts'
import type { AgentId } from '../types/index.ts'
import { captureSnapshot, serializeSnapshot } from './snapshot.ts'
import type { CameraSnapshot, ViewSnapshot } from './snapshot.ts'
import { AUTOSAVE_KEY, browserStorage, writeStoredSnapshot } from './storage.ts'
import type { SnapshotStorage } from './storage.ts'

/**
 * How long a burst of changes is coalesced before one write. Half a second: long
 * enough that a drag or a playing run costs ~2 writes a second instead of 60, short
 * enough that a reload feels like it kept the view.
 */
export const AUTOSAVE_DEBOUNCE_MS = 500

/** The live state one autosave reads. */
export interface AutosaveInput {
  /** The mounted run (only its id is stored). */
  run: TraceModel
  /** The canonical `?trace=` fragment naming it, or `null` for the default mount. */
  trace: string | null
  /** Playhead position, ms. */
  elapsedMs: number
  /** Playback speed. */
  speed: PlaybackSpeed
  /** The lens. */
  filter: FilterState
  /** The inspected agent, or `null`. */
  selection: AgentId | null
  /** The camera as the viewport reports it (the seed until one is reported). */
  camera: CameraSnapshot
}

/** Where and how to save; every field has a production default. */
export interface AutosaveOptions {
  /** Defaults to {@link browserStorage}. */
  storage?: SnapshotStorage
  /** Defaults to {@link AUTOSAVE_KEY}. */
  key?: string
  /** Defaults to {@link AUTOSAVE_DEBOUNCE_MS}. */
  debounceMs?: number
  /** The capture clock; defaults to `Date.now` (tests pass a fixed one). */
  now?: () => number
}

/** What the shell gets from {@link useAutosave}. */
export interface AutosaveController {
  /** Report the camera after it moved. Stable identity. */
  onCameraChange: (camera: CameraSnapshot) => void
  /** Write the current view now (the endings; also handy in a test). */
  saveNow: () => void
}

/**
 * A snapshot's identity **without** its capture time: two writes of the same view
 * have the same key, so the hook can skip a redundant write (and still timestamp
 * the write that does happen).
 */
function viewKey(snapshot: ViewSnapshot): string {
  return serializeSnapshot({ ...snapshot, savedAt: 0 })
}

/**
 * Hold and periodically write one view. The run is part of the input because the
 * snapshot names it: swapping runs must write the *new* run's id, not carry the
 * old one.
 */
export function useAutosave(
  input: AutosaveInput,
  options: AutosaveOptions = {},
): AutosaveController {
  // Resolved once per component: a new storage object every render would be a new
  // identity in every callback below (and, for the fallback, a new "browser").
  const storageRef = useRef<SnapshotStorage | null>(null)
  if (storageRef.current === null)
    storageRef.current = options.storage ?? browserStorage()
  const storage = storageRef.current
  const key = options.key ?? AUTOSAVE_KEY
  const debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS
  const now = options.now ?? Date.now

  // The latest live state, kept in refs so the timer callback never closes over a
  // stale render. Writing during render is deliberate: the value the timer writes
  // must be the value of the most recent commit.
  const latest = useRef(input)
  latest.current = input
  const cameraRef = useRef(input.camera)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastWritten = useRef<string | null>(null)

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const source = latest.current
    const snapshot = captureSnapshot({
      runId: source.run.id,
      trace: source.trace,
      elapsedMs: source.elapsedMs,
      speed: source.speed,
      filter: source.filter,
      selection: source.selection,
      camera: cameraRef.current,
      savedAt: now(),
    })
    // The view is what must be new, not the timestamp: a burst that ends on the
    // same view it last wrote is not worth a second write.
    const view = viewKey(snapshot)
    if (view === lastWritten.current) return
    if (writeStoredSnapshot(storage, snapshot, key) === 'saved') {
      lastWritten.current = view
    }
  }, [key, now, storage])

  const schedule = useCallback(() => {
    if (timer.current !== null) return
    timer.current = setTimeout(() => {
      timer.current = null
      flush()
    }, debounceMs)
  }, [debounceMs, flush])

  // A change in the view is a reason to plan a write. The camera and the playhead
  // are the two that move continuously; the rest move in clicks.
  useEffect(() => {
    schedule()
  }, [
    schedule,
    input.run,
    input.trace,
    input.elapsedMs,
    input.speed,
    input.filter,
    input.selection,
  ])

  // The endings: a tab that is closed or hidden inside the debounce window still
  // saves the view it had.
  useEffect(() => {
    const flushNow = (): void => {
      flush()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flushNow()
    }
    window.addEventListener('pagehide', flushNow)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flushNow)
      document.removeEventListener('visibilitychange', onVisibility)
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
  }, [flush])

  const onCameraChange = useCallback(
    (camera: CameraSnapshot) => {
      cameraRef.current = camera
      schedule()
    },
    [schedule],
  )

  return { onCameraChange, saveNow: flush }
}
