import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROFILE_FRAME_BUDGET_MS,
  ProfileError,
  buildProfileReport,
  describeProfile,
  medianCost,
  measuredFrameCostMs,
  renderProfileMarkdown,
  summarizeFrameSamples,
} from './profile.ts'
import type {
  ProfileCosts,
  ProfileReport,
  ProfileScene,
  ProfileTarget,
} from './profile.ts'

/**
 * The frame-budget report (M5-T2).
 *
 * These tests pin the *reading*, not the measurement: the numbers come from a
 * probe, and what can be wrong here is how they are turned into a verdict — the
 * percentile rule, the drop-the-garbage rule, which budget each verdict rides
 * on, and the arithmetic that prices a scene with measured costs. Nothing about
 * the rendered look is asserted (jsdom has no GPU, PRD §5, and the look is
 * human-reviewed in M5-T5).
 */

const TARGET: ProfileTarget = {
  name: 'unit-test target',
  cpu: 'test cpu',
  gpu: 'test rasterizer',
  browser: 'test browser',
  runtime: 'node test',
  caveat: 'Synthetic numbers — this target exists only to test the report.',
}

const COSTS: ProfileCosts = {
  glyphMatrixNs: 200,
  nodeInstanceNs: 40,
  arcVertexNs: 2.5,
  revealMs: 0.4,
}

/** A scene with `n` nodes, `n` arcs of `sides` vertices and `g` glyphs. */
function scene(overrides: Partial<ProfileScene> = {}): ProfileScene {
  const counts = overrides.counts ?? {
    nodes: 1000,
    arcs: 999,
    glyphs: 1000,
    arcVertices: 999 * 32,
  }
  return {
    label: 'scale:1000 agents',
    agents: 1000,
    messages: 1999,
    toolCalls: 1000,
    counts,
    drawCalls: 3,
    detail: {
      tier: 'reduced',
      nodeSegments: 12,
      arcSegments: 8,
      arcSides: 4,
      glyphMax: null,
      settleIterations: 200,
    },
    ingestMs: 40,
    planMs: 900,
    costs: COSTS,
    frameWork: {
      glyphMatrixWritesPerFrame: counts.glyphs,
      nodeColorWritesPerReveal: counts.nodes,
      arcVertexWritesPerReveal: counts.arcVertices,
      estimatedCostMs: 1.2,
    },
    frameSamples: [],
    ...overrides,
  }
}

/** `count` frame deltas, all `ms`. */
function frames(count: number, ms: number): number[] {
  return Array.from({ length: count }, () => ms)
}

function report(
  overrides: Partial<Parameters<typeof buildProfileReport>[0]> = {},
): ProfileReport {
  return buildProfileReport({
    generatedAt: '2026-10-27',
    target: TARGET,
    scenes: [scene()],
    ...overrides,
  })
}

// ── frame statistics ────────────────────────────────────────────────────────

