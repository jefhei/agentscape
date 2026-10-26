import { describe, expect, it } from 'vitest'
import { FIXTURES } from '../fixtures/index.ts'
import { buildScaleRun } from '../scale/index.ts'
import { FRAME_CPU_BUDGET_MS } from '../scale/index.ts'
import { DRAW_CALL_CEILING } from './budget.ts'
import { buildScenePlan } from './scenePlan.ts'
import { buildNodeScenePlan } from './nodes.ts'
import { buildArcScenePlan } from './arcs.ts'
import { buildGlyphScenePlan } from './glyphs.ts'

/**
 * The scale landing, end to end (M5-T1).
 *
 * These are the claims the task makes, measured on a **real 1–2k-agent run** built
 * through the real ingest path (`buildScaleRun` → adapter → normalizer):
 *
 *  1. the geometry budget still holds at scale — one draw call per active layer,
 *     because instancing already made the count trace-independent;
 *  2. level-of-detail actually engages, per layer, and the plan reports it;
 *  3. the per-frame work stays inside the frame ceiling;
 *  4. the scene is still deterministic — the same run yields a byte-identical
 *     layout and instance set;
 *  5. a fixture-sized run is *untouched*: the full-detail budgets are unchanged,
 *     so every M3/M4 pin still describes the scene the app draws.
 *
 * No rendered look is asserted (jsdom has no GPU, PRD §5) — the look is
 * human-reviewed (M5-T5). These tests cost a few seconds of real relaxation,
 * which is the price of measuring the scene the app would really build.
 */

/** A 1200-agent scene: the middle of the task's 1–2k target. */
const BIG_NODES = 1200

describe('scale — the composed scene at 1.2k agents (M5-T1)', () => {
  const { run } = buildScaleRun({ agents: BIG_NODES, messagesPerAgent: 2 })
  const plan = buildScenePlan(run)

  it('draws every agent and keeps the draw-call budget', () => {
    expect(plan.counts.agents).toBe(BIG_NODES)
    expect(plan.counts.nodes).toBe(BIG_NODES)
    expect(plan.counts.arcs).toBe(plan.layout.links.length)
    expect(plan.drawCalls).toBeLessThanOrEqual(DRAW_CALL_CEILING)
    expect(plan.drawCalls).toBe(3)
    expect(plan.withinBudget).toBe(true)
  })

  it('reports a level-of-detail plan that is coarser than full', () => {
    expect(plan.detail.tier).not.toBe('full')
    expect(plan.detail.counts.agents).toBe(BIG_NODES)
    // Node spheres and arc tubes are both tessellated more cheaply than the
    // full-detail fixture budget…
    expect(plan.nodes.style.segments).toBeLessThan(24)
    expect(plan.arcs.style.segments * plan.arcs.style.sides).toBeLessThan(16 * 6)
    // …and the layers were built under the very plan the scene reports.
    expect(plan.nodes.detail).toBe(plan.detail)
    expect(plan.arcs.detail).toBe(plan.detail)
    expect(plan.glyphs.detail).toBe(plan.detail)
  })

  it('bounds the glyph population and reports what it dropped', () => {
    expect(plan.glyphs.budget.total).toBe(run.meta.toolCallCount)
    expect(plan.glyphs.budget.cap).toBe(plan.detail.glyphs.max)
    expect(plan.glyphs.budget.drawn).toBe(plan.counts.glyphs)
    expect(plan.glyphs.budget.dropped).toBe(
      plan.glyphs.budget.total - plan.glyphs.budget.drawn,
    )
    expect(plan.glyphs.budget.drawn).toBeLessThanOrEqual(plan.glyphs.budget.cap)
    // The scene still reports the TRACE's tool-call count, not the drawn one.
    expect(plan.counts.toolCalls).toBe(run.meta.toolCallCount)
  })

  it('keeps the per-frame work inside the frame ceiling', () => {
    expect(plan.frameWork.writesPerFrame).toBeGreaterThan(0)
    expect(plan.frameWork.estimatedCostMs).toBeLessThanOrEqual(FRAME_CPU_BUDGET_MS)
    expect(plan.frameWork.withinBudget).toBe(true)
    expect(plan.frameWork.instances.nodes).toBe(plan.counts.nodes)
    expect(plan.frameWork.instances.glyphs).toBe(plan.counts.glyphs)
    expect(plan.frameWork.vertices.arcs).toBe(plan.arcs.vertexCount)
  })

  it('settles within the scale budget rather than the full 2000 iterations', () => {
    expect(plan.settled.iterations).toBeGreaterThan(0)
    expect(plan.settled.iterations).toBeLessThan(2000)
    expect(plan.settled.iterations).toBe(plan.detail.settlement.maxIterations)
  })

  it('is deterministic — the same run builds a byte-identical scene', () => {
    const again = buildScenePlan(
      buildScaleRun({ agents: BIG_NODES, messagesPerAgent: 2 }).run,
    )

    expect(JSON.stringify(again.layout.nodes)).toBe(JSON.stringify(plan.layout.nodes))
    expect(JSON.stringify(again.nodes.instances)).toBe(
      JSON.stringify(plan.nodes.instances),
    )
    expect(JSON.stringify(again.detail)).toBe(JSON.stringify(plan.detail))
    expect(again.settled.iterations).toBe(plan.settled.iterations)
  })

  it('places every agent distinctly, at scale', () => {
    const positions = plan.layout.nodes.map((node) => node.position)
    const keys = new Set(positions.map((p) => `${p.x},${p.y},${p.z}`))
    expect(keys.size).toBe(positions.length)
    for (const node of plan.nodes.instances) {
      expect(Number.isFinite(node.matrix[0])).toBe(true)
      expect(Number.isFinite(node.matrix[12])).toBe(true)
    }
    expect(plan.layout.bounds.radius).toBeGreaterThan(0)
  })
})

