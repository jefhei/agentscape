import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import { FIXTURES, buildFixture } from '../fixtures/index.ts'
import {
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
} from './index.ts'
import type { PlaybackSpeed, Playhead, Timeline, TimelineFrame } from './index.ts'

/**
 * Timeline / playhead model tests (M1-T7).
 *
 * The timeline model is the pure playback seam (PRD §5): it answers "what time
 * is it, what has fired, which agents are live, what is the next event?" so the
 * render layer can drive the *spatial* scene over time without owning any of
 * the arithmetic. These tests gate it hard, because M4-T1's scrubber and every
 * playback control build directly on it:
 *
 *  1. **Shape** — the timeline exposes the canonical events, the distinct event
 *     times ("stops") and the run's span, derived from a normalized model.
 *  2. **Frames** — `frameAt` is a clamped, monotonic, deterministic function of
 *     the playhead position: what has fired, the progress through the run, and
 *     which agents are active (senders *and* recipients).
 *  3. **Playback** — play/pause/speed/seek/step/advance are pure state
 *     transitions over the playhead value.
 *  4. **Determinism & purity** — no clock, no randomness, no mutation; the same
 *     inputs always yield a byte-identical timeline / frame / playhead.
 *
 * No visuals are asserted — jsdom has no GPU and the look is human-held
 * (M5-T5). Only the pure half is gated.
 */

/** The handoff chain: agent_a → agent_b → agent_c → agent_d, one stop per minute. */
const handoff = buildFixture('handoff-chain').run

/** Fan-out: one orchestrator, five silent workers — six agents, five messages. */
const fanOut = buildFixture('fan-out').run

/** A run whose entire event stream sits at one instant (span 0). */
const instant: TraceModel = normalizeTrace(
  parseAgentMessagesExport([
    {
      id: 1,
      from_agent: 'solo',
      to_agent: 'peer',
      created_at: '2026-01-01T00:00:00.000Z',
      body: '{"action":"ping"}',
    },
  ]),
)

/** The adapter's empty run. */
const empty: TraceModel = normalizeTrace(parseAgentMessagesExport([]))

const allAgentsActive = (run: TraceModel) => [...run.agents.map((a) => a.id)]

// ── buildTimeline ─────────────────────────────────────────────────────────

describe('buildTimeline (M1-T7)', () => {
  it('returns a fully-formed Timeline (compile-checked)', () => {
    const timeline = buildTimeline(handoff)
    expectTypeOf(timeline).toEqualTypeOf<Timeline>()
    expect(timeline.events).toBe(handoff.events)
    expect(timeline.agentIds).toEqual(handoff.agents.map((agent) => agent.id))
    expect(timeline.startedAt).toBe(handoff.startedAt)
    expect(timeline.endedAt).toBe(handoff.endedAt)
    expect(timeline.spanMs).toBe(handoff.endedAt - handoff.startedAt)
  })

  it('collapses the event stream into distinct ascending stops', () => {
    const timeline = buildTimeline(handoff)
    // handoff-chain: a→b @0, b→c @1min, c→d @2min, bracketed by run_start/run_end.
    expect(timeline.stops).toEqual([
      handoff.startedAt,
      handoff.startedAt + 60_000,
      handoff.startedAt + 120_000,
    ])
    expect(timeline.stops[0]).toBe(timeline.startedAt)
    expect(timeline.stops[timeline.stops.length - 1]).toBe(timeline.endedAt)
  })

  it('places several same-instant events on a single stop', () => {
    // Every event of the instant run shares one timestamp.
    const timeline = buildTimeline(instant)
    expect(timeline.stops).toEqual([instant.startedAt])
    expect(timeline.events.length).toBeGreaterThan(1)
    expect(timeline.spanMs).toBe(0)
  })

  it('is deterministic — byte-identical across calls', () => {
    expect(JSON.stringify(buildTimeline(handoff))).toBe(
      JSON.stringify(buildTimeline(handoff)),
    )
  })

  it('builds a valid empty timeline for an empty run', () => {
    const timeline = buildTimeline(empty)
    expect(timeline.events).toEqual([])
    expect(timeline.stops).toEqual([])
    expect(timeline.agentIds).toEqual([])
    expect(timeline.spanMs).toBe(0)
  })

  it('does not mutate the model', () => {
    const before = JSON.stringify(handoff)
    buildTimeline(handoff)
    expect(JSON.stringify(handoff)).toBe(before)
  })

  it('produces ascending in-range stops for every fixture', () => {
    for (const { run } of FIXTURES) {
      const timeline = buildTimeline(run)
      expect(timeline.spanMs).toBe(run.endedAt - run.startedAt)
      expect(timeline.spanMs).toBeGreaterThanOrEqual(0)
      for (let i = 0; i < timeline.stops.length; i += 1) {
        const stop = timeline.stops[i]
        expect(stop).toBeGreaterThanOrEqual(timeline.startedAt)
        expect(stop).toBeLessThanOrEqual(timeline.endedAt)
        if (i > 0) expect(stop).toBeGreaterThan(timeline.stops[i - 1])
      }
    }
  })
})

