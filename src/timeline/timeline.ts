/**
 * Timeline / playhead model (M1-T7).
 *
 * The pure playback seam of the data layer (PRD §5 lists it beside the trace
 * contract, the adapter, normalization and the layout). A {@link TraceModel}
 * goes in; a flat, scrub-able {@link Timeline} plus a {@link Playhead} come
 * out, and every question the render layer asks while a run is playing —
 * "what time is it? which agents are live? which events have fired? what is
 * the next event?" — is answered here, deterministically, with no GPU, no DOM
 * and **no clock**.
 *
 * ## What this is — and what it is not
 *
 * This is the *scalar* that drives the **spatial** scene over time: the
 * playhead's `elapsedMs` decides which message arcs have appeared, which nodes
 * are "hot", and how far through the run the camera has walked (M4-T1's
 * scrubber / play / pause / speed / step-to-next-event all ride on
 * {@link Playhead} + {@link frameAt}). It is deliberately NOT a timeline *view*
 * — no rendering, no linear-replay product surface. Linear replay/search/diff
 * already exist elsewhere in the pipeline (PRD §8); the spatial view is the
 * product, and this module only feeds it. That is also why the model is a
 * handful of pure functions over an immutable state value rather than a
 * stateful store: the UI owns the React/Zustand plumbing, the model owns the
 * arithmetic.
 *
 * ## Determinism (PRD §5)
 *
 * Every function is a pure function of its arguments. The module never reads
 * `Date.now` / `performance.now`, never calls `Math.random`, and never mutates
 * its inputs — real elapsed time is passed *in* as `deltaMs` by the caller's
 * animation loop, so the same model plus the same playhead always produce the
 * same frame, byte for byte. That is what makes a scrub, a step and a replay
 * reproducible.
 *
 * ## Time base
 *
 * `Timeline` works in **epoch milliseconds** for absolute times (`times`,
 * `startedAt`, `endedAt`, a `TimelineFrame.timeMs`) and in **elapsed
 * milliseconds from the run start** for the playhead (`Playhead.elapsedMs`,
 * `TimelineFrame.elapsedMs`). The translation is always `timeMs = startedAt +
 * elapsedMs`; both are integers for any real trace, so stepping is exact.
 */

import type { AgentId, Event } from '../types/index.ts'
import { isMessageEvent } from '../types/index.ts'
import type { TraceModel } from '../model/index.ts'

// ── Playback speeds ─────────────────────────────────────────────────────────

/**
 * The discrete playback speeds the scrubber cycles through (M4-T1). A fixed,
 * ordered set rather than a free number: it is what the UI exposes, it keeps
 * the "speed up / slow down" interaction deterministic, and `1` is exactly
 * real time. Powers of two so a speed change doubles / halves the advance.
 */
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4] as const

/** One of the {@link PLAYBACK_SPEEDS} multipliers. */
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number]

/** Real-time playback, the default a fresh playhead starts on. */
export const DEFAULT_SPEED: PlaybackSpeed = 1

/** Clamp a number into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

// ── Timeline ────────────────────────────────────────────────────────────────

/**
 * A run's event stream flattened into the shape a scrubber drives: the
 * canonical events, the distinct moments in time they occur at (the
 * "stops" a step jumps between) and the run's time bounds.
 *
 * Built by {@link buildTimeline} from a normalized {@link TraceModel}, so the
 * events are guaranteed to be in canonical order (ascending `at`, then kind
 * rank, then id) with a contiguous `sequence` assigned by M1-T5 — this module
 * relies on that order rather than re-sorting.
 */
export interface Timeline {
  /** The events, in canonical order (shares the model's array; treated as read-only). */
  events: readonly Event[]
  /**
   * The distinct event times (epoch ms), ascending — where "step to next /
   * previous event" lands. Several events can share one instant; they are one
   * stop and fire together, which is what makes stepping total even when a
   * trace has sub-millisecond bursts.
   */
  stops: readonly number[]
  /** Agent ids in canonical (model) order — the order `activeAgentIds` uses. */
  agentIds: readonly AgentId[]
  /** Earliest fact, epoch ms. */
  startedAt: number
  /** Latest fact, epoch ms. */
  endedAt: number
  /** `endedAt - startedAt`, in ms; `0` for an empty run or a single instant. */
  spanMs: number
}

/**
 * Build the {@link Timeline} view over a normalized {@link TraceModel}. Pure
 * and deterministic: the same model always yields a byte-identical timeline.
 * The model is not mutated.
 *
 * Requires a normalized model — its events must already be in canonical order
 * (M1-T5 guarantees this), which is what lets the stops pass be a single
 * linear scan and the frame lookup a binary search.
 */
