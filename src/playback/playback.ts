/**
 * Playback transport model (M4-T1) — the pure half of the scrubber.
 *
 * M1-T7 landed the *playback arithmetic*: a {@link Timeline}, a {@link frameAt}
 * lookup and an immutable {@link Playhead} with pure transitions. What it
 * deliberately left out was the **transport** — the little state machine a
 * player exposes to a user: play / pause, faster / slower, scrub to a position,
 * step to the next event, restart, finish. Every one of those is a rule (does a
 * step pause playback? does play at the end restart? what does a scrub to 40%
 * mean on a zero-span run?), and rules belong in the pure layer, where they are
 * gated by vitest instead of discovered by clicking.
 *
 * So this module is one reducer over one immutable value:
 *
 * ```
 * PlaybackState = { timeline, playhead }   --(PlaybackAction)-->  PlaybackState
 * ```
 *
 * plus the two other things a scrubber needs and a component should not invent:
 *
 * - **the scrubber's geometry** — {@link buildScrubber}: the run's distinct
 *   event instants as *marks* (thinned deterministically, because a 2k-event
 *   run must not put 2k DOM nodes in the track), and an event-density
 *   histogram to draw behind the track so the shape of the run is visible
 *   before you scrub it;
 * - **the readout** — {@link describePlayback} / {@link formatDuration}: the
 *   "0.0s / 4:00 · 3 of 12 events · 2 of 6 agents" line, formatted once, in a
 *   place a test can pin.
 *
 * ## What this is — and what it is not
 *
 * It is the **transport for the spatial view**: its position feeds
 * `frameAt` → the scene's reveal (`src/scene/reveal.ts`), so scrubbing changes
 * *what the 3D scene shows*, not what a transcript says. It is NOT a linear
 * replay UI: there is no event list, no log view, no search, no per-event text
 * stream here. AgentReplay/traceview/tracediff already cover linear
 * replay/search/diff (PRD §8); the spatial view is the product, and this module
 * only decides *when* the scene is.
 *
 * ## Purity + no clock (PRD §5)
 *
 * Pure and deterministic: no React, no DOM, no three.js, no `Date.now` /
 * `performance.now`, no `Math.random`, and no mutation of any argument. Real
 * time is passed *in* by the caller's animation loop as `{ type: 'tick',
 * deltaMs }`; the same state plus the same action list always yields the same
 * state, byte for byte. The React plumbing (the `requestAnimationFrame` loop,
 * keyboard listeners) lives in `usePlayback.ts`, one layer up.
 */

import type { TraceModel } from '../model/index.ts'
import {
  advance,
  buildTimeline,
  createPlayhead,
  cycleSpeed,
  frameAt,
  seek,
  setPlaying,
  setSpeed,
  stepBackward as stepPlayheadBackward,
  stepForward as stepPlayheadForward,
} from '../timeline/index.ts'
import type {
  PlaybackSpeed,
  Playhead,
  Timeline,
  TimelineFrame,
} from '../timeline/index.ts'

// ── Scrubber tunables ───────────────────────────────────────────────────────

/**
 * Most marks the scrubber track draws. A run can have one distinct instant per
 * event (2k stops on a 2k-event trace), and rendering one DOM node per stop at
 * 60 fps would cost more than the scene it is scrubbing. The marks are a
 * *thumbnail* of where events cluster — the density histogram carries the rest,
 * and the slider itself is continuous.
 */
export const DEFAULT_MAX_SCRUB_MARKS = 64

/** Buckets in the event-density histogram behind the track. */
export const DEFAULT_SCRUB_BUCKETS = 48

// ── Transport state ─────────────────────────────────────────────────────────

/** The transport's whole state: the run's timeline and the cursor into it. */
export interface PlaybackState {
  /** The flattened run (M1-T7); never replaced by a transition. */
  timeline: Timeline
  /** Where playback sits and how it is running (M1-T7). */
  playhead: Playhead
}

/** Optional initial state for {@link createPlayback}. */
export interface PlaybackOptions {
  /** Start position from the run start, ms (clamped). Default `0`. */
  elapsedMs?: number
  /** Start speed (one of {@link PLAYBACK_SPEEDS}). Default `1`. */
  speed?: PlaybackSpeed
  /** Start running. Default `false` — a freshly loaded run is paused at 0. */
  playing?: boolean
}

