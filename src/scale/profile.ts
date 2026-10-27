/**
 * The frame-budget profiling report (M5-T2).
 *
 * M5-T1 landed a **cost model**: `frameWork.ts` prices a composed scene's
 * per-frame writes with three measured `ns/unit` constants. This module is the
 * other half of the same claim — a *report* built from numbers that were
 * actually measured, on a stated target, with the method written down next to
 * them. It turns raw samples into the reading a person needs:
 *
 * | input | question | output |
 * |---|---|---|
 * | browser frame deltas | how fast does it really run? | p50 / p95 / p99 ms, fps, jank frames |
 * | timed write batches | what does one unit of write cost? | `ns/unit` (median of the batches) |
 * | a scene's counts | what does that cost this scene? | ms/frame, headroom, verdict |
 *
 * ## Why measured, not asserted
 *
 * A draw-call count says how many times the GPU is asked to draw; a frame time
 * says how long it took. The PRD's performance claim is "1,000–2,000 nodes at
 * interactive frame rates", so the report has to answer it in milliseconds on a
 * named target, with the sampling method disclosed — not by re-asserting the
 * cost model against itself. Every number in the report is either a raw sample
 * list or arithmetic over one.
 *
 * ## Decisions this module makes (and why)
 *
 * - **Percentiles, not means.** A frame budget is missed by the frames that are
 *   *slow*, so the verdict rides on **p95** — a mean lets one 200 ms stall hide
 *   behind 300 good frames, which is exactly the stutter a viewer notices.
 *   Nearest-rank percentile: no interpolation, so a reported p95 is always a
 *   frame time that really occurred.
 * - **Two budgets, kept apart.** M5-T1's {@link FRAME_CPU_BUDGET_MS} (8 ms) is
 *   the main-thread share of a 60 fps frame; {@link PROFILE_FRAME_BUDGET_MS}
 *   (16.67 ms) is the whole frame the browser measures, GPU and compositor
 *   included. The scene's write cost is judged against the first; a measured
 *   frame time is judged against the second. Conflating them would either excuse
 *   a 15 ms main thread or fail a scene that is fine.
 * - **Sample hygiene is a filter, not an error.** A `NaN`, an infinity or a
 *   non-positive delta (a paused tab, a clock step) is dropped from a sample
 *   list, and the drop is reported as {@link FrameStats.dropped}. Refusing the
 *   whole run over one bad sample would be worse than naming it.
 * - **The report is deterministic.** Same inputs → byte-identical report, so a
 *   committed report can be re-generated and diffed. `generatedAt` is data
 *   passed in, never read from a clock here.
 *
 * Pure (PRD §5): no clock, no randomness, no DOM, no React, no three.js, and no
 * mutation of its inputs — the module is gated by vitest and the *measurement*
 * that feeds it lives in `scripts/profile-frame-budget.mjs`.
 */

import type { FrameWork } from './frameWork.ts'
import { FRAME_CPU_BUDGET_MS } from './frameWork.ts'

// ── Budgets ─────────────────────────────────────────────────────────────────

/** A 60 fps frame, in milliseconds — the budget a measured frame is judged against. */
export const PROFILE_FRAME_BUDGET_MS = 1000 / 60

/** The percentile the interactive verdict rides on (see the module comment). */
export const PROFILE_VERDICT_PERCENTILE = 95

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown when the inputs cannot make an honest report — a scene with no counts,
 * a measured cost that is not a positive number, frame samples that are all
 * unusable. Fails loudly: a report full of zeros is worse than no report,
 * because it reads like a passing measurement.
 */
export class ProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileError'
  }
}

// ── Frame statistics ────────────────────────────────────────────────────────

/** What a list of frame deltas actually says. */
export interface FrameStats {
  /** Whether any usable sample survived (an unmeasured scene is not a fast one). */
  measured: boolean
  /** Usable samples (finite and positive). */
  count: number
  /** Samples dropped as unusable (non-finite, zero or negative). */
  dropped: number
  /** Fastest frame, ms. */
  minMs: number
  /** Median frame, ms. */
  p50Ms: number
  /** 95th percentile frame, ms — the number the verdict rides on. */
  p95Ms: number
  /** 99th percentile frame, ms. */
  p99Ms: number
  /** Slowest frame, ms. */
  maxMs: number
  /** Arithmetic mean, ms (reported for context, never for the verdict). */
  meanMs: number
  /** Frames per second at {@link FrameStats.p50Ms} — the typical rate. */
  fps: number
  /** Frames per second at {@link FrameStats.p95Ms} — the rate in the slow tail. */
  p95Fps: number
  /** Frames slower than the budget. */
  overBudgetFrames: number
  /** The budget the frames were judged against, ms. */
  budgetMs: number
  /** Whether {@link FrameStats.p95Ms} is inside the budget. */
  withinBudget: boolean
}