describe('summarizeFrameSamples (M5-T2)', () => {
  it('reports an unmeasured scene as unmeasured, not as fast', () => {
    const stats = summarizeFrameSamples([])
    expect(stats.measured).toBe(false)
    expect(stats.count).toBe(0)
    expect(stats.p50Ms).toBe(0)
    expect(stats.p95Ms).toBe(0)
    expect(stats.fps).toBe(0)
    // An empty sample list is not evidence of meeting the budget.
    expect(stats.withinBudget).toBe(false)
  })

  it('reads a single sample as every percentile', () => {
    const stats = summarizeFrameSamples([16])
    expect(stats.measured).toBe(true)
    expect(stats.count).toBe(1)
    expect(stats.minMs).toBe(16)
    expect(stats.p50Ms).toBe(16)
    expect(stats.p95Ms).toBe(16)
    expect(stats.p99Ms).toBe(16)
    expect(stats.maxMs).toBe(16)
    expect(stats.fps).toBe(62.5)
  })

  it('uses nearest-rank percentiles — every reported value is a real frame', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1)
    const stats = summarizeFrameSamples(samples)
    expect(stats.minMs).toBe(1)
    expect(stats.p50Ms).toBe(50)
    expect(stats.p95Ms).toBe(95)
    expect(stats.p99Ms).toBe(99)
    expect(stats.maxMs).toBe(100)
    expect(stats.meanMs).toBe(50.5)
  })

  it('does not interpolate between frames', () => {
    // 100 frames whose slowest three are 40 ms: rank 95 is the 95th value (16),
    // never the average of neighbours.
    const samples = [...frames(97, 16), 40, 41, 42]
    const stats = summarizeFrameSamples(samples)
    expect(stats.p95Ms).toBe(16)
    // p99 of 100 samples is rank 99 — the second-slowest frame, not the max.
    expect(stats.p99Ms).toBe(41)
    expect(stats.maxMs).toBe(42)
  })

  it('rides the verdict on p95, not on the mean', () => {
    // 99 fast frames and one 200 ms stall: the mean looks fine, the tail does not.
    const stats = summarizeFrameSamples([...frames(99, 10), 200])
    expect(stats.meanMs).toBeLessThan(PROFILE_FRAME_BUDGET_MS)
    expect(stats.p95Ms).toBe(10)
    expect(stats.maxMs).toBe(200)
    // p95 is still inside the budget — which is the rule, stated honestly: one
    // stall in a hundred frames does not flunk a scene, and the max shows it.
    expect(stats.withinBudget).toBe(true)
    // …but a tail that reaches 5% of frames does.
    expect(
      summarizeFrameSamples([...frames(90, 10), ...frames(10, 30)]).withinBudget,
    ).toBe(false)
  })

  it('counts the frames that missed the budget', () => {
    const stats = summarizeFrameSamples([10, 10, 17, 20, 10])
    expect(stats.overBudgetFrames).toBe(2)
    expect(stats.withinBudget).toBe(false)
  })

  it('does not call a frame exactly on the budget over it', () => {
    const stats = summarizeFrameSamples(frames(10, PROFILE_FRAME_BUDGET_MS))
    expect(stats.overBudgetFrames).toBe(0)
    expect(stats.withinBudget).toBe(true)
  })

  it('drops unusable samples and reports how many', () => {
    const stats = summarizeFrameSamples([
      16,
      Number.NaN,
      0,
      -4,
      Number.POSITIVE_INFINITY,
      16,
    ])
    expect(stats.count).toBe(2)
    expect(stats.dropped).toBe(4)
    expect(stats.p50Ms).toBe(16)
    expect(stats.maxMs).toBe(16)
  })

  it('quotes fps at the median and in the slow tail', () => {
    const stats = summarizeFrameSamples([8, 16, 33])
    expect(stats.p50Ms).toBe(16)
    expect(stats.fps).toBe(62.5)
    // Three samples: rank 95 of 3 is the slowest frame, so the tail rate is its.
    expect(stats.p95Fps).toBe(30.3)
    expect(summarizeFrameSamples([8, 16, 50]).p95Fps).toBe(20)
    expect(summarizeFrameSamples(frames(100, 20)).p95Fps).toBe(50)
  })

  it('judges against the budget it is given', () => {
    const samples = frames(100, 10)
    expect(summarizeFrameSamples(samples).withinBudget).toBe(true)
    expect(summarizeFrameSamples(samples, 8).withinBudget).toBe(false)
    expect(summarizeFrameSamples(samples, 8).budgetMs).toBe(8)
  })

  it('falls back to the frame budget for a nonsense budget', () => {
    expect(summarizeFrameSamples(frames(4, 10), 0).budgetMs).toBe(16.67)
    expect(summarizeFrameSamples(frames(4, 10), Number.NaN).budgetMs).toBe(16.67)
  })

  it('is order-independent and does not mutate the samples', () => {
    const samples = [20, 8, 16, 40, 12]
    const copy = [...samples]
    const stats = summarizeFrameSamples(samples)
    expect(samples).toEqual(copy)
    expect(summarizeFrameSamples([...samples].reverse())).toEqual(stats)
  })
})

