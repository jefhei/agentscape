# AgentScape — frame budget (M5-T2)

Measured 2026-10-27 on **authoring box, software-rasterized browser**.

- CPU: Intel(R) Pentium(R) Gold G5420 CPU @ 3.80GHz (4 threads)
- GPU / rasterizer: ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver) — a software rasterizer, so a pessimistic floor rather than a mid-range GPU
- Browser: Google Chrome 155.0.8059.84 · canvas 1280×599 @ 1×
- Runtime: Node v22.23.1

> The write costs are real measurements of the loops the render layer runs. The browser frame times are real requestAnimationFrame deltas, but they were rasterized by SwiftShader (software), so they are a worst-case floor rather than a claim about any particular GPU. A mid-range discrete or integrated GPU should be faster; this report cannot prove how much.

**Verdict.** Write cost within the 8 ms main-thread budget; measured frames over the 16.67 ms frame budget at p95.

Budgets: 8 ms of main-thread work per 60 fps frame; 16.67 ms per whole frame.

## Scenes

| scene | agents | messages | tool calls | nodes | arcs | glyphs | arc vertices | draw calls | detail | ingest ms | plan ms | measured ms/frame | budget | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fixture: Fan-out | 6 | 5 | 5 | 6 | 5 | 5 | 510 | 3 | full | 0.4 | 15.9 | 0.000 | 8.00 ms headroom | within |
| scale:250 agents | 250 | 479 | 479 | 250 | 249 | 479 | 25,398 | 3 | full | 5.8 | 794.9 | 0.120 | 7.88 ms headroom | within |
| scale:1000 agents | 1,000 | 1,916 | 1,916 | 1,000 | 999 | 1,916 | 101,898 | 3 | reduced | 22.3 | 2581.6 | 0.450 | 7.55 ms headroom | within |
| scale:2000 agents | 2,000 | 3,833 | 3,833 | 2,000 | 1,999 | 3,000 (cap 3,000) | 71,964 | 3 | minimal | 47.1 | 2833.1 | 0.530 | 7.47 ms headroom | within |
| scale:2000 agents, dense (4 reports each) | 2,000 | 9,833 | 9,833 | 2,000 | 1,999 | 3,000 (cap 3,000) | 71,964 | 3 | minimal | 115.3 | 2919.6 | 0.520 | 7.48 ms headroom | within |

## Measured browser frames

| scene | samples | dropped | p50 ms | p95 ms | p99 ms | max ms | fps (p50) | fps (p95) | frames over budget | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| fixture: Fan-out | 44 | 0 | 216.70 | 400.10 | 583.40 | 583.40 | 4.6 | 2.5 | 44 | over |
| scale:250 agents | 35 | 0 | 283.30 | 533.30 | 599.90 | 599.90 | 3.5 | 1.9 | 35 | over |
| scale:1000 agents | 29 | 0 | 333.30 | 633.30 | 666.60 | 666.60 | 3.0 | 1.6 | 29 | over |
| scale:2000 agents | 29 | 0 | 316.60 | 716.60 | 800.00 | 800.00 | 3.2 | 1.4 | 29 | over |
| scale:2000 agents, dense (4 reports each) | 27 | 0 | 333.40 | 750.00 | 933.30 | 933.30 | 3.0 | 1.3 | 27 | over |

## Measured write costs

One unit each, median of repeated batches (see the method below).

| scene | glyph matrix ns | node instance ns | arc vertex ns | reveal call ms |
|---|---|---|---|---|
| fixture: Fan-out | 71.16 | 66.10 | 2.67 | 0.006 |
| scale:250 agents | 86.19 | 54.28 | 2.62 | 0.111 |
| scale:1000 agents | 66.87 | 54.67 | 2.64 | 0.120 |
| scale:2000 agents | 72.90 | 54.67 | 2.77 | 0.212 |
| scale:2000 agents, dense (4 reports each) | 70.81 | 54.63 | 2.82 | 0.207 |

## Where the frame goes

