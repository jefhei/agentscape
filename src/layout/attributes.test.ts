import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import { FIXTURES, buildFixture } from '../fixtures/index.ts'
import type { TraceModel } from '../model/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { AgentId } from '../types/index.ts'
import {
  DEFAULT_MAX_ARC_WIDTH,
  DEFAULT_MAX_EMISSIVE,
  DEFAULT_MAX_NODE_SIZE,
  DEFAULT_MIN_ARC_WIDTH,
  DEFAULT_MIN_EMISSIVE,
  DEFAULT_MIN_NODE_SIZE,
  NEUTRAL_INTENSITY,
  deriveLayoutLinks,
  linkAttribute,
  mapTraceAttributes,
  nodeAttribute,
} from './index.ts'
import type { LinkAttribute, NodeAttribute, TraceAttributes } from './index.ts'

/**
 * Visual-attribute mapping tests (M2-T3).
 *
 * The mapping turns a normalized trace into the numbers the render layer draws
 * with: node size + emissive from an agent's activity, arc width from the
 * message volume on a link. These tests gate it as *data* — the ranges, the
 * monotonicity, the neutral fallback, the degenerate shapes and the
 * reproducibility — over the four reference fixtures. No visuals are asserted:
 * jsdom has no GPU, and the look is human-held (M5-T5).
 */

/** A fixed timestamp so test rows are deterministic. */
const T = '2026-01-01T00:00:00.000Z'

/** One minute, in ms, for staggered rows. */
const MIN = 60_000

/** A run built from an explicit row list, through the real ingest path. */
function modelFrom(rows: Parameters<typeof parseAgentMessagesExport>[0]): TraceModel {
  return normalizeTrace(parseAgentMessagesExport(rows))
}

/** How many agents in the model carry the given activity total. */
function nodeByAgent(attributes: TraceAttributes, agentId: AgentId): NodeAttribute {
  const node = nodeAttribute(attributes, agentId)
  if (node === null) throw new Error(`no node for ${agentId}`)
  return node
}

const EMPTY_ACTIVITY = { min: 0, max: 0 }

// ── shape ───────────────────────────────────────────────────────────────────

describe('mapTraceAttributes — shape (M2-T3)', () => {
  it('returns a fully-formed TraceAttributes (compile-checked)', () => {
    const attributes = mapTraceAttributes(buildFixture('fan-out').run)
    expectTypeOf(attributes).toEqualTypeOf<TraceAttributes>()
    expectTypeOf(attributes.nodes).toEqualTypeOf<NodeAttribute[]>()
    expectTypeOf(attributes.links).toEqualTypeOf<LinkAttribute[]>()
    expect(attributes.nodes.length).toBeGreaterThan(0)
  })

  it('emits one node per agent, in canonical id order', () => {
    for (const fixture of FIXTURES) {
      const attributes = mapTraceAttributes(fixture.run)
      expect(attributes.nodes.map((node) => node.agentId)).toEqual(
        fixture.run.agents.map((agent) => agent.id),
      )
      expect(new Set(attributes.nodes.map((node) => node.agentId)).size).toBe(
        attributes.nodes.length,
      )
    }
  })

  it('emits one arc per link, matching the layout adjacency', () => {
    for (const fixture of FIXTURES) {
      const attributes = mapTraceAttributes(fixture.run)
      const links = deriveLayoutLinks(fixture.run)
      expect(attributes.links.map((l) => [l.source, l.target, l.volume])).toEqual(
        links.map((l) => [l.source, l.target, l.weight]),
      )
    }
  })

  it('configures every channel to its documented default range', () => {
    const attributes = mapTraceAttributes(buildFixture('fan-out').run)
    expect(DEFAULT_MIN_NODE_SIZE).toBeLessThan(DEFAULT_MAX_NODE_SIZE)
    expect(DEFAULT_MIN_EMISSIVE).toBeLessThan(DEFAULT_MAX_EMISSIVE)
    expect(DEFAULT_MIN_ARC_WIDTH).toBeLessThan(DEFAULT_MAX_ARC_WIDTH)
    for (const node of attributes.nodes) {
      expect(node.size).toBeGreaterThanOrEqual(DEFAULT_MIN_NODE_SIZE)
      expect(node.size).toBeLessThanOrEqual(DEFAULT_MAX_NODE_SIZE)
      expect(node.emissive).toBeGreaterThanOrEqual(DEFAULT_MIN_EMISSIVE)
      expect(node.emissive).toBeLessThanOrEqual(DEFAULT_MAX_EMISSIVE)
    }
    for (const link of attributes.links) {
      expect(link.width).toBeGreaterThanOrEqual(DEFAULT_MIN_ARC_WIDTH)
      expect(link.width).toBeLessThanOrEqual(DEFAULT_MAX_ARC_WIDTH)
    }
  })
})

