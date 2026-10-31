/**
 * Persistence layer (M6-T1) — the public seam for the autosave.
 *
 * The PRD's runtime is 100% client-side with "recorded trace JSON in; localStorage
 * autosave out", so persistence is one small value and no backend. The split
 * follows the project's shape (PRD §5):
 *
 * - **pure** (`snapshot.ts`) — the snapshot schema, capture and parse: what is
 *   saved and how stored text is validated back. No React, no storage, no clock.
 * - **pure** (`restore.ts`) — what a saved view restores onto a run: the run-id
 *   guard, the prune, and the camera rebuilt on the scene's own opening shot.
 * - **pure** (`boot.ts`) — the precedence between an explicit `?trace=` link, the
 *   saved run and the default fixture.
 * - **seam** (`storage.ts`) — `localStorage` behind a three-method interface that
 *   cannot throw at its callers, with an in-memory double for tests.
 * - **React** (`useAutosave.ts`) — the timer and the refs: when to write. Thin.
 *
 * Import from `../persist`, not from the deep module paths: this barrel is what
 * lets the internals move while the shell depends only on the shipped API.
 */

export {
  AUTOSAVE_KEY,
  browserStorage,
  clearStoredSnapshot,
  createMemoryStorage,
  readStoredSnapshot,
  writeStoredSnapshot,
} from './storage.ts'
export type { SaveOutcome, SnapshotStorage } from './storage.ts'

export {
  DEFAULT_CAMERA_SNAPSHOT,
  SNAPSHOT_VERSION,
  cameraSnapshotOf,
  captureSnapshot,
  isPlaybackSpeed,
  normalizeSnapshot,
  parseSnapshot,
  serializeSnapshot,
} from './snapshot.ts'
export type {
  CameraSnapshot,
  FilterSnapshot,
  FlyPoseSnapshot,
  OrbitPoseSnapshot,
  PlaybackSnapshot,
  RunSnapshot,
  SnapshotSource,
  ViewSnapshot,
} from './snapshot.ts'

export { restoreCameraPlan, restoreView } from './restore.ts'
export type { RestoredCamera, RestoredView } from './restore.ts'

export { bootState } from './boot.ts'
export type { BootState } from './boot.ts'

export { AUTOSAVE_DEBOUNCE_MS, useAutosave } from './useAutosave.ts'
export type {
  AutosaveController,
  AutosaveInput,
  AutosaveOptions,
} from './useAutosave.ts'
