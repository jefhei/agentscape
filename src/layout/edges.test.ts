import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import { FIXTURES, buildFixture } from '../fixtures/index.ts'
import type { TraceModel } from '../model/index.ts'
import { compareModelIds, normalizeTrace } from '../model/index.ts'
import type { AgentId } from '../types/index.ts'
import {
  DerivedEdgeError,
  EDGE_KINDS,
  HANDOFF_VERBS,
  SPAWN_VERBS,
  classifyAction,
  deriveEdgeModel,
  edgeBetween,
  lineageOf,
  withDerivedLineage,
} from './index.ts'
import type { DerivedEdge, EdgeKind, EdgeModel } from './index.ts'

/**
 * Derived edge model tests (M2-T4).
 *
 * The model turns a normalized trace into its typed relationships —
 * spawn / handoff / message edges — and, from the spawn edges, each agent's
 * role and parent. These tests gate it as *data* over the four reference
 * fixtures: classification, direction, aggregation, lineage, determinism and
 * the fail-loudly cycle guard. No visuals are asserted: jsdom has no GPU, and
 * the look is human-held (M5-T5).
 */

/** A fixed timestamp so test rows are deterministic. */
const T = '2026-01-01T00:00:00.000Z'

/** One minute, in ms, for staggered rows. */
const MIN = 60_000

/** ISO-8601 UTC at a fixed offset from {@link T}. */
function at(offsetMs: number): string {
  return new Date(Date.parse(T) + offsetMs).toISOString()
}

/** A run built from an explicit row list, through the real ingest path. */
function modelFrom(rows: Parameters<typeof parseAgentMessagesExport>[0]): TraceModel {
  return normalizeTrace(parseAgentMessagesExport(rows))
}

/** The kind-rank used to order the edge list, mirroring the module's canonical order. */
const RANK: Record<EdgeKind, number> = { spawn: 0, handoff: 1, message: 2 }

/** `[kind, source, target, weight]` for every edge — a compact readable shape. */
function edgeTuples(edgeModel: EdgeModel): [EdgeKind, AgentId, AgentId, number][] {
  return edgeModel.edges.map((edge) => [
    edge.kind,
    edge.source,
    edge.target,
    edge.weight,
  ])
}

// ── shape ───────────────────────────────────────────────────────────────────

describe('deriveEdgeModel — shape (M2-T4)', () => {
  it('returns a fully-formed EdgeModel (compile-checked)', () => {
    const edgeModel = deriveEdgeModel(buildFixture('fan-out').run)
    expectTypeOf(edgeModel).toEqualTypeOf<EdgeModel>()
    expectTypeOf(edgeModel.edges).toEqualTypeOf<DerivedEdge[]>()
    expect(edgeModel.edges.length).toBeGreaterThan(0)
  })

  it('pins EDGE_KINDS to exactly spawn, handoff, message', () => {
    expect(EDGE_KINDS).toEqual(['spawn', 'handoff', 'message'])
  })

  it('emits one lineage per agent, in canonical id order', () => {
    for (const fixture of FIXTURES) {
      const edgeModel = deriveEdgeModel(fixture.run)
      expect(edgeModel.agents.map((lineage) => lineage.agentId)).toEqual(
        fixture.run.agents.map((agent) => agent.id),
      )
    }
  })

  it('groups edges by kind and counts them consistently', () => {
    for (const fixture of FIXTURES) {
      const edgeModel = deriveEdgeModel(fixture.run)
      for (const kind of EDGE_KINDS) {
        expect(edgeModel.byKind[kind]).toEqual(
          edgeModel.edges.filter((edge) => edge.kind === kind),
        )
        expect(edgeModel.counts[kind]).toBe(edgeModel.byKind[kind].length)
      }
      expect(
        edgeModel.counts.spawn + edgeModel.counts.handoff + edgeModel.counts.message,
      ).toBe(edgeModel.edges.length)
    }
  })

  it('orders the edge list canonically (kind-rank, then source, then target)', () => {
    for (const fixture of FIXTURES) {
      const edgeModel = deriveEdgeModel(fixture.run)
      const keys: [number, AgentId, AgentId][] = edgeModel.edges.map((edge) => [
        RANK[edge.kind],
        edge.source,
        edge.target,
      ])
      const sorted = [...keys].sort(
        (a, b) =>
          a[0] - b[0] || compareModelIds(a[1], b[1]) || compareModelIds(a[2], b[2]),
      )
      expect(keys).toEqual(sorted)
    }
  })
})

// ── classification ──────────────────────────────────────────────────────────