// ── activity drives node size + emissive ─────────────────────────────────────

describe('mapTraceAttributes — node activity (M2-T3)', () => {
  it('counts activity as sent + received + tool calls', () => {
    // Fan-out: the orchestrator sends five action-bearing assignments (so five
    // tool calls too) and receives nothing; each worker only receives one.
    const { run } = buildFixture('fan-out')
    const attributes = mapTraceAttributes(run)
    const orchestrator = nodeByAgent(attributes, 'a_orchestrator')
    expect(orchestrator.activity).toEqual({
      agentId: 'a_orchestrator',
      messagesSent: 5,
      messagesReceived: 0,
      toolCalls: 5,
      total: 10,
    })
    const worker = nodeByAgent(attributes, 'a_worker_alpha')
    expect(worker.activity.total).toBe(1)
    expect(worker.activity.messagesReceived).toBe(1)
    expect(worker.activity.toolCalls).toBe(0)
  })

  it('exposes the same numbers the model carries', () => {
    for (const fixture of FIXTURES) {
      const attributes = mapTraceAttributes(fixture.run)
      for (const node of attributes.nodes) {
        const agent = fixture.run.agents.find((a) => a.id === node.agentId)!
        expect(node.activity.messagesSent).toBe(agent.messagesSent)
        expect(node.activity.messagesReceived).toBe(agent.messagesReceived)
        expect(node.activity.toolCalls).toBe(
          fixture.run.toolCalls.filter((call) => call.agentId === agent.id).length,
        )
        expect(node.activity.total).toBe(
          agent.messagesSent + agent.messagesReceived + node.activity.toolCalls,
        )
      }
    }
  })

  it('reads the quiet terminal leaf as the least active node (dead branch)', () => {
    const attributes = mapTraceAttributes(buildFixture('dead-branch').run)
    // worker_dead receives one assignment and never replies; the orchestrator
    // sends two and is answered once; worker_ok both receives and replies.
    expect(nodeByAgent(attributes, 'a_worker_dead').activity.total).toBe(1)
    expect(nodeByAgent(attributes, 'a_worker_ok').activity.total).toBe(3)
    expect(nodeByAgent(attributes, 'a_orchestrator').activity.total).toBe(5)
    expect(attributes.activityRange).toEqual({ min: 1, max: 5 })
  })

  it('is monotone: more activity never reads smaller or dimmer', () => {
    for (const fixture of FIXTURES) {
      const ordered = [...mapTraceAttributes(fixture.run).nodes].sort(
        (a, b) => a.activity.total - b.activity.total,
      )
      for (let i = 1; i < ordered.length; i += 1) {
        expect(ordered[i].size).toBeGreaterThanOrEqual(ordered[i - 1].size - 1e-12)
        expect(ordered[i].emissive).toBeGreaterThanOrEqual(
          ordered[i - 1].emissive - 1e-12,
        )
      }
    }
  })

  it('pins the extremes of the activity range to the ends of both channels', () => {
    for (const fixture of FIXTURES) {
      const attributes = mapTraceAttributes(fixture.run)
      const totals = attributes.nodes.map((node) => node.activity.total)
      const min = Math.min(...totals)
      const max = Math.max(...totals)
      for (const node of attributes.nodes) {
        if (node.activity.total === max && max > min) {
          expect(node.intensity).toBe(1)
          expect(node.size).toBe(DEFAULT_MAX_NODE_SIZE)
          expect(node.emissive).toBe(DEFAULT_MAX_EMISSIVE)
        }
        if (node.activity.total === min && max > min) {
          expect(node.intensity).toBe(0)
          expect(node.size).toBe(DEFAULT_MIN_NODE_SIZE)
          expect(node.emissive).toBe(DEFAULT_MIN_EMISSIVE)
        }
      }
    }
  })
})

// ── message volume drives arc width ─────────────────────────────────────────