// ── frameAt ───────────────────────────────────────────────────────────────

describe('frameAt (M1-T7)', () => {
  it('returns a fully-formed frame at the run start', () => {
    const timeline = buildTimeline(handoff)
    const frame = frameAt(timeline, 0)
    expectTypeOf(frame).toEqualTypeOf<TimelineFrame>()
    expect(frame.elapsedMs).toBe(0)
    expect(frame.timeMs).toBe(timeline.startedAt)
    expect(frame.progress).toBe(0)
    expect(frame.atEnd).toBe(false)
    // run_start + the first message (a→b) all sit at offset 0; the recipient
    // is live as soon as the message fires, not only once it replies.
    expect(frame.firedCount).toBeGreaterThan(1)
    expect(frame.activeAgentIds).toContain('a_agent_a')
    expect(frame.activeAgentIds).toContain('a_agent_b')
  })

  it('clamps a position before the start and past the end', () => {
    const timeline = buildTimeline(handoff)
    expect(frameAt(timeline, -5000)).toEqual(frameAt(timeline, 0))
    expect(frameAt(timeline, timeline.spanMs + 5000)).toEqual(
      frameAt(timeline, timeline.spanMs),
    )
  })

  it('reports progress linearly from 0 to 1 and flags the end', () => {
    const timeline = buildTimeline(handoff)
    expect(frameAt(timeline, 0).progress).toBe(0)
    expect(frameAt(timeline, timeline.spanMs / 2).progress).toBe(0.5)
    const end = frameAt(timeline, timeline.spanMs)
    expect(end.progress).toBe(1)
    expect(end.atEnd).toBe(true)
  })

  it('reveals events monotonically as time advances', () => {
    const timeline = buildTimeline(fanOut)
    let previousCount = -1
    let previousCursor = -2
    for (let elapsed = 0; elapsed <= timeline.spanMs; elapsed += 30_000) {
      const frame = frameAt(timeline, elapsed)
      expect(frame.firedCount).toBeGreaterThanOrEqual(previousCount)
      expect(frame.cursorIndex).toBeGreaterThanOrEqual(previousCursor)
      expect(frame.firedCount).toBe(frame.cursorIndex + 1)
      previousCount = frame.firedCount
      previousCursor = frame.cursorIndex
    }
  })

  it('grows the active-agent set as the fan-out unfolds', () => {
    const timeline = buildTimeline(fanOut)
    // At the first assign only the orchestrator and its first worker are live.
    expect(frameAt(timeline, 0).activeAgentIds).toEqual([
      'a_orchestrator',
      'a_worker_alpha',
    ])
    // Once every worker has been assigned, all six agents are active.
    expect(frameAt(timeline, timeline.spanMs).activeAgentIds).toEqual(
      allAgentsActive(fanOut),
    )
  })

  it('counts a silent recipient-only agent as active (dead branch)', () => {
    const dead = buildFixture('dead-branch').run
    const timeline = buildTimeline(dead)
    const frame = frameAt(timeline, timeline.spanMs)
    // worker_dead never sends anything and never calls a tool; it is live only
    // because it *received* its assignment.
    expect(frame.activeAgentIds).toContain('a_worker_dead')
    expect(frame.activeAgentIds).toEqual(allAgentsActive(dead))
  })

  it('handles a zero-span run as a single instant', () => {
    const timeline = buildTimeline(instant)
    const frame = frameAt(timeline, 0)
    expect(frame.firedCount).toBe(timeline.events.length)
    expect(frame.cursorIndex).toBe(timeline.events.length - 1)
    expect(frame.progress).toBe(1)
    expect(frame.atEnd).toBe(true)
    expect(frame.activeAgentIds).toEqual(allAgentsActive(instant))
  })

  it('handles an empty run without inventing facts', () => {
    const frame = frameAt(buildTimeline(empty), 0)
    expect(frame.cursorIndex).toBe(-1)
    expect(frame.firedCount).toBe(0)
    expect(frame.activeAgentIds).toEqual([])
    expect(frame.progress).toBe(0)
    expect(frame.atEnd).toBe(true)
  })

  it('is deterministic and does not mutate the timeline', () => {
    const timeline = buildTimeline(fanOut)
    const before = JSON.stringify(timeline)
    expect(JSON.stringify(frameAt(timeline, 90_000))).toBe(
      JSON.stringify(frameAt(timeline, 90_000)),
    )
    expect(JSON.stringify(timeline)).toBe(before)
  })
})