describe('classifyAction — edge-kind rules (M2-T4)', () => {
  it('reads a coordination verb as a spawn', () => {
    expect(classifyAction('assign_task')).toBe('spawn')
    expect(classifyAction('start_loop')).toBe('spawn')
    expect(classifyAction('spawn_agent')).toBe('spawn')
    expect(classifyAction('delegate_work')).toBe('spawn')
    expect(classifyAction('dispatch')).toBe('spawn')
    expect(classifyAction('kickoff')).toBe('spawn')
  })

  it('reads a relay verb as a handoff, however it is spelled', () => {
    expect(classifyAction('handoff')).toBe('handoff')
    expect(classifyAction('hand_off')).toBe('handoff')
    expect(classifyAction('hand-off')).toBe('handoff')
    expect(classifyAction('relay_task')).toBe('handoff')
    expect(classifyAction('escalate')).toBe('handoff')
    expect(classifyAction('transfer')).toBe('handoff')
  })

  it('splits camelCase so assignTask is a spawn', () => {
    expect(classifyAction('assignTask')).toBe('spawn')
    expect(classifyAction('transferOwnership')).toBe('handoff')
  })

  it('treats anything else — and no action — as an ordinary message', () => {
    expect(classifyAction(null)).toBe('message')
    expect(classifyAction('')).toBe('message')
    expect(classifyAction('draft')).toBe('message')
    expect(classifyAction('revise')).toBe('message')
    expect(classifyAction('task_complete')).toBe('message')
    // A reply whose *whole* action mentions assignment is still not a spawn —
    // only the leading verb classifies.
    expect(classifyAction('assignment_complete')).toBe('message')
    expect(classifyAction('review_complete')).toBe('message')
  })

  it('checks handoff before spawn when an action matches both', () => {
    expect(classifyAction('relay_assign')).toBe('handoff')
  })

  it('exposes the verb tables it applies', () => {
    expect(SPAWN_VERBS).toContain('assign')
    expect(HANDOFF_VERBS).toContain('handoff')
  })
})

// ── per-fixture structure ───────────────────────────────────────────────────

