# AgentScape — the real fleet run (M5-T3, dogfood)

The first non-synthetic trace: the `debian2_bot` pipeline's own
`agent_messages` table, captured as an export and rendered by the app.

Measured 2026-10-28 on the authoring box (Chromium 155 headless, software GL —
SwiftShader — at 1280×800).

## Provenance

| | |
|---|---|
| table | `kgluqrkrxujjkcuwhuvo.supabase.co` → `agent_messages` (the one format v1 ingests) |
| captured | 2026-10-28, `node scripts/capture-fleet-export.mjs` |
| snapshot | `src/fixtures/real/debian2-fleet.export.json` — 158 rows, 116 kB |
| loader | `src/fixtures/real/fleetExport.ts` — rows → adapter (M1-T4) → normalizer (M1-T5) |
| mounted by | `?trace=fleet` (`src/trace/traceQuery.ts`) — the app's default mount is unchanged |
| redactions | credential values → `[redacted]` · key-shaped text → `[redacted-key]` · `/home/<account>/…` → `~/…` |

The snapshot is the *export*, not a hand-built run: it goes through the same
two-stage ingest a user's own export takes, which is the whole point of the
dogfood. The three redactions above are the only transformations; every id,
timestamp, agent name and subject is as recorded (the capture script refuses to
write a file that still matches a key-or-home-path pattern).

Only the Ansible-style coordination traffic is in this table — the pipeline
writes status messages here, not prompts or model output — so the capture is
small in bytes and *sparse* in events. That sparsity is itself a finding (see
§4).

## 1. What the run contains

| fact | value |
|---|---|
| rows / messages | 158 |
| agents | 10 |
| tool calls (bodies with a string `action`) | 118 |
| events (messages + tool calls + 2 lifecycle) | 278 |
| broadcasts (`to_agent` NULL) | 5 |
| bodies that are JSON without an action | 24 |
| bodies that are free text | 16 |
| span | 2026-06-07T01:58Z → 2026-10-21T09:54Z (**136.3 days**) |
| distinct actions | 34 (`script_ready` 27, `research_brief_ready` 26, `review_complete` 15, …) |
| record-level facts | no token column, no cost column ⇒ HUD prints `— not recorded`, never `$0.00` |

### The graph

- 33 directed edges between agent pairs collapse to **26 layout links**;
  `deriveEdgeModel` classifies **all 33 as `message`** — 0 spawn, 0 handoff.
- Traffic is one-way and concentrated: `hermes_bot → debian2_bot` 103 messages,
  `debian2_bot → hermes_bot` 33, everything else ≤ 2.
- Five names are the same host under different spellings —
  `hermes_bot`, `Host_hermes_bot`, `hermes_host2`, `herm_bot`, and
  `rpi4_bot`/`Rpi4_bot` — so the export renders **10 nodes for what is roughly a
  3-host fleet**.
- Derived lineage: `hermes_bot` is the only coordinator (it is the run's
  origin), the other nine are workers, and **every `parentId` is null** — the
  table records no spawn relationships, so the hierarchy is a star that the data
  cannot confirm.

| agent | sent | received | role |
|---|---|---|---|
| hermes_bot | 106 | 41 | coordinator (origin) |
| debian2_bot | 39 | 108 | worker |
| Host_hermes_bot | 8 | 7 | worker |
| hermes_host2 | 2 | 4 | worker |
| herm_bot | 1 | 8 | worker |
| hermes_research | 1 | 5 | worker |
| local | 1 | 5 | worker |
| rpi4_bot | 0 | 7 | worker |
| Rpi4_bot | 0 | 6 | worker |
| video_producer | 0 | 7 | worker |

## 2. What it costs to draw

One scene plan, one settlement, one attribute map — all from the trace:

| measure | value |
|---|---|
| run id / seed | `run_a4afe631` / `2762991153` (content-derived, stable) |
| settlement | converged, 898 iterations of the 2000 cap |
| nodes / links (arcs) / glyphs | 10 / 26 / 118 |
| drawn elements | 154 |
| draw calls | **3** (ceiling 3, `withinBudget`), 1 post-process pass (bloom) |
| arc vertices | 2,652 (16×6 full detail — the run is far below every LOD rung) |
| priced per-frame writes | 2,780 → ~0.03 ms against the 8 ms main-thread budget |
| settled bounds | radius 1.10, centre (−0.88, 0.00, −1.42) |
| camera | distance 12.00, near 0.1, far 16.4, aimed at the settled centre |