The same measured cost, split by write loop. Rounded to a hundredth, so the parts can differ from the total above by a hundredth.

| scene | glyph matrices ms | node instances ms | arc vertices ms | total ms |
|---|---|---|---|---|
| fixture: Fan-out | 0.000 | 0.000 | 0.000 | 0.000 |
| scale:250 agents | 0.040 | 0.010 | 0.070 | 0.120 |
| scale:1000 agents | 0.130 | 0.050 | 0.270 | 0.450 |
| scale:2000 agents | 0.220 | 0.110 | 0.200 | 0.530 |
| scale:2000 agents, dense (4 reports each) | 0.210 | 0.110 | 0.200 | 0.520 |

## Comparison with the M5-T1 cost model

The model prices a worst-case frame from its own constants; the measured column prices the same frame with this run's samples.

| scene | model ms/frame | measured ms/frame | delta ms |
|---|---|---|---|
| fixture: Fan-out | 0.000 | 0.000 | 0.000 |
| scale:250 agents | 0.160 | 0.120 | -0.040 |
| scale:1000 agents | 0.630 | 0.450 | -0.180 |
| scale:2000 agents | 0.760 | 0.530 | -0.230 |
| scale:2000 agents, dense (4 reports each) | 0.760 | 0.520 | -0.240 |

## Method

- Write costs: median of 25 timed batches (3 warmup) per scene, each batch running the loop as the render layer runs it.
- Glyph matrices: `writeGlyphMatrices` (`src/scene/glyphs.ts`), the function `GlyphLayer` calls from `useFrame`.
- Node instances: `Matrix4.fromArray` + `InstancedMesh.setMatrixAt` + `Color.setRGB` + `setColorAt`, mirroring `AgentNodeLayer`’s reveal effect.
- Arc vertices: `array.set(base)` then a per-arc, per-vertex multiply, mirroring `MessageArcLayer`’s reveal effect.
- Reveal call: `revealAt` over the scene’s own reveal track, one call per playhead move.
- Ingest and plan times: single-shot wall time around the real pipeline (`parseAgentMessagesExport` → `normalizeTrace` → `buildScenePlan`).
- Browser frames: requestAnimationFrame deltas sampled at rest in headless Chrome (SwiftShader) against the built app, after a warmup; see `scripts/collect-frame-samples.mjs`.
- A frame is judged over budget when p95 exceeds 16.67 ms; a scene’s writes are judged over budget when they exceed 8 ms (half a frame, M5-T1).

## Findings

- At `scale:2000 agents, dense (4 reports each)` the worst-case frame spends 0.52 ms of main-thread writes: 40% glyph matrices, 21% node instances, 39% arc vertices.
- Ingest plus scene composition for `scale:2000 agents, dense (4 reports each)` takes 3.03 s (120 relaxation iterations) — paid once, before the first frame, and the real scale wall rather than the frame rate.
- Level of detail engages with population: `scale:2000 agents, dense (4 reports each)` draws 2000 nodes at 8 sphere segments and 1999 arcs at 8×4, with 3000 glyphs (capped at 3000).
- The measured frames do not track the write cost: from `fixture: Fan-out` to `scale:2000 agents, dense (4 reports each)` the per-frame write cost grows 248.2× while the median frame grows 1.43×. On this target the frame is bounded by rasterization, not by the scene's main-thread writes — which is why the write budget and the frame budget are reported separately.
- Even `fixture: Fan-out` (6 nodes) misses the 16.67 ms frame budget on this target, so these frame times cannot demonstrate interactive rates at *any* scene size — they bound the worst case and nothing more. A GPU-backed browser is required for the PRD's interactivity claim, and that measurement is not this report's.
- M5-T1's cost model stays conservative: it prices a glyph matrix at 193 ns against 70.81 ns measured here, so its verdict errs toward caution.

## Reproduce

```sh
node --experimental-strip-types scripts/profile-frame-budget.mjs --frames docs/frame-samples.json
```
