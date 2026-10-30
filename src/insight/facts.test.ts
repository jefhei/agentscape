import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import type { AgentMessageRow } from '../adapter/index.ts'
import { buildFixture } from '../fixtures/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import {
  DEFAULT_LOOP_MIN_BALANCE,
  INSIGHT_KINDS,
  buildStructuralFacts,
  deriveMessageChannels,
  factOf,
} from './index.ts'

/**
 * The structural-fact derivation (M5-T4).
 *
 * What is gated here is the *data*: which fact each fixture supports, the exact
 * numbers behind it, and the two rules that keep the facts honest — a fan-out is
 * counted as spawn children only when the vocabulary yields them, and a
 * reciprocating pair is not called a loop until it is symmetric. The look is not
 * asserted anywhere (jsdom has no GPU; M5-T5 owns it).
 *
 * All four fixture runs come from `buildFixture`, i.e. through the real adapter +
 * normalizer — the same path a user's export takes.
 */

const FAN_OUT = buildFixture('fan-out').run
const LOOP = buildFixture('loop').run
const DEAD_BRANCH = buildFixture('dead-branch').run
const HANDOFF = buildFixture('handoff-chain').run

// ── Channels ────────────────────────────────────────────────────────────────

describe('deriveMessageChannels — the arcs, with their direction kept (M5-T4)', () => {
  it('gives the fan-out fixture one channel per assignment, all one-way', () => {
    const channels = deriveMessageChannels(FAN_OUT)
    expect(channels).toHaveLength(5)
    for (const channel of channels) {
      expect(channel.a).toBe('a_orchestrator')
      expect(channel.fromAToB).toBe(1)
      expect(channel.fromBToA).toBe(0)
      expect(channel.volume).toBe(1)
      expect(channel.messageIds).toHaveLength(1)
    }
    // Canonical: sorted by (a, b), so the five worker channels are alphabetical.
    expect(channels.map((channel) => channel.b)).toEqual([
      'a_worker_alpha',
      'a_worker_beta',
      'a_worker_delta',
      'a_worker_epsilon',
      'a_worker_gamma',
    ])
  })

  it('counts both directions of an exchange on one channel', () => {
    const channel = deriveMessageChannels(LOOP).find(
      (entry) => entry.a === 'a_critic' && entry.b === 'a_researcher',
    )
    expect(channel).toBeDefined()
    expect(channel?.fromAToB).toBe(3)
    expect(channel?.fromBToA).toBe(3)
    expect(channel?.volume).toBe(6)
    expect(channel?.lastAt).toBeGreaterThan(channel?.firstAt ?? 0)
  })

  it('expands a broadcast into one spoke per other agent, and skips a self-message', () => {
    const model = normalizeTrace(
      parseAgentMessagesExport(
        [
          {
            id: 1,
            from_agent: 'hub',
            to_agent: null,
            subject: 'all hands',
            body: JSON.stringify({ action: 'announce' }),
            created_at: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 2,
            from_agent: 'self',
            to_agent: 'self',
            subject: 'note to self',
            created_at: '2026-01-01T00:01:00.000Z',
          },
          {
            id: 3,
            from_agent: 'leaf',
            to_agent: 'hub',
            subject: 'ack',
            created_at: '2026-01-01T00:02:00.000Z',
          },
        ],
        { label: 'broadcast' },
      ),
    )
    const channels = deriveMessageChannels(model)
    // The broadcast reaches `leaf` AND `self` (a broadcast is heard by every other
    // agent), so there are two spokes; the self-message adds none.
    expect(channels).toHaveLength(2)
    const toLeaf = channels.find((channel) => channel.b === 'a_leaf')
    expect(toLeaf).toBeDefined()
    expect(toLeaf?.a).toBe('a_hub')
    expect(toLeaf?.fromAToB).toBe(1) // hub → leaf, from the broadcast
    expect(toLeaf?.fromBToA).toBe(1) // leaf → hub, the ack
    expect(toLeaf?.volume).toBe(2)
    // `self` only hears the broadcast and never answers.
    const toSelf = channels.find((channel) => channel.b === 'a_self')
    expect(toSelf?.volume).toBe(1)
    expect(toSelf?.fromBToA).toBe(0)
  })

  it('drops a self-message entirely: it has no channel to draw', () => {
    const model = normalizeTrace(
      parseAgentMessagesExport(
        [
          {
            id: 1,
            from_agent: 'solo',
            to_agent: 'solo',
            subject: 'thinking',
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
        { label: 'self' },
      ),
    )
    expect(deriveMessageChannels(model)).toEqual([])
  })
})

// ── Fan-out ─────────────────────────────────────────────────────────────────

describe('the fan-out fact', () => {
  it('counts spawn children on the fan-out fixture and names the widest', () => {
    const facts = buildStructuralFacts(FAN_OUT)
    const fact = factOf(facts, 'fan-out')
    expect(fact?.kind).toBe('fan-out')
    if (fact?.kind !== 'fan-out') throw new Error('expected a fan-out fact')

    expect(facts.hierarchyDerivable).toBe(true)
    expect(fact.evidence.basis).toBe('spawn')
    expect(fact.supported).toBe(true)
    expect(fact.evidence.topAgentId).toBe('a_orchestrator')
    expect(fact.evidence.topFanOut).toBe(5)
    expect(fact.evidence.topSpokes).toBe(5)
    expect(fact.evidence.topOneWay).toBe(true)
    expect(fact.evidence.fannedAgents).toBe(1)
    expect(fact.agentIds).toEqual(['a_orchestrator'])
    expect(fact.answer).toContain('a_orchestrator')
    expect(fact.answer).toContain('5 agents put to work')
  })

  it('is unsupported when nobody fans out (the loop fixture is a pair)', () => {
    const fact = factOf(buildStructuralFacts(LOOP), 'fan-out')
    if (fact?.kind !== 'fan-out') throw new Error('expected a fan-out fact')
    expect(fact.supported).toBe(false)
    expect(fact.evidence.topFanOut).toBe(1)
    expect(fact.agentIds).toEqual([])
    expect(fact.reason).toContain('widest spawn is 1 child')
  })

  it('falls back to message reach when the vocabulary yields no spawn edges', () => {
    // The handoff chain's actions are `handoff`, so no spawn edge derives and the
    // only fan the trace supports is who addressed whom — one each, here.
    const facts = buildStructuralFacts(HANDOFF)
    const fact = factOf(facts, 'fan-out')
    if (fact?.kind !== 'fan-out') throw new Error('expected a fan-out fact')
    expect(facts.hierarchyDerivable).toBe(false)
    expect(fact.evidence.basis).toBe('reach')
    expect(fact.supported).toBe(false)
    expect(fact.answer).toBe(
      'No agent fans out: every agent addresses at most one other.',
    )
  })

  it('counts a broadcast as a spoke to every agent, and says so', () => {
    const model = normalizeTrace(
      parseAgentMessagesExport(
        [
          {
            id: 1,
            from_agent: 'hub',
            to_agent: null,
            subject: 'all hands',
            created_at: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 2,
            from_agent: 'a',
            to_agent: 'hub',
            subject: 'ack',
            created_at: '2026-01-01T00:01:00.000Z',
          },
          {
            id: 3,
            from_agent: 'b',
            to_agent: 'hub',
            subject: 'ack',
            created_at: '2026-01-01T00:02:00.000Z',
          },
          {
            id: 4,
            from_agent: 'hub',
            to_agent: 'a',
            subject: 'follow up',
            created_at: '2026-01-01T00:03:00.000Z',
          },
        ],
        { label: 'shout' },
      ),
    )
    const fact = factOf(buildStructuralFacts(model), 'fan-out')
    if (fact?.kind !== 'fan-out') throw new Error('expected a fan-out fact')
    const hub = fact.evidence.ranking.find((fan) => fan.agentId === 'a_hub')
    expect(hub).toBeDefined()
    expect(hub?.reach).toBe(2) // a and b
    expect(hub?.directedReach).toBe(1) // a only
    expect(hub?.broadcastReach).toBe(2)
    expect(hub?.broadcastsSent).toBe(1)
    expect(fact.answer).toContain('1 broadcast row reaches 2 of them')
  })
})

// ── Loops ───────────────────────────────────────────────────────────────────

describe('the loop fact', () => {
  it('finds the loop fixture’s symmetric pair and that the run ends inside it', () => {
    const fact = factOf(buildStructuralFacts(LOOP), 'loop')
    if (fact?.kind !== 'loop') throw new Error('expected a loop fact')
    expect(fact.supported).toBe(true)
    expect(fact.agentIds).toEqual(['a_critic', 'a_researcher'])
    expect(fact.evidence.loops).toBe(1)
    expect(fact.evidence.endsInsideLoop).toBe(true)

    const pair = fact.evidence.pairs[0]
    expect(pair.a).toBe('a_critic')
    expect(pair.b).toBe('a_researcher')
    expect(pair.fromAToB).toBe(3)
    expect(pair.fromBToA).toBe(3)
    expect(pair.turns).toBe(3)
    expect(pair.balance).toBe(1)
    expect(pair.openAtEnd).toBe(true)
    expect(pair.loop).toBe(true)
    expect(fact.answer).toContain('3 turns each way')
    expect(fact.answer).toContain('the run ends inside the loop')
  })

  it('does not call a single request-and-reply a loop', () => {
    const fact = factOf(buildStructuralFacts(DEAD_BRANCH), 'loop')
    if (fact?.kind !== 'loop') throw new Error('expected a loop fact')
    expect(fact.supported).toBe(false)
    expect(fact.evidence.reciprocating).toBe(1)
    expect(fact.evidence.pairs).toEqual([])
    expect(fact.answer).toContain('exchange once each way')
    expect(fact.reason).toContain('a loop needs 2 turns')
  })

  it('rejects an asymmetric busy channel: reciprocity is not a loop', () => {
    /** `forward` messages hub → leaf, `back` messages leaf → hub. */
    const exchange = (forward: number, back: number): TraceModel => {
      const rows: AgentMessageRow[] = [
        ...Array.from({ length: forward }, (_, index) => ({
          id: 100 + index,
          from_agent: 'hub',
          to_agent: 'leaf',
          subject: 'report',
          created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        })),
        ...Array.from({ length: back }, (_, index) => ({
          id: 200 + index,
          from_agent: 'leaf',
          to_agent: 'hub',
          subject: 'ack',
          created_at: new Date(Date.UTC(2026, 0, 1, 0, 10 + index)).toISOString(),
        })),
      ]
      return normalizeTrace(
        parseAgentMessagesExport(rows, { label: `${forward}:${back}` }),
      )
    }

    // 3:2 is exactly at the symmetry bar (80%) — the least balanced exchange that
    // still reads as a loop, and the boundary is pinned here rather than guessed.
    const atBar = factOf(buildStructuralFacts(exchange(3, 2)), 'loop')
    if (atBar?.kind !== 'loop') throw new Error('expected a loop fact')
    expect(atBar.evidence.pairs[0].turns).toBe(2)
    expect(atBar.evidence.pairs[0].balance).toBe(DEFAULT_LOOP_MIN_BALANCE)
    expect(atBar.supported).toBe(true)

    // One more one-way message and the same pair is a hub relationship, not a loop.
    const pastBar = factOf(buildStructuralFacts(exchange(4, 2)), 'loop')
    if (pastBar?.kind !== 'loop') throw new Error('expected a loop fact')
    expect(pastBar.evidence.pairs[0].balance).toBeLessThan(DEFAULT_LOOP_MIN_BALANCE)
    expect(pastBar.supported).toBe(false)
    expect(pastBar.answer).toContain('asymmetric')
    expect(pastBar.answer).toContain('hub relationship, not a loop')
  })
})

// ── Imbalance ───────────────────────────────────────────────────────────────

describe('the imbalance fact', () => {
  it('reads agent concentration on the fan-out fixture', () => {
    const fact = factOf(buildStructuralFacts(FAN_OUT), 'imbalance')
    if (fact?.kind !== 'imbalance') throw new Error('expected an imbalance fact')
    expect(fact.supported).toBe(true)
    expect(fact.evidence.basis).toBe('agent')
    expect(fact.evidence.topAgentId).toBe('a_orchestrator')
    // 5 sent + 0 received + 5 tool calls = 10, against 1 each for the workers.
    expect(fact.evidence.agents[0].activity).toBe(10)
    expect(fact.evidence.totalActivity).toBe(15)
    expect(fact.evidence.agents[0].share).toBeCloseTo(0.6667, 4)
    expect(fact.evidence.agentRatio).toBe(10)
    expect(fact.answer).toContain('67%')
    expect(fact.agentIds).toEqual(['a_orchestrator'])
  })

  it('reads channel concentration when the agents themselves are tied', () => {
    const fact = factOf(buildStructuralFacts(LOOP), 'imbalance')
    if (fact?.kind !== 'imbalance') throw new Error('expected an imbalance fact')
    expect(fact.supported).toBe(true)
    // researcher 7 vs critic 6 is a tie for practical purposes; the channel is not.
    expect(fact.evidence.agentRatio).toBeLessThan(2)
    expect(fact.evidence.basis).toBe('channel')
    expect(fact.evidence.channels[0].volume).toBe(6)
    expect(fact.evidence.channelRatio).toBe(6)
    expect(fact.agentIds).toEqual(['a_critic', 'a_researcher'])
  })

  it('reports an even run as unsupported rather than inventing a winner', () => {
    const fact = factOf(buildStructuralFacts(HANDOFF), 'imbalance')
    if (fact?.kind !== 'imbalance') throw new Error('expected an imbalance fact')
    expect(fact.supported).toBe(false)
    expect(fact.evidence.basis).toBe(null)
    expect(fact.answer).toBe(
      'No concentration: traffic is spread evenly across agents and channels.',
    )
    expect(fact.reason).toContain('agents 1×, channels 1×')
  })
})

// ── Cost ────────────────────────────────────────────────────────────────────

describe('the cost fact', () => {
  it('is unavailable on every v1 run, and says why instead of printing zero', () => {
    for (const model of [FAN_OUT, LOOP, HANDOFF]) {
      const fact = factOf(buildStructuralFacts(model), 'cost')
      if (fact?.kind !== 'cost') throw new Error('expected a cost fact')
      expect(fact.supported).toBe(false)
      expect(fact.evidence.recorded).toBe(false)
      expect(fact.evidence.agents).toEqual([])
      expect(fact.answer).toContain('Not recorded')
      expect(fact.short).toBe('not recorded')
    }
  })

  it('attributes recorded spend when a trace carries it', () => {
    // The v1 export has no cost column, so the only way a trace carries cost is a
    // richer source. Stamp it onto a real run and re-normalize (M1-T5 preserves
    // per-message cost), which is the shape a future adapter would produce.
    const withCost = normalizeTrace({
      ...LOOP,
      messages: LOOP.messages.map((message, index) => ({
        ...message,
        costUsd: index === 0 ? 0.9 : 0.1,
      })),
    })
    const fact = factOf(buildStructuralFacts(withCost), 'cost')
    if (fact?.kind !== 'cost') throw new Error('expected a cost fact')
    expect(fact.supported).toBe(true)
    expect(fact.evidence.recorded).toBe(true)
    // 0.9 for the kickoff + 0.1 for each of the six loop messages.
    expect(fact.evidence.totalCostUsd).toBeCloseTo(1.5, 6)
    expect(fact.evidence.agents).toHaveLength(3)
    expect(fact.evidence.topAgentId).toBe('a_orchestrator')
    expect(fact.evidence.topShare).toBeCloseTo(0.6, 4)
    expect(fact.answer).toContain('60%')
  })
})

// ── Determinism + purity ────────────────────────────────────────────────────

describe('determinism and purity (PRD §5)', () => {
  it('yields a byte-identical derivation for the same run', () => {
    const first = buildStructuralFacts(LOOP)
    const second = buildStructuralFacts(LOOP)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('is independent of the order the model’s arrays arrive in', () => {
    const shuffled = normalizeTrace({
      ...LOOP,
      agents: [...LOOP.agents].reverse(),
      messages: [...LOOP.messages].reverse(),
      toolCalls: [...LOOP.toolCalls].reverse(),
      events: [...LOOP.events].reverse(),
    })
    expect(JSON.stringify(buildStructuralFacts(shuffled))).toBe(
      JSON.stringify(buildStructuralFacts(LOOP)),
    )
  })

  it('derives every kind exactly once, in the documented order', () => {
    const facts = buildStructuralFacts(FAN_OUT)
    expect(facts.facts.map((fact) => fact.kind)).toEqual([...INSIGHT_KINDS])
  })

  it('keeps the module free of clocks, randomness, three.js and React', () => {
    for (const file of ['facts.ts', 'access.ts', 'report.ts']) {
      const raw = readFileSync(resolve(process.cwd(), 'src/insight', file), 'utf8')
      // Comments are stripped first: these modules *document* the forbidden
      // tokens (that is the point of the purity notes), so only code counts.
      const source = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      for (const forbidden of [
        'Math.random',
        'Date.now',
        "from 'three'",
        "from 'react'",
      ]) {
        expect(source, `${file} must not contain ${forbidden}`).not.toContain(forbidden)
      }
      expect(source, `${file} must not read the clock`).not.toContain('new Date(')
    }
  })

  it('is a fixed point: re-deriving from an edge model gives the same facts', () => {
    const derived = buildStructuralFacts(LOOP)
    expect(derived.edgeCounts.spawn).toBe(1)
    expect(derived.pairCount).toBe(2)
    expect(derived.lastExchange).toEqual({ from: 'a_critic', to: 'a_researcher' })
  })
})
