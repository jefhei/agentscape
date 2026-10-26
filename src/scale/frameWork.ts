/**
 * Per-frame work of a composed scene (M5-T1) — the **measured, not asserted**
 * half of "scale to 1–2k nodes".
 *
 * A draw-call count (M3-T5) says how many times the GPU is asked to draw; it says
 * nothing about how much *work per frame* the scene implies. At 1–2k nodes the
 * cost that actually shows up on the main thread comes from exactly three places,
 * all of them countable from a plan:
 *
 * | work | when | unit | measured cost |
 * |---|---|---|---|
 * | glyph instance matrices | every frame (the orbit tick) | one 4×4 matrix per glyph | 193 ns |
 * | arc vertex intensities | every playhead move (the reveal) | one float per arc vertex | 2.5 ns |
 * | node instance colours | every playhead move (the reveal) | one RGB per node | 2.1 ns |
 *
 * Node *matrices* are not on the list on purpose: the layout is settled, so they
 * are written once when the plan is mounted (M3-T1), not per frame. The three
 * per-unit costs were measured on the authoring box by timing the real loops
 * (glyph matrices through {@link writeGlyphMatrices}, the other two as the plain
 * typed-array writes the reveal performs); they are constants of *this* model, not
 * a claim about any other machine — M5-T2's profiling report is where real frame
 * times on a mid-range target land.
 *
 * ## Why a cost model instead of a profiler
 *
 * jsdom has no GPU and a cron run has no browser, so this module cannot time a
 * frame. What it *can* do — and what catches the regression that matters — is turn
 * a plan into the work units the render layer will spend, and price them with
 * measured constants. A change that makes per-frame work grow with the trace again
 * (say, a per-frame rebuild over every glyph) shows up here as a cost that scales
 * with the run instead of one bounded by the LOD caps.
 *
 * {@link FRAME_CPU_BUDGET_MS} is half of a 60 fps frame: the rest belongs to the
 * GPU, React and the browser. It is a **report**, not a prohibition — a
 * pathologically dense run can exceed it, and `withinBudget: false` is the honest
 * reading. Hiding arcs to fit the number would hide the structure the product
 * exists to show.
 *
 * Pure and deterministic: a function of its argument only, no clock, no DOM, no
 * three.js. Nothing about the rendered *look* is asserted here.
 */

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Main-thread budget for the scene's own per-frame writes, in milliseconds:
 * half of a 60 fps frame, so the GPU, React and the browser get the other half.
 */
export const FRAME_CPU_BUDGET_MS = 8

/** Frames per second the per-second figures are quoted at. */
export const FRAME_RATE = 60

/**
 * Measured cost of one write unit, in nanoseconds. See the module table for what
 * each loop is; re-measure with the probe described in `references/m5-scale.md` if
 * the render layer's hot loops change shape.
 */
export const FRAME_WRITE_COST_NS = {
  /** One glyph's orbit matrix (two trig calls + 16 float writes). */
  glyphMatrix: 193,
  /** One arc vertex's intensity (a typed-array read, multiply, write). */
  arcVertex: 2.5,
  /** One node's instance colour (three multiplies and writes). */
  nodeColor: 2.1,
} as const

// ── Public shapes ───────────────────────────────────────────────────────────

/** What a composed scene draws, in the units the per-frame work is derived from. */
export interface FrameCounts {
  /** Node instances (one per drawn agent). */
  nodes: number
  /** Arc tubes (one per communication link). */
  arcs: number
  /** Glyph instances (one per drawn tool call). */
  glyphs: number
  /** Vertices in the arc layer's one batched geometry. */
  arcVertices: number
}

/** A composed scene, as far as the frame budget is concerned. */
export interface FrameScene {
  /** The scene's counts (`ScenePlan.counts` plus the arc vertex count). */
  counts: FrameCounts
  /** Geometry draw calls the scene costs (`ScenePlan.drawCalls`). */
  drawCalls: number
  /** Full-screen post-processing passes (`ScenePlan.postProcessPasses`). */
  postProcessPasses: number
}