export function buildTimeline(model: TraceModel): Timeline {
  const events = model.events

  // `stops` = distinct `at`, ascending. A linear scan is enough because the
  // events are canonical (non-decreasing `at`).
  const stops: number[] = []
  for (const event of events) {
    if (stops.length === 0 || stops[stops.length - 1] !== event.at) stops.push(event.at)
  }

  return {
    events,
    stops,
    agentIds: model.agents.map((agent) => agent.id),
    startedAt: model.startedAt,
    endedAt: model.endedAt,
    spanMs: model.endedAt - model.startedAt,
  }
}

// ── Frame lookup ────────────────────────────────────────────────────────────

/**
 * Index of the last event whose `at` is `<= timeMs`, or `-1` when every event
 * is later than `timeMs`. Binary search over the canonical (ascending `at`)
 * event array; ties resolve to the last of the group, so *every* event at an
 * instant counts as fired the moment the playhead reaches it.
 */
function lastIndexAtOrBefore(events: readonly Event[], timeMs: number): number {
  let low = 0
  let high = events.length - 1
  let result = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (events[mid].at <= timeMs) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return result
}

/**
 * The state of the run at a point in time — everything the render layer needs
 * to draw frame-by-frame. `elapsedMs` is clamped into `[0, spanMs]`, so asking
 * for a time before the run or past its end yields the first / last frame
 * rather than an invalid one.
 */
export interface TimelineFrame {
  /** Playhead position from the run start, clamped to `[0, spanMs]`. */
  elapsedMs: number
  /** Absolute time of the playhead, epoch ms (`startedAt + elapsedMs`). */
  timeMs: number
  /** Index of the most recently fired event, or `-1` when none has fired yet. */
  cursorIndex: number
  /** How many events have fired (`cursorIndex + 1`). */
  firedCount: number
  /**
   * Agents touched by a fired event, in canonical agent order. An agent is
   * active if it has *sent or received* a fired message, or made a fired tool
   * call — so a silent worker lights up the moment its first message lands,
   * not only once it replies.
   */
  activeAgentIds: readonly AgentId[]
  /** Fraction of the run elapsed, `[0, 1]` (`0` for an empty run). */
  progress: number
  /** Whether the playhead sits at (or past) the end of the run. */
  atEnd: boolean
}

/**
 * The run's state at `elapsedMs` from the start. Pure and deterministic: the
 * same timeline + position always yields a byte-identical frame, and the
 * timeline is not mutated.
 */
export function frameAt(timeline: Timeline, elapsedMs: number): TimelineFrame {
  const elapsed = clamp(elapsedMs, 0, timeline.spanMs)
  const timeMs = timeline.startedAt + elapsed
  const cursorIndex = lastIndexAtOrBefore(timeline.events, timeMs)
  const firedCount = cursorIndex + 1

  // Collect the agents touched by everything that has fired. A message fires
  // for both its sender and its recipient; a broadcast (`to === null`) names
  // no single recipient, so only the sender is touched here.
  const active = new Set<AgentId>()
  for (let i = 0; i < firedCount; i += 1) {
    const event = timeline.events[i]
    if (event.agentId !== null) active.add(event.agentId)
    if (isMessageEvent(event) && event.to !== null) active.add(event.to)
  }
  // Filter the canonical agent list so the result order is stable, never the
  // Set's insertion order.
  const activeAgentIds = timeline.agentIds.filter((id) => active.has(id))

  const progress =
    timeline.spanMs === 0
      ? timeline.events.length === 0
        ? 0
        : 1
      : clamp(elapsed / timeline.spanMs, 0, 1)

  return {
    elapsedMs: elapsed,
    timeMs,
    cursorIndex,
    firedCount,
    activeAgentIds,
    progress,
    atEnd: elapsed >= timeline.spanMs,
  }
}

// ── Playhead ────────────────────────────────────────────────────────────────

/**
 * The mutable-in-the-UI, immutable-in-the-model playback cursor. A plain data
 * value: every operation below returns a new `Playhead`, so React state, a
 * Zustand store or a raw `useState` can hold it without surprises.
 */
export interface Playhead {
  /** Position from the run start, ms; kept clamped to `[0, timeline.spanMs]`. */
  elapsedMs: number
  /** Current speed multiplier. */
  speed: PlaybackSpeed
  /** Whether playback is running. */
  playing: boolean
}

