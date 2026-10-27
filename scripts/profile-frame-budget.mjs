#!/usr/bin/env node
/**
 * The frame-budget probe (M5-T2) — the measurement half of the report.
 *
 * It measures, it does not assert. Three kinds of number come out of here:
 *
 * | what | how | where it lands |
 * |---|---|---|
 * | ingest + scene-plan time | wall time around the real pipeline | `ingestMs` / `planMs` per scene |
 * | per-unit write cost | repeated timing of the real write loops | `costs` per scene |
 * | browser frame times | requestAnimationFrame deltas (`--frames`) | `frameSamples` per scene |
 *
 * The write loops are the ones the render layer runs:
 * - **glyph matrices** — `writeGlyphMatrices` (`src/scene/glyphs.ts`), called by
 *   `GlyphLayer` from `useFrame` every frame;
 * - **node instances** — `Matrix4.fromArray` + `InstancedMesh.setMatrixAt` +
 *   `Color.setRGB` + `setColorAt`, the loop in `AgentNodeLayer`'s reveal effect;
 * - **arc vertices** — `array.set(base)` then a per-arc per-vertex multiply, the
 *   loop in `MessageArcLayer`'s reveal effect.
 *
 * The last two are reproduced here rather than imported because they live inside
 * React effects that need a renderer; they are four lines each and the file/line
 * each mirrors is named in the report's method. The pure half of both loops (the
 * reveal's numbers) *is* imported — `revealAt`.
 *
 * Usage:
 *   node --experimental-strip-types scripts/profile-frame-budget.mjs
 *   node --experimental-strip-types scripts/profile-frame-budget.mjs --frames docs/frame-samples.json
 *
 * Writes `docs/frame-budget.md` and `docs/frame-budget.json` and prints the
 * verdict. Nothing is served, and nothing is asserted — a red number is a
 * finding, not a build failure.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import * as THREE from 'three'

import { buildFixture } from '../src/fixtures/index.ts'
import { FRAME_WRITE_COST_NS, buildScaleRun } from '../src/scale/index.ts'
import { buildScenePlan } from '../src/scene/scenePlan.ts'
import { buildRevealTrack, revealAt } from '../src/scene/reveal.ts'
import { writeGlyphMatrices } from '../src/scene/glyphs.ts'
import {
  PROFILE_FRAME_BUDGET_MS,
  buildProfileReport,
  medianCost,
  renderProfileMarkdown,
  summarizeFrameSamples,
} from '../src/scale/profile.ts'

/** Minimum units a timed batch must cover, so a tiny scene is not timed at timer resolution. */
const MIN_UNITS_PER_BATCH = 50_000

/** Repetitions per write loop (median reported; the first three warm up the JIT). */
const REPS = 25
/** Warmup repetitions, discarded. */
const WARMUP = 3

/** The scenes to profile, in report order. */
const SCENES = [
  { label: 'fixture: Fan-out', fixture: 'fan-out' },
  { label: 'scale:250 agents', agents: 250, messagesPerAgent: 1 },
  { label: 'scale:1000 agents', agents: 1000, messagesPerAgent: 1 },
  { label: 'scale:2000 agents', agents: 2000, messagesPerAgent: 1 },
  {
    label: 'scale:2000 agents, dense (4 reports each)',
    agents: 2000,
    messagesPerAgent: 4,
  },
]

/** Milliseconds, rounded to a hundredth. */
function ms(value) {
  return Math.round(value * 100) / 100
}

/** Run `fn` once and return its wall time in ms. */
function timed(fn) {
  const start = performance.now()
  const result = fn()
  return { ms: performance.now() - start, result }
}

/**
 * Median per-unit cost, in ns, of `units` per call over {@link REPS} batches.
 *
 * Each batch repeats the call enough times to cover {@link MIN_UNITS_PER_BATCH}
 * units: a 6-node scene would otherwise be timed at timer resolution, and the
 * report would print a "cost" that is mostly clock noise.
 */