// ── write costs ─────────────────────────────────────────────────────────────

describe('medianCost (M5-T2)', () => {
  it('takes the median of an odd batch count', () => {
    expect(medianCost([3, 1, 2])).toBe(2)
    expect(medianCost([100, 1, 2, 3, 400])).toBe(3)
  })

  it('takes the midpoint of an even batch count', () => {
    expect(medianCost([1, 2, 3, 4])).toBe(2.5)
  })

  it('rounds to a hundredth', () => {
    expect(medianCost([1.23456])).toBe(1.23)
    expect(medianCost([1, 2, 3].map((value) => value + 0.0001))).toBe(2)
  })

  it('reports at the precision the caller asks for', () => {
    // A sub-hundredth millisecond figure rounds to zero at the default precision,
    // which would read as unmeasured — so the reveal cost asks for three digits.
    expect(medianCost([0.0042])).toBe(0)
    expect(medianCost([0.0042], 3)).toBe(0.004)
    expect(medianCost([0.0042], 4)).toBe(0.0042)
  })

  it('ignores an impossible sample', () => {
    expect(medianCost([Number.NaN, 5, -1, Number.POSITIVE_INFINITY, 7])).toBe(6)
  })

  it('refuses an empty batch list', () => {
    expect(() => medianCost([])).toThrow(ProfileError)
    expect(() => medianCost([Number.NaN, -1])).toThrow(ProfileError)
  })
})

describe('measuredFrameCostMs (M5-T2)', () => {
  it('prices a scene from its own counts and the measured costs', () => {
    // 1000 glyphs × 200 ns + 1000 nodes × 40 ns + 32,000 vertices × 2.5 ns
    expect(
      measuredFrameCostMs(
        { nodes: 1000, arcs: 999, glyphs: 1000, arcVertices: 32_000 },
        COSTS,
      ),
    ).toBe(0.32)
  })

  it('prices an empty scene at zero', () => {
    expect(
      measuredFrameCostMs({ nodes: 0, arcs: 0, glyphs: 0, arcVertices: 0 }, COSTS),
    ).toBe(0)
  })

  it('treats a negative count as nothing drawn', () => {
    expect(
      measuredFrameCostMs({ nodes: -5, arcs: 0, glyphs: -1, arcVertices: 0 }, COSTS),
    ).toBe(0)
  })

  it('refuses a cost that was never measured', () => {
    const missing = { ...COSTS, glyphMatrixNs: 0 }
    expect(() =>
      measuredFrameCostMs({ nodes: 1, arcs: 0, glyphs: 1, arcVertices: 0 }, missing),
    ).toThrow(ProfileError)
    expect(() =>
      measuredFrameCostMs(
        { nodes: 1, arcs: 0, glyphs: 0, arcVertices: 0 },
        { ...COSTS, nodeInstanceNs: Number.NaN },
      ),
    ).toThrow(ProfileError)
  })

  it('scales linearly with the population', () => {
    const small = measuredFrameCostMs(
      { nodes: 500, arcs: 0, glyphs: 500, arcVertices: 0 },
      COSTS,
    )
    const large = measuredFrameCostMs(
      { nodes: 2000, arcs: 0, glyphs: 2000, arcVertices: 0 },
      COSTS,
    )
    expect(large).toBeCloseTo(small * 4, 2)
  })
})

// ── the report ──────────────────────────────────────────────────────────────