/** A finite, strictly positive frame delta, or `null`. */
function frameSample(value: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** Round to a hundredth of a millisecond / hundredth of a frame — report precision. */
function dp2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Nearest-rank percentile of an **ascending** array: the smallest sample that is
 * `>= p%` of the way through. No interpolation, so every reported percentile is
 * a frame time that really occurred.
 */
function percentile(ascending: readonly number[], p: number): number {
  if (ascending.length === 0) return 0
  const rank = Math.ceil((p / 100) * ascending.length)
  const index = Math.min(ascending.length - 1, Math.max(0, rank - 1))
  return ascending[index]
}

/**
 * Summarize frame deltas (ms) measured in a browser. Unusable samples are
 * dropped and counted, never silently averaged in.
 *
 * Pure: sorts a copy; the caller's array is untouched.
 */
export function summarizeFrameSamples(
  samples: readonly number[],
  budgetMs: number = PROFILE_FRAME_BUDGET_MS,
): FrameStats {
  const budget =
    typeof budgetMs === 'number' && Number.isFinite(budgetMs) && budgetMs > 0
      ? budgetMs
      : PROFILE_FRAME_BUDGET_MS

  const usable: number[] = []
  let dropped = 0
  for (const sample of samples) {
    const value = frameSample(sample)
    if (value === null) dropped += 1
    else usable.push(value)
  }

  if (usable.length === 0) {
    return {
      measured: false,
      count: 0,
      dropped,
      minMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      meanMs: 0,
      fps: 0,
      p95Fps: 0,
      overBudgetFrames: 0,
      budgetMs: dp2(budget),
      withinBudget: false,
    }
  }

  const ascending = [...usable].sort((a, b) => a - b)
  const total = usable.reduce((sum, value) => sum + value, 0)
  const mean = total / usable.length
  const p50 = percentile(ascending, 50)
  const p95 = percentile(ascending, PROFILE_VERDICT_PERCENTILE)
  let overBudgetFrames = 0
  for (const value of usable) if (value > budget) overBudgetFrames += 1

  return {
    measured: true,
    count: usable.length,
    dropped,
    minMs: dp2(ascending[0]),
    p50Ms: dp2(p50),
    p95Ms: dp2(p95),
    p99Ms: dp2(percentile(ascending, 99)),
    maxMs: dp2(ascending[ascending.length - 1]),
    meanMs: dp2(mean),
    fps: dp2(1000 / p50),
    p95Fps: dp2(1000 / p95),
    overBudgetFrames,
    budgetMs: dp2(budget),
    // The percentile comparison uses the raw value, so rounding can never flip a
    // verdict sitting exactly on the budget.
    withinBudget: p95 <= budget,
  }
}

// ── Write costs ─────────────────────────────────────────────────────────────

/** The three per-frame write loops the scene spends, plus the per-scrub reveal. */
export type WriteLoop = 'glyphMatrix' | 'nodeInstance' | 'arcVertex'

/** Measured cost of one unit of each write loop, plus one reveal lookup. */
export interface ProfileCosts {
  /** ns per glyph instance matrix (the orbit tick, every frame). */
  glyphMatrixNs: number
  /** ns per node instance (its matrix and colour, every reveal move). */
  nodeInstanceNs: number
  /** ns per arc vertex intensity (every reveal move). */
  arcVertexNs: number
  /** ms per whole `revealAt` call (one per playhead move). */
  revealMs: number
}

/**
 * Median of `samples` — the cost statistic the report uses. A median rather
 * than a mean on purpose: a single GC pause in one batch must not move the
 * reported cost of a write.
 *
 * `digits` is the report precision (2 by default, for `ns` figures); pass 3+ for
 * a millisecond figure that is genuinely small (a `revealAt` call at fixture
 * scale is microseconds, and rounding it to `0.00 ms` would read as unmeasured).
 *
 * @throws ProfileError when no usable sample exists.
 */
export function medianCost(samples: readonly number[], digits = 2): number {
  const usable = samples.filter(
    (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  )
  if (usable.length === 0) {
    throw new ProfileError('cost samples must contain at least one finite value')
  }
  const ascending = [...usable].sort((a, b) => a - b)
  const middle = ascending.length >> 1
  const median =
    ascending.length % 2 === 1
      ? ascending[middle]
      : (ascending[middle - 1] + ascending[middle]) / 2
  const factor = 10 ** Math.max(0, Math.floor(digits))
  return Math.round(median * factor) / factor
}

/**
 * The priced cost of one frame for a scene with `counts`, using **measured**
 * per-unit costs. The worst case is assumed — the glyph orbit tick and a reveal
 * write in the same frame — which is what a scrub during playback really is.
 */
export function measuredFrameCostMs(
  counts: ProfileSceneCounts,
  costs: ProfileCosts,
): number {
  const ns =
    count(counts.glyphs) * positive(costs.glyphMatrixNs, 'glyphMatrixNs') +
    count(counts.nodes) * positive(costs.nodeInstanceNs, 'nodeInstanceNs') +
    count(counts.arcVertices) * positive(costs.arcVertexNs, 'arcVertexNs')
  return dp2(ns / 1e6)
}

/**
 * {@link measuredFrameCostMs} split by loop, in ms — the answer to "where does
 * the frame go", which is what a budget conversation actually needs. Rounded to
 * a hundredth, so the three parts may differ from the total by a hundredth or
 * two; the total is the authority.
 */
export function costBreakdownMs(
  counts: ProfileSceneCounts,
  costs: ProfileCosts,
): { glyphMatrixMs: number; nodeInstanceMs: number; arcVertexMs: number } {
  return {
    glyphMatrixMs: dp2(
      (count(counts.glyphs) * positive(costs.glyphMatrixNs, 'glyphMatrixNs')) / 1e6,
    ),
    nodeInstanceMs: dp2(
      (count(counts.nodes) * positive(costs.nodeInstanceNs, 'nodeInstanceNs')) / 1e6,
    ),
    arcVertexMs: dp2(
      (count(counts.arcVertices) * positive(costs.arcVertexNs, 'arcVertexNs')) / 1e6,
    ),
  }
}

// ── Report shapes ───────────────────────────────────────────────────────────

/** What a profiled scene draws. */
export interface ProfileSceneCounts {
  nodes: number
  arcs: number
  glyphs: number
  arcVertices: number
}

/** The level-of-detail rung the scene was built at, flattened for the report. */
export interface ProfileDetail {
  tier: string
  nodeSegments: number
  arcSegments: number
  arcSides: number
  /** Glyph cap, or `null` for "every tool call". */
  glyphMax: number | null
  settleIterations: number
}

/** One profiled scene: what it is, what it cost to build, what it costs per frame. */
export interface ProfileScene {
  /** Human label for the row, e.g. `scale:2000 agents`. */
  label: string
  /** Agents / messages / tool calls in the run. */
  agents: number
  messages: number
  toolCalls: number
  /** What the scene plan draws. */
  counts: ProfileSceneCounts
  /** Geometry draw calls (M3-T5's number). */
  drawCalls: number
  /** Level-of-detail the plan resolved (M5-T1). */
  detail: ProfileDetail
  /** Time to ingest the export, ms (adapter + normalize). */
  ingestMs: number
  /** Time to compose the scene plan, ms (settle + attributes + layers) — time to first frame. */
  planMs: number
  /** The costs measured **for this scene's units**. */
  costs: ProfileCosts
  /** M5-T1's cost-model reading, for comparison with the measured one. */
  frameWork: Pick<
    FrameWork,
    | 'glyphMatrixWritesPerFrame'
    | 'nodeColorWritesPerReveal'
    | 'arcVertexWritesPerReveal'
    | 'estimatedCostMs'
  >
  /** Browser frame deltas sampled for this scene, ms (empty when not sampled). */
  frameSamples: readonly number[]
}

/** One profiled scene, read back: the numbers the report prints. */
export interface ProfileSceneReading {
  scene: ProfileScene
  /** Measured ms per worst-case frame, from this scene's own counts and costs. */
  measuredCostMs: number
  /** The same cost split by write loop — where the frame actually goes. */
  breakdown: {
    /** Glyph instance matrices, ms. */
    glyphMatrixMs: number
    /** Node instance matrices + colours, ms. */
    nodeInstanceMs: number
    /** Arc vertex intensities, ms. */
    arcVertexMs: number
  }
  /** `FRAME_CPU_BUDGET_MS − measuredCostMs`; negative when over. */
  headroomMs: number
  /** Whether the measured write cost fits the main-thread share of a frame. */
  withinCpuBudget: boolean
  /** Frame statistics from the scene's own browser samples (`measured: false` when none). */
  frames: FrameStats
}

/** The machine/engine the numbers were measured on. */
export interface ProfileTarget {
  /** One-line name, e.g. "mid-range target (authoring box, software rasterizer)". */
  name: string
  /** CPU as reported by the host. */
  cpu: string
  /** GPU / rasterizer as reported by the browser. */
  gpu: string
  /** Browser + version. */
  browser: string
  /** Runtime (Node version) for the off-browser measurements. */
  runtime: string
  /** What this target *is not* — the honesty line the report prints verbatim. */
  caveat: string
}

/** Everything the markdown renderer needs. */
export interface ProfileReport {
  /** Report title (e.g. "AgentScape — frame budget (M5-T2)"). */
  title: string
  /** ISO date the numbers were measured; data, never read from a clock. */
  generatedAt: string
  /** Where the numbers came from. */
  target: ProfileTarget
  /** The main-thread budget the write costs are judged against, ms. */
  cpuBudgetMs: number
  /** The whole-frame budget the browser samples are judged against, ms. */
  frameBudgetMs: number
  /** One reading per profiled scene, in the order supplied. */
  scenes: ProfileSceneReading[]
  /** How the samples were taken (bullets, printed verbatim). */
  method: readonly string[]
  /** What the numbers mean (bullets, printed verbatim). */
  findings: readonly string[]
  /** The command that reproduces the numbers. */
  command: string
  /** Whether every scene fits the main-thread budget. */
  cpuWithinBudget: boolean
  /**
   * Whether every *sampled* scene fits the whole-frame budget at p95.
   * `null` when no scene carried browser samples.
   */
  frameWithinBudget: boolean | null
  /** One-line verdict. */
  verdict: string
}

/** Options for {@link buildProfileReport}. */
export interface ProfileReportInput {
  title?: string
  generatedAt: string
  target: ProfileTarget
  scenes: readonly ProfileScene[]
  method?: readonly string[]
  findings?: readonly string[]
  command?: string
  cpuBudgetMs?: number
  frameBudgetMs?: number
}

// ── Validation helpers ──────────────────────────────────────────────────────

/** A finite, non-negative integer, or `0`. */
function count(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

/** A finite, positive number, or {@link ProfileError} — a cost of zero is a missing measurement. */
function positive(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ProfileError(`${field} must be a positive measured number`)
  }
  return value
}

/** A finite, non-negative number, or {@link ProfileError}. */
function nonNegative(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ProfileError(`${field} must be a finite, non-negative number`)
  }
  return value
}

// ── Building the report ─────────────────────────────────────────────────────

/**
 * Turn measured scenes into the report the markdown renderer prints.
 *
 * Validates what it depends on (a scene must have counts and positive costs, and
 * its samples must be an array) and computes every derived number from the
 * measured inputs — notably {@link measuredFrameCostMs}, which is the cost model
 * priced with *this* machine's numbers rather than M5-T1's constants.
 *
 * Pure and deterministic: same input (in the same scene order) → byte-identical
 * report; the inputs are not mutated.
 *
 * @throws ProfileError when a scene cannot be read honestly.
 */
export function buildProfileReport(input: ProfileReportInput): ProfileReport {
  if (input.scenes.length === 0) {
    throw new ProfileError('a profile report needs at least one profiled scene')
  }
  const cpuBudgetMs =
    input.cpuBudgetMs === undefined
      ? FRAME_CPU_BUDGET_MS
      : positive(input.cpuBudgetMs, 'cpuBudgetMs')
  const frameBudgetMs =
    input.frameBudgetMs === undefined
      ? PROFILE_FRAME_BUDGET_MS
      : positive(input.frameBudgetMs, 'frameBudgetMs')

  const scenes: ProfileSceneReading[] = input.scenes.map((scene) => {
    if (scene.label.trim() === '') {
      throw new ProfileError('every profiled scene needs a label')
    }
    if (count(scene.agents) === 0 || count(scene.counts.nodes) === 0) {
      throw new ProfileError(
        `scene "${scene.label}" draws no nodes — nothing was measured`,
      )
    }
    if (!Array.isArray(scene.frameSamples)) {
      throw new ProfileError(`scene "${scene.label}" has no frame sample list`)
    }
    const measuredCostMs = measuredFrameCostMs(scene.counts, scene.costs)
    nonNegative(scene.ingestMs, `${scene.label}.ingestMs`)
    nonNegative(scene.planMs, `${scene.label}.planMs`)
    const headroomMs = dp2(cpuBudgetMs - measuredCostMs)
    return {
      scene,
      measuredCostMs,
      breakdown: costBreakdownMs(scene.counts, scene.costs),
      headroomMs,
      withinCpuBudget: measuredCostMs <= cpuBudgetMs,
      frames: summarizeFrameSamples(scene.frameSamples, frameBudgetMs),
    }
  })

  const cpuWithinBudget = scenes.every((reading) => reading.withinCpuBudget)
  const sampled = scenes.filter((reading) => reading.frames.measured)
  const frameWithinBudget =
    sampled.length === 0
      ? null
      : sampled.every((reading) => reading.frames.withinBudget)

  const verdict = describeVerdict(
    cpuWithinBudget,
    frameWithinBudget,
    cpuBudgetMs,
    frameBudgetMs,
  )

  return {
    title: input.title ?? 'AgentScape — frame budget (M5-T2)',
    generatedAt: input.generatedAt,
    target: input.target,
    cpuBudgetMs: dp2(cpuBudgetMs),
    frameBudgetMs: dp2(frameBudgetMs),
    scenes,
    method: [...(input.method ?? [])],
    findings: [...(input.findings ?? [])],
    command:
      input.command ??
      'node --experimental-strip-types scripts/profile-frame-budget.mjs',
    cpuWithinBudget,
    frameWithinBudget,
    verdict,
  }
}

/** The one-line verdict, from the two verdicts. */
function describeVerdict(
  cpuWithinBudget: boolean,
  frameWithinBudget: boolean | null,
  cpuBudgetMs: number,
  frameBudgetMs: number,
): string {
  const cpu = cpuWithinBudget ? 'within' : 'over'
  if (frameWithinBudget === null) {
    return `Write cost ${cpu} the ${dp2(cpuBudgetMs)} ms main-thread budget; no browser frame samples were taken.`
  }
  const frames = frameWithinBudget ? 'within' : 'over'
  return `Write cost ${cpu} the ${dp2(cpuBudgetMs)} ms main-thread budget; measured frames ${frames} the ${dp2(frameBudgetMs)} ms frame budget at p95.`
}

// ── Markdown ────────────────────────────────────────────────────────────────

/** A number with a fixed number of decimals, `—` when it is not a real measurement. */
function num(value: number, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}

/** An integer with thousands separators. */
function int(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString('en-US')
}

/**
 * A millisecond figure at the report's precision, with a real-but-tiny value
 * printed as `<0.001` rather than `0.000` — a measured cost and a missing one
 * must never read the same.
 */
function msCell(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value === 0) return '0.000'
  if (Math.abs(value) < 0.001) return '<0.001'
  return value.toFixed(3)
}