describe('scale — the top of the range, 2k agents (M5-T1)', () => {
  it('still composes a three-draw-call scene within the frame ceiling', () => {
    const { run } = buildScaleRun({ agents: 2000, messagesPerAgent: 2 })
    const plan = buildScenePlan(run)

    expect(plan.counts.nodes).toBe(2000)
    expect(plan.drawCalls).toBe(3)
    expect(plan.detail.tier).toBe('minimal')
    expect(plan.nodes.style.segments).toBe(8)
    expect(plan.frameWork.withinBudget).toBe(true)
    // The relaxation stayed bounded: the pair-work allowance dominates at 2k.
    expect(plan.settled.iterations).toBeLessThanOrEqual(
      plan.detail.settlement.maxIterations,
    )
  }, 120_000)
})

describe('scale — a fixture run is untouched (the compatibility pin)', () => {
  it('keeps the full-detail budgets for every fixture', () => {
    for (const fixture of FIXTURES) {
      const nodes = buildNodeScenePlan(fixture.run)
      const arcs = buildArcScenePlan(fixture.run)
      const glyphs = buildGlyphScenePlan(fixture.run)

      expect(nodes.detail.tier).toBe('full')
      expect(nodes.style.segments).toBe(24)
      expect(arcs.style.segments).toBe(16)
      expect(arcs.style.sides).toBe(6)
      expect(glyphs.budget.dropped).toBe(0)
      expect(glyphs.budget.drawn).toBe(fixture.run.toolCalls.length)
      expect(glyphs.detail.settlement.temperatureFloor).toBe(0)
    }
  })

  it('composes the mounted fixture at the same detail as before M5', () => {
    const plan = buildScenePlan(FIXTURES[0].run)

    expect(plan.counts.nodes).toBe(FIXTURES[0].run.meta.agentCount)
    expect(plan.nodes.style.segments).toBe(24)
    expect(plan.arcs.style.segments).toBe(16)
    expect(plan.detail.tier).toBe('full')
    expect(plan.frameWork.writesPerFrame).toBeGreaterThan(0)
    expect(plan.frameWork.withinBudget).toBe(true)
  })
})
