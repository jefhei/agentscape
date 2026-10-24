import { describe, expect, it } from 'vitest'
import type { AgentMessageRow } from '../adapter/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import { buildFixture, FIXTURE_SHAPES } from '../fixtures/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import { buildScenePlan } from '../scene/scenePlan.ts'
import {
  DORMANT_ARC_INTENSITY,
  DORMANT_NODE_GLOW,
  buildRevealTrack,
  revealAt,
} from '../scene/reveal.ts'
import type { RevealTrack } from '../scene/reveal.ts'
import { FILTER_KINDS, IDENTITY_FILTER, buildFilterView } from './filter.ts'
import type { FilterState } from './filter.ts'
import { HIDDEN_GLYPH_AT, FilterError, filterRevealTrack } from './filterTrack.ts'

/**
 * Filtering the reveal (M4-T5) is the join between "what matches" (`filter.ts`) and
 * "how lit is each element" (`src/scene/reveal.ts`). These tests pin the two things
 * that make it safe:
 *
 * 1. **The identity filter is a no-op, byte for byte.** A narrowed track must be
 *    the *same* track when nothing is filtered — otherwise the lens would silently
 *    change the scene a viewer sees with every control untouched.
 * 2. **Narrowing is narrowing.** A filtered element reads as the reveal's own
 *    dormant state (dim node, faint arc, absent glyph), never as a second
 *    brightness model — and the run's time bounds are carried through untouched, so
 *    the transport keeps scubbing the whole run.
 *
 * Nothing here asserts the rendered look (jsdom has no GPU; M5-T5 holds that).
 */

const MINUTE = 60_000
const FAN_OUT = buildFixture('fan-out').run
const DEAD_BRANCH = buildFixture('dead-branch').run
const LOOP = buildFixture('loop').run

function filterOf(partial: Partial<FilterState>): FilterState {
  return {
    agentIds: partial.agentIds ?? [],
    kinds: partial.kinds ?? FILTER_KINDS,
    window: partial.window ?? null,
  }
}

/** The scene plan + reveal track for a run (the pairing the app builds). */
function trackOf(model: TraceModel): RevealTrack {
  return buildRevealTrack(buildScenePlan(model))
}

function runOf(rows: AgentMessageRow[]): TraceModel {
  return normalizeTrace(parseAgentMessagesExport(rows))
}

describe('filterTrack — the identity filter is a no-op (M4-T5)', () => {
  it('reproduces the unfiltered track exactly, for every fixture', () => {
    for (const shape of FIXTURE_SHAPES) {
      const model = buildFixture(shape).run
      const track = trackOf(model)
      expect(filterRevealTrack(track, model, IDENTITY_FILTER), shape).toEqual(track)
    }
  })

  it('keeps one entry per drawn element, in the plan’s own order', () => {
    for (const shape of FIXTURE_SHAPES) {
      const model = buildFixture(shape).run
      const plan = buildScenePlan(model)
      const track = buildRevealTrack(plan)
      const filtered = filterRevealTrack(track, model, IDENTITY_FILTER)
      expect(
        filtered.nodes.map((node) => node.agentId),
        shape,
      ).toEqual(plan.nodes.instances.map((instance) => instance.agentId))
      expect(
        filtered.arcs.map((arc) => `${arc.source}>${arc.target}`),
        shape,
      ).toEqual(plan.arcs.arcs.map((arc) => `${arc.source}>${arc.target}`))
      expect(
        filtered.glyphs.map((glyph) => glyph.toolCallId),
        shape,
      ).toEqual(plan.glyphs.glyphs.map((glyph) => glyph.toolCallId))
    }
  })

  it('carries the run’s identity and time bounds through untouched', () => {
    const track = trackOf(LOOP)
    const filtered = filterRevealTrack(
      track,
      LOOP,
      filterOf({ window: { startMs: MINUTE, endMs: 2 * MINUTE } }),
    )
    expect(filtered.runId).toBe(track.runId)
    expect(filtered.startedAt).toBe(track.startedAt)
    expect(filtered.endedAt).toBe(track.endedAt)
    expect(filtered.spanMs).toBe(track.spanMs)
    expect(filtered.eventCount).toBe(track.eventCount)
  })
})

