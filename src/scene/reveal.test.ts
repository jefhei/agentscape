import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import { buildFixture, FIXTURE_SHAPES } from '../fixtures/index.ts'
import { buildScenePlan } from './scenePlan.ts'
import {
  ARC_LIVE_FLOOR,
  DORMANT_ARC_INTENSITY,
  DORMANT_NODE_GLOW,
  RevealError,
  buildRevealTrack,
  revealAt,
} from './reveal.ts'

/**
 * The reveal (M4-T1) is the pure join between the playhead and the composed
 * scene: *how lit is each element at time t*. These tests pin the rules — what
 * is dormant, what ramps with revealed volume, what only appears once its event
 * fires — and the invariants a scrubber relies on (monotone in time, clamped,
 * deterministic, aligned with the plan it indexes).
 *
 * Nothing here asserts the rendered look (jsdom has no GPU; M5-T5 holds that).
 * What it does assert is that the numbers the render layer multiplies by are the
 * run's own facts.
 */

const MINUTE = 60_000
const FAN_OUT = buildFixture('fan-out').run
const LOOP = buildFixture('loop').run

describe('reveal — the track (M4-T1)', () => {
  it('aligns one entry per drawn element, in the plan’s own order', () => {
    for (const shape of FIXTURE_SHAPES) {
      const plan = buildScenePlan(buildFixture(shape).run)
      const track = buildRevealTrack(plan)
      expect(track.runId, shape).toBe(plan.runId)
      expect(track.nodes, shape).toHaveLength(plan.nodes.count)
      expect(track.arcs, shape).toHaveLength(plan.arcs.count)
      expect(track.glyphs, shape).toHaveLength(plan.glyphs.count)
      expect(
        track.nodes.map((node) => node.agentId),
        shape,
      ).toEqual(plan.nodes.instances.map((instance) => instance.agentId))
      expect(
        track.arcs.map((arc) => `${arc.source}>${arc.target}`),
        shape,
      ).toEqual(plan.arcs.arcs.map((arc) => `${arc.source}>${arc.target}`))
      expect(
        track.glyphs.map((glyph) => glyph.toolCallId),
        shape,
      ).toEqual(plan.glyphs.glyphs.map((glyph) => glyph.toolCallId))
    }
  })

  it('re-derives each arc’s messages and agrees with the arc plan’s volume', () => {
    for (const shape of FIXTURE_SHAPES) {
      const plan = buildScenePlan(buildFixture(shape).run)
      const track = buildRevealTrack(plan)
      for (let index = 0; index < track.arcs.length; index += 1) {
        const arc = track.arcs[index]
        expect(arc.times, shape).toHaveLength(plan.arcs.arcs[index].volume)
        // Ascending, so `revealAt` can binary-search it.
        const sorted = [...arc.times].sort((a, b) => a - b)
        expect(arc.times, shape).toEqual(sorted)
      }
    }
  })

  it('carries the run’s own time bounds', () => {
    const track = buildRevealTrack(buildScenePlan(LOOP))
    expect(track.startedAt).toBe(LOOP.startedAt)
    expect(track.endedAt).toBe(LOOP.endedAt)
    expect(track.spanMs).toBe(LOOP.endedAt - LOOP.startedAt)
    expect(track.eventCount).toBe(LOOP.events.length)
  })

  it('credits a broadcast to every link its sender is part of', () => {
    // A broadcast reaches every other agent, exactly as the layout's adjacency
    // counts it — so both of the sender's arcs carry that message.
    const run = parseAgentMessagesExport([
      {
        id: 1,
        from_agent: 'orchestrator',
        to_agent: null,
        subject: 'all hands',
        body: JSON.stringify({ action: 'kickoff' }),
        status: 'unread',
        created_at: '2026-10-01T09:00:00.000Z',
      },
      {
        id: 2,
        from_agent: 'worker_a',
        to_agent: 'orchestrator',
        subject: 'ack',
        body: null,
        status: 'unread',
        created_at: '2026-10-01T09:01:00.000Z',
      },
      {
        id: 3,
        from_agent: 'worker_b',
        to_agent: 'orchestrator',
        subject: 'ack',
        body: null,
        status: 'unread',
        created_at: '2026-10-01T09:02:00.000Z',
      },
    ])
    const plan = buildScenePlan(run)
    const track = buildRevealTrack(plan)
    expect(track.arcs).toHaveLength(2)
    for (const arc of track.arcs) {
      expect(arc.times).toContain(run.startedAt)
    }
    // At the broadcast instant every link has traffic; the workers' replies come
    // later, so the links keep filling independently.
    const atStart = revealAt(track, 0)
    expect(atStart.counts.firedArcs).toBe(2)
    expect(atStart.arcs.map((arc) => arc.fired)).toEqual([1, 1])
    const later = revealAt(track, MINUTE + 1)
    expect(later.arcs.map((arc) => arc.fired)).toEqual([2, 1])
  })

  it('fails loudly when the plan and the run disagree about a link', () => {
    const plan = buildScenePlan(FAN_OUT)
    const tampered = {
      ...plan,
      arcs: {
        ...plan.arcs,
        arcs: plan.arcs.arcs.map((arc, index) =>
          index === 0 ? { ...arc, volume: arc.volume + 3 } : arc,
        ),
      },
    }
    expect(() => buildRevealTrack(tampered)).toThrow(RevealError)
    expect(() => buildRevealTrack(tampered)).toThrow(/claims/)
  })

  it('is deterministic byte for byte', () => {
    const plan = buildScenePlan(LOOP)
    expect(JSON.stringify(buildRevealTrack(plan))).toBe(
      JSON.stringify(buildRevealTrack(plan)),
    )
  })

  it('does not mutate the plan or the run', () => {
    const plan = buildScenePlan(FAN_OUT)
    const before = JSON.stringify(buildScenePlan(FAN_OUT))
    buildRevealTrack(plan)
    expect(JSON.stringify(plan)).toBe(before)
  })
})

