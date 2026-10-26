import { describe, expect, it } from 'vitest'
import {
  ARC_TESSELLATION_RUNGS,
  DETAIL_TIERS,
  DETAIL_TIER_RANK,
  GLYPH_CAP_RUNGS,
  MIN_SETTLE_ITERATIONS,
  NODE_SEGMENT_RUNGS,
  SETTLE_PAIR_BUDGET,
  SETTLE_RUNGS,
  describeDetail,
  glyphKeepCount,
  relaxationPairs,
  resolveDetailPlan,
  settleIterationsFor,
  settlementWithDetail,
} from './index.ts'
import type { DetailPlan } from './index.ts'

/**
 * Level-of-detail policy tests (M5-T1).
 *
 * These gate the *data* the scale task rests on: that a small run resolves to
 * exactly the pre-M5 budgets (so every M1–M4 scene pin still holds), that detail
 * degrades monotonically as a layer's population grows, that each layer's budget
 * depends only on its own population, and that the relaxation budget is a pure,
 * bounded function of the agent count. No rendered look is asserted — jsdom has no
 * GPU (PRD §5), and the look is human-reviewed (M5-T5).
 */

/** The pre-M5 defaults this module must reproduce below its first rung. */
const LEGACY = { nodeSegments: 24, arcSegments: 16, arcSides: 6, iterations: 2000 }

/** A plan for `counts`, with the counts spread over the layers. */
function plan(agents: number, links = 0, toolCalls = 0): DetailPlan {
  return resolveDetailPlan({ agents, links, toolCalls })
}

describe('detail plan — the legacy pins (M5-T1)', () => {
  it('resolves a small run to exactly the pre-M5 budgets', () => {
    const resolved = plan(6, 5, 5)

    expect(resolved.tier).toBe('full')
    expect(resolved.node.segments).toBe(LEGACY.nodeSegments)
    expect(resolved.arc.segments).toBe(LEGACY.arcSegments)
    expect(resolved.arc.sides).toBe(LEGACY.arcSides)
    expect(resolved.glyphs.max).toBe(Infinity)
    expect(resolved.glyphs.detail).toBe(0)
    expect(resolved.settlement.maxIterations).toBe(LEGACY.iterations)
    // The frozen-simulation floor is OFF below the first rung: M2-T2's settlement
    // rule is untouched for fixtures and ordinary runs.
    expect(resolved.settlement.temperatureFloor).toBe(0)
  })

  it('stays at the legacy budgets right up to the first rung boundary', () => {
    const atBoundary = plan(400, 1000, 3000)

    expect(atBoundary.tier).toBe('full')
    expect(atBoundary.node.segments).toBe(24)
    expect(atBoundary.arc.segments).toBe(16)
    expect(atBoundary.glyphs.max).toBe(Infinity)
  })

  it('degrades one rung past each boundary', () => {
    const past = plan(401, 1001, 3001)

    expect(past.node.segments).toBe(12)
    expect(past.arc.segments).toBe(8)
    expect(past.arc.sides).toBe(4)
    expect(past.glyphs.max).toBe(3000)
    expect(past.tier).toBe('reduced')
  })
})

describe('detail plan — monotonic degradation (M5-T1)', () => {
  const populations = [1, 100, 400, 401, 1200, 1500, 1501, 2000, 5000]

  it('never increases a layer budget as its population grows', () => {
    let previous = plan(0, 0, 0)
    for (const population of populations) {
      const next = plan(population, population * 3, population * 3)
      expect(next.node.segments).toBeLessThanOrEqual(previous.node.segments)
      expect(next.arc.segments).toBeLessThanOrEqual(previous.arc.segments)
      expect(next.arc.sides).toBeLessThanOrEqual(previous.arc.sides)
      expect(next.glyphs.max).toBeLessThanOrEqual(previous.glyphs.max)
      expect(next.settlement.maxIterations).toBeLessThanOrEqual(
        previous.settlement.maxIterations,
      )
      previous = next
    }
  })

  it('never increases its reported tier as any population grows', () => {
    let rank = 0
    for (const population of populations) {
      const next = plan(population, population * 2, population * 2)
      expect(DETAIL_TIER_RANK[next.tier]).toBeGreaterThanOrEqual(rank)
      rank = DETAIL_TIER_RANK[next.tier]
    }
  })

  it('reaches every tier across the range', () => {
    const tiers = new Set(populations.map((n) => plan(n, n * 3, n * 3).tier))
    expect(tiers).toEqual(new Set(DETAIL_TIERS))
  })

  it('keeps the 1–2k target range at reduced-or-better node detail', () => {
    for (const agents of [1000, 1200, 1500, 2000]) {
      const resolved = plan(agents, agents, agents)
      expect(resolved.node.segments).toBeGreaterThanOrEqual(8)
      expect(resolved.arc.sides).toBeGreaterThanOrEqual(3)
      expect(resolved.settlement.maxIterations).toBeGreaterThan(0)
    }
  })
})