describe('filterTrack — by agent', () => {
  it('lights the selected agent and its counterpart, and dims the rest', () => {
    const track = trackOf(FAN_OUT)
    const filtered = filterRevealTrack(
      track,
      FAN_OUT,
      filterOf({ agentIds: ['a_worker_alpha'] }),
    )
    const firstByAgent = new Map(
      filtered.nodes.map((node) => [node.agentId, node.firstAt]),
    )
    expect(firstByAgent.get('a_orchestrator')).toBe(FAN_OUT.startedAt)
    expect(firstByAgent.get('a_worker_alpha')).toBe(FAN_OUT.startedAt)
    for (const id of [
      'a_worker_beta',
      'a_worker_gamma',
      'a_worker_delta',
      'a_worker_epsilon',
    ]) {
      expect(firstByAgent.get(id), id).toBeNull()
    }
  })

  it('narrows the arcs to the selected agent’s own links', () => {
    const filtered = filterRevealTrack(
      trackOf(FAN_OUT),
      FAN_OUT,
      filterOf({ agentIds: ['a_worker_alpha'] }),
    )
    const lit = filtered.arcs.filter((arc) => arc.volume > 0)
    expect(lit).toHaveLength(1)
    expect(lit[0].source).toBe('a_orchestrator')
    expect(lit[0].target).toBe('a_worker_alpha')
    expect(lit[0].times).toEqual([FAN_OUT.startedAt])
    // The other links keep their entries (structure persists) with no traffic.
    expect(filtered.arcs).toHaveLength(5)
    expect(filtered.arcs.filter((arc) => arc.volume === 0)).toHaveLength(4)
  })

  it('hides the glyphs of agents outside the lens', () => {
    // Fan-out's calls all belong to the orchestrator, so a lens on a worker has
    // no tool-call activity at all.
    const filtered = filterRevealTrack(
      trackOf(FAN_OUT),
      FAN_OUT,
      filterOf({ agentIds: ['a_worker_alpha'] }),
    )
    for (const glyph of filtered.glyphs) {
      expect(glyph.at).toBe(HIDDEN_GLYPH_AT)
    }
    expect(
      revealAt(filtered, FAN_OUT.endedAt - FAN_OUT.startedAt).counts.visibleGlyphs,
    ).toBe(0)
  })

  it('keeps the calls of the selected agent', () => {
    const filtered = filterRevealTrack(
      trackOf(FAN_OUT),
      FAN_OUT,
      filterOf({ agentIds: ['a_orchestrator'] }),
    )
    const visible = filtered.glyphs.filter((glyph) => glyph.at !== HIDDEN_GLYPH_AT)
    expect(visible).toHaveLength(5)
    expect(visible.map((glyph) => glyph.at)).toEqual(
      FAN_OUT.toolCalls.map((call) => call.at),
    )
  })

  it('credits a broadcast to every link when a listener is selected', () => {
    const model = runOf([
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
    const filtered = filterRevealTrack(
      trackOf(model),
      model,
      filterOf({ agentIds: ['a_worker_a'] }),
    )
    // The broadcast is heard by worker_a, so its link carries it; worker_a's own
    // reply rides the same link, and the other worker's reply does not touch the
    // selection at all.
    expect(filtered.arcs).toHaveLength(2)
    const byTarget = new Map(filtered.arcs.map((arc) => [arc.target, arc]))
    expect(byTarget.get('a_worker_a')?.volume).toBe(2)
    expect(byTarget.get('a_worker_a')?.times).toEqual([
      model.startedAt,
      model.startedAt + MINUTE,
    ])
    expect(byTarget.get('a_worker_b')?.volume).toBe(1)
    expect(byTarget.get('a_worker_b')?.times).toEqual([model.startedAt])
  })
})

describe('filterTrack — by event type', () => {
  it('hides every glyph when only messages are kept', () => {
    const filtered = filterRevealTrack(
      trackOf(LOOP),
      LOOP,
      filterOf({ kinds: ['message'] }),
    )
    expect(filtered.glyphs.every((glyph) => glyph.at === HIDDEN_GLYPH_AT)).toBe(true)
    // Structure is untouched: the nodes and arcs keep all their traffic.
    expect(filtered.nodes.every((node) => node.firstAt !== null)).toBe(true)
    expect(filtered.arcs.map((arc) => arc.volume)).toEqual([6, 1])
  })

  it('keeps the glyphs when only tool calls are kept', () => {
    const filtered = filterRevealTrack(
      trackOf(LOOP),
      LOOP,
      filterOf({ kinds: ['tool_call'] }),
    )
    expect(filtered.glyphs.every((glyph) => glyph.at !== HIDDEN_GLYPH_AT)).toBe(true)
    // Tool calls are derived from messages, so the nodes are still lit by them.
    expect(filtered.nodes.every((node) => node.firstAt !== null)).toBe(true)
    // ...but no arc has message traffic to show.
    expect(filtered.arcs.every((arc) => arc.volume === 0)).toBe(true)
  })

  it('dims everything when no kind is kept', () => {
    const filtered = filterRevealTrack(
      trackOf(FAN_OUT),
      FAN_OUT,
      filterOf({ kinds: [] }),
    )
    expect(filtered.nodes.every((node) => node.firstAt === null)).toBe(true)
    expect(filtered.arcs.every((arc) => arc.volume === 0)).toBe(true)
    expect(filtered.glyphs.every((glyph) => glyph.at === HIDDEN_GLYPH_AT)).toBe(true)
    const reveal = revealAt(filtered, FAN_OUT.endedAt - FAN_OUT.startedAt)
    expect(reveal.counts).toEqual({ activeAgents: 0, firedArcs: 0, visibleGlyphs: 0 })
    expect(reveal.nodes.every((node) => node.glow === DORMANT_NODE_GLOW)).toBe(true)
    expect(reveal.arcs.every((arc) => arc.intensity === DORMANT_ARC_INTENSITY)).toBe(
      true,
    )
  })
})

describe('filterTrack — by time window', () => {
  it('keeps only the messages inside the window on each link', () => {
    const filtered = filterRevealTrack(
      trackOf(FAN_OUT),
      FAN_OUT,
      filterOf({ window: { startMs: MINUTE, endMs: 2 * MINUTE } }),
    )
    const lit = filtered.arcs.filter((arc) => arc.volume > 0)
    expect(lit).toHaveLength(2)
    expect(lit.map((arc) => arc.times[0]).sort((a, b) => a - b)).toEqual([
      FAN_OUT.startedAt + MINUTE,
      FAN_OUT.startedAt + 2 * MINUTE,
    ])
    for (const arc of lit) {
      expect(arc.times).not.toContain(FAN_OUT.startedAt)
    }
    expect(
      filtered.glyphs.filter((glyph) => glyph.at !== HIDDEN_GLYPH_AT),
    ).toHaveLength(2)
  })

  it('moves an agent’s first appearance to its first in-window event', () => {
    const filtered = filterRevealTrack(
      trackOf(FAN_OUT),
      FAN_OUT,
      filterOf({ window: { startMs: 3 * MINUTE, endMs: 4 * MINUTE } }),
    )
    const orchestrator = filtered.nodes.find(
      (node) => node.agentId === 'a_orchestrator',
    )
    const delta = filtered.nodes.find((node) => node.agentId === 'a_worker_delta')
    expect(orchestrator?.firstAt).toBe(FAN_OUT.startedAt + 3 * MINUTE)
    expect(delta?.firstAt).toBe(FAN_OUT.startedAt + 3 * MINUTE)
    // An agent with nothing in the window is dormant at its settled position.
    const alpha = filtered.nodes.find((node) => node.agentId === 'a_worker_alpha')
    expect(alpha?.firstAt).toBeNull()
  })

  it('leaves a link outside the window faint', () => {
    const filtered = filterRevealTrack(
      trackOf(DEAD_BRANCH),
      DEAD_BRANCH,
      filterOf({ window: { startMs: MINUTE, endMs: 2 * MINUTE } }),
    )
    const reveal = revealAt(filtered, 2 * MINUTE)
    // worker_ok's reply and the dead worker's assignment are inside the window;
    // the opening assignment to worker_ok is not.
    expect(reveal.counts.firedArcs).toBe(2)
    const okLink = reveal.arcs.find((arc) => arc.target === 'a_worker_ok')
    expect(okLink?.volume).toBe(1)
    expect(okLink?.fired).toBe(1)
  })
})

describe('filterTrack — composition with the reveal (M4-T5)', () => {
  it('reveals exactly the events the filter view counts', () => {
    for (const shape of FIXTURE_SHAPES) {
      const model = buildFixture(shape).run
      const track = trackOf(model)
      const filter = filterOf({
        agentIds: [model.agents[0].id],
        window: { startMs: 0, endMs: model.endedAt - model.startedAt },
      })
      const view = buildFilterView(model, filter)
      const reveal = revealAt(
        filterRevealTrack(track, model, filter),
        model.endedAt - model.startedAt,
      )
      expect(reveal.counts.visibleGlyphs, shape).toBe(view.toolCalls.kept)
      expect(reveal.counts.activeAgents, shape).toBe(view.agents.kept)
    }
  })

  it('is monotone in time under a filter, like the unfiltered reveal', () => {
    const filtered = filterRevealTrack(
      trackOf(LOOP),
      LOOP,
      filterOf({ agentIds: ['a_critic'] }),
    )
    let previous = -1
    for (let step = 0; step <= 12; step += 1) {
      const revealed = revealAt(filtered, step * 30_000).counts.visibleGlyphs
      expect(revealed).toBeGreaterThanOrEqual(previous)
      previous = revealed
    }
  })

  it('does not rescale the transport: the span is the run’s', () => {
    const track = trackOf(FAN_OUT)
    const filtered = filterRevealTrack(
      track,
      FAN_OUT,
      filterOf({ window: { startMs: MINUTE, endMs: 2 * MINUTE } }),
    )
    const atEnd = revealAt(filtered, 10 * MINUTE)
    expect(atEnd.elapsedMs).toBe(track.spanMs)
    expect(atEnd.progress).toBe(1)
  })
})

describe('filterTrack — determinism and immutability', () => {
  it('is byte-identical for the same inputs', () => {
    const track = trackOf(LOOP)
    const filter = filterOf({ agentIds: ['a_researcher'], kinds: ['message'] })
    expect(filterRevealTrack(track, LOOP, filter)).toEqual(
      filterRevealTrack(track, LOOP, filter),
    )
  })

  it('is independent of the order the model’s arrays arrive in', () => {
    const track = trackOf(FAN_OUT)
    const shuffled: TraceModel = {
      ...FAN_OUT,
      agents: [...FAN_OUT.agents].reverse(),
      messages: [...FAN_OUT.messages].reverse(),
      toolCalls: [...FAN_OUT.toolCalls].reverse(),
    }
    const filter = filterOf({ window: { startMs: MINUTE, endMs: 3 * MINUTE } })
    expect(filterRevealTrack(track, shuffled, filter)).toEqual(
      filterRevealTrack(track, FAN_OUT, filter),
    )
  })

  it('mutates neither the track nor the model, and keeps times ascending', () => {
    const track = trackOf(LOOP)
    const before = JSON.stringify({ track, model: LOOP })
    const filtered = filterRevealTrack(track, LOOP, filterOf({ kinds: ['tool_call'] }))
    expect(JSON.stringify({ track, model: LOOP })).toBe(before)
    for (const arc of filtered.arcs) {
      expect(arc.times).toEqual([...arc.times].sort((a, b) => a - b))
    }
    // The kept-times arrays are fresh: mutating one cannot poison the track.
    const loopArc = track.arcs.find((arc) => arc.times.length > 1)
    expect(loopArc).toBeDefined()
    if (loopArc === undefined) return
    const copy = filtered.arcs.find(
      (arc) => arc.source === loopArc.source && arc.target === loopArc.target,
    )
    expect(copy?.times).not.toBe(loopArc.times)
  })
})

describe('filterTrack — it fails loudly when the inputs disagree', () => {
  it('refuses a track from another run', () => {
    const track = trackOf(LOOP)
    expect(() => filterRevealTrack(track, FAN_OUT, IDENTITY_FILTER)).toThrow(
      FilterError,
    )
  })

  it('refuses a node for an agent the run does not have', () => {
    const track = trackOf(FAN_OUT)
    const broken: RevealTrack = {
      ...track,
      nodes: [
        { agentId: 'a_ghost', firstAt: track.startedAt },
        ...track.nodes.slice(1),
      ],
    }
    expect(() => filterRevealTrack(broken, FAN_OUT, IDENTITY_FILTER)).toThrow(/a_ghost/)
  })

  it('refuses a glyph for a tool call the run does not have', () => {
    const track = trackOf(FAN_OUT)
    const broken: RevealTrack = {
      ...track,
      glyphs: [{ toolCallId: 'tc_ghost', at: track.startedAt }],
    }
    expect(() => filterRevealTrack(broken, FAN_OUT, IDENTITY_FILTER)).toThrow(
      /tc_ghost/,
    )
  })
})