describe('reveal — at a moment in time (M4-T1)', () => {
  const plan = buildScenePlan(FAN_OUT)
  const track = buildRevealTrack(plan)

  it('opens dormant: the cast is drawn, the wiring is faint, no glyphs yet', () => {
    const reveal = revealAt(track, 0)
    expect(reveal.elapsedMs).toBe(0)
    expect(reveal.timeMs).toBe(track.startedAt)
    expect(reveal.progress).toBe(0)
    // At 0 the orchestrator has sent to worker_alpha: those two are lit, the
    // other four are still dormant — the shape is there, the activity is not.
    const glow = new Map(reveal.nodes.map((node) => [node.agentId, node.glow]))
    expect(glow.get('a_orchestrator')).toBe(1)
    expect(glow.get('a_worker_alpha')).toBe(1)
    expect(glow.get('a_worker_beta')).toBe(DORMANT_NODE_GLOW)
    expect(glow.get('a_worker_epsilon')).toBe(DORMANT_NODE_GLOW)
    // Only the first link has traffic; a one-message link is fully revealed the
    // moment its single message fires, so the ramp is complete immediately.
    expect(reveal.counts.firedArcs).toBe(1)
    const fired = reveal.arcs.filter((arc) => arc.fired > 0)
    expect(fired).toHaveLength(1)
    expect(fired[0].volume).toBe(1)
    expect(fired[0].intensity).toBe(1)
    // The first tool call fires at the same instant as the first message.
    expect(reveal.counts.visibleGlyphs).toBe(1)
  })

  it('ends fully lit: every agent glowing, every channel at full intensity, every glyph drawn', () => {
    const reveal = revealAt(track, track.spanMs)
    expect(reveal.progress).toBe(1)
    expect(reveal.nodes.every((node) => node.glow === 1)).toBe(true)
    expect(reveal.arcs.every((arc) => arc.intensity === 1)).toBe(true)
    expect(reveal.arcs.every((arc) => arc.reveal === 1)).toBe(true)
    expect(reveal.glyphs.every((glyph) => glyph.visible)).toBe(true)
    expect(reveal.counts.activeAgents).toBe(plan.counts.nodes)
    expect(reveal.counts.firedArcs).toBe(plan.counts.arcs)
    expect(reveal.counts.visibleGlyphs).toBe(plan.counts.glyphs)
  })

  it('reveals monotonically as the run plays', () => {
    let active = 0
    let arcs = 0
    let glyphs = 0
    for (let elapsed = 0; elapsed <= track.spanMs; elapsed += MINUTE / 4) {
      const reveal = revealAt(track, elapsed)
      expect(reveal.counts.activeAgents).toBeGreaterThanOrEqual(active)
      expect(reveal.counts.firedArcs).toBeGreaterThanOrEqual(arcs)
      expect(reveal.counts.visibleGlyphs).toBeGreaterThanOrEqual(glyphs)
      active = reveal.counts.activeAgents
      arcs = reveal.counts.firedArcs
      glyphs = reveal.counts.visibleGlyphs
    }
    expect(active).toBe(plan.counts.nodes)
  })

  it('ramps an arc with the fraction of its messages that have fired', () => {
    // The loop fixture: researcher ⇄ critic carries six messages, one per minute
    // from t=1min. Halfway through the link (three fired) it reads half revealed.
    const loopPlan = buildScenePlan(LOOP)
    const loopTrack = buildRevealTrack(loopPlan)
    const index = loopTrack.arcs.findIndex((arc) => arc.volume === 6)
    expect(index).toBeGreaterThanOrEqual(0)

    const half = revealAt(loopTrack, 3 * MINUTE)
    expect(half.arcs[index].fired).toBe(3)
    expect(half.arcs[index].volume).toBe(6)
    expect(half.arcs[index].reveal).toBe(0.5)
    expect(half.arcs[index].intensity).toBeCloseTo(
      ARC_LIVE_FLOOR + (1 - ARC_LIVE_FLOOR) * 0.5,
      10,
    )

    const start = revealAt(loopTrack, 0)
    expect(start.arcs[index].fired).toBe(0)
    expect(start.arcs[index].intensity).toBe(DORMANT_ARC_INTENSITY)
  })

  it('clamps a scrub outside the run to the run’s own ends', () => {
    expect(revealAt(track, -10_000)).toEqual(revealAt(track, 0))
    expect(revealAt(track, track.spanMs + 10_000)).toEqual(
      revealAt(track, track.spanMs),
    )
    expect(Number.isNaN(revealAt(track, Number.NaN).progress)).toBe(false)
  })

  it('is byte-identical for the same instant, however many times it is asked', () => {
    const a = revealAt(track, 2 * MINUTE)
    const b = revealAt(track, 2 * MINUTE)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('reveal — degenerate runs (M4-T1)', () => {
  it('is well-formed for an empty run', () => {
    const plan = buildScenePlan(parseAgentMessagesExport([]))
    const track = buildRevealTrack(plan)
    const reveal = revealAt(track, 0)
    expect(reveal.nodes).toEqual([])
    expect(reveal.arcs).toEqual([])
    expect(reveal.glyphs).toEqual([])
    expect(reveal.progress).toBe(0)
    expect(reveal.counts).toEqual({ activeAgents: 0, firedArcs: 0, visibleGlyphs: 0 })
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

describe('reveal — purity (M4-T1)', () => {
  it('reads no clock, no randomness, no renderer', () => {
    const root = findRepoRoot(process.cwd())
    const source = readFileSync(resolve(root, 'src/scene/reveal.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/Date\.now\s*\(/)
    expect(code).not.toMatch(/performance\.now\s*\(/)
    expect(code).not.toMatch(/Math\.random\s*\(/)
    expect(code).not.toMatch(/from 'three'/)
    expect(code).not.toMatch(/from 'react'/)
  })
})