describe('buildProfileReport (M5-T2)', () => {
  it('reads one scene back with its measured cost and headroom', () => {
    const built = report()
    expect(built.scenes).toHaveLength(1)
    const reading = built.scenes[0]
    expect(reading.scene.label).toBe('scale:1000 agents')
    // 1000 × 200 ns + 1000 × 40 ns + 31,968 × 2.5 ns = 0.32 ms
    expect(reading.measuredCostMs).toBe(0.32)
    expect(reading.headroomMs).toBe(7.68)
    expect(reading.withinCpuBudget).toBe(true)
    expect(built.cpuWithinBudget).toBe(true)
  })

  it('splits the cost by write loop', () => {
    const reading = report().scenes[0]
    // Glyphs 1000 × 200 ns = 0.2 ms; nodes 1000 × 40 ns = 0.04 ms; arcs
    // 31,968 × 2.5 ns = 0.08 ms.
    expect(reading.breakdown).toEqual({
      glyphMatrixMs: 0.2,
      nodeInstanceMs: 0.04,
      arcVertexMs: 0.08,
    })
    const parts =
      reading.breakdown.glyphMatrixMs +
      reading.breakdown.nodeInstanceMs +
      reading.breakdown.arcVertexMs
    expect(parts).toBeCloseTo(reading.measuredCostMs, 2)
  })

  it('keeps the scenes in the order it was given', () => {
    const built = report({
      scenes: [
        scene({
          label: 'small',
          counts: { nodes: 10, arcs: 9, glyphs: 10, arcVertices: 288 },
        }),
        scene({ label: 'large', agents: 2000 }),
      ],
    })
    expect(built.scenes.map((reading) => reading.scene.label)).toEqual([
      'small',
      'large',
    ])
  })

  it('has no frame verdict when nothing was sampled', () => {
    const built = report()
    expect(built.frameWithinBudget).toBeNull()
    expect(built.scenes[0].frames.measured).toBe(false)
    expect(built.verdict).toContain('no browser frame samples')
    expect(built.verdict).toContain('within the 8 ms main-thread budget')
  })

  it('reads sampled frames against the frame budget', () => {
    const built = report({ scenes: [scene({ frameSamples: frames(100, 12) })] })
    expect(built.frameWithinBudget).toBe(true)
    expect(built.scenes[0].frames.p95Ms).toBe(12)
    expect(built.verdict).toContain('frames within')
  })

  it('reads a slow tail as over the frame budget', () => {
    const built = report({
      scenes: [scene({ frameSamples: [...frames(90, 12), ...frames(10, 40)] })],
    })
    expect(built.frameWithinBudget).toBe(false)
    expect(built.scenes[0].frames.withinBudget).toBe(false)
    expect(built.verdict).toContain('frames over')
  })

  it('reads a scene whose writes exceed the main-thread budget', () => {
    const built = report({
      scenes: [
        scene({
          counts: {
            nodes: 120_000,
            arcs: 100_000,
            glyphs: 20_000,
            arcVertices: 1_000_000,
          },
        }),
      ],
    })
    const reading = built.scenes[0]
    // 20,000 × 200 ns + 120,000 × 40 ns + 1,000,000 × 2.5 ns = 11.3 ms.
    expect(reading.measuredCostMs).toBe(11.3)
    expect(reading.withinCpuBudget).toBe(false)
    expect(reading.headroomMs).toBe(-3.3)
    expect(built.cpuWithinBudget).toBe(false)
    expect(built.verdict).toContain('Write cost over')
  })

  it('judges against the budgets it is given', () => {
    const built = report({ cpuBudgetMs: 0.1, frameBudgetMs: 30 })
    expect(built.cpuBudgetMs).toBe(0.1)
    expect(built.frameBudgetMs).toBe(30)
    expect(built.cpuWithinBudget).toBe(false)
  })

  it('refuses a report with nothing to report', () => {
    expect(() => report({ scenes: [] })).toThrow(ProfileError)
  })

  it('refuses a scene that measured nothing', () => {
    expect(() => report({ scenes: [scene({ agents: 0 })] })).toThrow(/draws no nodes/)
    expect(() =>
      report({
        scenes: [scene({ counts: { nodes: 0, arcs: 0, glyphs: 0, arcVertices: 0 } })],
      }),
    ).toThrow(/draws no nodes/)
  })

  it('refuses a scene with no label', () => {
    expect(() => report({ scenes: [scene({ label: '  ' })] })).toThrow(ProfileError)
  })

  it('refuses a scene with an unmeasured cost or a bad build time', () => {
    expect(() =>
      report({ scenes: [scene({ costs: { ...COSTS, arcVertexNs: 0 } })] }),
    ).toThrow(ProfileError)
    expect(() => report({ scenes: [scene({ ingestMs: -1 })] })).toThrow(ProfileError)
    expect(() => report({ scenes: [scene({ planMs: Number.NaN })] })).toThrow(
      ProfileError,
    )
  })

  it('refuses a scene with no sample list at all', () => {
    expect(() =>
      report({ scenes: [scene({ frameSamples: undefined as unknown as number[] })] }),
    ).toThrow(/no frame sample list/)
  })

  it('does not mutate the scenes it was given', () => {
    const input = scene({ frameSamples: [16, 20] })
    const snapshot = JSON.parse(JSON.stringify(input))
    report({ scenes: [input] })
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot)
  })

  it('is deterministic — the same scenes produce a byte-identical report', () => {
    const first = JSON.stringify(report())
    const second = JSON.stringify(report())
    expect(first).toBe(second)
  })

  it('defaults its title and reproduction command', () => {
    const built = report()
    expect(built.title).toContain('M5-T2')
    expect(built.command).toContain('profile-frame-budget')
    expect(built.method).toEqual([])
    expect(built.findings).toEqual([])
  })
})

