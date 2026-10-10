import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import { FIXTURES, buildFixture } from '../fixtures/index.ts'
import type { TraceModel } from '../model/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { AgentId } from '../types/index.ts'
import {
  DEFAULT_DECAY,
  DEFAULT_ENERGY_TOLERANCE,
  DEFAULT_MAX_ITERATIONS,
  isSettled,
  layoutTrace,
  settleLayout,
} from './index.ts'
import type { ForceLayout, Settlement, Vec3 } from './index.ts'

/**
 * Layout settlement rules tests (M2-T2).
 *
 * The settlement pass is the pure half of the M2 "Spatial Layout Engine" that
 * turns a fixed-budget relaxation (M2-T1) into a *convergence-driven* one: it
 * relaxes until the forces balance and reports how it got there. These tests
 * gate the three properties the task names — over the four reference fixtures:
 *
 *  1. **Stable convergence** — the residual energy decays to `<= tolerance`
 *     (a real equilibrium) before the iteration cap.
 *  2. **No jitter** — every step is capped by a geometrically-decaying
 *     temperature, the tail movement is monotone, and the settled shape does
 *     not move.
 *  3. **Reproducible re-layout** — the pass is a pure function of the model
 *     (byte-identical, order-independent) whose result does not depend on the
 *     iteration budget once past convergence.
 *
 * No visuals are asserted — jsdom has no GPU and the look is human-held
 * (M5-T5). Only the pure half is gated.
 */

function distance(a: Vec3, b: Vec3): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** True when a link connects `a` and `b` (either direction). */
function isLinked(links: ForceLayout['links'], a: AgentId, b: AgentId): boolean {
  return links.some(
    (link) =>
      (link.source === a && link.target === b) ||
      (link.source === b && link.target === a),
  )
}

/** The initial cooling temperature for a run of `count` agents (mirrors M2-T1). */
function initialTemperature(count: number): number {
  return Math.max(1, Math.cbrt(count))
}

/** A run built from an explicit row list, through the real ingest path. */
function modelFrom(rows: Parameters<typeof parseAgentMessagesExport>[0]): TraceModel {
  return normalizeTrace(parseAgentMessagesExport(rows))
}

// ── stable convergence ──────────────────────────────────────────────────────

