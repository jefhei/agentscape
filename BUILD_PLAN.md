# Build Plan: AgentScape

3D Spatial Trace Visualizer for Multi-Agent AI Runs — load a recorded agent trace, walk it as a spatial scene. See `PRD.md` for the full product requirements (idea 178, v1.0 draft).

- **Stack**: Vite + TypeScript + React 19 + React Three Fiber 9 + drei + @react-three/postprocessing + three 0.185 + Zustand
- **Runtime**: 100% client-side. No backend. Recorded trace JSON in; localStorage autosave out.
- **Progress trackers**: `.hermes/status.json` (read FIRST — current task/milestone, plus load-bearing notes) and `.task-progress.json` (per-task detail log). Update BOTH after every task.
- **Commit convention**: `feat: <task-id> — <description>` for the task, then a separate `chore: <task-id> — tracker update` commit for the tracker files. Push after each task.
- **Seeded 2026-10-01**: the init commit carries the config set + an app shell **with no three.js import**. Landing the R3F viewport is **M1-T1** — the scaffold is not M1-T1 done.

## Two rules that shape this plan

1. **The data layer is pure; the render layer is thin.** Trace contract, `agent_messages` adapter, force-directed layout, visual-attribute mapping and the timeline model are pure modules gated by vitest in jsdom. Rendering cannot be verified headlessly — do not attempt to gate visuals in tests. Gate the pure half hard; the look is reviewed by a human (M5-T5).
2. **v1 ingests exactly one format** — an `agent_messages` export. OpenTelemetry GenAI and LangGraph adapters are post-MVP (M6-T5). Do not add a second parser early.

## Milestones

### M1 — Foundation, Trace Contract & Data Layer (days 1-2)

| Task | Description | Depends On | Est. |
|------|-------------|------------|------|
| [ ] M1-T1 | Land the React Three Fiber viewport + app shell wiring (empty scene) | — | 2h |
| [ ] M1-T2 | Add lint/format/typecheck/vitest/build gate and local dev scripts | M1-T1 | 2h |
| [ ] M1-T3 | Define the typed trace contract: Run, Agent, Message, ToolCall, Event | M1-T1 | 4h |
| [ ] M1-T4 | `agent_messages` export adapter (Supabase rows → trace contract) | M1-T3 | 4h |
| [ ] M1-T5 | TraceModel normalization pass with deterministic output + tests | M1-T4 | 3h |
| [ ] M1-T6 | Deterministic trace fixtures: synthetic runs (fan-out, loop, dead branch, handoff chain) | M1-T3 | 3h |
| [ ] M1-T7 | Timeline/playhead model over the event stream + tests | M1-T5 | 3h |

**Exit criteria**: app boots with an empty R3F scene; trace contract typed in `src/types/`; the adapter parses an `agent_messages` export into a normalized `TraceModel`; fixtures are deterministic; timeline model tested; `npm run verify` green.
**Machine gate**: types compile; parser + timeline tests pass on all fixtures; `npm run lint/build/test` green.

### M2 — Spatial Layout Engine (pure) (days 2-4)

| Task | Description | Depends On | Est. |
|------|-------------|------------|------|
| [ ] M2-T1 | Force-directed 3D layout over the agent graph (seeded, deterministic) | M1-T5, M1-T6 | 6h |
| [ ] M2-T2 | Layout settlement rules: stable convergence, no jitter, reproducible re-layout | M2-T1 | 4h |
| [ ] M2-T3 | Visual-attribute mapping: node size/emissive from activity, arc width from message volume | M2-T1 | 3h |
| [ ] M2-T4 | Derived edge model: spawn/handoff/message edges from the trace, never hand-placed | M1-T5 | 4h |
| [ ] M2-T5 | Layout + attribute invariant tests across all fixtures | M2-T2, M2-T3, M2-T4 | 4h |

**Exit criteria**: same trace → byte-identical layout; layout settles without jitter; every node position and visual attribute derives from trace data.
**Machine gate**: determinism pinned (two runs deep-equal); no hand-authored coordinates anywhere in `src/`.

### M3 — Scene Construction & Rendering (days 4-7)

| Task | Description | Depends On | Est. |
|------|-------------|------------|------|
| [ ] M3-T1 | Agent nodes as instanced glowing meshes (one InstancedMesh + per-node attrs) | M2-T5, M1-T1 | 5h |
| [ ] M3-T2 | Message arcs as batched animated GLSL curves (not one mesh per message) | M3-T1 | 6h |
| [ ] M3-T3 | Tool-call glyphs orbiting their calling agent node | M2-T4, M3-T1 | 4h |
| [ ] M3-T4 | Environment and lighting rig with bloom-honest emissive calibration | M3-T1 | 4h |
| [ ] M3-T5 | Draw-call budget gate measured against fixtures (ceiling enforced in tests) | M3-T2, M3-T3 | 3h |
| [ ] M3-T6 | Scene mounts a fixture trace end to end (data → layout → render) | M3-T1, M3-T2, M3-T4 | 3h |

