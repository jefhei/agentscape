import { describe, expect, it } from 'vitest'
import {
  FRAME_CPU_BUDGET_MS,
  FRAME_RATE,
  FRAME_WRITE_COST_NS,
  measureFrameWork,
} from './index.ts'
import type { FrameScene } from './index.ts'

/**
 * Per-frame work tests (M5-T1).
 *
 * The claim the scale task makes is a *bound*: the scene's own per-frame work must
 * stay inside a frame's CPU budget at 1–2k nodes, and must not grow with the trace
 * once the LOD ladders have capped it. These tests gate that arithmetic — the
 * write units, their measured pricing, the budget verdict and the degenerate
 * shapes. They do not measure wall-clock milliseconds: jsdom has no GPU, and the
 * real frame-time report is M5-T2's.
 */

/** A scene with the given populations (arcs priced at 32 vertices each). */
function scene(
  nodes: number,
  arcs: number,
  glyphs: number,
  vertices = arcs * 32,
): FrameScene {
  return {
    counts: { nodes, arcs, glyphs, arcVertices: vertices },
    drawCalls: 3,
    postProcessPasses: 1,
  }
}

describe('measureFrameWork (M5-T1)', () => {
  it('reports nothing for an empty scene', () => {
    const work = measureFrameWork(scene(0, 0, 0, 0))

    expect(work.writesPerFrame).toBe(0)
    expect(work.writesPerSecond).toBe(0)
    expect(work.estimatedCostMs).toBe(0)
    expect(work.withinBudget).toBe(true)
    expect(work.headroomMs).toBe(FRAME_CPU_BUDGET_MS)
    expect(work.instances).toEqual({ nodes: 0, arcs: 0, glyphs: 0 })
  })

  it('adds the three write sites and nothing else', () => {
    const work = measureFrameWork(scene(10, 4, 7, 100))

    expect(work.glyphMatrixWritesPerFrame).toBe(7)
    expect(work.nodeColorWritesPerReveal).toBe(10)
    expect(work.arcVertexWritesPerReveal).toBe(100)
    expect(work.writesPerFrame).toBe(117)
    expect(work.writesPerSecond).toBe(117 * FRAME_RATE)
  })

  it('prices each write site with its own measured cost', () => {
    const work = measureFrameWork(scene(1000, 1, 1000, 10_000))
    const expectedNs =
      1000 * FRAME_WRITE_COST_NS.glyphMatrix +
      1000 * FRAME_WRITE_COST_NS.nodeColor +
      10_000 * FRAME_WRITE_COST_NS.arcVertex

    expect(work.estimatedCostMs).toBeCloseTo(expectedNs / 1e6, 1)
    expect(work.estimatedCostMs).toBeGreaterThan(0)
  })

  it('carries the scene’s own draw calls and post-process passes through', () => {
    const work = measureFrameWork(scene(10, 4, 7, 100))

    expect(work.drawCalls).toBe(3)
    expect(work.postProcessPasses).toBe(1)
  })

  it('meets the CPU budget for a 1200-node scene at the reduced detail tier', () => {
    // 1200 nodes, ~1200 links at 8×4 (32 vertices), 3000 capped glyphs — the
    // shape `resolveDetailPlan` produces for a 1200-agent run.
    const work = measureFrameWork(scene(1200, 1199, 3000, 1199 * 32))

    expect(work.estimatedCostMs).toBeLessThan(FRAME_CPU_BUDGET_MS)
    expect(work.withinBudget).toBe(true)
    expect(work.headroomMs).toBeGreaterThan(0)
    // The orbit tick dominates: a glyph matrix is ~80× the cost of a vertex write.
    expect(
      work.glyphMatrixWritesPerFrame * FRAME_WRITE_COST_NS.glyphMatrix,
    ).toBeGreaterThan(work.arcVertexWritesPerReveal * FRAME_WRITE_COST_NS.arcVertex)
  })

  it('meets the CPU budget for the 2k-agent shape', () => {
    const work = measureFrameWork(scene(2000, 1999, 3000, 1999 * 32))

    expect(work.withinBudget).toBe(true)
  })

  it('reports over-budget honestly rather than clamping', () => {
    // 60k orbit matrices is ~11.6 ms of trigonometry on its own — past the budget.
    const work = measureFrameWork(scene(400, 1000, 60_000))

    expect(work.withinBudget).toBe(false)
    expect(work.headroomMs).toBeLessThan(0)
    expect(work.estimatedCostMs).toBeGreaterThan(FRAME_CPU_BUDGET_MS)
  })

  it('grows monotonically with every population', () => {
    let previous = 0
    for (const n of [1, 10, 100, 1000, 2000]) {
      const work = measureFrameWork(scene(n, n, n, n * 21))
      expect(work.writesPerFrame).toBeGreaterThan(previous)
      previous = work.writesPerFrame
    }
  })

  it('sanitizes nonsense counts to zero', () => {
    const work = measureFrameWork({
      counts: {
        nodes: Number.NaN,
        arcs: -2,
        glyphs: Number.POSITIVE_INFINITY,
        arcVertices: -100,
      },
      drawCalls: -1,
      postProcessPasses: Number.NaN,
    })

    expect(work.writesPerFrame).toBe(0)
    expect(work.estimatedCostMs).toBe(0)
    expect(work.drawCalls).toBe(0)
    expect(work.postProcessPasses).toBe(0)
  })

  it('is a pure function of its argument', () => {
    const input = scene(1200, 1199, 3000)
    expect(measureFrameWork(input)).toEqual(measureFrameWork(input))
    expect(input.counts.nodes).toBe(1200)
  })
})
