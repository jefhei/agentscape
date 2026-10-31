/**
 * Where the autosave lives (M6-T1) — the storage seam.
 *
 * The snapshot is a value; whether it is written to the browser's `localStorage`,
 * to a test's in-memory map, or to nothing at all is a decision made here and
 * nowhere else. The app asks for {@link browserStorage}; a test asks for
 * {@link createMemoryStorage}; both satisfy the same three-method
 * {@link SnapshotStorage} interface, which is `Storage`'s read/write/remove
 * surface and nothing more.
 *
 * ## Every call can fail, so no call throws
 *
 * `localStorage` is a browser API that lies about being available: a privacy mode
 * refuses the *property access*, a full disk throws `QuotaExceededError` on
 * `setItem`, and a corrupted profile can throw on `getItem`. Autosave is a
 * convenience — the app is fully usable without it — so none of those may reach
 * the React tree. Reads degrade to `null` and writes to a reported
 * `'failed'`, and the caller decides what to say (the hook says nothing: a viewer
 * who cannot save does not need a dialog about it).
 *
 * ## What is not here
 *
 * No schema, no parsing rules, no debounce, no React. Storage stores text; the
 * snapshot module owns what the text means and the hook owns when it is written.
 */

import { parseSnapshot, serializeSnapshot } from './snapshot.ts'
import type { ViewSnapshot } from './snapshot.ts'

/**
 * The key one autosave occupies. The *schema* version lives in the value, where a
 * reader can reject it; the key's `:view` segment keeps it from colliding with any
 * future unrelated key (a layout preference, a run cache).
 */
export const AUTOSAVE_KEY = 'agentscape:view'

/** The three-method slice of `Storage` the autosave needs. */
export interface SnapshotStorage {
  /** Stored text for `key`, or `null`. May throw (see the module doc). */
  getItem(key: string): string | null
  /** Store `value` under `key`. May throw (`QuotaExceededError`). */
  setItem(key: string, value: string): void
  /** Remove `key`. May throw on a hostile storage. */
  removeItem(key: string): void
}

/** What a write did. */
export type SaveOutcome = 'saved' | 'failed'

/**
 * A storage backed by a plain `Map` — the test double, and the fallback for a
 * browser whose `localStorage` is unreachable. It survives for the life of the
 * page only, which is exactly what a fallback should promise.
 */
export function createMemoryStorage(
  initial: Record<string, string> = {},
): SnapshotStorage {
  const values = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

/** The fallback when the browser has no usable `localStorage` (shared per page). */
const FALLBACK: SnapshotStorage = createMemoryStorage()

/**
 * The browser's `localStorage`, or an in-memory fallback when reaching it throws.
 *
 * The *property access itself* is what throws in a locked-down browser, so the
 * probe has to be inside the `try`, not a `typeof` check.
 */
export function browserStorage(): SnapshotStorage {
  try {
    const storage = globalThis.localStorage as Storage | undefined
    if (storage === undefined || storage === null) return FALLBACK
    // A getter can answer and still refuse every call; probe with a read of this
    // module's own key, which is cheap and never creates an entry.
    storage.getItem(AUTOSAVE_KEY)
    return storage
  } catch {
    return FALLBACK
  }
}

/**
 * Read and validate the stored snapshot, or `null`.
 *
 * A missing key, a storage that throws, and text that is not a valid snapshot all
 * read the same way to the app: "there is nothing to restore". Distinguishing them
 * would only invite a UI that reports corruption to a viewer who cannot act on it.
 */
export function readStoredSnapshot(
  storage: SnapshotStorage,
  key: string = AUTOSAVE_KEY,
): ViewSnapshot | null {
  try {
    return parseSnapshot(storage.getItem(key))
  } catch {
    return null
  }
}

/** Write `snapshot`, reporting whether the storage accepted it. Never throws. */
export function writeStoredSnapshot(
  storage: SnapshotStorage,
  snapshot: ViewSnapshot,
  key: string = AUTOSAVE_KEY,
): SaveOutcome {
  try {
    storage.setItem(key, serializeSnapshot(snapshot))
    return 'saved'
  } catch {
    return 'failed'
  }
}

/** Drop the autosave. Never throws (a storage that refuses a delete is left alone). */
export function clearStoredSnapshot(
  storage: SnapshotStorage,
  key: string = AUTOSAVE_KEY,
): void {
  try {
    storage.removeItem(key)
  } catch {
    // Nothing to do: the next write overwrites it, or the storage is unusable.
  }
}
