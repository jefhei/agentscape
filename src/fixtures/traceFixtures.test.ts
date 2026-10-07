import { describe, expect, expectTypeOf, it } from 'vitest'
import type { AgentMessageRow } from '../adapter/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import type { Run } from '../types/index.ts'
import type { TraceModel } from '../model/index.ts'
import { buildFixture, FIXTURES, FIXTURE_EPOCH_MS, FIXTURE_SHAPES } from './index.ts'
import type { FixtureShape, TraceFixture } from './index.ts'

/**
 * Deterministic trace fixture tests (M1-T6).
 *
 * These gate the fixture set hard, because everything downstream lays these
 * runs out (M2), renders them (M3) and compares them against a timeline (M5):
 *
 *  1. **Registry integrity** — exactly the four documented shapes, each a real
 *     export that flows through the real ingest path.
 *  2. **Determinism** — the same fixture builds byte-identically every time
 *     and is independent of input row order; every run is timed from one fixed
 *     epoch (no clock).
 *  3. **Shape** — each fixture really does exhibit the structural fact it is
 *     named for (a wide fan-out, a repeating loop edge, a terminal dead leaf,
 *     a linear handoff path).
 *
 * No visuals are asserted — jsdom has no GPU and the look is human-held
 * (M5-T5). Only the pure half is gated.
 */

/** The agent with the given raw name, or a hard failure if it is missing. */
function agentNamed(run: TraceModel, name: string) {
  const found = run.agents.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`fixture has no agent named ${name}`)
  return found
}

/** Widest fan-out: the most messages any single agent sent. */
function maxFanOut(run: TraceModel): number {
  return Math.max(0, ...run.agents.map((candidate) => candidate.messagesSent))
}