/** Optional initial state for {@link createPlayhead}. */
export interface PlayheadOptions {
  elapsedMs?: number
  speed?: PlaybackSpeed
  playing?: boolean
}

/**
 * A fresh playhead at the start of the run, paused, at real-time speed. An
 * initial `elapsedMs` is clamped into the run.
 */
export function createPlayhead(
  timeline: Timeline,
  options: PlayheadOptions = {},
): Playhead {
  return {
    elapsedMs: clamp(options.elapsedMs ?? 0, 0, timeline.spanMs),
    speed: options.speed ?? DEFAULT_SPEED,
    playing: options.playing ?? false,
  }
}

/** Set the running flag; identity when it does not change. */
export function setPlaying(playhead: Playhead, playing: boolean): Playhead {
  return playhead.playing === playing ? playhead : { ...playhead, playing }
}

/** Flip play ⇄ pause. */
export function togglePlay(playhead: Playhead): Playhead {
  return { ...playhead, playing: !playhead.playing }
}

/** Set the speed; identity when it does not change. */
export function setSpeed(playhead: Playhead, speed: PlaybackSpeed): Playhead {
  return playhead.speed === speed ? playhead : { ...playhead, speed }
}

/**
 * Step to the next / previous {@link PLAYBACK_SPEEDS} entry, wrapping at the
 * ends. `direction` is `1` (faster) or `-1` (slower). Pure; returns a new
 * playhead.
 */
export function cycleSpeed(playhead: Playhead, direction: 1 | -1 = 1): Playhead {
  const index = PLAYBACK_SPEEDS.indexOf(playhead.speed)
  const next = (index + direction + PLAYBACK_SPEEDS.length) % PLAYBACK_SPEEDS.length
  return { ...playhead, speed: PLAYBACK_SPEEDS[next] }
}

/** Move the playhead to `elapsedMs` (clamped); identity when it does not move. */
export function seek(
  playhead: Playhead,
  timeline: Timeline,
  elapsedMs: number,
): Playhead {
  const next = clamp(elapsedMs, 0, timeline.spanMs)
  return next === playhead.elapsedMs ? playhead : { ...playhead, elapsedMs: next }
}

/** Offset (from run start) of the first stop strictly after `elapsedMs`, or `null`. */
function nextStopElapsed(timeline: Timeline, elapsedMs: number): number | null {
  for (const stop of timeline.stops) {
    const offset = stop - timeline.startedAt
    if (offset > elapsedMs) return offset
  }
  return null
}

/**
 * Offset of the last stop strictly before `elapsedMs`, or `null` when the
 * playhead is at or before the first stop.
 */
function previousStopElapsed(timeline: Timeline, elapsedMs: number): number | null {
  let previous: number | null = null
  for (const stop of timeline.stops) {
    const offset = stop - timeline.startedAt
    if (offset < elapsedMs) previous = offset
    else break
  }
  return previous
}

/**
 * Jump to the next distinct event time (M4-T1's "step to next event"). From a
 * position between stops it moves to the upcoming stop; from a stop it moves
 * to the following one. At the last stop it is a no-op. Events sharing an
 * instant are one stop and are not re-visited. Playback state is preserved —
 * the caller pauses first if that is the desired UX.
 */
export function stepForward(playhead: Playhead, timeline: Timeline): Playhead {
  const target = nextStopElapsed(timeline, playhead.elapsedMs)
  return target === null ? playhead : seek(playhead, timeline, target)
}

/**
 * Jump to the previous distinct event time. At or before the first stop it
 * snaps to the run start (`0`). Playback state is preserved.
 */
export function stepBackward(playhead: Playhead, timeline: Timeline): Playhead {
  const target = previousStopElapsed(timeline, playhead.elapsedMs)
  return seek(playhead, timeline, target ?? 0)
}

/**
 * Advance the playhead by `deltaMs` of real time, scaled by its speed. Paused
 * or non-positive `deltaMs` is a no-op. The result is clamped to the run end,
 * and reaching the end automatically pauses playback (a run that finishes
 * stays finished until the user seeks back or restarts).
 */
export function advance(
  playhead: Playhead,
  timeline: Timeline,
  deltaMs: number,
): Playhead {
  if (!playhead.playing || deltaMs <= 0) return playhead
  const elapsedMs = clamp(
    playhead.elapsedMs + deltaMs * playhead.speed,
    0,
    timeline.spanMs,
  )
  const atEnd = elapsedMs >= timeline.spanMs
  return { ...playhead, elapsedMs, playing: atEnd ? false : playhead.playing }
}