/**
 * Every way the transport can be driven. A discriminated union rather than a
 * pile of callbacks so the state machine is one switch a test can walk.
 */
export type PlaybackAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'togglePlay' }
  | { type: 'setSpeed'; speed: PlaybackSpeed }
  | { type: 'faster' }
  | { type: 'slower' }
  | { type: 'seek'; elapsedMs: number }
  | { type: 'seekFraction'; fraction: number }
  | { type: 'stepForward' }
  | { type: 'stepBackward' }
  | { type: 'restart' }
  | { type: 'finish' }
  | { type: 'tick'; deltaMs: number }

/**
 * Build the transport for a normalized run. Paused at the start, real-time
 * speed: loading a trace must never start playing on its own.
 */
export function createPlayback(
  model: TraceModel,
  options: PlaybackOptions = {},
): PlaybackState {
  const timeline = buildTimeline(model)
  return { timeline, playhead: createPlayhead(timeline, options) }
}

/** The run's frame at the current position — what the scene reveals. */
export function playbackFrame(state: PlaybackState): TimelineFrame {
  return frameAt(state.timeline, state.playhead.elapsedMs)
}

/** Fraction of the run elapsed, `[0, 1]` (see {@link frameAt}). */
export function playbackProgress(state: PlaybackState): number {
  return playbackFrame(state).progress
}

/** The playhead at `fraction` of the run, `[0, 1]`. */
export function seekFraction(
  playhead: Playhead,
  timeline: Timeline,
  fraction: number,
): Playhead {
  const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction
  return seek(playhead, timeline, clamped * timeline.spanMs)
}

/** A new state with `playhead`, or the same state when the playhead did not move. */
function withPlayhead(state: PlaybackState, playhead: Playhead): PlaybackState {
  return playhead === state.playhead ? state : { ...state, playhead }
}

/** Whether the playhead sits at the end of a run that can actually move. */
function isFinished(state: PlaybackState): boolean {
  return state.timeline.spanMs > 0 && state.playhead.elapsedMs >= state.timeline.spanMs
}

/**
 * Start playing, restarting from the beginning when the run has already
 * finished (what a play button means at the end of a track). A run with no
 * span — empty, or every event at one instant — cannot be played, so this is
 * an identity: pressing play there must not leave a playhead that can never
 * advance lit up as "playing".
 */
function startPlaying(state: PlaybackState): PlaybackState {
  if (state.timeline.spanMs <= 0) return state
  const base = isFinished(state)
    ? seek(state.playhead, state.timeline, 0)
    : state.playhead
  return withPlayhead(state, setPlaying(base, true))
}

