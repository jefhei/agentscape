import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildFixture } from '../fixtures/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import { buildTimeline, createPlayhead, frameAt } from '../timeline/index.ts'
import type { Timeline } from '../timeline/index.ts'
import {
  DEFAULT_MAX_SCRUB_MARKS,
  actionForKey,
  buildScrubber,
  createPlayback,
  describePlayback,
  formatDuration,
  playbackFrame,
  reducePlayback,
  replayActions,
  seekFraction,
} from './playback.ts'
import type { PlaybackAction, PlaybackState } from './playback.ts'

/**
 * The transport is the pure half of M4-T1: a reducer over `{ timeline, playhead }`
 * plus the scrubber's geometry and the readout. These tests pin the *rules* a UI
 * would otherwise discover by clicking — what a step does, what play at the end
 * does, what a scrub means — and the determinism PRD §5 requires.
 *
 * jsdom has no GPU; nothing here asserts the look. The reveal those numbers drive
 * is gated separately in `src/scene/reveal.test.ts`.
 */

const RUN = buildFixture('fan-out').run
const TIMELINE = buildTimeline(RUN)

/** Fan-out: events at 0 / 60s / 120s / 180s / 240s (run_start … run_end). */
const MINUTE = 60_000

/** The transport state for a timeline, paused at the start. */
function stateOf(timeline: Timeline = TIMELINE): PlaybackState {
  return { timeline, playhead: createPlayhead(timeline) }
}

/** Apply actions in order. */
function run(state: PlaybackState, ...actions: PlaybackAction[]): PlaybackState {
  return replayActions(state, actions)
}

describe('playback transport — creation (M4-T1)', () => {
  it('starts paused at the beginning, at real time', () => {
    const state = createPlayback(RUN)
    expect(state.playhead).toEqual({ elapsedMs: 0, speed: 1, playing: false })
    expect(state.timeline.startedAt).toBe(RUN.startedAt)
    expect(state.timeline.spanMs).toBe(4 * MINUTE)
  })

  it('honours initial options, clamped into the run', () => {
    expect(createPlayback(RUN, { elapsedMs: MINUTE, speed: 2 }).playhead).toEqual({
      elapsedMs: MINUTE,
      speed: 2,
      playing: false,
    })
    expect(createPlayback(RUN, { elapsedMs: -5 }).playhead.elapsedMs).toBe(0)
    expect(createPlayback(RUN, { elapsedMs: 1e9 }).playhead.elapsedMs).toBe(4 * MINUTE)
  })

  it('frames the run through the M1-T7 lookup, not a second derivation', () => {
    const state = createPlayback(RUN, { elapsedMs: MINUTE })
    expect(playbackFrame(state)).toEqual(frameAt(state.timeline, MINUTE))
  })
})

describe('playback transport — play / pause (M4-T1)', () => {
  it('plays, pauses, and toggles', () => {
    let state = createPlayback(RUN)
    state = reducePlayback(state, { type: 'play' })
    expect(state.playhead.playing).toBe(true)

    state = reducePlayback(state, { type: 'pause' })
    expect(state.playhead.playing).toBe(false)

    state = reducePlayback(state, { type: 'togglePlay' })
    expect(state.playhead.playing).toBe(true)
    state = reducePlayback(state, { type: 'togglePlay' })
    expect(state.playhead.playing).toBe(false)
  })

  it('restarts from the beginning when play is pressed at the end', () => {
    const finished = run(stateOf(), { type: 'finish' })
    expect(finished.playhead.elapsedMs).toBe(TIMELINE.spanMs)

    const replayed = reducePlayback(finished, { type: 'play' })
    expect(replayed.playhead).toEqual({ elapsedMs: 0, speed: 1, playing: true })
  })

  it('cannot play a run with no span (empty or instant-long)', () => {
    const instant: Timeline = {
      ...TIMELINE,
      stops: [TIMELINE.startedAt],
      endedAt: TIMELINE.startedAt,
      spanMs: 0,
    }
    const state = stateOf(instant)
    expect(reducePlayback(state, { type: 'play' })).toBe(state)
    expect(reducePlayback(state, { type: 'togglePlay' })).toBe(state)
  })
})