// ── createPlayhead ────────────────────────────────────────────────────────

describe('createPlayhead (M1-T7)', () => {
  it('starts at the run start, paused, at real-time speed', () => {
    const playhead = createPlayhead(buildTimeline(handoff))
    expectTypeOf(playhead).toEqualTypeOf<Playhead>()
    expect(playhead).toEqual({ elapsedMs: 0, speed: DEFAULT_SPEED, playing: false })
    expect(DEFAULT_SPEED).toBe(1)
  })

  it('clamps an initial position into the run', () => {
    const timeline = buildTimeline(handoff)
    expect(createPlayhead(timeline, { elapsedMs: -1 }).elapsedMs).toBe(0)
    expect(createPlayhead(timeline, { elapsedMs: 1e9 }).elapsedMs).toBe(timeline.spanMs)
  })

  it('honours explicit options', () => {
    const playhead = createPlayhead(buildTimeline(handoff), {
      elapsedMs: 30_000,
      speed: 2,
      playing: true,
    })
    expect(playhead).toEqual({ elapsedMs: 30_000, speed: 2, playing: true })
  })
})

// ── playhead controls ─────────────────────────────────────────────────────

describe('playhead controls (M1-T7)', () => {
  const base = createPlayhead(buildTimeline(handoff))

  it('sets play / pause, returning the same value when unchanged', () => {
    const paused = setPlaying(base, false)
    expect(paused).toBe(base)
    const playing = setPlaying(base, true)
    expect(playing.playing).toBe(true)
    expect(base.playing).toBe(false)
  })

  it('toggles play ⇄ pause', () => {
    expect(togglePlay(base).playing).toBe(true)
    expect(togglePlay(togglePlay(base)).playing).toBe(false)
  })

  it('sets the speed purely', () => {
    expect(setSpeed(base, 1)).toBe(base)
    const fast = setSpeed(base, 4)
    expect(fast.speed).toBe(4)
    expect(base.speed).toBe(1)
  })

  it('cycles through the speed presets both ways, wrapping', () => {
    let playhead = createPlayhead(buildTimeline(handoff), { speed: 1 })
    const up: PlaybackSpeed[] = []
    for (let i = 0; i < PLAYBACK_SPEEDS.length; i += 1) {
      playhead = cycleSpeed(playhead, 1)
      up.push(playhead.speed)
    }
    expect(up).toEqual([2, 4, 0.25, 0.5, 1])

    const down: PlaybackSpeed[] = []
    for (let i = 0; i < PLAYBACK_SPEEDS.length; i += 1) {
      playhead = cycleSpeed(playhead, -1)
      down.push(playhead.speed)
    }
    expect(down).toEqual([0.5, 0.25, 4, 2, 1])
  })

  it('does not mutate the playhead it is given', () => {
    const before = JSON.stringify(base)
    setPlaying(base, true)
    setSpeed(base, 4)
    cycleSpeed(base, 1)
    expect(JSON.stringify(base)).toBe(before)
  })
})

// ── seek + step ───────────────────────────────────────────────────────────