/** A finite number, or the fallback. */
function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * Apply one transport action. Pure: the same state + action always yields the
 * same result, and an action that changes nothing returns the *same state
 * object* (so React re-renders only when something actually moved).
 *
 * UX rules baked in here (each is a decision, not an accident):
 *
 * - **Stepping pauses.** Stepping is inspection: you are walking the run event
 *   by event, so a running clock fighting your steps is wrong. Seek and speed
 *   changes preserve the running flag — a scrub while playing keeps playing.
 * - **Play at the end restarts.** Otherwise the button would be dead exactly
 *   when a visitor wants to watch the run again.
 * - **Finish pauses at the end**, and `tick` reaching the end auto-pauses
 *   (M1-T7's `advance`), so a finished run stays finished.
 */
export function reducePlayback(
  state: PlaybackState,
  action: PlaybackAction,
): PlaybackState {
  const { timeline, playhead } = state
  switch (action.type) {
    case 'play':
      return startPlaying(state)
    case 'pause':
      return withPlayhead(state, setPlaying(playhead, false))
    case 'togglePlay':
      return playhead.playing
        ? withPlayhead(state, setPlaying(playhead, false))
        : startPlaying(state)
    case 'setSpeed':
      return withPlayhead(state, setSpeed(playhead, action.speed))
    case 'faster':
      return withPlayhead(state, cycleSpeed(playhead, 1))
    case 'slower':
      return withPlayhead(state, cycleSpeed(playhead, -1))
    case 'seek':
      // A UI-fed position (a range input's value) can arrive as `NaN`; clamping
      // it to the start is the only sane reading, and it keeps `NaN` out of the
      // playhead where it would poison every later comparison.
      return withPlayhead(state, seek(playhead, timeline, finite(action.elapsedMs, 0)))
    case 'seekFraction':
      return withPlayhead(
        state,
        seekFraction(playhead, timeline, finite(action.fraction, 0)),
      )
    case 'stepForward':
      return withPlayhead(
        state,
        stepPlayheadForward(setPlaying(playhead, false), timeline),
      )
    case 'stepBackward':
      return withPlayhead(
        state,
        stepPlayheadBackward(setPlaying(playhead, false), timeline),
      )
    case 'restart':
      return startPlaying(withPlayhead(state, seek(playhead, timeline, 0)))
    case 'finish':
      return withPlayhead(
        state,
        setPlaying(seek(playhead, timeline, timeline.spanMs), false),
      )
    case 'tick':
      return withPlayhead(state, advance(playhead, timeline, finite(action.deltaMs, 0)))
  }
}

/** Fold a list of actions over a state — the deterministic replay of a session. */
export function replayActions(
  state: PlaybackState,
  actions: readonly PlaybackAction[],
): PlaybackState {
  return actions.reduce(reducePlayback, state)
}

// ── Keyboard ────────────────────────────────────────────────────────────────

/**
 * The transport action a key means, or `null` when it is not a transport key.
 * Kept here (rather than inline in the component) because the mapping is a rule:
 * space toggles, arrows step one event, Home/End jump to the ends. A modified
 * key (⌘/Ctrl/Alt) is deliberately NOT a transport key — that is the browser's
 * or the OS's.
 */
export function actionForKey(
  key: string,
  modifiers: { shift?: boolean; meta?: boolean; ctrl?: boolean; alt?: boolean } = {},
): PlaybackAction | null {
  if (modifiers.meta === true || modifiers.ctrl === true || modifiers.alt === true) {
    return null
  }
  switch (key) {
    case ' ':
    case 'Spacebar':
      return { type: 'togglePlay' }
    case 'ArrowRight':
      return { type: 'stepForward' }
    case 'ArrowLeft':
      return { type: 'stepBackward' }
    case 'Home':
      return { type: 'seek', elapsedMs: 0 }
    case 'End':
      return { type: 'finish' }
    default:
      return null
  }
}

// ── Scrubber geometry ───────────────────────────────────────────────────────

/** One mark on the scrubber track: a distinct instant where events happened. */
export interface ScrubberMark {
  /** Offset from the run start, ms. */
  elapsedMs: number
  /** Position along the track, `[0, 1]`. */
  fraction: number
  /** How many events share this instant. */
  eventCount: number
}

/** What a scrubber track draws — geometry only, no styling. */
export interface Scrubber {
  /** Length of the run, ms. */
  spanMs: number
  /** Distinct event instants in the run (before the marks are thinned). */
  stopCount: number
  /** The marks to draw, ascending by position; at most `maxMarks`. */
  marks: ScrubberMark[]
  /** Event counts per bucket, normalized to `[0, 1]` (all `0` for an empty run). */
  buckets: number[]
  /** `buckets.length`. */
  bucketCount: number
  /** Total events in the run. */
  eventCount: number
}

/** Optional scrubber overrides. */
export interface ScrubberOptions {
  /** Cap on drawn marks; default {@link DEFAULT_MAX_SCRUB_MARKS}. */
  maxMarks?: number
  /** Histogram buckets; default {@link DEFAULT_SCRUB_BUCKETS}. */
  buckets?: number
}

/** A positive integer, or the fallback. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback
}

/**
 * Pick at most `maxMarks` stops, evenly spaced by index, always keeping the
 * first and the last. Deterministic (no sampling, no randomness): the same
 * run always yields the same marks, which is what lets a test pin them and a
 * human recognise the track between sessions. Indices are deduped, so a short
 * run of distinct stops cannot produce duplicate marks.
 */
function thinStops(count: number, maxMarks: number): number[] {
  if (count <= maxMarks) return Array.from({ length: count }, (_, i) => i)
  const picked: number[] = []
  for (let i = 0; i < maxMarks; i += 1) {
    const index = Math.round((i * (count - 1)) / (maxMarks - 1))
    if (picked[picked.length - 1] !== index) picked.push(index)
  }
  return picked
}

/**
 * Derive the scrubber's geometry from a timeline: the distinct instants as
 * marks (thinned to `maxMarks`), and an event histogram over `buckets` equal
 * slices of elapsed time so the track shows where the run is busy before you
 * scrub it. Pure; the timeline is not mutated.
 *
 * A zero-span run puts every event in bucket `0` — there is no time axis to
 * spread it over, and inventing one would misrepresent the trace.
 */
export function buildScrubber(
  timeline: Timeline,
  options: ScrubberOptions = {},
): Scrubber {
  const maxMarks = positive(options.maxMarks, DEFAULT_MAX_SCRUB_MARKS)
  const bucketCount = positive(options.buckets, DEFAULT_SCRUB_BUCKETS)
  const { spanMs, stops } = timeline

  // Event counts per instant: one pass over the events, then a lookup per mark.
  const countByInstant = new Map<number, number>()
  for (const event of timeline.events) {
    countByInstant.set(event.at, (countByInstant.get(event.at) ?? 0) + 1)
  }

  const fractionOf = (elapsedMs: number): number =>
    spanMs === 0 ? 0 : elapsedMs / spanMs

  const marks: ScrubberMark[] = thinStops(stops.length, maxMarks).map((index) => {
    const elapsedMs = stops[index] - timeline.startedAt
    return {
      elapsedMs,
      fraction: fractionOf(elapsedMs),
      eventCount: countByInstant.get(stops[index]) ?? 0,
    }
  })

  const counts = new Array<number>(bucketCount).fill(0)
  for (const event of timeline.events) {
    const fraction = fractionOf(event.at - timeline.startedAt)
    const bucket = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor(fraction * bucketCount)),
    )
    counts[bucket] += 1
  }
  const peak = counts.reduce((max, count) => (count > max ? count : max), 0)
  const buckets = counts.map((count) => (peak === 0 ? 0 : count / peak))

  return {
    spanMs,
    stopCount: stops.length,
    marks,
    buckets,
    bucketCount,
    eventCount: timeline.events.length,
  }
}