describe('mapTraceAttributes — arc width (M2-T3)', () => {
  it('weights the arc by the messages exchanged between the pair (loop)', () => {
    const attributes = mapTraceAttributes(buildFixture('loop').run)
    // The researcher⇄critic chatter (6 messages) is the heaviest link; the
    // orchestrator's single kickoff to the researcher is the lightest.
    const chatter = linkAttribute(attributes, 'a_critic', 'a_researcher')!
    const kickoff = linkAttribute(attributes, 'a_orchestrator', 'a_researcher')!
    expect(chatter.volume).toBe(6)
    expect(kickoff.volume).toBe(1)
    expect(attributes.volumeRange).toEqual({ min: 1, max: 6 })
    expect(chatter.width).toBe(DEFAULT_MAX_ARC_WIDTH)
    expect(kickoff.width).toBe(DEFAULT_MIN_ARC_WIDTH)
    expect(chatter.width).toBeGreaterThan(kickoff.width)
  })

  it('weights an answered edge heavier than an unanswered one (dead branch)', () => {
    const attributes = mapTraceAttributes(buildFixture('dead-branch').run)
    // orchestrator↔worker_ok is answered (2 messages); orchestrator↔worker_dead
    // is one message into the void.
    expect(linkAttribute(attributes, 'a_orchestrator', 'a_worker_ok')!.volume).toBe(2)
    expect(linkAttribute(attributes, 'a_orchestrator', 'a_worker_dead')!.volume).toBe(1)
  })

  it('keeps every arc width inside the configured range', () => {
    for (const fixture of FIXTURES) {
      for (const link of mapTraceAttributes(fixture.run).links) {
        expect(link.intensity).toBeGreaterThanOrEqual(0)
        expect(link.intensity).toBeLessThanOrEqual(1)
        expect(link.width).toBeGreaterThanOrEqual(DEFAULT_MIN_ARC_WIDTH)
        expect(link.width).toBeLessThanOrEqual(DEFAULT_MAX_ARC_WIDTH)
      }
    }
  })
})

// ── neutral fallback + degenerate runs ──────────────────────────────────────

describe('mapTraceAttributes — neutral fallback (M2-T3)', () => {
  it('gives every element the midpoint when a channel has no spread', () => {
    // Fan-out: five weight-1 links — no volume spread.
    const fanOut = mapTraceAttributes(buildFixture('fan-out').run)
    expect(fanOut.volumeRange).toEqual({ min: 1, max: 1 })
    for (const link of fanOut.links) {
      expect(link.intensity).toBe(NEUTRAL_INTENSITY)
      expect(link.width).toBeCloseTo(
        (DEFAULT_MIN_ARC_WIDTH + DEFAULT_MAX_ARC_WIDTH) / 2,
        12,
      )
    }
  })

  it('falls back to neutral for a run whose agents all have equal activity', () => {
    // a→b and b→a: both agents send one, receive one and make one tool call.
    const model = modelFrom([
      {
        id: 1,
        from_agent: 'a',
        to_agent: 'b',
        subject: 'ping',
        body: JSON.stringify({ action: 'ping' }),
        created_at: T,
      },
      {
        id: 2,
        from_agent: 'b',
        to_agent: 'a',
        subject: 'pong',
        body: JSON.stringify({ action: 'pong' }),
        created_at: new Date(Date.parse(T) + MIN).toISOString(),
      },
    ])
    const attributes = mapTraceAttributes(model)
    expect(attributes.activityRange).toEqual({ min: 3, max: 3 })
    for (const node of attributes.nodes) {
      expect(node.activity.total).toBe(3)
      expect(node.intensity).toBe(NEUTRAL_INTENSITY)
      expect(node.size).toBeCloseTo(
        (DEFAULT_MIN_NODE_SIZE + DEFAULT_MAX_NODE_SIZE) / 2,
        12,
      )
    }
    // The single a↔b link is equally spread-free.
    expect(attributes.volumeRange).toEqual({ min: 2, max: 2 })
    expect(attributes.links[0].intensity).toBe(NEUTRAL_INTENSITY)
  })

  it('is well-formed on an empty run', () => {
    const attributes = mapTraceAttributes(modelFrom([]))
    expect(attributes.nodes).toEqual([])
    expect(attributes.links).toEqual([])
    expect(attributes.activityRange).toEqual(EMPTY_ACTIVITY)
    expect(attributes.volumeRange).toEqual(EMPTY_ACTIVITY)
  })

  it('gives a lone agent a neutral node and no arc', () => {
    const model = modelFrom([
      {
        id: 1,
        from_agent: 'solo',
        to_agent: 'solo',
        subject: 'note to self',
        body: JSON.stringify({ action: 'think' }),
        created_at: T,
      },
    ])
    const attributes = mapTraceAttributes(model)
    expect(attributes.nodes).toHaveLength(1)
    expect(attributes.nodes[0].agentId).toBe('a_solo')
    expect(attributes.nodes[0].intensity).toBe(NEUTRAL_INTENSITY)
    expect(attributes.links).toEqual([])
  })
})

