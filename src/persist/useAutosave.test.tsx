/**
 * Wiring tests for the autosave hook (M6-T1).
 *
 * The rules (what a snapshot is, what it restores) are gated in their own modules;
 * what is asserted here is the *timing* half: a burst of changes is one write, the
 * camera can be reported without a re-render, a closed tab still saves the view it
 * had, an unchanged view is not rewritten, and a failing storage is silent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { IDENTITY_FILTER } from '../filter/filter.ts'
import { buildFixture } from '../fixtures/index.ts'
import type { CameraSnapshot } from './snapshot.ts'
import { AUTOSAVE_DEBOUNCE_MS, useAutosave } from './useAutosave.ts'
import type { AutosaveInput } from './useAutosave.ts'
import { createMemoryStorage, readStoredSnapshot } from './storage.ts'
import type { SnapshotStorage } from './storage.ts'

const RUN = buildFixture('fan-out').run
const LOOP = buildFixture('loop').run

const CAMERA: CameraSnapshot = {
  mode: 'orbit',
  orbit: { azimuthDeg: 45, elevationDeg: 20, zoom: 1.5 },
  fly: { position: { x: 1, y: 2, z: 3 }, yawDeg: 90, pitchDeg: -10 },
}

/** A complete input; tests override one field at a time. */
function input(overrides: Partial<AutosaveInput> = {}): AutosaveInput {
  return {
    run: RUN,
    trace: null,
    elapsedMs: 1200,
    speed: 1,
    filter: IDENTITY_FILTER,
    selection: null,
    camera: CAMERA,
    ...overrides,
  }
}

/** A storage that counts writes and keeps them — for "one write per burst". */
function countingStorage(): {
  storage: SnapshotStorage
  writes: string[]
  inner: SnapshotStorage
} {
  const inner = createMemoryStorage()
  const writes: string[] = []
  return {
    inner,
    writes,
    storage: {
      getItem: (key) => inner.getItem(key),
      setItem: (key, value) => {
        writes.push(value)
        inner.setItem(key, value)
      },
      removeItem: (key) => inner.removeItem(key),
    },
  }
}

/** Mount the hook over a storage and a fixed clock. */
function autosaveHook(storage: SnapshotStorage, initial: AutosaveInput = input()) {
  return renderHook(
    (props: AutosaveInput) => useAutosave(props, { storage, now: () => 42_000 }),
    {
      initialProps: initial,
    },
  )
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAutosave (M6-T1)', () => {
  it('writes the view once the debounce has elapsed', () => {
    const { storage } = countingStorage()
    autosaveHook(storage)
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1)
    })
    expect(readStoredSnapshot(storage)).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    const saved = readStoredSnapshot(storage)
    expect(saved?.run.id).toBe(RUN.id)
    expect(saved?.savedAt).toBe(42_000)
    expect(saved?.playback).toEqual({ elapsedMs: 1200, speed: 1 })
  })

  it('coalesces a burst of changes into one write', () => {
    const { storage, writes } = countingStorage()
    const { rerender } = autosaveHook(storage)
    for (const elapsedMs of [1300, 1400, 1500, 1600]) {
      rerender(input({ elapsedMs }))
    }
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
    })
    expect(writes).toHaveLength(1)
    // ...and the write is the *end* of the burst, which is the view worth keeping.
    expect(readStoredSnapshot(storage)?.playback.elapsedMs).toBe(1600)
  })

  it('writes again after the next burst', () => {
    const { storage, writes } = countingStorage()
    const { rerender } = autosaveHook(storage)
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
    })
    rerender(input({ elapsedMs: 2000 }))
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
    })
    expect(writes).toHaveLength(2)
    expect(readStoredSnapshot(storage)?.playback.elapsedMs).toBe(2000)
  })

  it('saves the camera the viewport reports, without a re-render', () => {
    const { storage } = countingStorage()
    const { result } = autosaveHook(storage)
    const moved: CameraSnapshot = {
      mode: 'fly',
      orbit: { azimuthDeg: 10, elevationDeg: 5, zoom: 2 },
      fly: { position: { x: 4, y: 5, z: 6 }, yawDeg: 180, pitchDeg: 12 },
    }
    act(() => {
      result.current.onCameraChange(moved)
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
    })
    expect(readStoredSnapshot(storage)?.camera).toEqual(moved)
  })

  it('flushes immediately when the page is hidden or closed', () => {
    const { storage, writes } = countingStorage()
    autosaveHook(storage)
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(writes).toHaveLength(1)
    expect(readStoredSnapshot(storage)?.run.id).toBe(RUN.id)

    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(writes).toHaveLength(1) // the same view — not worth a second write
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  it('does not rewrite a view that has not changed', () => {
    const { storage, writes } = countingStorage()
    const { rerender } = autosaveHook(storage)
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
    })
    rerender(input())
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
    })
    expect(writes).toHaveLength(1)
  })

  it('records the run it is mounted on, not the one it started with', () => {
    const { storage } = countingStorage()
    const { rerender } = autosaveHook(storage)
    rerender(input({ run: LOOP, trace: 'trace=scale:4' }))
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
    })
    expect(readStoredSnapshot(storage)?.run).toEqual({
      id: LOOP.id,
      trace: 'trace=scale:4',
    })
  })

  it('records the lens, the selection and the trace', () => {
    const { storage } = countingStorage()
    const { rerender } = autosaveHook(storage)
    rerender(
      input({
        trace: 'trace=fleet',
        selection: 'a_worker_alpha',
        speed: 2,
        filter: {
          agentIds: ['a_worker_alpha'],
          kinds: ['message'],
          window: { startMs: 0, endMs: 500 },
        },
      }),
    )
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
    })
    const saved = readStoredSnapshot(storage)
    expect(saved?.run.trace).toBe('trace=fleet')
    expect(saved?.selection).toBe('a_worker_alpha')
    expect(saved?.playback.speed).toBe(2)
    expect(saved?.filter.agentIds).toEqual(['a_worker_alpha'])
    expect(saved?.filter.window).toEqual({ startMs: 0, endMs: 500 })
  })

  it('writes on demand', () => {
    const { storage } = countingStorage()
    const { result } = autosaveHook(storage)
    act(() => {
      result.current.saveNow()
    })
    expect(readStoredSnapshot(storage)).not.toBeNull()
  })

  it('stays silent when the storage refuses writes', () => {
    const failing: SnapshotStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => undefined,
    }
    const { rerender } = autosaveHook(failing)
    expect(() => {
      rerender(input({ elapsedMs: 3000 }))
      act(() => {
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS)
        window.dispatchEvent(new Event('pagehide'))
      })
    }).not.toThrow()
  })

  it('clears its timer on unmount (no write after the hook is gone)', () => {
    const { storage, writes } = countingStorage()
    const { unmount } = autosaveHook(storage)
    unmount()
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 4)
    })
    expect(writes).toHaveLength(0)
  })
})