describe('detail plan — per-layer independence (M5-T1)', () => {
  it('does not coarsen nodes just because a run has many tool calls', () => {
    const manyCalls = plan(10, 9, 50_000)

    expect(manyCalls.node.segments).toBe(24)
    expect(manyCalls.arc.segments).toBe(16)
    expect(manyCalls.glyphs.max).toBe(1500)
    // The *worst* rung decides the summary tier, but no layer reads it.
    expect(manyCalls.tier).toBe('minimal')
  })

  it('does not coarsen glyphs just because a run has many agents', () => {
    const manyAgents = plan(3000, 10, 10)

    expect(manyAgents.node.segments).toBe(8)
    expect(manyAgents.glyphs.max).toBe(Infinity)
  })

  it('coarsens arcs by link count, not by agent count', () => {
    expect(plan(2000, 900, 0).arc.segments).toBe(16)
    expect(plan(5, 900, 0).arc.segments).toBe(16)
    expect(plan(5, 3000, 0).arc.segments).toBe(8)
    expect(plan(5, 20_000, 0).arc.sides).toBe(3)
  })
})

describe('detail plan — the relaxation budget (M5-T1)', () => {
  it('counts pairs the way the relaxation does', () => {
    expect(relaxationPairs(0)).toBe(0)
    expect(relaxationPairs(1)).toBe(0)
    expect(relaxationPairs(2)).toBe(1)
    expect(relaxationPairs(100)).toBe(4950)
  })

  it('is a pure, bounded function of the agent count', () => {
    for (const agents of [0, 1, 2, 400, 401, 1200, 2000, 10_000]) {
      const iterations = settleIterationsFor(agents)
      expect(iterations).toBe(settleIterationsFor(agents))
      expect(Number.isInteger(iterations)).toBe(true)
      const ladder = SETTLE_RUNGS[SETTLE_RUNGS.length - 1].value.maxIterations
      expect(iterations).toBeLessThanOrEqual(Math.max(LEGACY.iterations, ladder))
      if (agents >= 2) expect(iterations).toBeGreaterThanOrEqual(MIN_SETTLE_ITERATIONS)
    }
  })

  it('never relaxes a degenerate run', () => {
    expect(settleIterationsFor(0)).toBe(0)
    expect(settleIterationsFor(1)).toBe(0)
  })

  it('spends no more than the pair-work allowance', () => {
    for (const agents of [401, 800, 1200, 2000]) {
      const iterations = settleIterationsFor(agents)
      // The floor can push past the allowance, but only slightly: 120 steps of a
      // 2000-agent relaxation is 120 × 2·10⁶ pairs — bounded, not proportional.
      expect(iterations * relaxationPairs(agents)).toBeLessThanOrEqual(
        Math.max(SETTLE_PAIR_BUDGET, MIN_SETTLE_ITERATIONS * relaxationPairs(agents)),
      )
    }
  })

  it('shrinks as the run grows through the budgeted range', () => {
    expect(settleIterationsFor(1200)).toBeLessThan(settleIterationsFor(800))
    expect(settleIterationsFor(2000)).toBeLessThan(settleIterationsFor(1200))
  })
})