describe('deriveEdgeModel — the four reference shapes (M2-T4)', () => {
  it('fan-out: the orchestrator spawns each of five workers, none returning', () => {
    const { run } = buildFixture('fan-out')
    const edgeModel = deriveEdgeModel(run)

    expect(edgeModel.counts).toEqual({ spawn: 5, handoff: 0, message: 0 })
    expect(
      edgeModel.byKind.spawn.map((edge) => [
        edge.source,
        edge.target,
        edge.weight,
        edge.actions,
      ]),
    ).toEqual([
      ['a_orchestrator', 'a_worker_alpha', 1, ['assign_task']],
      ['a_orchestrator', 'a_worker_beta', 1, ['assign_task']],
      ['a_orchestrator', 'a_worker_delta', 1, ['assign_task']],
      ['a_orchestrator', 'a_worker_epsilon', 1, ['assign_task']],
      ['a_orchestrator', 'a_worker_gamma', 1, ['assign_task']],
    ])

    const orchestrator = lineageOf(edgeModel, 'a_orchestrator')
    expect(orchestrator?.role).toBe('coordinator')
    expect(orchestrator?.parentId).toBeNull()
    expect(orchestrator?.childIds).toEqual([
      'a_worker_alpha',
      'a_worker_beta',
      'a_worker_delta',
      'a_worker_epsilon',
      'a_worker_gamma',
    ])
    expect(orchestrator?.fanOut).toBe(5)
    expect(edgeModel.maxFanOut).toBe(5)
    expect(edgeModel.rootIds).toEqual(['a_orchestrator'])

    for (const worker of ['alpha', 'beta', 'delta', 'epsilon', 'gamma']) {
      const lineage = lineageOf(edgeModel, `a_worker_${worker}`)
      expect(lineage?.role).toBe('worker')
      expect(lineage?.parentId).toBe('a_orchestrator')
      expect(lineage?.fanOut).toBe(0)
    }
  })

  it('loop: a kickoff spawns the researcher; the draft/revise chatter is two message edges', () => {
    const { run } = buildFixture('loop')
    const edgeModel = deriveEdgeModel(run)

    expect(edgeModel.counts).toEqual({ spawn: 1, handoff: 0, message: 2 })
    expect(edgeTuples(edgeModel)).toEqual([
      ['spawn', 'a_orchestrator', 'a_researcher', 1],
      ['message', 'a_critic', 'a_researcher', 3],
      ['message', 'a_researcher', 'a_critic', 3],
    ])
    // Direction is preserved: the back-and-forth is TWO edges, not one collapsing link.
    expect(
      edgeBetween(edgeModel, 'a_researcher', 'a_critic', 'message')?.actions,
    ).toEqual(['draft'])
    expect(
      edgeBetween(edgeModel, 'a_critic', 'a_researcher', 'message')?.actions,
    ).toEqual(['revise'])

    expect(lineageOf(edgeModel, 'a_orchestrator')?.role).toBe('coordinator')
    expect(lineageOf(edgeModel, 'a_researcher')?.role).toBe('worker')
    // The critic was never spawned, but it took part — so it is a worker.
    expect(lineageOf(edgeModel, 'a_critic')?.role).toBe('worker')
    expect(lineageOf(edgeModel, 'a_critic')?.parentId).toBeNull()
    expect(edgeModel.rootIds).toEqual(['a_critic', 'a_orchestrator'])
  })

  it('dead-branch: two spawns and a completion reply; the quiet leaf has a parent', () => {
    const { run } = buildFixture('dead-branch')
    const edgeModel = deriveEdgeModel(run)

    expect(edgeTuples(edgeModel)).toEqual([
      ['spawn', 'a_orchestrator', 'a_worker_dead', 1],
      ['spawn', 'a_orchestrator', 'a_worker_ok', 1],
      ['message', 'a_worker_ok', 'a_orchestrator', 1],
    ])
    expect(edgeModel.maxFanOut).toBe(2)
    expect(lineageOf(edgeModel, 'a_worker_dead')?.role).toBe('worker')
    expect(lineageOf(edgeModel, 'a_worker_dead')?.parentId).toBe('a_orchestrator')
    expect(lineageOf(edgeModel, 'a_worker_ok')?.role).toBe('worker')
    expect(edgeModel.rootIds).toEqual(['a_orchestrator'])
  })

  it('handoff-chain: a directed relay, no spawn, every agent a root', () => {
    const { run } = buildFixture('handoff-chain')
    const edgeModel = deriveEdgeModel(run)

    expect(edgeModel.counts).toEqual({ spawn: 0, handoff: 3, message: 0 })
    expect(edgeTuples(edgeModel)).toEqual([
      ['handoff', 'a_agent_a', 'a_agent_b', 1],
      ['handoff', 'a_agent_b', 'a_agent_c', 1],
      ['handoff', 'a_agent_c', 'a_agent_d', 1],
    ])
    // No spawn anywhere, so nobody has a parent.
    expect(edgeModel.agents.every((lineage) => lineage.parentId === null)).toBe(true)
    expect(edgeModel.rootIds).toEqual([
      'a_agent_a',
      'a_agent_b',
      'a_agent_c',
      'a_agent_d',
    ])
    // The initiator coordinates; the rest relay.
    expect(lineageOf(edgeModel, 'a_agent_a')?.role).toBe('coordinator')
    expect(lineageOf(edgeModel, 'a_agent_b')?.role).toBe('worker')
    expect(lineageOf(edgeModel, 'a_agent_d')?.role).toBe('worker')
    expect(edgeModel.maxFanOut).toBe(0)
  })
})

// ── direction, broadcasts, self-messages ─────────────────────────────────────

describe('deriveEdgeModel — direction and targets (M2-T4)', () => {
  it('keeps each direction separate (unlike the collapsed layout link)', () => {
    const edgeModel = deriveEdgeModel(buildFixture('loop').run)
    // deriveLayoutLinks would collapse this pair into one weight-6 link; here it
    // is two directed edges of weight 3 each.
    const forward = edgeBetween(edgeModel, 'a_researcher', 'a_critic', 'message')
    const backward = edgeBetween(edgeModel, 'a_critic', 'a_researcher', 'message')
    expect(forward?.weight).toBe(3)
    expect(backward?.weight).toBe(3)
  })

  it('reaches every other agent for a broadcast, and none for the sender', () => {
    const run = modelFrom([
      { id: 1, from_agent: 'alpha', to_agent: 'beta', created_at: T, body: null },
      { id: 2, from_agent: 'gamma', to_agent: null, created_at: at(MIN), body: null },
    ])
    const edgeModel = deriveEdgeModel(run)

    expect(edgeTuples(edgeModel)).toEqual([
      ['message', 'a_alpha', 'a_beta', 1],
      ['message', 'a_gamma', 'a_alpha', 1],
      ['message', 'a_gamma', 'a_beta', 1],
    ])
    // beta only ever received — no outgoing edge.
    expect(edgeModel.edges.some((edge) => edge.source === 'a_beta')).toBe(false)
  })

  it('drops a self-message: a self-link has no direction to model', () => {
    const run = modelFrom([
      {
        id: 1,
        from_agent: 'solo',
        to_agent: 'solo',
        created_at: T,
        body: '{"action":"note"}',
      },
    ])
    const edgeModel = deriveEdgeModel(run)
    expect(edgeModel.edges).toEqual([])
    expect(edgeModel.counts).toEqual({ spawn: 0, handoff: 0, message: 0 })
  })

  it('classifies an inline action-bearing message into the right edge kind', () => {
    const run = modelFrom([
      {
        id: 1,
        from_agent: 'boss',
        to_agent: 'worker',
        created_at: T,
        body: '{"action":"assign_task"}',
      },
      {
        id: 2,
        from_agent: 'worker',
        to_agent: 'boss',
        created_at: at(MIN),
        body: '{"action":"task_complete"}',
      },
      {
        id: 3,
        from_agent: 'boss',
        to_agent: 'peer',
        created_at: at(2 * MIN),
        body: '{"action":"handoff"}',
      },
    ])
    const edgeModel = deriveEdgeModel(run)
    expect(edgeModel.counts).toEqual({ spawn: 1, handoff: 1, message: 1 })
    expect(edgeBetween(edgeModel, 'a_boss', 'a_worker', 'spawn')).not.toBeNull()
    expect(edgeBetween(edgeModel, 'a_worker', 'a_boss', 'message')).not.toBeNull()
    expect(edgeBetween(edgeModel, 'a_boss', 'a_peer', 'handoff')).not.toBeNull()
  })
})