// ── markdown ────────────────────────────────────────────────────────────────

describe('renderProfileMarkdown (M5-T2)', () => {
  const built = report({
    scenes: [
      scene({ label: 'scale:1000 agents', frameSamples: frames(100, 12) }),
      scene({
        label: 'scale:2000 agents',
        agents: 2000,
        counts: { nodes: 2000, arcs: 1999, glyphs: 3000, arcVertices: 1999 * 32 },
        detail: {
          tier: 'minimal',
          nodeSegments: 8,
          arcSegments: 6,
          arcSides: 3,
          glyphMax: 3000,
          settleIterations: 120,
        },
      }),
    ],
    method: ['Frame deltas sampled with requestAnimationFrame.'],
    findings: ['The glyph orbit tick dominates the per-frame write cost.'],
    command: 'node --experimental-strip-types scripts/profile-frame-budget.mjs',
  })

  it('opens with the title, the measurement date and the target', () => {
    const md = renderProfileMarkdown(built)
    expect(md.startsWith('# AgentScape — frame budget (M5-T2)')).toBe(true)
    expect(md).toContain('Measured 2026-10-27 on **unit-test target**')
    expect(md).toContain('CPU: test cpu')
    expect(md).toContain('GPU / rasterizer: test rasterizer')
    expect(md).toContain('> Synthetic numbers')
  })

  it('states the verdict and both budgets', () => {
    const md = renderProfileMarkdown(built)
    expect(md).toContain('**Verdict.** Write cost within the 8 ms main-thread budget')
    expect(md).toContain('8 ms of main-thread work per 60 fps frame')
    expect(md).toContain('16.67 ms per whole frame')
  })

  it('prints one scene row per scene with its own numbers', () => {
    const md = renderProfileMarkdown(built)
    expect(md).toContain('| scale:1000 agents | 1,000 | 1,999 | 1,000 |')
    expect(md).toContain('| scale:2000 agents | 2,000 |')
    // The capped glyph population is labelled as a cap, not silently reported.
    expect(md).toContain('(cap 3,000)')
    // Detail tier per row.
    expect(md).toContain('| reduced |')
    expect(md).toContain('| minimal |')
  })

  it('prints un-sampled scenes as not sampled and sampled ones as numbers', () => {
    const md = renderProfileMarkdown(built)
    expect(md).toContain(
      '| scale:2000 agents | — | 0 | — | — | — | — | — | — | — | not sampled |',
    )
    expect(md).toContain('| scale:1000 agents | 100 | 0 | 12.00 | 12.00 |')
  })

  it('prints the measured write costs and the model comparison', () => {
    const md = renderProfileMarkdown(built)
    expect(md).toContain(
      '| glyph matrix ns | node instance ns | arc vertex ns | reveal call ms |',
    )
    expect(md).toContain('| 200.00 | 40.00 | 2.50 | 0.400 |')
    expect(md).toContain('| scene | model ms/frame | measured ms/frame | delta ms |')
    expect(md).toContain('| 1.200 |')
  })

  it('prints where the frame goes, split by loop', () => {
    const md = renderProfileMarkdown(built)
    expect(md).toContain('## Where the frame goes')
    expect(md).toContain(
      '| scene | glyph matrices ms | node instances ms | arc vertices ms | total ms |',
    )
    // 1000 glyphs × 200 ns / 1000 nodes × 40 ns / 31,968 vertices × 2.5 ns.
    expect(md).toContain('| scale:1000 agents | 0.200 | 0.040 | 0.080 | 0.320 |')
  })

  it('prints the method, findings and reproduction command when supplied', () => {
    const md = renderProfileMarkdown(built)
    expect(md).toContain('## Method')
    expect(md).toContain('- Frame deltas sampled with requestAnimationFrame.')
    expect(md).toContain('## Findings')
    expect(md).toContain('- The glyph orbit tick dominates the per-frame write cost.')
    expect(md).toContain('## Reproduce')
    expect(md).toContain('```sh')
    expect(md).toContain(
      'node --experimental-strip-types scripts/profile-frame-budget.mjs',
    )
  })

  it('omits the optional sections when there is nothing to say', () => {
    const md = renderProfileMarkdown(report())
    expect(md).not.toContain('## Method')
    expect(md).not.toContain('## Findings')
    expect(md).toContain('## Reproduce')
  })

  it('never prints NaN, undefined or an interpolation placeholder', () => {
    const md = renderProfileMarkdown(built)
    expect(md).not.toContain('NaN')
    expect(md).not.toContain('undefined')
    expect(md).not.toContain('[object')
  })

  it('is deterministic', () => {
    expect(renderProfileMarkdown(built)).toBe(renderProfileMarkdown(built))
  })
})