The spatial cost is the same as any six-node fixture: instancing already made
draw calls trace-independent (M3-T5). The real run is **small**, not heavy — the
trace is sparse, not dense.

## 3. It really renders (mount smoke test, not a look review)

`npm run build` → `npx vite preview --port 4173` → headless Chrome over CDP,
navigating to `/?trace=fleet`:

| probe | at the playhead's start | after the transport's `End` |
|---|---|---|
| `data-run-id` | `run_a4afe631` | `run_a4afe631` |
| `data-draw-calls` | 3 | 3 |
| `data-reveal-arcs` | 1 | 26 |
| `data-reveal-glyphs` | 0 | 118 |
| `data-playback-elapsed` | 0 | 11,778,988,509 |
| HUD | `10 agents · 158 messages · 118 tool calls · 3271:56:28` | same |

`docs/screenshots/fleet-run-start.png` and `fleet-run-revealed.png` are those two
moments. Both are SwiftShader software renders: they prove the run reaches the
renderer and that the reveal walks it, and they say nothing reliable about frame
rate (see `docs/frame-budget.md` for why).

## 4. What the dogfood found (inputs to M5-T4 and M5-T5)

These are findings, not fixes: the look is human-held (M5-T5) and the insight
criterion is M5-T4's gate. Each is recorded with what it threatens.

1. **The scene reads as one bright disc, not ten agents** (look — M5-T5). The hot
   node's radiance saturates bloom and its drawn radius (0.9 units) is close to
   the layout's ~1-unit edge length, so the busiest agent swallows its
   neighbours; at the run start (screenshot 1) there is effectively one node on
   screen. Candidate causes: within-run min-max normalization pushed to its
   ceiling by a single dominant agent, node radius vs edge length, and the bloom
   threshold when one emitter is 3× the next.
2. **The default framing is ~10× too wide for this run** (look — M5-T5). The
   cloud's settled radius is 1.10 while the camera sits at a fixed distance of
   12: the run occupies roughly a tenth of the frame. The far plane already
   derives from the extent radius; the distance does not. (The fan-out fixture is
   1.61 at the same distance, so the problem is general, worst on compact runs.)
3. **The hierarchy is empty on real data** (data — M5-T4). `deriveEdgeModel`
   classifies by verb tables (`assign_task`, `handoff`, …) and the pipeline's
   real actions are `script_ready`, `review_complete`, `render_complete`, … — so
   every edge is a plain `message` and no `parentId` is derivable. The spatial
   view still shows *flow* (who talks to whom, how much) but not *structure*
   (who spawned whom). M2-T4's typing is not wrong; it has simply never seen
   this vocabulary.
4. **Identity fragmentation** (data — upstream, not this repo). Six names for
   three hosts inflate the node count and split one agent's traffic across
   several small nodes. The visualizer must not merge names it cannot prove are
   the same agent; the fix belongs in the pipeline that writes the table.
5. **Duration is unreadable at fleet scale** (UI — M5-T5). `3271:56:28` is honest
   (the HUD formats hours) but no human reads 136 days from it; both the HUD and
   the transport show that form.
6. **Most of the playhead's travel is silence** (design note — M6-T5). 158
   distinct stops spread over 136 days: the largest gap is 23.6 days, so at a
   constant speed the reveal sits still most of the time and then bursts.
   Wall-clock-time playback is linear by design; event-time playback is a
   post-MVP question, not a v1 defect.
7. **The snapshot costs bundle weight.** The committed export adds 116 kB raw
   (24.9 kB gzipped) to the app chunk; the built `index` chunk is 225 kB / 57.8 kB
   gzip including it. Acceptable for a 158-row dogfood; a real 50k-row export
   would need fetching, not importing (M6 scope).

**What this means for the product bet (M5-T4):** the real fleet run supports the
*flow* half of the claim — the one-way 103:33 imbalance and the 26-link fan are
immediately visible as a hub with a thick arc and a halo of thin ones, and a
linear transcript does not show that. It does **not** currently support the
*hierarchy* half (finding 3) or a fair *look* judgement (findings 1–2) until
M5-T5 has had eyes on it. M5-T4's demonstration should therefore use the fan-out
and loop shapes it was planned against, and say plainly that the real run was
rendered and what it exposed.

## Reproduce

```bash
npm run build
npx vite preview --port 4173 --strictPort     # then open http://localhost:4173/?trace=fleet
npm run test -- src/fixtures/real src/trace   # the export + seam tests
node scripts/capture-fleet-export.mjs         # refresh the snapshot (needs SUPABASE_ANON_KEY)
```