// ── lineage edge cases ───────────────────────────────────────────────────────

describe('deriveEdgeModel — lineage edge cases (M2-T4)', () => {
  it('counts an agent that only ever receives as a participant (worker)', () => {
    const run = modelFrom([
      {
        id: 1,
        from_agent: 'orchestrator',
        to_agent: 'sink',
        created_at: T,
        body: '{"action":"ping"}',
      },
    ])
    const edgeModel = deriveEdgeModel(run)
    // v1 cannot tell an external sink from a dead leaf, so it does not invent
    // the `external` role — a participant is a worker.
    expect(lineageOf(edgeModel, 'a_sink')?.role).toBe('worker')
    expect(lineageOf(edgeModel, 'a_sink')?.parentId).toBeNull()
    expect(lineageOf(edgeModel, 'a_orchestrator')?.role).toBe('coordinator')
  })

  it('assigns unknown to an agent with no edges at all', () => {
    const base = buildFixture('fan-out').run
    const withGhost: TraceModel = {
      ...base,
      agents: [
        ...base.agents,
        {
          id: 'a_ghost',
          name: 'ghost',
          role: 'unknown',
          parentId: null,
          firstSeenAt: 0,
          lastSeenAt: 0,
          messagesSent: 0,
          messagesReceived: 0,
          tokens: 0,
          costUsd: 0,
        },
      ],
    }
    const edgeModel = deriveEdgeModel(withGhost)
    expect(lineageOf(edgeModel, 'a_ghost')?.role).toBe('unknown')
    expect(lineageOf(edgeModel, 'a_ghost')?.parentId).toBeNull()
  })

  it('picks the earliest spawner when several agents spawn the same child', () => {
    const run = modelFrom([
      {
        id: 1,
        from_agent: 'boss1',
        to_agent: 'worker',
        created_at: T,
        body: '{"action":"assign_task"}',
      },
      {
        id: 2,
        from_agent: 'boss2',
        to_agent: 'worker',
        created_at: at(MIN),
        body: '{"action":"assign_task"}',
      },
    ])
    const edgeModel = deriveEdgeModel(run)
    // Both spawn edges are kept (fan-in is visible)…
    expect(edgeModel.counts.spawn).toBe(2)
    // …but the parent is the earliest, deterministically.
    expect(lineageOf(edgeModel, 'a_worker')?.parentId).toBe('a_boss1')
    expect(lineageOf(edgeModel, 'a_worker')?.role).toBe('worker')
  })

  it('throws DerivedEdgeError when the spawn edges form a cycle', () => {
    const run = modelFrom([
      {
        id: 1,
        from_agent: 'a',
        to_agent: 'b',
        created_at: T,
        body: '{"action":"spawn_agent"}',
      },
      {
        id: 2,
        from_agent: 'b',
        to_agent: 'a',
        created_at: at(MIN),
        body: '{"action":"spawn_agent"}',
      },
    ])
    expect(() => deriveEdgeModel(run)).toThrow(DerivedEdgeError)
  })

  it('is empty and well-formed for an empty run', () => {
    const edgeModel = deriveEdgeModel(modelFrom([]))
    expect(edgeModel.edges).toEqual([])
    expect(edgeModel.agents).toEqual([])
    expect(edgeModel.rootIds).toEqual([])
    expect(edgeModel.counts).toEqual({ spawn: 0, handoff: 0, message: 0 })
    expect(edgeModel.maxFanOut).toBe(0)
  })
})