describe('settleLayout — stable convergence (M2-T2)', () => {
  it('returns a fully-formed Settlement (compile-checked)', () => {
    const settlement = settleLayout(buildFixture('fan-out').run)
    expectTypeOf(settlement).toEqualTypeOf<Settlement>()
    expectTypeOf(settlement.layout).toEqualTypeOf<ForceLayout>()
    expect(settlement.maxIterations).toBe(DEFAULT_MAX_ITERATIONS)
    expect(settlement.decay).toBe(DEFAULT_DECAY)
    expect(settlement.energyTolerance).toBe(DEFAULT_ENERGY_TOLERANCE)
    expect(settlement.layout.seed).toBe(buildFixture('fan-out').run.seed)
  })

  it('converges to a genuine equilibrium on every fixture', () => {
    for (const fixture of FIXTURES) {
      const settlement = settleLayout(fixture.run)
      expect(settlement.converged).toBe(true)
      // Converged *before* the cap — the rule did the stopping, not the budget.
      expect(settlement.iterations).toBeGreaterThan(0)
      expect(settlement.iterations).toBeLessThan(settlement.maxIterations)
      // The residual force is at/below the tolerance: the forces balance.
      expect(settlement.finalEnergy).toBeLessThanOrEqual(settlement.energyTolerance)
      expect(settlement.layout.energy).toBe(settlement.finalEnergy)
      expect(isSettled(settlement.layout)).toBe(true)
    }
  })

  it('records the full convergence and jitter trace', () => {
    for (const fixture of FIXTURES) {
      const settlement = settleLayout(fixture.run)
      expect(settlement.energyHistory).toHaveLength(settlement.iterations)
      expect(settlement.movementHistory).toHaveLength(settlement.iterations)
      expect(settlement.layout.iterations).toBe(settlement.iterations)
      expect(settlement.energyHistory.at(-1)).toBe(settlement.finalEnergy)
      expect(settlement.movementHistory.at(-1)).toBe(settlement.finalMovement)
    }
  })

  it('descends: the residual force falls from its initial peak', () => {
    for (const fixture of FIXTURES) {
      const { energyHistory, finalEnergy } = settleLayout(fixture.run)
      expect(energyHistory[0]).toBeGreaterThan(finalEnergy)
      // The last stretch is all small — it has genuinely settled, not just stopped.
      expect(Math.max(...energyHistory.slice(-10))).toBeLessThan(1e-3)
    }
  })

  it('settles a looser tolerance no later than a tighter one', () => {
    for (const fixture of FIXTURES) {
      const loose = settleLayout(fixture.run, { energyTolerance: 1e-2 })
      const tight = settleLayout(fixture.run, { energyTolerance: 1e-8 })
      // Stopping set for the loose rule is a superset of the tight rule's, so
      // its first crossing can never come later.
      expect(loose.iterations).toBeLessThanOrEqual(tight.iterations)
      // Each stops with its own residual force at or below its own threshold.
      expect(loose.finalEnergy).toBeLessThanOrEqual(1e-2)
      expect(tight.finalEnergy).toBeLessThanOrEqual(1e-8)
    }
  })

  it('settles degenerate runs immediately', () => {
    const empty = settleLayout(modelFrom([]))
    expect(empty.converged).toBe(true)
    expect(empty.iterations).toBe(0)
    expect(empty.layout.nodes).toEqual([])
    expect(empty.finalEnergy).toBe(0)
    expect(empty.energyHistory).toEqual([])

    const solo = modelFrom([
      {
        id: 1,
        from_agent: 'solo',
        to_agent: 'solo',
        subject: 'note to self',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ])
    const settlement = settleLayout(solo)
    expect(settlement.converged).toBe(true)
    expect(settlement.iterations).toBe(0)
    expect(settlement.layout.nodes).toEqual([
      { agentId: 'a_solo', position: { x: 0, y: 0, z: 0 } },
    ])
  })

  it('never runs past the cap, and reports an unconverged layout honestly', () => {
    const fixture = buildFixture('fan-out').run
    const clipped = settleLayout(fixture, { maxIterations: 5 })
    expect(clipped.iterations).toBe(5)
    expect(clipped.converged).toBe(false)
    expect(clipped.energyHistory).toHaveLength(5)
    expect(clipped.layout.iterations).toBe(5)
    // A configuration with no finite equilibrium is *not* settled — reported,
    // never faked. Two agents that never talk only repel, so the residual force
    // never reaches zero at any finite distance.
    const unlinked = settleLayout(
      modelFrom([
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
      ]),
    )
    expect(unlinked.converged).toBe(false)
    expect(unlinked.finalEnergy).toBeGreaterThan(0)
    // …but the frozen configuration is still well-formed.
    expect(unlinked.layout.nodes).toHaveLength(2)
  })
})

// ── no jitter ───────────────────────────────────────────────────────────────

describe('settleLayout — no jitter (M2-T2)', () => {
  it('caps every step by that step’s (geometrically decaying) temperature', () => {
    for (const fixture of FIXTURES) {
      const settlement = settleLayout(fixture.run)
      const half = initialTemperature(fixture.run.agents.length)
      settlement.movementHistory.forEach((movement, iter) => {
        const temperature = half * settlement.decay ** iter
        // No node ever moves further than the current temperature.
        expect(movement).toBeLessThanOrEqual(temperature + 1e-12)
      })
      // The final step is bounded by the last temperature — tiny by construction.
      const lastTemperature = half * settlement.decay ** (settlement.iterations - 1)
      expect(settlement.finalMovement).toBeLessThanOrEqual(lastTemperature + 1e-12)
      expect(settlement.finalMovement).toBeLessThan(1e-5)
    }
  })

  it('decays the movement: the tail is monotone and never oscillates', () => {
    for (const fixture of FIXTURES) {
      const { movementHistory } = settleLayout(fixture.run)
      expect(movementHistory.at(-1)!).toBeLessThan(movementHistory[0])
      // Once the temperature cap binds, movement is strictly non-increasing —
      // the shape cannot jitter back and forth at the end.
      const tail = movementHistory.slice(-100)
      for (let i = 1; i < tail.length; i += 1) {
        expect(tail[i]).toBeLessThanOrEqual(tail[i - 1] + 1e-15)
      }
    }
  })

  it('stops moving: a far larger budget settles to the identical shape', () => {
    for (const fixture of FIXTURES) {
      const settled = settleLayout(fixture.run).layout
      const roomier = settleLayout(fixture.run, { maxIterations: 5000 }).layout
      // If the shape were still creeping, more headroom would move it.
      expect(JSON.stringify(roomier.nodes)).toBe(JSON.stringify(settled.nodes))
    }
  })

  it('is idempotent and does not mutate the model', () => {
    for (const fixture of FIXTURES) {
      const before = JSON.stringify(fixture.run)
      const first = settleLayout(fixture.run)
      const second = settleLayout(fixture.run)
      expect(JSON.stringify(first)).toBe(JSON.stringify(second))
      expect(JSON.stringify(fixture.run)).toBe(before)
    }
  })
})

// ── reproducible re-layout ──────────────────────────────────────────────────

describe('settleLayout — reproducible re-layout (M2-T2)', () => {
  it('is byte-identical across calls', () => {
    for (const fixture of FIXTURES) {
      expect(JSON.stringify(settleLayout(fixture.run))).toBe(
        JSON.stringify(settleLayout(fixture.run)),
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
      expect(JSON.stringify(settleLayout(scrambled))).toBe(
        JSON.stringify(settleLayout(run)),
      )
    }
  })

  it('is budget-independent: the settled shape ignores the cap', () => {
    for (const fixture of FIXTURES) {
      const baseline = JSON.stringify(settleLayout(fixture.run).layout.nodes)
      for (const maxIterations of [1500, 3000, 8000]) {
        expect(
          JSON.stringify(settleLayout(fixture.run, { maxIterations }).layout.nodes),
        ).toBe(baseline)
      }
    }
  })

  it('defaults the seed to the model’s and honours an override', () => {
    const model = buildFixture('fan-out').run
    expect(settleLayout(model).layout.seed).toBe(model.seed)
    expect(settleLayout(model, { seed: 7 }).layout.seed).toBe(7)
    expect(JSON.stringify(settleLayout(model, { seed: 7 }).layout.nodes)).not.toBe(
      JSON.stringify(settleLayout(model).layout.nodes),
    )
  })

  it('places every agent once, in canonical order, still structurally true', () => {
    for (const fixture of FIXTURES) {
      const layout = settleLayout(fixture.run).layout
      expect(layout.nodes.map((node) => node.agentId)).toEqual(
        fixture.run.agents.map((agent) => agent.id),
      )
      expect(new Set(layout.nodes.map((node) => node.agentId)).size).toBe(
        layout.nodes.length,
      )

      // Settlement must not break the shape: connected agents still settle
      // nearer than unconnected ones (the property M2-T1 established).
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
})

// ── isSettled ───────────────────────────────────────────────────────────────

describe('isSettled (M2-T2)', () => {
  it('is false for a fixed-budget layout, true for a settled one', () => {
    for (const fixture of FIXTURES) {
      // M2-T1's default 300-iteration layout freezes while forces remain.
      expect(isSettled(layoutTrace(fixture.run))).toBe(false)
      expect(isSettled(settleLayout(fixture.run).layout)).toBe(true)
    }
  })

  it('treats a trivial layout as settled and honours a tolerance override', () => {
    const empty = layoutTrace(modelFrom([]))
    expect(isSettled(empty)).toBe(true)

    const layout = layoutTrace(buildFixture('fan-out').run)
    expect(isSettled(layout, layout.energy + 1)).toBe(true)
    expect(isSettled(layout, layout.energy / 2)).toBe(false)
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

describe('settlement — purity (M2-T2)', () => {
  const source = readFileSync(
    resolve(findRepoRoot(process.cwd()), 'src/layout/settlement.ts'),
    'utf8',
  )
    // Drop comments so the module's own doc (“never Math.random …”) does not
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

  it('drives the shared simulation core rather than a second force law', () => {
    // One physics for both primitives: the settlement pass must reuse M2-T1's
    // prepared state, step and layout builders.
    expect(source).toMatch(/from '\.\/forceLayout\.ts'/)
    expect(source).toMatch(/\bprepareSimulation\b/)
    expect(source).toMatch(/\brelaxIteration\b/)
    expect(source).toMatch(/\bbuildLayout\b/)
  })
})
