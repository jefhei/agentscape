/**
 * Tests for the autosave storage seam (M6-T1).
 *
 * `localStorage` is the one part of persistence that can fail at runtime for
 * reasons the app cannot control (quota, privacy mode, a corrupted profile), so
 * these tests are mostly about **failure being ordinary**: a read that throws is
 * "nothing saved", a write that throws is a reported `'failed'`, and neither
 * reaches the caller as an exception.
 */

import { describe, expect, it } from 'vitest'
import { buildFixture } from '../fixtures/index.ts'
import { IDENTITY_FILTER } from '../filter/filter.ts'
import { captureSnapshot } from './snapshot.ts'
import type { ViewSnapshot } from './snapshot.ts'
import {
  AUTOSAVE_KEY,
  browserStorage,
  clearStoredSnapshot,
  createMemoryStorage,
  readStoredSnapshot,
  writeStoredSnapshot,
} from './storage.ts'
import type { SnapshotStorage } from './storage.ts'

const RUN = buildFixture('fan-out').run

/** A valid snapshot to store. */
function snapshot(): ViewSnapshot {
  return captureSnapshot({
    runId: RUN.id,
    trace: null,
    elapsedMs: 500,
    speed: 1,
    filter: IDENTITY_FILTER,
    selection: null,
    camera: {
      mode: 'orbit',
      orbit: { azimuthDeg: 90, elevationDeg: 18, zoom: 1 },
      fly: null,
    },
    savedAt: 1_700_000_000_000,
  })
}

describe('createMemoryStorage (M6-T1)', () => {
  it('stores, reads and removes like Storage', () => {
    const storage = createMemoryStorage({ seed: 'value' })
    expect(storage.getItem('seed')).toBe('value')
    expect(storage.getItem('missing')).toBeNull()
    storage.setItem('a', '1')
    expect(storage.getItem('a')).toBe('1')
    storage.removeItem('a')
    expect(storage.getItem('a')).toBeNull()
  })

  it('is not shared between instances', () => {
    const one = createMemoryStorage()
    const two = createMemoryStorage()
    one.setItem('k', 'v')
    expect(two.getItem('k')).toBeNull()
  })
})

describe('round trip (M6-T1)', () => {
  it('writes a snapshot and reads the same value back', () => {
    const storage = createMemoryStorage()
    const saved = snapshot()
    expect(writeStoredSnapshot(storage, saved)).toBe('saved')
    expect(storage.getItem(AUTOSAVE_KEY)).toContain('"version":1')
    expect(readStoredSnapshot(storage)).toEqual(saved)
  })

  it('reads nothing from an absent key', () => {
    expect(readStoredSnapshot(createMemoryStorage())).toBeNull()
  })

  it('reads nothing from text that is not a snapshot', () => {
    expect(
      readStoredSnapshot(createMemoryStorage({ [AUTOSAVE_KEY]: '<html>' })),
    ).toBeNull()
    expect(readStoredSnapshot(createMemoryStorage({ [AUTOSAVE_KEY]: '{}' }))).toBeNull()
  })

  it('honours a caller-supplied key', () => {
    const storage = createMemoryStorage()
    writeStoredSnapshot(storage, snapshot(), 'other:key')
    expect(storage.getItem(AUTOSAVE_KEY)).toBeNull()
    expect(readStoredSnapshot(storage, 'other:key')).not.toBeNull()
  })
})

describe('a storage that fails (M6-T1)', () => {
  /** A storage whose every call throws — a locked-down browser, or a full disk. */
  function hostile(throwsOn: 'get' | 'set' | 'remove'): SnapshotStorage {
    const boom = (): never => {
      throw new Error('QuotaExceededError')
    }
    return {
      getItem: throwsOn === 'get' ? boom : () => null,
      setItem: throwsOn === 'set' ? boom : () => undefined,
      removeItem: throwsOn === 'remove' ? boom : () => undefined,
    }
  }

  it('reads a throwing getItem as "nothing saved"', () => {
    expect(readStoredSnapshot(hostile('get'))).toBeNull()
  })

  it('reports a throwing setItem as failed, without throwing', () => {
    expect(() => writeStoredSnapshot(hostile('set'), snapshot())).not.toThrow()
    expect(writeStoredSnapshot(hostile('set'), snapshot())).toBe('failed')
  })

  it('swallows a throwing removeItem', () => {
    expect(() => clearStoredSnapshot(hostile('remove'))).not.toThrow()
  })

  it('clears a real save', () => {
    const storage = createMemoryStorage()
    writeStoredSnapshot(storage, snapshot())
    clearStoredSnapshot(storage)
    expect(readStoredSnapshot(storage)).toBeNull()
  })
})

describe('browserStorage (M6-T1)', () => {
  it('returns the browser localStorage when it is usable', () => {
    // jsdom implements localStorage; the seam must hand it over rather than the
    // in-memory fallback, or a real reload would lose the view.
    const storage = browserStorage()
    storage.setItem('agentscape:test-probe', '1')
    expect(globalThis.localStorage.getItem('agentscape:test-probe')).toBe('1')
    storage.removeItem('agentscape:test-probe')
    expect(globalThis.localStorage.getItem('agentscape:test-probe')).toBeNull()
  })

  it('falls back to an in-memory storage when the property access throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    try {
      const storage = browserStorage()
      expect(() => storage.setItem('k', 'v')).not.toThrow()
      expect(storage.getItem('k')).toBe('v')
    } finally {
      if (original !== undefined)
        Object.defineProperty(globalThis, 'localStorage', original)
    }
  })

  it('reads an empty browser storage as nothing saved', () => {
    globalThis.localStorage.removeItem(AUTOSAVE_KEY)
    expect(readStoredSnapshot(browserStorage())).toBeNull()
  })
})