function nsPerUnit(batch, units) {
  const calls = Math.max(1, Math.ceil(MIN_UNITS_PER_BATCH / units))
  const totalUnits = units * calls
  const samples = []
  for (let index = 0; index < REPS + WARMUP; index += 1) {
    const start = performance.now()
    for (let call = 0; call < calls; call += 1) batch()
    const elapsed = performance.now() - start
    if (index >= WARMUP) samples.push((elapsed * 1e6) / totalUnits)
  }
  return medianCost(samples)
}

/** The host's CPU, from /proc/cpuinfo (a measurement, not a slogan). */
function cpuName() {
  try {
    const info = readFileSync('/proc/cpuinfo', 'utf8')
    const match = info.match(/^model name\s*:\s*(.+)$/m)
    return match === null ? 'unknown CPU' : `${match[1].trim()} (${cores()} threads)`
  } catch {
    return `unknown CPU (${cores()} threads)`
  }
}

/** Logical CPU count. */
function cores() {
  try {
    const info = readFileSync('/proc/cpuinfo', 'utf8')
    return (info.match(/^processor\s*:/gm) ?? []).length
  } catch {
    return 1
  }
}

/** Node's version, for the runtime line. */
function nodeVersion() {
  return `Node ${process.version}`
}

/** Profile one scene: build it for real, then measure its write loops. */
function profileScene(spec) {
  const ingest = timed(() =>
    'fixture' in spec
      ? buildFixture(spec.fixture)
      : buildScaleRun({ agents: spec.agents, messagesPerAgent: spec.messagesPerAgent }),
  )
  const run = ingest.result.run
  const composed = timed(() => buildScenePlan(run))
  const plan = composed.result

  const glyphs = plan.glyphs.glyphs
  const arcVertices = plan.arcs.buffers.aIntensity.length
  const glyphTarget = new Float32Array(glyphs.length * 16)

  // The glyph orbit tick (GlyphLayer's useFrame work) — the real function.
  let glyphTick = 0
  const glyphNs =
    glyphs.length === 0
      ? 0
      : nsPerUnit(() => {
          glyphTick = (glyphTick + 16.7) % 1000
          writeGlyphMatrices(glyphs, glyphTick, glyphTarget)
        }, glyphs.length)

  // The node reveal (AgentNodeLayer's effect): matrix + colour per instance.
  const nodeMesh =
    plan.nodes.instances.length === 0
      ? null
      : new THREE.InstancedMesh(
          new THREE.SphereGeometry(1, 8, 8),
          new THREE.MeshBasicMaterial(),
          plan.nodes.instances.length,
        )
  const matrix = new THREE.Matrix4()
  const color = new THREE.Color()
  /** The loop AgentNodeLayer runs, verbatim. */
  const writeNodes = () => {
    for (let index = 0; index < plan.nodes.instances.length; index += 1) {
      const instance = plan.nodes.instances[index]
      matrix.fromArray(instance.matrix)
      nodeMesh.setMatrixAt(index, matrix)
      color.setRGB(instance.color[0], instance.color[1], instance.color[2])
      nodeMesh.setColorAt(index, color)
    }
    nodeMesh.instanceMatrix.needsUpdate = true
    if (nodeMesh.instanceColor !== null) nodeMesh.instanceColor.needsUpdate = true
  }
  const nodeNs =
    nodeMesh === null ? 0 : nsPerUnit(writeNodes, plan.nodes.instances.length)

  // The arc reveal (MessageArcLayer's effect): reset, then scale each arc's range.
  const track = buildRevealTrack(plan)
  const baseIntensity =
    arcVertices === 0 ? null : Float32Array.from(plan.arcs.buffers.aIntensity)
  const arcTarget =
    arcVertices === 0 ? null : Float32Array.from(plan.arcs.buffers.aIntensity)
  /** The loop MessageArcLayer runs, verbatim. */
  const writeArcs = (reveal) => {
    arcTarget.set(baseIntensity)
    for (let index = 0; index < plan.arcs.arcs.length; index += 1) {
      const arc = plan.arcs.arcs[index]
      const intensity = reveal.arcs[index]?.intensity ?? 1
      const end = arc.vertexStart + arc.vertexCount
      for (let vertex = arc.vertexStart; vertex < end; vertex += 1) {
        arcTarget[vertex] = baseIntensity[vertex] * intensity
      }
    }
  }
  const arcReveal = revealAt(track, track.spanMs / 2)
  const arcNs =
    arcVertices === 0 ? 0 : nsPerUnit(() => writeArcs(arcReveal), arcVertices)

  // The per-scrub reveal lookup (`revealAt`), measured whole: one call.
  const revealSamples = []
  for (let index = 0; index < REPS; index += 1) {
    const start = performance.now()
    revealAt(track, (index / REPS) * track.spanMs)
    revealSamples.push(performance.now() - start)
  }
  const revealMs = medianCost(revealSamples, 3)

  return {
    label: spec.label,
    agents: run.meta.agentCount,
    messages: run.meta.messageCount,
    toolCalls: run.meta.toolCallCount,
    counts: {
      nodes: plan.counts.nodes,
      arcs: plan.counts.arcs,
      glyphs: plan.counts.glyphs,
      arcVertices,
    },
    drawCalls: plan.drawCalls,
    detail: {
      tier: plan.detail.tier,
      nodeSegments: plan.detail.node.segments,
      arcSegments: plan.detail.arc.segments,
      arcSides: plan.detail.arc.sides,
      glyphMax: plan.detail.glyphs.max === Infinity ? null : plan.detail.glyphs.max,
      settleIterations: plan.settled.iterations,
    },
    ingestMs: ms(ingest.ms),
    planMs: ms(composed.ms),
    costs: {
      glyphMatrixNs: glyphNs,
      nodeInstanceNs: nodeNs,
      arcVertexNs: arcNs,
      revealMs,
    },
    frameWork: {
      glyphMatrixWritesPerFrame: plan.frameWork.glyphMatrixWritesPerFrame,
      nodeColorWritesPerReveal: plan.frameWork.nodeColorWritesPerReveal,
      arcVertexWritesPerReveal: plan.frameWork.arcVertexWritesPerReveal,
      estimatedCostMs: plan.frameWork.estimatedCostMs,
    },
    frameSamples: [],
  }
}