describe('playback transport — seeking (M4-T1)', () => {
  it('seeks to a clamped absolute position and keeps the running flag', () => {
    const playing = run(stateOf(), { type: 'play' })
    const seeked = reducePlayback(playing, { type: 'seek', elapsedMs: 2 * MINUTE })
    expect(seeked.playhead.elapsedMs).toBe(2 * MINUTE)
    expect(seeked.playhead.playing).toBe(true)

    expect(
      reducePlayback(seeked, { type: 'seek', elapsedMs: -1 }).playhead.elapsedMs,
    ).toBe(0)
    expect(
      reducePlayback(seeked, { type: 'seek', elapsedMs: 1e9 }).playhead.elapsedMs,
    ).toBe(TIMELINE.spanMs)
  })

  it('maps a 0..1 fraction onto the run, clamped', () => {
    const state = stateOf()
    expect(
      reducePlayback(state, { type: 'seekFraction', fraction: 0.25 }).playhead
        .elapsedMs,
    ).toBe(MINUTE)
    expect(
      reducePlayback(state, { type: 'seekFraction', fraction: 2 }).playhead.elapsedMs,
    ).toBe(TIMELINE.spanMs)
    expect(
      reducePlayback(state, { type: 'seekFraction', fraction: -2 }).playhead.elapsedMs,
    ).toBe(0)
    expect(seekFraction(state.playhead, TIMELINE, 0.5).elapsedMs).toBe(2 * MINUTE)
  })

  it('never carries a NaN into the playhead', () => {
    const state = run(stateOf(), { type: 'seek', elapsedMs: MINUTE })
    expect(
      reducePlayback(state, { type: 'seek', elapsedMs: Number.NaN }).playhead.elapsedMs,
    ).toBe(0)
    expect(
      reducePlayback(state, { type: 'seekFraction', fraction: Number.NaN }).playhead
        .elapsedMs,
    ).toBe(0)
    const playing = run(state, { type: 'play' })
    expect(
      reducePlayback(playing, { type: 'tick', deltaMs: Number.NaN }).playhead.elapsedMs,
    ).toBe(MINUTE)
  })

  it('restarts at 0 and plays, and finishes at the end and pauses', () => {
    const restarted = reducePlayback(
      run(stateOf(), { type: 'seek', elapsedMs: 3 * MINUTE }),
      { type: 'restart' },
    )
    expect(restarted.playhead.elapsedMs).toBe(0)
    expect(restarted.playhead.playing).toBe(true)

    const finished = reducePlayback(restarted, { type: 'finish' })
    expect(finished.playhead.elapsedMs).toBe(TIMELINE.spanMs)
    expect(finished.playhead.playing).toBe(false)
  })
})

describe('playback transport — stepping (M4-T1)', () => {
  it('steps forward one event instant at a time, pausing first', () => {
    let state = run(stateOf(), { type: 'play' })
    for (let step = 1; step <= 4; step += 1) {
      state = reducePlayback(state, { type: 'stepForward' })
      expect(state.playhead.elapsedMs).toBe(step * MINUTE)
      expect(state.playhead.playing).toBe(false)
    }
    // The end of the run: no next stop, so the position stays put.
    expect(reducePlayback(state, { type: 'stepForward' }).playhead.elapsedMs).toBe(
      TIMELINE.spanMs,
    )
  })

  it('steps forward from between two instants to the upcoming one', () => {
    const between = run(stateOf(), { type: 'seek', elapsedMs: MINUTE + 5_000 })
    expect(reducePlayback(between, { type: 'stepForward' }).playhead.elapsedMs).toBe(
      2 * MINUTE,
    )
  })

  it('steps backward to the previous instant, snapping to 0 before the first', () => {
    const atThree = run(stateOf(), { type: 'seek', elapsedMs: 3 * MINUTE })
    expect(reducePlayback(atThree, { type: 'stepBackward' }).playhead.elapsedMs).toBe(
      2 * MINUTE,
    )

    const atStart = stateOf()
    expect(reducePlayback(atStart, { type: 'stepBackward' }).playhead.elapsedMs).toBe(0)

    const between = run(stateOf(), { type: 'seek', elapsedMs: MINUTE + 5_000 })
    expect(reducePlayback(between, { type: 'stepBackward' }).playhead.elapsedMs).toBe(
      MINUTE,
    )
  })

  it('walks the whole run in steps and lands on the end, visiting each stop once', () => {
    const visited: number[] = []
    let state = stateOf()
    for (;;) {
      const next = reducePlayback(state, { type: 'stepForward' })
      if (next === state) break
      state = next
      visited.push(state.playhead.elapsedMs)
    }
    expect(visited).toEqual([1, 2, 3, 4].map((n) => n * MINUTE))
  })
})

