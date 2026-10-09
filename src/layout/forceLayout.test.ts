import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import { FIXTURES, buildFixture } from '../fixtures/index.ts'
import type { TraceModel } from '../model/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { AgentId } from '../types/index.ts'
import {
  DEFAULT_IDEAL_DISTANCE,
  DEFAULT_ITERATIONS,
  deriveLayoutLinks,
  layoutTrace,
  positionById,
} from './index.ts'
import type { ForceLayout, LayoutLink, Vec3 } from './index.ts'

/**
 * Force-directed 3D layout tests (M2-T1).
 *
 * The layout is the pure half of the M2 "Spatial Layout Engine" (PRD §5): a
 * normalized trace in, deterministic 3D positions out. These tests gate the
 * *data* properties the render layer and the settlement/attribute tasks
 * (M2-T2/M2-T3/M2-T5) build on:
 *
 *  1. **Graph derivation** — the undirected communication graph is read off the
 *     messages (weights, broadcasts, self-messages), independently of order.
 *  2. **Determinism** — the same trace always yields a byte-identical layout,
 *     whatever order its arrays arrive in, seeded by the run's own `seed`.
 *  3. **Structure** — connected agents settle nearer than unconnected ones, and
 *     no two nodes coincide (repulsion does its job); the layout is genuinely
 *     3D.
 *  4. **Invariants & edges** — one node per agent, finite positions, bounds
 *     enclose the cloud, and the 0/1-agent cases are well-formed.
 *  5. **Purity** — no clock, no randomness, no three.js/DOM.
 *
 * No visuals are asserted — jsdom has no GPU and the look is human-held
 * (M5-T5). Only the pure half is gated.
 */

/** Position of an agent, narrowed from the nullable helper. */
function pos(layout: ForceLayout, agentId: AgentId): Vec3 {
  const found = positionById(layout, agentId)
  if (found === null) throw new Error(`missing position for ${agentId}`)
  return found
}

/** Euclidean distance between two points. */
function distance(a: Vec3, b: Vec3): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/** True when a link connects `a` and `b` (either direction). */
function isLinked(links: readonly LayoutLink[], a: AgentId, b: AgentId): boolean {
  return links.some(
    (link) =>
      (link.source === a && link.target === b) ||
      (link.source === b && link.target === a),
  )
}

/** A run built from an explicit row list, through the real ingest path. */
function modelFrom(rows: Parameters<typeof parseAgentMessagesExport>[0]): TraceModel {
  return normalizeTrace(parseAgentMessagesExport(rows))
}

// ── deriveLayoutLinks ───────────────────────────────────────────────────────