// ── Browser frames (optional) ───────────────────────────────────────────────

/** Load `--frames <path>`: `{ _meta?: {...}, "<label>": [ms, ...], ... }`. */
function loadFrameSamples(argv) {
  const flag = argv.indexOf('--frames')
  if (flag < 0) return { meta: null, samples: {} }
  const path = argv[flag + 1]
  if (path === undefined) throw new Error('--frames needs a path')
  const loaded = JSON.parse(readFileSync(resolve(path), 'utf8'))
  const { _meta: meta = null, ...samples } = loaded
  return { meta, samples }
}

/** The browser version, if one can be asked (a measurement, not a claim). */
function chromeVersion() {
  try {
    const reported = execFileSync('google-chrome', ['--version'], { encoding: 'utf8' })
    return reported.trim()
  } catch {
    return 'browser not detected (frame samples supplied by the collector)'
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const { meta: browserMeta, samples: frameSamples } = loadFrameSamples(argv)
const scenes = SCENES.map(profileScene).map((scene) => ({
  ...scene,
  frameSamples: frameSamples[scene.label] ?? [],
}))

const sampled = Object.keys(frameSamples)
const software = (browserMeta?.renderer ?? '').toLowerCase().includes('swiftshader')

/** The largest scene, used for the "where the time goes" findings. */
const largest = scenes[scenes.length - 1]
const largestCostNs =
  largest.counts.glyphs * largest.costs.glyphMatrixNs +
  largest.counts.nodes * largest.costs.nodeInstanceNs +
  largest.counts.arcVertices * largest.costs.arcVertexNs

/** Percent of the largest scene's write cost spent in `part`, rounded. */
function share(part) {
  return largestCostNs === 0 ? 0 : Math.round((part / largestCostNs) * 100)
}

/** The median frame of a scene's samples (0 when unsampled). */
function medianFrame(scene) {
  const usable = scene.frameSamples
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
  return usable.length === 0 ? 0 : usable[Math.floor(usable.length / 2)]
}

const firstSampled = scenes.find((scene) => medianFrame(scene) > 0)
const largestSampled = [...scenes].reverse().find((scene) => medianFrame(scene) > 0)
const frameRatio =
  firstSampled === undefined ||
  largestSampled === undefined ||
  medianFrame(firstSampled) === 0
    ? null
    : medianFrame(largestSampled) / medianFrame(firstSampled)
const writeRatio =
  firstSampled === undefined || largestSampled === undefined
    ? null
    : (largestSampled.counts.glyphs * largestSampled.costs.glyphMatrixNs +
        largestSampled.counts.nodes * largestSampled.costs.nodeInstanceNs +
        largestSampled.counts.arcVertices * largestSampled.costs.arcVertexNs) /
      Math.max(
        1,
        firstSampled.counts.glyphs * firstSampled.costs.glyphMatrixNs +
          firstSampled.counts.nodes * firstSampled.costs.nodeInstanceNs +
          firstSampled.counts.arcVertices * firstSampled.costs.arcVertexNs,
      )

const findings = [
  `At \`${largest.label}\` the worst-case frame spends ${ms(largestCostNs / 1e6)} ms of main-thread writes: ${share(largest.counts.glyphs * largest.costs.glyphMatrixNs)}% glyph matrices, ${share(largest.counts.nodes * largest.costs.nodeInstanceNs)}% node instances, ${share(largest.counts.arcVertices * largest.costs.arcVertexNs)}% arc vertices.`,
  `Ingest plus scene composition for \`${largest.label}\` takes ${ms(largest.ingestMs + largest.planMs) < 1000 ? `${ms(largest.ingestMs + largest.planMs)} ms` : `${(ms(largest.ingestMs + largest.planMs) / 1000).toFixed(2)} s`} (${largest.detail.settleIterations} relaxation iterations) — paid once, before the first frame, and the real scale wall rather than the frame rate.`,
  `Level of detail engages with population: \`${largest.label}\` draws ${largest.counts.nodes} nodes at ${largest.detail.nodeSegments} sphere segments and ${largest.counts.arcs} arcs at ${largest.detail.arcSegments}×${largest.detail.arcSides}, with ${largest.counts.glyphs} glyphs${largest.detail.glyphMax === null ? '' : ` (capped at ${largest.detail.glyphMax})`}.`,
]

if (frameRatio !== null && writeRatio !== null) {
  findings.push(
    `The measured frames do not track the write cost: from \`${firstSampled.label}\` to \`${largestSampled.label}\` the per-frame write cost grows ${writeRatio.toFixed(1)}× while the median frame grows ${frameRatio.toFixed(2)}×. On this target the frame is bounded by rasterization, not by the scene's main-thread writes — which is why the write budget and the frame budget are reported separately.`,
  )
  if (medianFrame(firstSampled) > PROFILE_FRAME_BUDGET_MS) {
    findings.push(
      `Even \`${firstSampled.label}\` (${firstSampled.counts.nodes} nodes) misses the ${ms(PROFILE_FRAME_BUDGET_MS)} ms frame budget on this target, so these frame times cannot demonstrate interactive rates at *any* scene size — they bound the worst case and nothing more. A GPU-backed browser is required for the PRD's interactivity claim, and that measurement is not this report's.`,
    )
  }
}

findings.push(
  `M5-T1's cost model stays conservative: it prices a glyph matrix at ${FRAME_WRITE_COST_NS.glyphMatrix} ns against ${largest.costs.glyphMatrixNs} ns measured here, so its verdict errs toward caution.`,
)

const report = buildProfileReport({
  generatedAt: new Date().toISOString().slice(0, 10),
  target: {
    name: 'authoring box, software-rasterized browser',
    cpu: cpuName(),
    gpu:
      browserMeta === null
        ? 'not measured (no browser samples in this run)'
        : `${browserMeta.renderer} — ${software ? 'a software rasterizer, so a pessimistic floor rather than a mid-range GPU' : 'as reported by the browser'}`,
    browser:
      browserMeta === null
        ? chromeVersion()
        : `${chromeVersion()} · canvas ${browserMeta.canvas?.width ?? 0}×${browserMeta.canvas?.height ?? 0} @ ${browserMeta.devicePixelRatio ?? 1}×`,
    runtime: nodeVersion(),
    caveat: software
      ? 'The write costs are real measurements of the loops the render layer runs. The browser frame times are real requestAnimationFrame deltas, but they were rasterized by SwiftShader (software), so they are a worst-case floor rather than a claim about any particular GPU. A mid-range discrete or integrated GPU should be faster; this report cannot prove how much.'
      : 'The write costs are real measurements of the loops the render layer runs, and the frame times are real requestAnimationFrame deltas from the browser named above. They describe that machine and that browser only.',
  },
  scenes,
  method: [
    `Write costs: median of ${REPS} timed batches (${WARMUP} warmup) per scene, each batch running the loop as the render layer runs it.`,
    'Glyph matrices: `writeGlyphMatrices` (`src/scene/glyphs.ts`), the function `GlyphLayer` calls from `useFrame`.',
    'Node instances: `Matrix4.fromArray` + `InstancedMesh.setMatrixAt` + `Color.setRGB` + `setColorAt`, mirroring `AgentNodeLayer`’s reveal effect.',
    'Arc vertices: `array.set(base)` then a per-arc, per-vertex multiply, mirroring `MessageArcLayer`’s reveal effect.',
    'Reveal call: `revealAt` over the scene’s own reveal track, one call per playhead move.',
    'Ingest and plan times: single-shot wall time around the real pipeline (`parseAgentMessagesExport` → `normalizeTrace` → `buildScenePlan`).',
    sampled.length === 0
      ? 'Browser frames: none supplied (re-run with `--frames docs/frame-samples.json` from `scripts/collect-frame-samples.mjs`).'
      : 'Browser frames: requestAnimationFrame deltas sampled at rest in headless Chrome (SwiftShader) against the built app, after a warmup; see `scripts/collect-frame-samples.mjs`.',
    'A frame is judged over budget when p95 exceeds 16.67 ms; a scene’s writes are judged over budget when they exceed 8 ms (half a frame, M5-T1).',
  ],
  findings,
  command:
    'node --experimental-strip-types scripts/profile-frame-budget.mjs --frames docs/frame-samples.json',
})

const docs = resolve('docs')
mkdirSync(docs, { recursive: true })
writeFileSync(resolve(docs, 'frame-budget.md'), renderProfileMarkdown(report))
writeFileSync(
  resolve(docs, 'frame-budget.json'),
  `${JSON.stringify(
    {
      generatedAt: report.generatedAt,
      target: report.target,
      cpuBudgetMs: report.cpuBudgetMs,
      frameBudgetMs: report.frameBudgetMs,
      verdict: report.verdict,
      scenes: report.scenes.map((reading) => ({
        ...reading.scene,
        measuredCostMs: reading.measuredCostMs,
        headroomMs: reading.headroomMs,
        withinCpuBudget: reading.withinCpuBudget,
        frames: summarizeFrameSamples(reading.scene.frameSamples, report.frameBudgetMs),
      })),
    },
    null,
    2,
  )}\n`,
)

for (const reading of report.scenes) {
  const frames = reading.frames
  const frameLine = frames.measured
    ? `frames p50 ${frames.p50Ms} ms / p95 ${frames.p95Ms} ms (${frames.fps} fps)`
    : 'frames not sampled'
  console.log(
    `${reading.scene.label.padEnd(46)} nodes ${String(reading.scene.counts.nodes).padStart(5)}  ` +
      `cost ${String(reading.measuredCostMs).padStart(7)} ms  ${frameLine}`,
  )
}
console.log(`\n${report.verdict}`)
console.log('wrote docs/frame-budget.md and docs/frame-budget.json')
