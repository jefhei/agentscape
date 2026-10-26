/**
 * Level-of-detail policy (M5-T1).
 *
 * The scale task's *pure* half. The PRD asks the scene to stay interactive at
 * 1–2k nodes; instancing (M3) already made the draw-call count independent of
 * the trace, so what is left at scale is **per-element cost**: how many vertices
 * an arc tube costs, how many glyphs orbit, how many subdivisions a node sphere
 * has, and how long the layout relaxation may run. This module answers all four
 * from the trace's *counts alone*, as one deterministic plan.
 *
 * ## Per-layer budgets, not one global switch
 *
 * A trace can be lopsided: fifty agents can emit a hundred thousand tool calls,
 * and a thousand agents can exchange almost nothing. Dropping a node sphere to 8
 * segments because a run has many tool calls would be a regression with no
 * benefit, so each layer gets its own ladder and its own population as the
 * driver:
 *
 * | layer | driven by | full | reduced | minimal |
 * |---|---|---|---|---|
 * | nodes | agents | 24 seg | 12 seg | 8 seg |
 * | arcs | communication links | 16×6 | 8×4 | 6×3 |
 * | glyphs | tool calls | all, detail 0 | 3000, detail 0 | 1500, detail 0 |
 * | layout | agents | 2000 iters | pair budget | pair budget |
 *
 * The plan also reports one {@link DetailPlan.tier} — the **coarsest** ladder
 * rung any layer reached — purely so a caller (a debug HUD, a test, M5-T2's
 * report) can say "this scene is running at reduced detail" in one word. No
 * decision in the codebase is keyed off that word: every layer reads its own
 * budget, so making the tier coarser never silently changes an unrelated layer.
 *
 * ## The four boundaries are decisions
 *
 * - **Nodes.** Above ~400 agents a 24×24 sphere is ~1.1k triangles each, so a
 *   1200-agent run spends >1.3M triangles on spheres that are a few pixels
 *   across. 12×12 is still round at the sizes the camera frames; 8×8 is a
 *   deliberate faceted dot for the 1500+ case. The *look* is human-reviewed
 *   (M5-T5) — these are the tiers it should review at.
 * - **Arcs.** An arc tube costs `(segments + 1) × sides` vertices, and every
 *   vertex carries seven attributes, so arc tessellation is the dominant memory
 *   term: 2400 links at 16×6 was ~50 MB of plan data before this module
 *   (measured, M5-T1). 8×4 cuts that ~3×, 6×3 ~4.5×. Fewer samples still bow
 *   correctly because the bulge is a quadratic curve, not a polyline sample.
 * - **Glyphs.** One glyph per tool call is the honest default, and below 3000
 *   calls it is also the cheap one. Above that the *most recent*
 *   {@link DetailPlan.glyphs.max} calls are drawn — a live run's tail is what a
 *   viewer is looking at, and an orbiting cloud of 40k marks is legible as
 *   nothing. The dropped count is reported, never hidden: the scene plan's
 *   `counts.toolCalls` (the trace fact) and `counts.glyphs` (what is drawn)
 *   disagree on purpose and a test pins that they do.
 * - **Layout.** The relaxation is O(n²) per iteration, so time-to-first-frame
 *   is the real scale wall, not the frame rate. The budget is expressed as a
 *   **pair-work allowance** — `iterations = budget / pairs(agents)` — which is a
 *   pure function of the agent count (so it is deterministic and identical on
 *   every machine, unlike a wall-clock budget) and lands the 1–2k range at
 *   ~2 s of relaxation. Measured (M5-T1): the shape at the budgeted iteration
 *   count is within a radius percent of the fully-relaxed shape (see
 *   `references/m5-scale.md`), and linked agents stay ~25× closer than random
 *   pairs at every tier, so the graph structure survives the truncation.
 *
 * ## Purity (PRD §5)
 *
 * Pure and deterministic: a function of the counts only — no three.js, no DOM,
 * no clock, no `Math.random`. The same counts always yield the same plan, and
 * the plan is a value (fresh objects per call), so a caller cannot mutate one
 * and confuse the next. Nothing about the rendered look is asserted in tests;
 * what *is* asserted is that detail degrades monotonically with population and
 * that the budgets are finite and sane.
 */

import type { SettlementOptions } from '../layout/index.ts'

// ── Tiers ───────────────────────────────────────────────────────────────────

/** The detail rungs, coarsest last. */
export const DETAIL_TIERS = ['full', 'reduced', 'minimal'] as const