// ── lookups ──────────────────────────────────────────────────────────────────

describe('edge lookups (M2-T4)', () => {
  it('lineageOf finds an agent and returns null for an absent one', () => {
    const edgeModel = deriveEdgeModel(buildFixture('fan-out').run)
    expect(lineageOf(edgeModel, 'a_orchestrator')?.role).toBe('coordinator')
    expect(lineageOf(edgeModel, 'a_nobody')).toBeNull()
  })

  it('edgeBetween is direction- and kind-specific', () => {
    const edgeModel = deriveEdgeModel(buildFixture('fan-out').run)
    expect(
      edgeBetween(edgeModel, 'a_orchestrator', 'a_worker_alpha', 'spawn'),
    ).not.toBeNull()
    // Wrong direction.
    expect(edgeBetween(edgeModel, 'a_worker_alpha', 'a_orchestrator')).toBeNull()
    // Right pair, wrong kind.
    expect(
      edgeBetween(edgeModel, 'a_orchestrator', 'a_worker_alpha', 'message'),
    ).toBeNull()
    // Any-kind lookup finds it.
    expect(edgeBetween(edgeModel, 'a_orchestrator', 'a_worker_alpha')?.kind).toBe(
      'spawn',
    )
  })
})

// ── applying lineage back onto the contract ──────────────────────────────────

describe('withDerivedLineage (M2-T4)', () => {
  it('fills in role and parentId on every agent', () => {
    const { run } = buildFixture('fan-out')
    // The raw adapter/normalizer output leaves them at their defaults.
    expect(run.agents.every((agent) => agent.role === 'unknown')).toBe(true)
    expect(run.agents.every((agent) => agent.parentId === null)).toBe(true)

    const enriched = withDerivedLineage(run)
    const orchestrator = enriched.agents.find((agent) => agent.id === 'a_orchestrator')
    const worker = enriched.agents.find((agent) => agent.id === 'a_worker_alpha')
    expect(orchestrator?.role).toBe('coordinator')
    expect(worker?.role).toBe('worker')
    expect(worker?.parentId).toBe('a_orchestrator')
  })

  it('is a fixed point of normalizeTrace (roles survive re-normalization)', () => {
    for (const fixture of FIXTURES) {
      const enriched = withDerivedLineage(fixture.run)
      expect(JSON.stringify(normalizeTrace(enriched))).toBe(JSON.stringify(enriched))
    }
  })

  it('accepts a pre-derived edge model and yields the same result', () => {
    const { run } = buildFixture('dead-branch')
    const edgeModel = deriveEdgeModel(run)
    expect(JSON.stringify(withDerivedLineage(run, edgeModel))).toBe(
      JSON.stringify(withDerivedLineage(run)),
    )
  })

  it('does not mutate the model it is given', () => {
    const { run } = buildFixture('fan-out')
    const before = JSON.stringify(run)
    withDerivedLineage(run)
    expect(JSON.stringify(run)).toBe(before)
  })
})

// ── determinism + purity ─────────────────────────────────────────────────────

describe('deriveEdgeModel — determinism (M2-T4)', () => {
  it('is byte-identical across calls', () => {
    for (const fixture of FIXTURES) {
      expect(JSON.stringify(deriveEdgeModel(fixture.run))).toBe(
        JSON.stringify(deriveEdgeModel(fixture.run)),
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
      expect(JSON.stringify(deriveEdgeModel(scrambled))).toBe(
        JSON.stringify(deriveEdgeModel(run)),
      )
    }
  })

  it('does not mutate the model', () => {
    for (const fixture of FIXTURES) {
      const before = JSON.stringify(fixture.run)
      deriveEdgeModel(fixture.run)
      expect(JSON.stringify(fixture.run)).toBe(before)
    }
  })
})

// ── purity guard ─────────────────────────────────────────────────────────────

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

describe('edge model — purity (M2-T4)', () => {
  const source = readFileSync(
    resolve(findRepoRoot(process.cwd()), 'src/layout/edges.ts'),
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

  it('is a distinct graph from the layout adjacency (no second force layout)', () => {
    expect(source).toMatch(/from '\.\.\/model\/index\.ts'/)
    expect(source).toMatch(/\bcompareModelIds\b/)
    expect(source).not.toMatch(/from '\.\/forceLayout\.ts'/)
  })
})