describe('seek and step (M1-T7)', () => {
  it('seeks within the run, clamping and staying pure', () => {
    const timeline = buildTimeline(handoff)
    const playhead = createPlayhead(timeline)
    expect(seek(playhead, timeline, -100).elapsedMs).toBe(0)
    expect(seek(playhead, timeline, 1e9).elapsedMs).toBe(timeline.spanMs)
    expect(seek(playhead, timeline, 0)).toBe(playhead)
    expect(seek(playhead, timeline, 30_000).elapsedMs).toBe(30_000)
    expect(playhead.elapsedMs).toBe(0)
  })

  it('steps forward to each subsequent stop and stops at the last', () => {
    const timeline = buildTimeline(handoff)
    let playhead = createPlayhead(timeline)
    const visited: number[] = []
    for (;;) {
      const next = stepForward(playhead, timeline)
      if (next === playhead) break
      playhead = next
      visited.push(playhead.elapsedMs)
    }
    expect(visited).toEqual([60_000, 120_000])
  })

  it('steps backward to the previous stop, snapping to the start', () => {
    const timeline = buildTimeline(handoff)
    const atEnd = createPlayhead(timeline, { elapsedMs: timeline.spanMs })
    expect(stepBackward(atEnd, timeline).elapsedMs).toBe(60_000)
    expect(stepBackward(createPlayhead(timeline), timeline).elapsedMs).toBe(0)
  })

  it('steps between stops from an in-between position', () => {
    const timeline = buildTimeline(handoff)
    const between = createPlayhead(timeline, { elapsedMs: 30_000 })
    expect(stepForward(between, timeline).elapsedMs).toBe(60_000)
    expect(stepBackward(between, timeline).elapsedMs).toBe(0)
  })

  it('preserves speed and playing state while stepping', () => {
    const timeline = buildTimeline(handoff)
    const playhead = createPlayhead(timeline, { speed: 4, playing: true })
    const stepped = stepForward(playhead, timeline)
    expect(stepped.speed).toBe(4)
    expect(stepped.playing).toBe(true)
  })

  it('walking forward from the start visits every stop for every fixture', () => {
    for (const { run } of FIXTURES) {
      const timeline = buildTimeline(run)
      const expected = timeline.stops.map((stop) => stop - timeline.startedAt).slice(1)
      let playhead = createPlayhead(timeline)
      const visited: number[] = []
      for (;;) {
        const next = stepForward(playhead, timeline)
        if (next === playhead) break
        playhead = next
        visited.push(playhead.elapsedMs)
      }
      expect(visited).toEqual(expected)
    }
  })
})

// ── advance ───────────────────────────────────────────────────────────────

describe('advance (M1-T7)', () => {
  const timeline = buildTimeline(handoff)

  it('is a no-op when paused or given a non-positive delta', () => {
    const paused = createPlayhead(timeline)
    expect(advance(paused, timeline, 1000)).toBe(paused)
    const playing = createPlayhead(timeline, { playing: true })
    expect(advance(playing, timeline, 0)).toBe(playing)
    expect(advance(playing, timeline, -50)).toBe(playing)
  })

  it('moves by the real delta scaled by speed', () => {
    const at1x = createPlayhead(timeline, { playing: true })
    expect(advance(at1x, timeline, 1000).elapsedMs).toBe(1000)

    const at2x = createPlayhead(timeline, { playing: true, speed: 2 })
    expect(advance(at2x, timeline, 1000).elapsedMs).toBe(2000)
  })

  it('clamps at the end and auto-pauses there', () => {
    const nearEnd = createPlayhead(timeline, {
      elapsedMs: timeline.spanMs - 1000,
      playing: true,
    })
    const done = advance(nearEnd, timeline, 10_000)
    expect(done.elapsedMs).toBe(timeline.spanMs)
    expect(done.playing).toBe(false)
  })

  it('keeps playing when the delta does not reach the end', () => {
    const playing = createPlayhead(timeline, { playing: true })
    const next = advance(playing, timeline, 1000)
    expect(next.playing).toBe(true)
    expect(next.elapsedMs).toBe(1000)
  })

  it('is deterministic', () => {
    const playhead = createPlayhead(timeline, { playing: true, speed: 4 })
    expect(JSON.stringify(advance(playhead, timeline, 3000))).toBe(
      JSON.stringify(advance(playhead, timeline, 3000)),
    )
  })
})

// ── purity guard ──────────────────────────────────────────────────────────

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

describe('timeline model — purity (M1-T7)', () => {
  it('reads no clock and no randomness (pure module source)', () => {
    const source = readFileSync(
      resolve(findRepoRoot(process.cwd()), 'src/timeline/timeline.ts'),
      'utf8',
    )
      // Drop comments so the module's own doc ("never reads Date.now …") does
      // not trip the scan — only real call sites matter.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')

    expect(source).not.toMatch(/\bDate\.now\s*\(/)
    expect(source).not.toMatch(/\bperformance\.now\s*\(/)
    expect(source).not.toMatch(/\bMath\.random\s*\(/)
  })
})