// ── Readout ─────────────────────────────────────────────────────────────────

/**
 * Format a duration for the transport's readout: one decimal below ten seconds
 * ("0.0s", "1.5s"), whole seconds below a minute ("45s"), then `M:SS` and
 * `H:MM:SS`. Negative and non-finite inputs are clamped to `0`, so a readout can
 * never print `NaN`.
 */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const seconds = safe / 1000
  if (safe < 10_000) return `${seconds.toFixed(1)}s`
  if (safe < 60_000) return `${Math.round(seconds)}s`
  const whole = Math.floor(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  const two = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${minutes}:${two(secs)}`
}

/** Everything the transport bar prints, derived once and pinned by tests. */
export interface PlaybackReadout {
  /** Position, ms. */
  elapsedMs: number
  /** Run length, ms. */
  spanMs: number
  /** `elapsedMs / spanMs`, `[0, 1]`. */
  progress: number
  /** Events fired at this position. */
  firedCount: number
  /** Events in the run. */
  eventCount: number
  /** Agents touched so far. */
  activeAgentCount: number
  /** Agents in the run. */
  agentCount: number
  /** `formatDuration(elapsedMs)`. */
  elapsedLabel: string
  /** `formatDuration(spanMs)`. */
  spanLabel: string
  /** `1×`, `0.25×`, … */
  speedLabel: string
  /** Whether playback is running. */
  playing: boolean
  /** Whether the playhead is at the end. */
  atEnd: boolean
}

/** Derive the transport's readout from its state. Pure. */
export function describePlayback(state: PlaybackState): PlaybackReadout {
  const frame = playbackFrame(state)
  const label = `${state.playhead.speed}×`
  return {
    elapsedMs: frame.elapsedMs,
    spanMs: state.timeline.spanMs,
    progress: frame.progress,
    firedCount: frame.firedCount,
    eventCount: state.timeline.events.length,
    activeAgentCount: frame.activeAgentIds.length,
    agentCount: state.timeline.agentIds.length,
    elapsedLabel: formatDuration(frame.elapsedMs),
    spanLabel: formatDuration(state.timeline.spanMs),
    speedLabel: label,
    playing: state.playhead.playing,
    atEnd: frame.atEnd,
  }
}