// ── options + lookups ────────────────────────────────────────────────────────

describe('mapTraceAttributes — options and lookups (M2-T3)', () => {
  it('honours output-range overrides', () => {
    const run = buildFixture('fan-out').run
    const attributes = mapTraceAttributes(run, {
      minNodeSize: 1,
      maxNodeSize: 3,
      minEmissive: 0,
      maxEmissive: 0.5,
    })
    expect(nodeByAgent(attributes, 'a_orchestrator').size).toBe(3)
    expect(nodeByAgent(attributes, 'a_orchestrator').emissive).toBe(0.5)
    expect(nodeByAgent(attributes, 'a_worker_alpha').size).toBe(1)
    expect(nodeByAgent(attributes, 'a_worker_alpha').emissive).toBe(0)
  })

  it('tolerates a swapped range and ignores non-finite overrides', () => {
    const run = buildFixture('fan-out').run
    const swapped = mapTraceAttributes(run, { minNodeSize: 3, maxNodeSize: 1 })
    expect(nodeByAgent(swapped, 'a_orchestrator').size).toBe(3)
    expect(nodeByAgent(swapped, 'a_worker_alpha').size).toBe(1)

    const guarded = mapTraceAttributes(run, { maxNodeSize: Number.NaN })
    expect(nodeByAgent(guarded, 'a_orchestrator').size).toBe(DEFAULT_MAX_NODE_SIZE)
  })

  it('looks an attribute up by agent, and an arc up by either direction', () => {
    const attributes = mapTraceAttributes(buildFixture('loop').run)
    expect(nodeAttribute(attributes, 'a_researcher')).toEqual(
      attributes.nodes.find((node) => node.agentId === 'a_researcher'),
    )
    expect(nodeAttribute(attributes, 'a_nobody')).toBeNull()

    const forward = linkAttribute(attributes, 'a_critic', 'a_researcher')
    const backward = linkAttribute(attributes, 'a_researcher', 'a_critic')
    expect(forward).not.toBeNull()
    expect(backward).toEqual(forward)
    // The critic and the orchestrator never talk directly.
    expect(linkAttribute(attributes, 'a_critic', 'a_orchestrator')).toBeNull()
  })
})

// ── determinism + purity ─────────────────────────────────────────────────────

describe('mapTraceAttributes — determinism (M2-T3)', () => {
  it('is byte-identical across calls', () => {
    for (const fixture of FIXTURES) {
      expect(JSON.stringify(mapTraceAttributes(fixture.run))).toBe(
        JSON.stringify(mapTraceAttributes(fixture.run)),
      )
    }
  })

  it('is independent of the order of the model arrays', () => {
    for (const fixture of FIXTURES) {
      const run = fixture.run
      const scrambled: TraceModel = {
        ...run,
        agents: [...run.agents].reverse(),
        messages: [...run.messages].reverse(),
        toolCalls: [...run.toolCalls].reverse(),
        events: [...run.events].reverse(),
      }
      expect(JSON.stringify(mapTraceAttributes(scrambled))).toBe(
        JSON.stringify(mapTraceAttributes(run)),
      )
    }
  })

  it('does not mutate the model', () => {
    for (const fixture of FIXTURES) {
      const before = JSON.stringify(fixture.run)
      mapTraceAttributes(fixture.run)
      expect(JSON.stringify(fixture.run)).toBe(before)
    }
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

describe('attribute mapping — purity (M2-T3)', () => {
  const source = readFileSync(
    resolve(findRepoRoot(process.cwd()), 'src/layout/attributes.ts'),
    'utf8',
  )
    // Drop comments so the module's own doc ("no Math.random …") does not trip
    // the scan — only real call sites matter.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  it('reads no clock and no randomness', () => {
    expect(source).not.toMatch(/\bDate\.now\s*\(/)
    expect(source).not.toMatch(/\bperformance\.now\s*\(/)
    expect(source).not.toMatch(/\bMath\.random\s*\(/)
  })

  it('is a data-layer module — no three.js or DOM', () => {
    expect(source).not.toMatch(/from ['"]three['"]/)
    expect(source).not.toMatch(/@react-three/)
    expect(source).not.toMatch(/\bdocument\./)
    expect(source).not.toMatch(/\bwindow\./)
  })

  it('derives its arcs from the layout adjacency, not a second graph', () => {
    expect(source).toMatch(/from '\.\/forceLayout\.ts'/)
    expect(source).toMatch(/\bderiveLayoutLinks\b/)
  })
})