describe('detail plan — overrides and purity (M5-T1)', () => {
  it('is deterministic and does not mutate its counts argument', () => {
    const counts = { agents: 1200, links: 2400, toolCalls: 5000 }
    const first = resolveDetailPlan(counts)
    const second = resolveDetailPlan(counts)

    expect(second).toEqual(first)
    expect(counts).toEqual({ agents: 1200, links: 2400, toolCalls: 5000 })
  })

  it('sanitizes nonsense counts to a degenerate plan', () => {
    const resolved = resolveDetailPlan({
      agents: Number.NaN,
      links: -5,
      toolCalls: Number.POSITIVE_INFINITY,
    })

    expect(resolved.counts).toEqual({ agents: 0, links: 0, toolCalls: 0, elements: 0 })
    expect(resolved.settlement.maxIterations).toBe(LEGACY.iterations)
  })

  it('lets a forced tier coarsen every ladder at once', () => {
    const forced = resolveDetailPlan({ agents: 5 }, { tier: 'minimal' })

    expect(forced.tier).toBe('minimal')
    expect(forced.node.segments).toBe(8)
    expect(forced.arc.segments).toBe(6)
    expect(forced.glyphs.max).toBe(1500)
    expect(forced.settlement.temperatureFloor).toBeGreaterThan(0)
  })

  it('lets a caller pin one field without restating the others', () => {
    const pinned = resolveDetailPlan(
      { agents: 1200, links: 2400 },
      {
        nodeSegments: 20,
        arc: { sides: 5 },
        glyphCap: 42,
        settlement: { maxIterations: 7 },
      },
    )

    expect(pinned.node.segments).toBe(20)
    expect(pinned.arc.sides).toBe(5)
    expect(pinned.arc.segments).toBe(8)
    expect(pinned.glyphs.max).toBe(42)
    expect(pinned.settlement.maxIterations).toBe(7)
  })

  it('sanitizes bad overrides rather than emitting them', () => {
    const pinned = resolveDetailPlan(
      { agents: 5 },
      {
        nodeSegments: -3,
        arc: { segments: 0 },
        glyphCap: -1,
        settlement: { maxIterations: -2 },
      },
    )

    expect(pinned.node.segments).toBe(24)
    expect(pinned.arc.segments).toBe(16)
    expect(pinned.glyphs.max).toBe(0)
    expect(pinned.settlement.maxIterations).toBe(0)
  })

  it('satisfies the glyph rungs’ own ceilings', () => {
    for (const rung of GLYPH_CAP_RUNGS) {
      if (rung.max === Infinity) continue
      expect(resolveDetailPlan({ agents: 1, toolCalls: rung.max }).glyphs.max).toBe(
        rung.value,
      )
    }
  })

  it('keeps every ladder terminating in an Infinity rung', () => {
    for (const ladder of [
      NODE_SEGMENT_RUNGS,
      ARC_TESSELLATION_RUNGS,
      GLYPH_CAP_RUNGS,
      SETTLE_RUNGS,
    ]) {
      expect(ladder[ladder.length - 1].max).toBe(Infinity)
    }
  })
})

describe('settlementWithDetail (M5-T1)', () => {
  it('fills the ladder budget and keeps every other option', () => {
    const merged = settlementWithDetail(plan(1200), {
      seed: 4242,
      decay: 0.97,
      energyTolerance: 1e-9,
    })

    expect(merged.seed).toBe(4242)
    expect(merged.decay).toBe(0.97)
    expect(merged.energyTolerance).toBe(1e-9)
    expect(merged.maxIterations).toBe(plan(1200).settlement.maxIterations)
    expect(merged.temperatureFloor).toBe(plan(1200).settlement.temperatureFloor)
  })

  it('lets an explicit budget win over the ladder', () => {
    const merged = settlementWithDetail(plan(1200), {
      maxIterations: 5,
      temperatureFloor: 0,
    })

    expect(merged.maxIterations).toBe(5)
    expect(merged.temperatureFloor).toBe(0)
  })
})

describe('glyphKeepCount (M5-T1)', () => {
  it('keeps everything under an infinite cap', () => {
    expect(glyphKeepCount(12, Infinity)).toEqual({ keep: 12, dropped: 0 })
    expect(glyphKeepCount(0, Infinity)).toEqual({ keep: 0, dropped: 0 })
  })

  it('keeps the cap and reports the drop', () => {
    expect(glyphKeepCount(5000, 3000)).toEqual({ keep: 3000, dropped: 2000 })
  })

  it('never reports more than the population, and never a negative keep', () => {
    expect(glyphKeepCount(10, 50)).toEqual({ keep: 10, dropped: 0 })
    expect(glyphKeepCount(10, 0)).toEqual({ keep: 0, dropped: 10 })
    expect(glyphKeepCount(-4, 10)).toEqual({ keep: 0, dropped: 0 })
  })
})

describe('describeDetail (M5-T1)', () => {
  it('names the tier and every budget in one line', () => {
    const text = describeDetail(plan(1200, 2400, 3500))

    expect(text).toContain('reduced')
    expect(text).toContain('nodes 12seg')
    expect(text).toContain('arcs 8×4')
    expect(text).toContain('≤3000 glyphs')
    expect(text).toMatch(/iters/)
  })

  it('says "all glyphs" when the layer is uncapped', () => {
    expect(describeDetail(plan(6, 5, 5))).toContain('all glyphs')
  })
})