**Exit criteria**: a fixture run renders as instanced nodes + batched arcs + glyphs; draw-call ceiling enforced by a test that measures the real scene plan.
**Machine gate**: draw-call count asserted (measured, not claimed); no per-message mesh anywhere.

### M4 — Playback, Controls & Inspection UI (days 7-9)

| Task | Description | Depends On | Est. |
|------|-------------|------------|------|
| [ ] M4-T1 | Timeline scrubber with play/pause/speed/step-to-next-event | M1-T7, M3-T6 | 5h |
| [ ] M4-T2 | Orbit camera mode (survey the run shape) | M3-T6 | 3h |
| [ ] M4-T3 | Fly camera mode (move inside the run) | M4-T2 | 4h |
| [ ] M4-T4 | Node click → detail panel: agent, messages, tool calls, timing, cost attribution | M4-T2 | 4h |
| [ ] M4-T5 | Filter and focus: by agent, by event type, by time window | M4-T4 | 4h |
| [ ] M4-T6 | HUD overlay: run summary (agents, messages, duration, tokens, cost) | M4-T1 | 3h |

**Exit criteria**: a run can be scrubbed and replayed; both camera modes work; clicking a node shows its real events; filters narrow the scene.
**Machine gate**: playhead model + filter predicates unit-tested; UI wiring integration-tested via RTL.

### M5 — Scale, the 3D-Earns-Its-Keep Proof & Polish (days 9-11)

| Task | Description | Depends On | Est. |
|------|-------------|------------|------|
| [ ] M5-T1 | Scale to 1–2k nodes via instancing + level-of-detail; measure frame budget | M3-T5, M4-T5 | 6h |
| [ ] M5-T2 | Frame-budget profiling report on a mid-range target (measured, not asserted) | M5-T1 | 3h |
| [ ] M5-T3 | Render the real `debian2_bot` fleet run from an `agent_messages` export (dogfood) | M1-T4, M3-T6 | 4h |
| [ ] M5-T4 | Implement and demonstrate the spatial-insight criterion vs a timeline (fan-out + runaway loop) | M5-T1, M5-T3 | 5h |
| [ ] M5-T5 | Visual review loop: walk the run, list defects, fix, repeat — **HUMAN-HELD** | M5-T4, M4-T6 | 4h |

**Exit criteria**: 1–2k nodes interactive at the measured budget; the real fleet run renders; **the PRD §7 criterion is demonstrated against a timeline and written down**.
**Machine gate**: frame budget measured and reported; the criterion's evidence committed to `docs/`.
**HUMAN-HELD**: M5-T5 needs eyes on the scene. The build cron skips it, leaves it unchecked and records no verdict — it blocks nothing.

### M6 — Persistence, QA & Launch (days 11-14)

| Task | Description | Depends On | Est. |
|------|-------------|------------|------|
| [ ] M6-T1 | localStorage autosave of loaded run + view state | M4-T5 | 2h |
| [ ] M6-T2 | Shareable URL: trace reference + layout seed | M6-T1 | 3h |
| [ ] M6-T3 | Full defect pass and fix loop until the defect count converges to zero | M5-T5 | 4h |
| [ ] M6-T4 | Deploy public demo (static hosting) with README, screenshots and a demo GIF | M6-T3 | 4h |
| [ ] M6-T5 | Post-MVP backlog triage (OTel/LangGraph adapters, live tail, run diff, WebXR, annotations) | M6-T4 | 2h |

**Exit criteria**: run state survives reload and sharing; defect list zeroed; public demo deployed.

## Execution Rules

1. Read `.hermes/status.json` AND this file at session start.
2. Resolve the next task by dependency order (Depends On column), not visual order.
3. Read ALL existing source in `src/` before writing anything new.
4. Implement properly — working code, not stubs. Add/extend tests (vitest) for the pure layer: parser, layout determinism, attribute mapping, timeline, filters.
5. Update `.task-progress.json` AND `.hermes/status.json` after every task; commit trackers as their own `chore:` commit.
6. Verify with `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build` before committing. Never `npm run dev` in an automated run — it never exits.
7. **Do not gate visuals in tests.** jsdom has no GPU. Test the data layer; leave the look to the human review loop.
8. **Do not drift toward a timeline.** Linear replay/search/diff already exist elsewhere in the pipeline's backlog — the spatial view is the product.

## Verification Gate (every task)

- [ ] Code implemented + tests added/updated
- [ ] `npm run lint` clean
- [ ] `npm run typecheck` clean
- [ ] `npm run test` green
- [ ] `npm run build` green
- [ ] Trackers updated, commits made, pushed

## Human-held tasks (skipped by the automated build)

- **M5-T5 — visual review loop.** Needs a human in the browser: walk the rendered run, judge the look, log defects (severity + location), fix, repeat. The automated build skips it and carries on; M6-T3 consumes its findings once an interactive session has run it.