describe('describeProfile (M5-T2)', () => {
  it('names every scene and the verdict on one line', () => {
    const line = describeProfile(
      report({
        scenes: [scene({ label: 'small' }), scene({ label: 'large', agents: 2000 })],
      }),
    )
    expect(line).toContain('small 0.32 ms')
    expect(line).toContain('large 0.32 ms')
    expect(line).toContain('Write cost within')
    expect(line).not.toContain('\n')
  })
})

// ── purity scan ─────────────────────────────────────────────────────────────

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

describe('profile — purity (PRD §5)', () => {
  const root = findRepoRoot(process.cwd())
  const source = readFileSync(resolve(root, 'src/scale/profile.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  it('reads no clock and no randomness', () => {
    expect(source).not.toMatch(/\bDate\.now\s*\(/)
    expect(source).not.toMatch(/\bperformance\.now\s*\(/)
    expect(source).not.toMatch(/\bMath\.random\s*\(/)
    expect(source).not.toMatch(/\bnew Date\s*\(/)
  })

  it('is a data-layer module — no React, no three.js, no DOM', () => {
    expect(source).not.toMatch(/from ['"]react['"]/)
    expect(source).not.toMatch(/from ['"]three['"]/)
    expect(source).not.toMatch(/@react-three/)
    expect(source).not.toMatch(/\bdocument\./)
    expect(source).not.toMatch(/\bwindow\./)
  })

  it('prices scenes with the frame model rather than a second constant set', () => {
    expect(source).toMatch(/from '\.\/frameWork\.ts'/)
    expect(source).toMatch(/FRAME_CPU_BUDGET_MS/)
    expect(source).not.toMatch(/\bMath\.floor\(8\b/)
  })
})
