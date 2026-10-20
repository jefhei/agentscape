/**
 * Public entry point for the playback transport (M4-T1).
 *
 * Import from `../playback`, not from the deep module paths — this barrel is the
 * seam that keeps the transport's internals free to move while the app shell
 * depends only on the shipped API.
 *
 * - **pure** (`playback.ts`) — the transport state machine
 *   ({@link createPlayback} / {@link reducePlayback}), the scrubber's geometry
 *   ({@link buildScrubber}), the keyboard map ({@link actionForKey}) and the
 *   readout ({@link describePlayback}). Fully unit-tested in jsdom.
 * - **React** (`usePlayback.ts`) — the animation clock and the key listener:
 *   the one thing the pure layer cannot own. Thin by construction.
 */
export {
  DEFAULT_MAX_SCRUB_MARKS,
  DEFAULT_SCRUB_BUCKETS,
  actionForKey,
  buildScrubber,
  createPlayback,
  describePlayback,
  formatDuration,
  playbackFrame,
  playbackProgress,
  reducePlayback,
  replayActions,
  seekFraction,
} from './playback.ts'

export type {
  PlaybackAction,
  PlaybackOptions,
  PlaybackReadout,
  PlaybackState,
  Scrubber,
  ScrubberMark,
  ScrubberOptions,
} from './playback.ts'

export { usePlayback } from './usePlayback.ts'
export type { PlaybackController } from './usePlayback.ts'