/** Directed message counts keyed `from→to`, broadcasts skipped. */
function edgeCounts(run: TraceModel): Map<string, number> {
  const names = new Map(run.agents.map((candidate) => [candidate.id, candidate.name]))
  const counts = new Map<string, number>()
  for (const message of run.messages) {
    if (message.to === null) continue
    const key = `${names.get(message.from)}->${names.get(message.to)}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

const byShape = (shape: FixtureShape): TraceFixture => buildFixture(shape)

describe('trace fixtures — registry (M1-T6)', () => {
  it('exposes exactly the four documented shapes, in stable order', () => {
    expect(FIXTURE_SHAPES).toEqual(['fan-out', 'loop', 'dead-branch', 'handoff-chain'])
    expect(FIXTURES.map((fixture) => fixture.shape)).toEqual([...FIXTURE_SHAPES])
    expect(FIXTURES).toHaveLength(4)
  })

  it('builds a fully-formed TraceFixture with a normalized run', () => {
    for (const fixture of FIXTURES) {
      expectTypeOf(fixture.run).toEqualTypeOf<TraceModel>()
      expectTypeOf(fixture.run).toEqualTypeOf<Run>()
      expect(fixture.title.length).toBeGreaterThan(0)
      expect(fixture.description.length).toBeGreaterThan(0)
      expect(fixture.rows.length).toBeGreaterThan(0)
      expect(fixture.run.source).toBe('agent_messages')
      expect(fixture.run.label).toBe(`fixture: ${fixture.title}`)
      // The run is exactly what the real export says it is.
      expect(fixture.run.meta.messageCount).toBe(fixture.rows.length)
    }
  })

  it('gives every fixture unique row ids (the adapter rejects collisions)', () => {
    for (const fixture of FIXTURES) {
      const ids = fixture.rows.map((row) => String(row.id))
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('freezes the registry and each fixture’s rows', () => {
    expect(Object.isFrozen(FIXTURES)).toBe(true)
    for (const fixture of FIXTURES) {
      expect(Object.isFrozen(fixture.rows)).toBe(true)
    }
  })
})

describe('trace fixtures — determinism (M1-T6)', () => {
  it('builds the same fixture byte-identically across calls', () => {
    for (const shape of FIXTURE_SHAPES) {
      const first = byShape(shape)
      const second = byShape(shape)
      expect(JSON.stringify(first.rows)).toBe(JSON.stringify(second.rows))
      expect(JSON.stringify(first.run)).toBe(JSON.stringify(second.run))
    }
  })

  it('keeps the registry byte-identical to a fresh build', () => {
    for (const fixture of FIXTURES) {
      expect(JSON.stringify(fixture.run)).toBe(
        JSON.stringify(buildFixture(fixture.shape).run),
      )
    }
  })

  it('produces a run that is a fixed point of normalization', () => {
    for (const fixture of FIXTURES) {
      expect(JSON.stringify(buildFixture(fixture.shape).run)).toBe(
        JSON.stringify(fixture.run),
      )
    }
  })

  it('is independent of the order rows are listed in', () => {
    for (const fixture of FIXTURES) {
      const reversed: AgentMessageRow[] = [...fixture.rows].reverse()
      const run = parseAgentMessagesExport(reversed, {
        label: `fixture: ${fixture.title}`,
      })
      expect(JSON.stringify(run)).toBe(JSON.stringify(fixture.run))
    }
  })

  it('times every run from the one fixed epoch — no clock', () => {
    for (const fixture of FIXTURES) {
      const { run } = fixture
      expect(run.startedAt).toBe(FIXTURE_EPOCH_MS)
      expect(run.endedAt).toBeGreaterThanOrEqual(run.startedAt)
      expect(run.meta.durationMs).toBe(run.endedAt - run.startedAt)
    }
  })

  it('derives a stable, distinct seed for each fixture (never authored)', () => {
    const seeds = FIXTURES.map((fixture) => {
      const { seed } = fixture.run
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
      return seed
    })
    expect(new Set(seeds).size).toBe(FIXTURES.length)
  })
})

describe('trace fixtures — fan-out shape (M1-T6)', () => {
  const { run } = byShape('fan-out')

  it('has one orchestrator fanning out to five distinct workers', () => {
    expect(run.meta.agentCount).toBe(6)
    expect(run.meta.messageCount).toBe(5)
    expect(run.meta.broadcastCount).toBe(0)

    const orchestrator = agentNamed(run, 'orchestrator')
    expect(orchestrator.messagesSent).toBe(5)
    expect(orchestrator.messagesReceived).toBe(0)

    const recipients = new Set(
      run.messages
        .filter((message) => message.from === orchestrator.id)
        .map((message) => message.to),
    )
    expect(recipients.size).toBe(5)
  })

  it('has five silent workers, each receiving exactly one assignment', () => {
    const workers = run.agents.filter((candidate) =>
      candidate.name.startsWith('worker_'),
    )
    expect(workers).toHaveLength(5)
    for (const worker of workers) {
      expect(worker.messagesSent).toBe(0)
      expect(worker.messagesReceived).toBe(1)
    }
  })

  it('is the widest out-degree in the fixture set', () => {
    const widest = maxFanOut(run)
    expect(widest).toBe(5)
    for (const other of FIXTURES) {
      if (other.shape === 'fan-out') continue
      expect(maxFanOut(other.run)).toBeLessThan(widest)
    }
  })
})

describe('trace fixtures — loop shape (M1-T6)', () => {
  const { run } = byShape('loop')

  it('has a researcher and critic bouncing messages in both directions', () => {
    expect(run.meta.agentCount).toBe(3)
    expect(run.meta.messageCount).toBe(7)

    const edges = edgeCounts(run)
    expect(edges.get('researcher->critic')).toBe(3)
    expect(edges.get('critic->researcher')).toBe(3)
  })

  it('sends the loop work back and forth the same number of times', () => {
    const researcher = agentNamed(run, 'researcher')
    const critic = agentNamed(run, 'critic')
    expect(researcher.messagesSent).toBe(3)
    expect(critic.messagesSent).toBe(3)
    // The researcher also received the one kickoff plus three revisions.
    expect(researcher.messagesReceived).toBe(4)
    expect(critic.messagesReceived).toBe(3)
  })

  it('opens with a single orchestrator kickoff', () => {
    expect(agentNamed(run, 'orchestrator').messagesSent).toBe(1)
  })
})

describe('trace fixtures — dead-branch shape (M1-T6)', () => {
  const { run } = byShape('dead-branch')

  it('has one worker that completes and one that goes silent', () => {
    expect(run.meta.agentCount).toBe(3)
    expect(run.meta.messageCount).toBe(3)

    const ok = agentNamed(run, 'worker_ok')
    expect(ok.messagesSent).toBe(1)
    expect(ok.messagesReceived).toBe(1)

    const dead = agentNamed(run, 'worker_dead')
    expect(dead.messagesSent).toBe(0)
    expect(dead.messagesReceived).toBe(1)
  })

  it('has exactly one terminal leaf (receives, never sends)', () => {
    const leaves = run.agents.filter(
      (candidate) => candidate.messagesSent === 0 && candidate.messagesReceived > 0,
    )
    expect(leaves).toHaveLength(1)
    expect(leaves[0].name).toBe('worker_dead')
  })

  it('leaves the dead leaf’s window at a single instant — one event, then silence', () => {
    const dead = agentNamed(run, 'worker_dead')
    expect(dead.firstSeenAt).toBe(dead.lastSeenAt)
  })

  it('fans the orchestrator out to two workers', () => {
    expect(agentNamed(run, 'orchestrator').messagesSent).toBe(2)
  })
})

describe('trace fixtures — handoff-chain shape (M1-T6)', () => {
  const { run } = byShape('handoff-chain')

  it('is a directed relay agent_a → agent_b → agent_c → agent_d', () => {
    expect(run.meta.agentCount).toBe(4)
    expect(run.meta.messageCount).toBe(3)

    const edges = edgeCounts(run)
    expect([...edges.keys()].sort()).toEqual([
      'agent_a->agent_b',
      'agent_b->agent_c',
      'agent_c->agent_d',
    ])
    expect([...edges.values()]).toEqual([1, 1, 1])
  })

  it('has intermediates sending and receiving exactly once; ends terminating', () => {
    const a = agentNamed(run, 'agent_a')
    const b = agentNamed(run, 'agent_b')
    const c = agentNamed(run, 'agent_c')
    const d = agentNamed(run, 'agent_d')

    expect([a.messagesSent, a.messagesReceived]).toEqual([1, 0])
    expect([b.messagesSent, b.messagesReceived]).toEqual([1, 1])
    expect([c.messagesSent, c.messagesReceived]).toEqual([1, 1])
    expect([d.messagesSent, d.messagesReceived]).toEqual([0, 1])
  })

  it('records a handoff action on each link', () => {
    expect(run.messages.map((message) => message.action)).toEqual([
      'handoff',
      'handoff',
      'handoff',
    ])
    expect(run.meta.toolCallCount).toBe(3)
  })
})

describe('trace fixtures — isolation (M1-T6)', () => {
  it('returns a fresh run and rows on each build, distinct from the registry', () => {
    for (const fixture of FIXTURES) {
      const fresh = buildFixture(fixture.shape)
      expect(fresh.rows).not.toBe(fixture.rows)
      expect(fresh.run).not.toBe(fixture.run)
    }
  })

  it('does not let a mutated build leak into the registry', () => {
    const fresh = buildFixture('loop')
    const registry = FIXTURES[1]
    fresh.run.meta.messageCount = -1
    expect(registry.run.meta.messageCount).toBe(7)
  })
})