/** One of {@link DETAIL_TIERS}. */
export type DetailTier = (typeof DETAIL_TIERS)[number]

/** Rank of a tier (0 = full); the plan reports the maximum rank it reached. */
export const DETAIL_TIER_RANK: Readonly<Record<DetailTier, number>> = {
  full: 0,
  reduced: 1,
  minimal: 2,
}

/** Rung of a per-layer ladder: apply down to `max` elements, then stop. */
interface Rung<T> {
  /** Inclusive upper bound on the layer's population for this rung. */
  max: number
  value: T
}

// ── Per-layer ladders ───────────────────────────────────────────────────────

/** Sphere width/height segments per agent count. */
export const NODE_SEGMENT_RUNGS: readonly Rung<number>[] = [
  { max: 400, value: 24 },
  { max: 1500, value: 12 },
  { max: Infinity, value: 8 },
]

/** Arc tube tessellation per link count. */
export const ARC_TESSELLATION_RUNGS: readonly Rung<{
  segments: number
  sides: number
}>[] = [
  // ≤1000 links: 102 vertices each (~100k vertices) — the fixture and ordinary
  // fleet range, and the value every M3/M4 pin was built with.
  { max: 1000, value: { segments: 16, sides: 6 } },
  // ≤5000 links: 32 vertices each (~160k) — still bowed, a third of the memory.
  { max: 5000, value: { segments: 8, sides: 4 } },
  // Beyond: a triangular prism per arc (~10k links × 21 = 210k vertices).
  { max: Infinity, value: { segments: 6, sides: 3 } },
]

/** Glyph population cap per tool-call count. */
export const GLYPH_CAP_RUNGS: readonly Rung<number>[] = [
  { max: 3000, value: Infinity },
  { max: 12000, value: 3000 },
  { max: Infinity, value: 1500 },
]

/**
 * Pair evaluations the relaxation may spend, in total. `iterations` is
 * `budget / pairs(agents)`, clamped to the layout ladder below — so the cost of
 * a scene build is bounded by a constant *pair* count rather than growing with
 * `n² × iterations`.
 */
export const SETTLE_PAIR_BUDGET = 2.0e8

/** Layout budget per agent count: iteration cap and the frozen-simulation floor. */
export const SETTLE_RUNGS: readonly Rung<{
  maxIterations: number
  temperatureFloor: number
}>[] = [
  // Below the first rung the exact M2-T2 defaults apply, untouched: the four
  // fixtures and any ordinary fleet run settle exactly as they did before this
  // module existed (this is what keeps every M1–M4 layout pin valid).
  { max: 400, value: { maxIterations: 2000, temperatureFloor: 0 } },
  { max: 1500, value: { maxIterations: 600, temperatureFloor: 1e-3 } },
  { max: Infinity, value: { maxIterations: 400, temperatureFloor: 1e-3 } },
]

/**
 * Never relax fewer than this many iterations at scale: below it the seeded
 * cloud is still a random cube and the graph structure has not shown up yet
 * (measured, M5-T1). It only binds above ~1.8k agents, where the pair budget
 * would otherwise go to zero.
 */
export const MIN_SETTLE_ITERATIONS = 120

// ── Public shapes ───────────────────────────────────────────────────────────

/** What a trace has, in the units the ladders are keyed on. */
export interface DetailCounts {
  /** Agents in the run — one node each. */
  agents: number
  /** Communication links the layout derived — one arc each. */
  links?: number
  /** Tool calls in the run — at most one glyph each. */
  toolCalls?: number
}

/** The node layer's chosen geometry. */
export interface NodeDetail {
  /** Sphere width/height segments for the one node `InstancedMesh`. */
  segments: number
}

/** The arc layer's chosen tessellation. */
export interface ArcDetail {
  /** Curve samples per arc (rings are `segments + 1`). */
  segments: number
  /** Vertices around the tube. */
  sides: number
}

/** The glyph layer's chosen population and geometry. */
export interface GlyphDetail {
  /** Octahedron subdivision level (0 = the unit octahedron). */
  detail: number
  /** Most glyphs the layer draws; `Infinity` for "every tool call". */
  max: number
}

/** The layout's chosen relaxation budget. */
export interface SettlementDetail {
  /** Iteration cap for the settlement pass. */
  maxIterations: number
  /** Temperature at/below which the simulation counts as frozen (`0` = off). */
  temperatureFloor: number
}