describe('playback transport — the clock (M4-T1)', () => {
  it('advances by real time × speed', () => {
    const playing = run(stateOf(), { type: 'play' }, { type: 'setSpeed', speed: 2 })
    const state = reducePlayback(playing, { type: 'tick', deltaMs: 1_000 })
    expect(state.playhead.elapsedMs).toBe(2_000)
  })

  it('is a no-op while paused, for a non-positive delta, and scales with speed', () => {
    const paused = stateOf()
    expect(reducePlayback(paused, { type: 'tick', deltaMs: 1_000 })).toBe(paused)
    expect(
      reducePlayback(run(paused, { type: 'play' }), { type: 'tick', deltaMs: 0 })
        .playhead.elapsedMs,
    ).toBe(0)
    expect(
      reducePlayback(run(paused, { type: 'play' }), { type: 'tick', deltaMs: -10 })
        .playhead.elapsedMs,
    ).toBe(0)
    expect(
      reducePlayback(run(paused, { type: 'play' }, { type: 'slower' }), {
        type: 'tick',
        deltaMs: 1_000,
      }).playhead.elapsedMs,
    ).toBe(500)
  })

  it('clamps at the end and auto-pauses there', () => {
    const state = reducePlayback(run(stateOf(), { type: 'play' }), {
      type: 'tick',
      deltaMs: 10 * MINUTE,
    })
    expect(state.playhead.elapsedMs).toBe(TIMELINE.spanMs)
    expect(state.playhead.playing).toBe(false)
  })

  it('is deterministic: the same tick sequence yields the same state', () => {
    const ticks: PlaybackAction[] = [
      { type: 'play' },
      { type: 'tick', deltaMs: 16 },
      { type: 'tick', deltaMs: 16 },
      { type: 'faster' },
      { type: 'tick', deltaMs: 33 },
      { type: 'togglePlay' },
    ]
    const first = replayActions(stateOf(), ticks)
    const second = replayActions(stateOf(), ticks)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})

describe('playback transport — speed (M4-T1)', () => {
  it('cycles through the fixed speed set and wraps', () => {
    let state = stateOf()
    const seen: number[] = []
    for (let i = 0; i < 5; i += 1) {
      state = reducePlayback(state, { type: 'faster' })
      seen.push(state.playhead.speed)
    }
    expect(seen).toEqual([2, 4, 0.25, 0.5, 1])

    state = reducePlayback(state, { type: 'slower' })
    expect(state.playhead.speed).toBe(0.5)
    expect(reducePlayback(state, { type: 'setSpeed', speed: 2 }).playhead.speed).toBe(2)
  })

  it('keeps the running flag across a speed change', () => {
    const playing = run(stateOf(), { type: 'play' })
    expect(reducePlayback(playing, { type: 'faster' }).playhead.playing).toBe(true)
  })
})

describe('playback transport — no-op identity (M4-T1)', () => {
  it('returns the same state object when nothing moved', () => {
    const state = stateOf()
    expect(reducePlayback(state, { type: 'pause' })).toBe(state)
    expect(reducePlayback(state, { type: 'seek', elapsedMs: 0 })).toBe(state)
    expect(reducePlayback(state, { type: 'setSpeed', speed: 1 })).toBe(state)
    expect(reducePlayback(state, { type: 'stepBackward' })).toBe(state)
  })
})

describe('playback transport — keyboard map (M4-T1)', () => {
  it('maps the transport keys', () => {
    expect(actionForKey(' ')).toEqual({ type: 'togglePlay' })
    expect(actionForKey('Spacebar')).toEqual({ type: 'togglePlay' })
    expect(actionForKey('ArrowRight')).toEqual({ type: 'stepForward' })
    expect(actionForKey('ArrowLeft')).toEqual({ type: 'stepBackward' })
    expect(actionForKey('Home')).toEqual({ type: 'seek', elapsedMs: 0 })
    expect(actionForKey('End')).toEqual({ type: 'finish' })
  })

  it('leaves other keys and modified keys alone', () => {
    expect(actionForKey('a')).toBeNull()
    expect(actionForKey('Enter')).toBeNull()
    expect(actionForKey('ArrowRight', { meta: true })).toBeNull()
    expect(actionForKey('ArrowRight', { ctrl: true })).toBeNull()
    expect(actionForKey('ArrowRight', { alt: true })).toBeNull()
    // Shift is not reserved by the transport yet, so it still steps.
    expect(actionForKey('ArrowRight', { shift: true })).toEqual({ type: 'stepForward' })
  })
})

describe('playback transport — readout (M4-T1)', () => {
  it('formats durations by scale', () => {
    expect(formatDuration(0)).toBe('0.0s')
    expect(formatDuration(-100)).toBe('0.0s')
    expect(formatDuration(Number.NaN)).toBe('0.0s')
    expect(formatDuration(1_234)).toBe('1.2s')
    expect(formatDuration(1_500)).toBe('1.5s')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(60_000)).toBe('1:00')
    expect(formatDuration(245_000)).toBe('4:05')
    expect(formatDuration(3_726_000)).toBe('1:02:06')
  })

  it('describes the run at the playhead', () => {
    const state = createPlayback(RUN, { elapsedMs: MINUTE })
    const readout = describePlayback(state)
    const frame = frameAt(state.timeline, MINUTE)
    expect(readout.elapsedMs).toBe(MINUTE)
    expect(readout.spanMs).toBe(4 * MINUTE)
    expect(readout.progress).toBe(0.25)
    expect(readout.firedCount).toBe(frame.firedCount)
    expect(readout.eventCount).toBe(RUN.events.length)
    expect(readout.activeAgentCount).toBe(frame.activeAgentIds.length)
    expect(readout.agentCount).toBe(RUN.meta.agentCount)
    expect(readout.elapsedLabel).toBe('1:00')
    expect(readout.spanLabel).toBe('4:00')
    expect(readout.speedLabel).toBe('1×')
    expect(readout.playing).toBe(false)
    expect(readout.atEnd).toBe(false)
  })

  it('labels a fractional speed and the finished state', () => {
    const state = run(stateOf(), { type: 'slower' }, { type: 'finish' })
    const readout = describePlayback(state)
    expect(readout.speedLabel).toBe('0.5×')
    expect(readout.atEnd).toBe(true)
    expect(readout.progress).toBe(1)
  })
})

describe('playback transport — scrubber geometry (M4-T1)', () => {
  it('marks every distinct event instant, positioned and counted', () => {
    const scrubber = buildScrubber(TIMELINE)
    expect(scrubber.stopCount).toBe(5)
    expect(scrubber.marks.map((mark) => mark.elapsedMs)).toEqual([
      0,
      MINUTE,
      2 * MINUTE,
      3 * MINUTE,
      4 * MINUTE,
    ])
    expect(scrubber.marks.map((mark) => mark.fraction)).toEqual([0, 0.25, 0.5, 0.75, 1])
    // 0: run_start + the first assign + its tool call; the middle instants carry
    // the message + its tool call; the end adds run_end.
    expect(scrubber.marks.map((mark) => mark.eventCount)).toEqual([3, 2, 2, 2, 3])
    expect(scrubber.eventCount).toBe(RUN.events.length)
    expect(scrubber.spanMs).toBe(4 * MINUTE)
  })

  it('thins the marks deterministically and keeps the ends', () => {
    const scrubber = buildScrubber(TIMELINE, { maxMarks: 3 })
    expect(scrubber.stopCount).toBe(5)
    expect(scrubber.marks.map((mark) => mark.elapsedMs)).toEqual([
      0,
      2 * MINUTE,
      4 * MINUTE,
    ])
    // Deterministic: the same run always yields the same marks.
    expect(buildScrubber(TIMELINE, { maxMarks: 3 })).toEqual(scrubber)
  })

  it('never draws more marks than the cap, even on a long run', () => {
    const scrubber = buildScrubber(TIMELINE, { maxMarks: 2 })
    expect(scrubber.marks).toHaveLength(2)
    expect(DEFAULT_MAX_SCRUB_MARKS).toBeGreaterThan(2)
  })

  it('builds an event-density histogram normalized to its peak', () => {
    const scrubber = buildScrubber(TIMELINE, { buckets: 48 })
    expect(scrubber.buckets).toHaveLength(48)
    expect(scrubber.bucketCount).toBe(48)
    expect(Math.max(...scrubber.buckets)).toBe(1)
    // The opening instant lands in bucket 0; the middle ones at a quarter steps.
    expect(scrubber.buckets[0]).toBe(1)
    expect(scrubber.buckets[12]).toBeCloseTo(2 / 3, 10)
    expect(scrubber.buckets[24]).toBeCloseTo(2 / 3, 10)
    // Every event is accounted for: the histogram is a partition, not a sample.
    const peak = 3
    const counted = scrubber.buckets.reduce((sum, value) => sum + value * peak, 0)
    expect(counted).toBe(RUN.events.length)
  })

  it('is well-formed for an empty run', () => {
    const empty = buildTimeline(parseAgentMessagesExport([]))
    const scrubber = buildScrubber(empty, { buckets: 4 })
    expect(scrubber.stopCount).toBe(0)
    expect(scrubber.marks).toEqual([])
    expect(scrubber.eventCount).toBe(0)
    expect(scrubber.buckets).toEqual([0, 0, 0, 0])
  })

  it('handles a zero-span run without inventing a time axis', () => {
    // Two messages at the exact same instant through the real ingest path: a
    // run whose whole life is one point in time.
    const at = '2026-10-01T09:00:00.000Z'
    const instant = buildTimeline(
      parseAgentMessagesExport([
        {
          id: 1,
          from_agent: 'alpha',
          to_agent: 'beta',
          subject: 'ping',
          body: null,
          status: 'unread',
          created_at: at,
        },
        {
          id: 2,
          from_agent: 'beta',
          to_agent: 'alpha',
          subject: 'pong',
          body: null,
          status: 'unread',
          created_at: at,
        },
      ]),
    )
    expect(instant.spanMs).toBe(0)

    const scrubber = buildScrubber(instant, { buckets: 4 })
    expect(scrubber.marks).toHaveLength(1)
    expect(scrubber.marks[0]).toEqual({
      elapsedMs: 0,
      fraction: 0,
      eventCount: instant.events.length,
    })
    expect(scrubber.buckets).toEqual([1, 0, 0, 0])
  })
})

// ── purity guard ────────────────────────────────────────────────────────────

/** Walk up from cwd until the package manifest is found. */
function findRepoRoot(start: string): string {
  let dir = start
  for (;;) {
    if (existsSync(resolve(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('package.json not found above cwd')
    dir = parent
  }
}

describe('playback transport — purity (M4-T1)', () => {
  it('reads no clock and no randomness', () => {
    const root = findRepoRoot(process.cwd())
    const source = readFileSync(resolve(root, 'src/playback/playback.ts'), 'utf8')
    // Comments are stripped first: the module's own doc names these functions.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/Date\.now\s*\(/)
    expect(code).not.toMatch(/performance\.now\s*\(/)
    expect(code).not.toMatch(/Math\.random\s*\(/)
    // No React and no three.js in the pure half.
    expect(code).not.toMatch(/from 'react'/)
    expect(code).not.toMatch(/from 'three'/)
  })
})