/**
 * Render a report as markdown — the artifact committed under `docs/`.
 *
 * Deterministic string building: the same report always renders byte-identically,
 * so a committed report can be regenerated and diffed. Every number comes from
 * the report; the renderer formats and labels, and adds no claim of its own.
 */
export function renderProfileMarkdown(report: ProfileReport): string {
  const lines: string[] = []

  lines.push(`# ${report.title}`, '')
  lines.push(
    `Measured ${report.generatedAt} on **${report.target.name}**.`,
    '',
    `- CPU: ${report.target.cpu}`,
    `- GPU / rasterizer: ${report.target.gpu}`,
    `- Browser: ${report.target.browser}`,
    `- Runtime: ${report.target.runtime}`,
    '',
    `> ${report.target.caveat}`,
    '',
    `**Verdict.** ${report.verdict}`,
    '',
    `Budgets: ${report.cpuBudgetMs} ms of main-thread work per 60 fps frame; ${report.frameBudgetMs} ms per whole frame.`,
    '',
  )

  lines.push('## Scenes', '')
  lines.push(
    '| scene | agents | messages | tool calls | nodes | arcs | glyphs | arc vertices | draw calls | detail | ingest ms | plan ms | measured ms/frame | budget | verdict |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  )
  for (const reading of report.scenes) {
    const { scene } = reading
    const glyphs =
      scene.detail.glyphMax === null
        ? int(scene.counts.glyphs)
        : `${int(scene.counts.glyphs)} (cap ${int(scene.detail.glyphMax)})`
    lines.push(
      `| ${scene.label} | ${int(scene.agents)} | ${int(scene.messages)} | ${int(scene.toolCalls)} | ${int(scene.counts.nodes)} | ${int(scene.counts.arcs)} | ${glyphs} | ${int(scene.counts.arcVertices)} | ${int(scene.drawCalls)} | ${scene.detail.tier} | ${num(scene.ingestMs, 1)} | ${num(scene.planMs, 1)} | ${msCell(reading.measuredCostMs)} | ${num(reading.headroomMs, 2)} ms headroom | ${reading.withinCpuBudget ? 'within' : 'over'} |`,
    )
  }
  lines.push('')

  lines.push('## Measured browser frames', '')
  lines.push(
    '| scene | samples | dropped | p50 ms | p95 ms | p99 ms | max ms | fps (p50) | fps (p95) | frames over budget | verdict |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  )
  for (const reading of report.scenes) {
    const frames = reading.frames
    if (!frames.measured) {
      lines.push(
        `| ${reading.scene.label} | — | ${int(frames.dropped)} | — | — | — | — | — | — | — | not sampled |`,
      )
      continue
    }
    lines.push(
      `| ${reading.scene.label} | ${int(frames.count)} | ${int(frames.dropped)} | ${num(frames.p50Ms)} | ${num(frames.p95Ms)} | ${num(frames.p99Ms)} | ${num(frames.maxMs)} | ${num(frames.fps, 1)} | ${num(frames.p95Fps, 1)} | ${int(frames.overBudgetFrames)} | ${frames.withinBudget ? 'within' : 'over'} |`,
    )
  }
  lines.push('')

  lines.push('## Measured write costs', '')
  lines.push(
    'One unit each, median of repeated batches (see the method below).',
    '',
    '| scene | glyph matrix ns | node instance ns | arc vertex ns | reveal call ms |',
    '|---|---|---|---|---|',
  )
  for (const reading of report.scenes) {
    const costs = reading.scene.costs
    lines.push(
      `| ${reading.scene.label} | ${num(costs.glyphMatrixNs)} | ${num(costs.nodeInstanceNs)} | ${num(costs.arcVertexNs)} | ${num(costs.revealMs, 3)} |`,
    )
  }
  lines.push('')

  lines.push('## Where the frame goes', '')
  lines.push(
    'The same measured cost, split by write loop. Rounded to a hundredth, so the parts can differ from the total above by a hundredth.',
    '',
    '| scene | glyph matrices ms | node instances ms | arc vertices ms | total ms |',
    '|---|---|---|---|---|',
  )
  for (const reading of report.scenes) {
    const parts = reading.breakdown
    lines.push(
      `| ${reading.scene.label} | ${msCell(parts.glyphMatrixMs)} | ${msCell(parts.nodeInstanceMs)} | ${msCell(parts.arcVertexMs)} | ${msCell(reading.measuredCostMs)} |`,
    )
  }
  lines.push('')

  lines.push('## Comparison with the M5-T1 cost model', '')
  lines.push(
    "The model prices a worst-case frame from its own constants; the measured column prices the same frame with this run's samples.",
    '',
    '| scene | model ms/frame | measured ms/frame | delta ms |',
    '|---|---|---|---|',
  )
  for (const reading of report.scenes) {
    const model = reading.scene.frameWork.estimatedCostMs
    lines.push(
      `| ${reading.scene.label} | ${msCell(model)} | ${msCell(reading.measuredCostMs)} | ${num(reading.measuredCostMs - model, 3)} |`,
    )
  }
  lines.push('')

  if (report.method.length > 0) {
    lines.push('## Method', '')
    for (const line of report.method) lines.push(`- ${line}`)
    lines.push('')
  }

  if (report.findings.length > 0) {
    lines.push('## Findings', '')
    for (const line of report.findings) lines.push(`- ${line}`)
    lines.push('')
  }

  lines.push('## Reproduce', '')
  lines.push('```sh', report.command, '```', '')

  return lines.join('\n')
}

/** A one-line summary for a console or a test failure message. */
export function describeProfile(report: ProfileReport): string {
  const scenes = report.scenes
    .map((reading) => `${reading.scene.label} ${num(reading.measuredCostMs, 2)} ms`)
    .join(', ')
  return `${scenes} — ${report.verdict}`
}