/** The complete level-of-detail plan for one run. */
export interface DetailPlan {
  /** The coarsest rung any layer reached — a summary, never a switch. */
  tier: DetailTier
  /** The counts the plan was resolved from (sanitized, integers). */
  counts: { agents: number; links: number; toolCalls: number; elements: number }
  /** Nodes: sphere tessellation. */
  node: NodeDetail
  /** Arcs: tube tessellation. */
  arc: ArcDetail
  /** Glyphs: population cap and geometry. */
  glyphs: GlyphDetail
  /** Layout: iteration cap and frozen-simulation floor. */
  settlement: SettlementDetail
}

/** Optional overrides for {@link resolveDetailPlan} — a caller pinning detail. */
export interface DetailOptions {
  /** Force this tier's budget for every layer (a look/dev override, or a test). */
  tier?: DetailTier
  /** Force the node sphere segments (wins over the ladder). */
  nodeSegments?: number
  /** Force the arc tessellation (wins over the ladder). */
  arc?: Partial<ArcDetail>
  /** Force the glyph cap (wins over the ladder). */
  glyphCap?: number
  /** Force the layout budget (wins over the ladder). */
  settlement?: Partial<SettlementDetail>
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** A finite, non-negative integer, or `0`. */
function count(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/** The rung that applies to `population`, or the rung of a forced tier. */
function rungFor<T>(
  rungs: readonly Rung<T>[],
  population: number,
  forced?: DetailTier,
): T {
  if (forced !== undefined) {
    return rungs[Math.min(DETAIL_TIER_RANK[forced], rungs.length - 1)].value
  }
  for (const rung of rungs) {
    if (population <= rung.max) return rung.value
  }
  // Unreachable: every ladder ends at `Infinity`. Fail loudly if one does not.
  throw new Error('detail ladder has no Infinity rung')
}

/** The tier the applicable rung corresponds to (a forced tier wins). */
function tierFor<T>(
  rungs: readonly Rung<T>[],
  population: number,
  forced?: DetailTier,
): DetailTier {
  if (forced !== undefined) return forced
  for (let index = 0; index < rungs.length; index += 1) {
    if (population <= rungs[index].max) return DETAIL_TIERS[Math.min(index, 2)]
  }
  return 'minimal'
}

/** Pairs a fully-connected relaxation of `agents` nodes would evaluate. */
export function relaxationPairs(agents: number): number {
  const n = Math.max(0, agents)
  // Explicitly zero for a degenerate run: `0 × -1 / 2` is `-0`, and a negative
  // zero in a budget reads as nonsense downstream.
  if (n < 2) return 0
  return (n * (n - 1)) / 2
}

/**
 * The relaxation iteration budget for `agents` nodes: the pair-work allowance
 * divided by the pairs one iteration evaluates, clamped to the layout ladder and
 * to {@link MIN_SETTLE_ITERATIONS}.
 *
 * Pure and machine-independent on purpose — a wall-clock budget would make the
 * settled shape depend on the viewer's CPU, which is exactly what M2-T2's
 * reproducibility rule forbids.
 */
export function settleIterationsFor(agents: number): number {
  const ladder = rungFor(SETTLE_RUNGS, count(agents)).maxIterations
  const pairs = relaxationPairs(count(agents))
  if (pairs === 0) return 0
  const budgeted = Math.floor(SETTLE_PAIR_BUDGET / pairs)
  return Math.max(Math.min(MIN_SETTLE_ITERATIONS, ladder), Math.min(ladder, budgeted))
}

/** A positive override, or the ladder value. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

/**
 * Resolve the level-of-detail plan for a trace's counts.
 *
 * Pure and deterministic: the same counts (in any order — there is only one
 * argument) always produce the same plan, and each layer's budget depends only
 * on that layer's population. Overrides win over the ladders field by field, so
 * a caller can pin one layer without restating the others.
 *
 * A run smaller than the first rung of every ladder resolves to exactly the
 * pre-M5 defaults (`24` node segments, `16×6` arcs, every glyph, `2000`
 * iterations, no floor) — that is the property that keeps the M1–M4 scene pins
 * valid, and a test asserts it.
 */
export function resolveDetailPlan(
  counts: DetailCounts,
  options: DetailOptions = {},
): DetailPlan {
  const agents = count(counts.agents)
  const links = count(counts.links)
  const toolCalls = count(counts.toolCalls)
  const elements = agents + links + toolCalls

  const forced = options.tier
  const nodeTier = tierFor(NODE_SEGMENT_RUNGS, agents, forced)
  const arcTier = tierFor(ARC_TESSELLATION_RUNGS, links, forced)
  const glyphTier = tierFor(GLYPH_CAP_RUNGS, toolCalls, forced)
  const settleTier = tierFor(SETTLE_RUNGS, agents, forced)

  const nodeSegments = Math.max(
    3,
    Math.floor(
      positive(options.nodeSegments, rungFor(NODE_SEGMENT_RUNGS, agents, forced)),
    ),
  )

  const arcLadder = rungFor(ARC_TESSELLATION_RUNGS, links, forced)
  const arc: ArcDetail = {
    segments: Math.max(
      1,
      Math.floor(positive(options.arc?.segments, arcLadder.segments)),
    ),
    sides: Math.max(3, Math.floor(positive(options.arc?.sides, arcLadder.sides))),
  }

  const glyphLadder = rungFor(GLYPH_CAP_RUNGS, toolCalls, forced)
  const glyphMax = options.glyphCap === undefined ? glyphLadder : options.glyphCap
  const glyphs: GlyphDetail = {
    detail: 0,
    max: glyphMax === Infinity ? Infinity : Math.max(0, Math.floor(glyphMax)),
  }

  const settleLadder = rungFor(SETTLE_RUNGS, agents, forced)
  const settlement: SettlementDetail = {
    // The ladder caps a run; the pair-work allowance caps it further. A
    // degenerate 0/1-agent run never relaxes, so the ladder value stands there.
    maxIterations:
      options.settlement?.maxIterations === undefined
        ? agents < 2
          ? settleLadder.maxIterations
          : Math.min(settleLadder.maxIterations, settleIterationsFor(agents))
        : Math.max(0, Math.floor(options.settlement.maxIterations)),
    temperatureFloor:
      options.settlement?.temperatureFloor === undefined
        ? settleLadder.temperatureFloor
        : Math.max(0, options.settlement.temperatureFloor),
  }

  const tier = coarsest([nodeTier, arcTier, glyphTier, settleTier])

  return {
    tier,
    counts: { agents, links, toolCalls, elements },
    node: { segments: nodeSegments },
    arc,
    glyphs,
    settlement,
  }
}

/** The coarsest of the tiers. */
function coarsest(tiers: readonly DetailTier[]): DetailTier {
  let worst: DetailTier = 'full'
  for (const tier of tiers) {
    if (DETAIL_TIER_RANK[tier] > DETAIL_TIER_RANK[worst]) worst = tier
  }
  return worst
}

/**
 * The settlement options a layer should use: the caller's explicit options win
 * field by field, and this plan fills the two the ladders own. Every other option
 * (`seed`, `decay`, `energyTolerance`, `idealDistance`) is passed through
 * untouched — the scale policy has no business overriding a caller's seed.
 *
 * This is the seam that keeps a standalone layer plan (which settles its own
 * layout) on the same budget as the composed scene (which passes one layout
 * down).
 */
export function settlementWithDetail(
  detail: DetailPlan,
  options: SettlementOptions = {},
): Required<Pick<SettlementOptions, 'maxIterations' | 'temperatureFloor'>> &
  SettlementOptions {
  return {
    ...options,
    maxIterations: options.maxIterations ?? detail.settlement.maxIterations,
    temperatureFloor: options.temperatureFloor ?? detail.settlement.temperatureFloor,
  }
}

/**
 * How many of `total` glyphs to draw under a cap: the **most recent** calls win,
 * with the canonical id order as the tie-break, so a capped plan is deterministic
 * and biased toward the live tail of the run rather than toward whichever agent
 * ids sort first.
 *
 * Pure: it returns how many to keep from the *end* of a `(time, id)`-sorted call
 * list, plus the count it dropped.
 */
export function glyphKeepCount(
  total: number,
  max: number,
): { keep: number; dropped: number } {
  const count = Math.max(0, Math.floor(total))
  if (max === Infinity) return { keep: count, dropped: 0 }
  const keep = Math.max(0, Math.min(count, Math.floor(max)))
  return { keep, dropped: count - keep }
}

/** A one-line summary for a HUD or a test failure message. */
export function describeDetail(plan: DetailPlan): string {
  const glyphs =
    plan.glyphs.max === Infinity ? 'all glyphs' : `≤${plan.glyphs.max} glyphs`
  return `${plan.tier} — nodes ${plan.node.segments}seg, arcs ${plan.arc.segments}×${plan.arc.sides}, ${glyphs}, ≤${plan.settlement.maxIterations} iters`
}