/** The per-frame work a plan implies. */
export interface FrameWork {
  /** Geometry draw calls across every layer (M3-T5's number, carried for context). */
  drawCalls: number
  /** Full-screen post-processing passes (bloom), a fixed cost. */
  postProcessPasses: number
  /** Instances drawn, by layer. */
  instances: { nodes: number; arcs: number; glyphs: number }
  /** Vertices drawn in the arc layer's one buffer. */
  vertices: { arcs: number }
  /** Instance matrices rewritten on **every** frame (the glyph orbit tick). */
  glyphMatrixWritesPerFrame: number
  /** Arc vertex intensities rewritten when the playhead moves (the reveal). */
  arcVertexWritesPerReveal: number
  /** Node instance colours rewritten when the playhead moves (the reveal). */
  nodeColorWritesPerReveal: number
  /** Total write units in the worst case (orbit tick plus reveal). */
  writesPerFrame: number
  /** {@link FrameWork.writesPerFrame} at {@link FRAME_RATE}. */
  writesPerSecond: number
  /** The priced cost of {@link FrameWork.writesPerFrame}, in milliseconds. */
  estimatedCostMs: number
  /** The main-thread budget this cost is judged against. */
  budgetMs: number
  /** `budgetMs − estimatedCostMs`; negative when over budget. */
  headroomMs: number
  /** Whether the scene fits the budget — a report, not a gate. */
  withinBudget: boolean
}

// ── The measurement ─────────────────────────────────────────────────────────

/** A finite, non-negative count. */
function count(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

/**
 * Measure the per-frame work a composed scene implies. Every number is read from
 * the scene's own counts, so a scene cannot be measured at one size and drawn at
 * another.
 *
 * Pure: a function of its argument only.
 */
export function measureFrameWork(scene: FrameScene): FrameWork {
  const nodes = count(scene.counts.nodes)
  const arcs = count(scene.counts.arcs)
  const glyphs = count(scene.counts.glyphs)
  const arcVertices = count(scene.counts.arcVertices)

  // The glyph layer is the only animated one (M3-T3 ships an orbit rule driven by
  // a frame clock), so its matrices are the whole per-frame instance cost; the
  // other two loops run when the playhead moves.
  const glyphMatrixWritesPerFrame = glyphs
  const nodeColorWritesPerReveal = nodes
  const arcVertexWritesPerReveal = arcVertices

  const writesPerFrame =
    glyphMatrixWritesPerFrame + nodeColorWritesPerReveal + arcVertexWritesPerReveal

  const costNs =
    glyphMatrixWritesPerFrame * FRAME_WRITE_COST_NS.glyphMatrix +
    nodeColorWritesPerReveal * FRAME_WRITE_COST_NS.nodeColor +
    arcVertexWritesPerReveal * FRAME_WRITE_COST_NS.arcVertex
  // Nanoseconds → milliseconds, rounded to a hundredth so a report reads cleanly
  // and two identically-shaped scenes compare equal.
  const estimatedCostMs = Math.round((costNs / 1e6) * 100) / 100

  return {
    drawCalls: count(scene.drawCalls),
    postProcessPasses: count(scene.postProcessPasses),
    instances: { nodes, arcs, glyphs },
    vertices: { arcs: arcVertices },
    glyphMatrixWritesPerFrame,
    arcVertexWritesPerReveal,
    nodeColorWritesPerReveal,
    writesPerFrame,
    writesPerSecond: writesPerFrame * FRAME_RATE,
    estimatedCostMs,
    budgetMs: FRAME_CPU_BUDGET_MS,
    headroomMs: Math.round((FRAME_CPU_BUDGET_MS - estimatedCostMs) * 100) / 100,
    withinBudget: estimatedCostMs <= FRAME_CPU_BUDGET_MS,
  }
}
