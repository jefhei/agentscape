/**
 * Public entry point for the timeline / playhead model (M1-T7).
 *
 * Import from `../timeline` (or `./timeline`), not from the deep module path —
 * this barrel is the seam that keeps the module's internals free to move while
 * the render layer (M4-T1's scrubber and playback) depends only on the pure
 * model.
 */
export {
  advance,
  buildTimeline,
  createPlayhead,
  cycleSpeed,
  DEFAULT_SPEED,
  frameAt,
  PLAYBACK_SPEEDS,
  seek,
  setPlaying,
  setSpeed,
  stepBackward,
  stepForward,
  togglePlay,
} from './timeline.ts'

export type {
  PlaybackSpeed,
  Playhead,
  PlayheadOptions,
  Timeline,
  TimelineFrame,
} from './timeline.ts'