describe('deriveLayoutLinks (M2-T1)', () => {
  it('fans out to a star: one weight-1 link per worker', () => {
    const links = deriveLayoutLinks(buildFixture('fan-out').run)
    expect(links).toHaveLength(5)
    expect(links.every((link) => link.source === 'a_orchestrator')).toBe(true)
    expect(links.every((link) => link.weight === 1)).toBe(true)
    expect(links.map((link) => link.target)).toEqual([
      'a_worker_alpha',
      'a_worker_beta',
      'a_worker_delta',
      'a_worker_epsilon',
      'a_worker_gamma',
    ])
  })

  it('collapses the researcher⇄critic chatter into one weighted link', () => {
    const links = deriveLayoutLinks(buildFixture('loop').run)
    expect(links).toEqual([
      { source: 'a_critic', target: 'a_researcher', weight: 6 },
      { source: 'a_orchestrator', target: 'a_researcher', weight: 1 },
    ])
  })

  it('weights the answered edge higher than the unanswered assignment', () => {
    const links = deriveLayoutLinks(buildFixture('dead-branch').run)
    expect(links).toEqual([
      { source: 'a_orchestrator', target: 'a_worker_dead', weight: 1 },
      { source: 'a_orchestrator', target: 'a_worker_ok', weight: 2 },
    ])
  })

  it('reads the handoff chain as a directed path', () => {
    const links = deriveLayoutLinks(buildFixture('handoff-chain').run)
    expect(links).toEqual([
      { source: 'a_agent_a', target: 'a_agent_b', weight: 1 },
      { source: 'a_agent_b', target: 'a_agent_c', weight: 1 },
      { source: 'a_agent_c', target: 'a_agent_d', weight: 1 },
    ])
  })

  it('links a broadcast sender to every other agent', () => {
    const model = modelFrom([
      {
        id: 1,
        from_agent: 'hub',
        to_agent: null,
        subject: 'announce',
        created_at: '2026-01-01T00:00:00.000Z',
        body: '{"action":"announce"}',
      },
      {
        id: 2,
        from_agent: 'peer_a',
        to_agent: 'peer_a',
        subject: 'self',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 3,
        from_agent: 'peer_b',
        to_agent: 'peer_b',
        subject: 'self',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ])
    expect(deriveLayoutLinks(model)).toEqual([
      { source: 'a_hub', target: 'a_peer_a', weight: 1 },
      { source: 'a_hub', target: 'a_peer_b', weight: 1 },
    ])
  })

  it('contributes no link for a self-message', () => {
    const model = modelFrom([
      {
        id: 1,
        from_agent: 'solo',
        to_agent: 'solo',
        subject: 'note to self',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 2,
        from_agent: 'solo',
        to_agent: 'friend',
        subject: 'hello',
        created_at: '2026-01-01T00:01:00.000Z',
      },
    ])
    expect(deriveLayoutLinks(model)).toEqual([
      { source: 'a_friend', target: 'a_solo', weight: 1 },
    ])
  })

  it('is independent of message order and byte-stable', () => {
    const model = buildFixture('loop').run
    const reversed = modelFrom([...buildFixture('loop').rows].reverse())
    expect(JSON.stringify(deriveLayoutLinks(reversed))).toBe(
      JSON.stringify(deriveLayoutLinks(model)),
    )
    expect(JSON.stringify(deriveLayoutLinks(model))).toBe(
      JSON.stringify(deriveLayoutLinks(model)),
    )
  })
})

// ── layoutTrace: shape & determinism ────────────────────────────────────────

describe('layoutTrace (M2-T1)', () => {
  const model = buildFixture('fan-out').run

  it('returns a fully-formed ForceLayout (compile-checked)', () => {
    const layout = layoutTrace(model)
    expectTypeOf(layout).toEqualTypeOf<ForceLayout>()
    expect(layout.seed).toBe(model.seed)
    expect(layout.iterations).toBe(DEFAULT_ITERATIONS)
    expect(Number.isFinite(layout.energy)).toBe(true)
    expect(layout.energy).toBeGreaterThanOrEqual(0)
  })

  it('places every agent exactly once, in canonical id order', () => {
    for (const fixture of FIXTURES) {
      const layout = layoutTrace(fixture.run)
      const expected = fixture.run.agents.map((agent) => agent.id)
      expect(layout.nodes.map((node) => node.agentId)).toEqual(expected)
      expect(new Set(layout.nodes.map((node) => node.agentId)).size).toBe(
        layout.nodes.length,
      )
    }
  })

  it('uses the model seed by default and honours a seed override', () => {
    expect(layoutTrace(model).seed).toBe(model.seed)
    expect(layoutTrace(model, { seed: 42 }).seed).toBe(42)
  })

  it('is byte-identical across calls', () => {
    for (const fixture of FIXTURES) {
      expect(JSON.stringify(layoutTrace(fixture.run))).toBe(
        JSON.stringify(layoutTrace(fixture.run)),
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
      expect(JSON.stringify(layoutTrace(scrambled))).toBe(
        JSON.stringify(layoutTrace(run)),
      )
    }
  })

  it('does not mutate the model', () => {
    for (const fixture of FIXTURES) {
      const before = JSON.stringify(fixture.run)
      layoutTrace(fixture.run)
      expect(JSON.stringify(fixture.run)).toBe(before)
    }
  })

  it('positions every node finite, and no two nodes coincide', () => {
    for (const fixture of FIXTURES) {
      const layout = layoutTrace(fixture.run)
      for (const node of layout.nodes) {
        expect(Number.isFinite(node.position.x)).toBe(true)
        expect(Number.isFinite(node.position.y)).toBe(true)
        expect(Number.isFinite(node.position.z)).toBe(true)
      }
      for (let i = 0; i < layout.nodes.length; i += 1) {
        for (let j = i + 1; j < layout.nodes.length; j += 1) {
          expect(
            distance(layout.nodes[i].position, layout.nodes[j].position),
          ).toBeGreaterThan(1e-3)
        }
      }
    }
  })

  it('uses three dimensions (the cloud is not flat)', () => {
    const layout = layoutTrace(buildFixture('fan-out').run)
    const zs = layout.nodes.map((node) => node.position.z)
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(1e-3)
  })

  it('bounds enclose every node and radius is the farthest node', () => {
    for (const fixture of FIXTURES) {
      const layout = layoutTrace(fixture.run)
      const { min, max, center, radius } = layout.bounds
      let farthest = 0
      for (const node of layout.nodes) {
        const { x, y, z } = node.position
        expect(x).toBeGreaterThanOrEqual(min.x)
        expect(x).toBeLessThanOrEqual(max.x)
        expect(y).toBeGreaterThanOrEqual(min.y)
        expect(y).toBeLessThanOrEqual(max.y)
        expect(z).toBeGreaterThanOrEqual(min.z)
        expect(z).toBeLessThanOrEqual(max.z)
        farthest = Math.max(farthest, distance(node.position, center))
      }
      expect(radius).toBeCloseTo(farthest, 10)
    }
  })
})

// ── layoutTrace: emergent structure ─────────────────────────────────────────

describe('layout structure (M2-T1)', () => {
  it('settles connected agents nearer than unconnected ones (all fixtures)', () => {
    for (const fixture of FIXTURES) {
      const layout = layoutTrace(fixture.run)
      const linked: number[] = []
      const unlinked: number[] = []
      for (let i = 0; i < layout.nodes.length; i += 1) {
        for (let j = i + 1; j < layout.nodes.length; j += 1) {
          const a = layout.nodes[i]
          const b = layout.nodes[j]
          const d = distance(a.position, b.position)
          if (isLinked(layout.links, a.agentId, b.agentId)) linked.push(d)
          else unlinked.push(d)
        }
      }
      expect(linked.length).toBeGreaterThan(0)
      expect(unlinked.length).toBeGreaterThan(0)
      expect(mean(linked)).toBeLessThan(mean(unlinked))
    }
  })

  it('keeps the mean link length below the mean pairwise distance', () => {
    for (const fixture of FIXTURES) {
      const layout = layoutTrace(fixture.run)
      const linkLengths = layout.links.map((link) =>
        distance(pos(layout, link.source), pos(layout, link.target)),
      )
      const all: number[] = []
      for (let i = 0; i < layout.nodes.length; i += 1) {
        for (let j = i + 1; j < layout.nodes.length; j += 1) {
          all.push(distance(layout.nodes[i].position, layout.nodes[j].position))
        }
      }
      expect(mean(linkLengths)).toBeLessThan(mean(all))
    }
  })
})

// ── layoutTrace: edge cases & options ───────────────────────────────────────

describe('layoutTrace edge cases (M2-T1)', () => {
  it('yields an empty layout for an empty run', () => {
    const layout = layoutTrace(modelFrom([]))
    expect(layout.nodes).toEqual([])
    expect(layout.links).toEqual([])
    expect(layout.iterations).toBe(0)
    expect(layout.energy).toBe(0)
    expect(layout.bounds.radius).toBe(0)
  })

  it('sits a single agent at the origin', () => {
    const model = modelFrom([
      {
        id: 1,
        from_agent: 'solo',
        to_agent: 'solo',
        subject: 'note to self',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ])
    const layout = layoutTrace(model)
    expect(layout.nodes).toEqual([
      { agentId: 'a_solo', position: { x: 0, y: 0, z: 0 } },
    ])
    expect(layout.links).toEqual([])
    expect(layout.iterations).toBe(0)
  })

  it('still spreads apart agents that share no link', () => {
    const model = modelFrom([
      {
        id: 1,
        from_agent: 'a',
        to_agent: 'a',
        subject: 'self a',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 2,
        from_agent: 'b',
        to_agent: 'b',
        subject: 'self b',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ])
    const layout = layoutTrace(model)
    expect(layout.links).toEqual([])
    expect(layout.nodes).toHaveLength(2)
    expect(
      distance(layout.nodes[0].position, layout.nodes[1].position),
    ).toBeGreaterThan(1e-3)
  })

  it('returns the seeded initial placement at zero iterations, deterministically', () => {
    const model = buildFixture('handoff-chain').run
    const layout = layoutTrace(model, { iterations: 0 })
    expect(layout.iterations).toBe(0)
    expect(layout.energy).toBe(0)
    expect(JSON.stringify(layout)).toBe(
      JSON.stringify(layoutTrace(model, { iterations: 0 })),
    )
  })

  it('scales settled links apart with a larger ideal edge length', () => {
    const model = buildFixture('fan-out').run
    const meanLink = (layout: ForceLayout): number =>
      mean(
        layout.links.map((link) =>
          distance(pos(layout, link.source), pos(layout, link.target)),
        ),
      )
    expect(meanLink(layoutTrace(model, { idealDistance: 2 }))).toBeGreaterThan(
      meanLink(layoutTrace(model, { idealDistance: 1 })),
    )
  })

  it('produces a different shape for a different seed', () => {
    const model = buildFixture('fan-out').run
    const a = layoutTrace(model)
    const b = layoutTrace(model, { seed: model.seed + 1 })
    expect(JSON.stringify(a.nodes)).not.toBe(JSON.stringify(b.nodes))
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

describe('layout — purity (M2-T1)', () => {
  const source = readFileSync(
    resolve(findRepoRoot(process.cwd()), 'src/layout/forceLayout.ts'),
    'utf8',
  )
    // Drop comments so the module's own doc ("never Math.random …") does not
    // trip the scan — only real call sites matter.
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

  it('leans on the natural id comparator rather than a lexical sort', () => {
    expect(source).toMatch(/compareModelIds/)
  })

  it('defaults the ideal edge length to the exported constant', () => {
    expect(DEFAULT_IDEAL_DISTANCE).toBe(1)
    expect(DEFAULT_ITERATIONS).toBeGreaterThan(0)
  })
})
