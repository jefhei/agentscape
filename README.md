# AgentScape

**Walk a multi-agent AI run in 3D.** Load a recorded agent trace and explore it as a
spatial scene — agents as glowing bodies, messages as animated arcs, tool calls as
orbiting glyphs, with a timeline scrubber to replay the whole run.

Flat timelines make the *sequence* of a multi-agent run obvious and its *shape*
invisible. AgentScape renders the shape: fan-outs, handoff chains, runaway sub-agent
loops, dead branches and cost concentration — the structural facts a linear waterfall
forces you to reconstruct by eye.

## Status

Early build. Scaffold + PRD + build plan landed 2026-10-01; one task/day proceeds from
`BUILD_PLAN.md`. The app boots on a rendered trace: a deterministic fixture run
is laid out, lit and drawn (nodes, arcs, glyphs, bloom) in the real app, and the
scene composition is measured against a 3-draw-call ceiling it provably holds. The five-part build
gate is wired (M1-T2): `npm run verify` runs lint → format → typecheck → test → build.
The typed trace contract (M1-T3) is landed in [`src/types/`](src/types/trace.ts) —
`Run`, `Agent`, `Message`, `ToolCall` and the `Event` union every other module speaks.
The `agent_messages` adapter (M1-T4) is landed in
[`src/adapter/`](src/adapter/agentMessages.ts) — `parseAgentMessagesExport` turns a
recorded Supabase export into a normalized `Run`, deterministically and independent of
row order. The TraceModel normalization pass (M1-T5) is landed in
[`src/model/`](src/model/traceModel.ts) — `normalizeTrace` canonicalizes order, assigns
`Event.sequence`, recomputes every derived field from the facts and verifies referential
integrity, so the same facts always yield a byte-identical model. The deterministic trace
fixtures (M1-T6) are landed in [`src/fixtures/`](src/fixtures/traceFixtures.ts) — four
synthetic `agent_messages` exports, one per structural shape (fan-out, loop, dead branch,
handoff chain), each pushed through the real adapter + normalizer from a single fixed
epoch, so a fixture is byte-stable and exhibits exactly the shape it is named for. The
timeline/playhead model (M1-T7) is landed in
[`src/timeline/`](src/timeline/timeline.ts) — `buildTimeline` flattens a normalized run
into scrub-able stops, `frameAt` reports what has fired and which agents are live at any
position, and play/pause/speed/seek/step/advance are pure transitions over the `Playhead`
value (no clock). The force-directed 3D layout (M2-T1) is landed in
[`src/layout/`](src/layout/forceLayout.ts) — `layoutTrace` relaxes the agent
communication graph (derived from the messages) into deterministic 3D positions,
seeded from the run's own `seed`, so the same trace always renders the same shape.
The layout settlement rules (M2-T2) are landed in
[`src/layout/`](src/layout/settlement.ts) — `settleLayout` relaxes until the forces
balance, cooling **exponentially and independently of the iteration budget**, so the
settled shape is reproducible re-layout to re-layout, and reports `converged` plus the
energy and per-step movement traces; `isSettled` reads a layout's residual force.
The visual-attribute mapping (M2-T3) is landed in
[`src/layout/`](src/layout/attributes.ts) — `mapTraceAttributes` turns the trace's facts
into the numbers the render layer draws with: node size and emissive driven by an agent's
activity (`messagesSent + messagesReceived + toolCalls`), arc width driven by the message
volume on each communication link. Both channels are normalized within the run, fall back
to a neutral midpoint when a channel has no spread, and are pure and reproducible.
The derived edge model (M2-T4) is landed in
[`src/layout/`](src/layout/edges.ts) — `deriveEdgeModel` turns the trace's messages
into typed **spawn / handoff / message** edges (classified from each message's declared
action, direction preserved, never hand-placed) and derives every agent's `role` and
`parentId` from the spawn edges, so the fan-out hierarchy has one owner;
`withDerivedLineage` writes those roles/parents back onto the model.
The cross-fixture invariant harness (M2-T5) is landed in
[`src/layout/`](src/layout/invariants.ts) — `checkLayoutInvariants` /
`checkAttributeInvariants` / `checkEdgeInvariants` (and the end-to-end
`checkSceneInvariants`) assert the M2 exit criteria as data over every fixture:
one node per agent in canonical order, finite distinct positions, bounds that
enclose the cloud, a seeded layout whose link topology *is* the trace's graph,
activity/intensity that re-derives from the model and maps monotonically into
range, and an acyclic spawn lineage with consistent roles. The
`findHandAuthoredCoordinates` scanner is the machine gate — a test uses it to
prove the pure half of `src/` carries no hand-placed coordinate.
The agent nodes (M3-T1) are landed in [`src/scene/`](src/scene/nodes.ts) —
`buildNodeScenePlan` settles the layout and joins it with the attribute mapping
into one instance per agent (position, radius, glow colour and a **finished
instance matrix**, so the render half decides nothing), and `AgentNodeLayer`
draws them as a single `InstancedMesh`: one draw call for the whole agent
population, and no per-node mesh anywhere. The message arcs (M3-T2) are landed in
[`src/scene/`](src/scene/arcs.ts) — `buildArcScenePlan` sweeps one tube per
communication link along a bowed curve between the settled node positions into a
**single batched geometry**, at the link's own width (M2-T3), and derives each
arc's animation from the trace: the pulse rate from the channel's message volume
and the pulse *direction* from the channel's **net** traffic — a balanced channel
is parked rather than sent one way arbitrarily. `MessageArcLayer` uploads that
batch and animates it with one `ShaderMaterial` whose GLSL is generated from the
plan's own attribute/uniform contract, so the GPU half cannot silently drift from
the tested pure half (`arcPulseParameter` is the reference implementation the
shader mirrors; the GLSL itself is additionally compiled out of band with
`glslangValidator` in GLSL ES 1.00 and desktop 1.10). Still one draw call for
every arc — never one mesh per message. The tool-call glyphs (M3-T3) are landed in
[`src/scene/`](src/scene/glyphs.ts) — `buildGlyphScenePlan` puts one mark per tool
call on a derived orbit around the agent that made it (radius clears the node,
plane and phase de-synchronised per agent, rate keyed to the caller's activity,
size/hue from the call's spawn/handoff/message kind), with the orbit rule a pure
function of time; `GlyphLayer` keeps one `InstancedMesh` in step with the frame
clock. The lighting rig (M3-T4) is landed in
[`src/scene/`](src/scene/environment.ts) — the background, fog band, four lights
and bloom threshold are derived from the settled cloud's extent, and the
bloom-honest emissive calibration inverts ACES to solve the quiet/hot radiances
and the activity→radiance exponent from *display* anchors, so bright reads as hot
without blowing out. The draw-call budget (M3-T5) is enforced in
[`src/scene/`](src/scene/budget.ts) — every fixture measures **3** geometry draw
calls (nodes + arcs + glyphs; the rig draws none) and a run forty times larger
measures the same, because the batch unit is the layer, not the message. The
whole scene is mounted (M3-T6) by [`src/scene/`](src/scene/scenePlan.ts) —
`buildScenePlan` composes every layer from **one** settlement and **one** attribute
map, aims the camera at the settled cloud with the rig's own framing distance, and
reports the measured budget it was composed under; `Scene.tsx` is a thin applier,
and the app boots on the deterministic fan-out fixture (data → layout → render in
the real app). The playback transport (M4-T1) is landed in
[`src/playback/`](src/playback/playback.ts) — one pure reducer over
`{ timeline, playhead }` (play/pause, speed ladder, scrub, step-to-next-event,
restart) plus the scrubber's thinned marks and event-density histogram and the
keyboard map, with the `requestAnimationFrame` clock and the key listener in
`usePlayback`; the frame it produces feeds
[`src/scene/reveal.ts`](src/scene/reveal.ts), so scrubbing lights the **spatial
scene** in run order (structure persists, activity is revealed) rather than
opening a transcript. The orbit camera (M4-T2) is landed in
[`src/camera/`](src/camera/orbit.ts) — `createOrbitCamera` reads the scene plan's
opening shot as an orbit (it reproduces that shot exactly), `orbitBy` /
`zoomBy` / `resetOrbit` are pure clamped transitions over
`{ target, azimuth, elevation, zoom }`, the eye is always derived as
`target + direction · distance` (so the pose cannot leave the orbit sphere), the
dolly range is a multiple of the scene's own framing distance, and the far plane
is re-derived at every distance so zooming out never clips the cloud. Drag
(primary button, grab-the-cloud) and wheel (line/page deltas normalized, capped
per event) are measured by `OrbitCameraRig` and mapped by the pure module;
`CameraBar` is the accessible control surface (zoom in/out, reset) and the
readout. The fly camera (M4-T3) is landed in [`src/camera/`](src/camera/fly.ts) —
`createFlyCamera` takes over the pose the camera is already looking from (the mode
switch seeds it, so flying never teleports the view), the eye *is* the state and
`flyForward` / `flyRight` derive the frame from the same spherical rule the orbit
uses, `flyLookBy` / `flyMove` / `flyAdvance` / `resetFly` are pure clamped
transitions (speed, wheel advance and the flight envelope are all multiples of the
cloud's own radius, a frame's delta is capped, and the composed direction is
normalized so a diagonal is not faster), and the far plane is derived from the
envelope rather than the look distance so turning round inside a big cloud never
clips it. `FlyCameraRig` measures the drag, the wheel and the held WASD/Q-E keys
(one `requestAnimationFrame` loop while a key is down, real elapsed time per
frame), and the mode chip in `CameraBar` is the switch between the two modes.
The node inspector (M4-T4) is landed in [`src/inspect/`](src/inspect/inspect.ts) —
`buildAgentDetail` joins the run's facts into one agent's panel model (derived
role/parent/children and peers, its messages in both directions with counterparts
and offsets, its tool calls, its activity window and share of the run, and its
tokens/spend itemised per message and per tool call, checked against the model's
own totals so a drifted attribution fails loudly), with each row flagged as fired
or pending at the playhead and the panel model fully unit-tested; the click path
is the pure `agentIdForClick` (instance index → agent, and a drag past 4 px is a
camera gesture, not a click) plus `useSelection` in the shell, and
`AgentDetailPanel` is a thin consumer that dims pending rows, caps its lists and
closes on its button or Escape.
The filter (M4-T5) is landed in [`src/filter/`](src/filter/filter.ts) — three facets
(agents, event types, time window), one reducer and three predicates, with an
identity filter that provably changes nothing. The lens **narrows activity and keeps
structure**: `filterRevealTrack` re-derives which messages still count and hands the
result to the same reveal the playhead uses, so filtered-out nodes sit at their
dormant glow, unfiltered links at their faint skeleton and filtered-out glyphs vanish —
no second brightness model, no re-layout on a chip click. `FilterBar` is the thin
control surface (agent chips, event-type toggles, two window sliders, a live "what
survives" line; double-clicking an agent chip focuses on just that agent), and the
viewport draws the scene through `useFilter`.
Next: **M4-T6 — HUD overlay: run summary (agents, messages, duration, tokens, cost)**.

## Stack

Vite · TypeScript · React 19 · React Three Fiber · drei · @react-three/postprocessing ·
three 0.185 · Zustand

100% client-side. Trace ingestion is a recorded JSON export; no backend, no account.

## Docs

- [`PRD.md`](PRD.md) — product requirements (idea 178)
- [`BUILD_PLAN.md`](BUILD_PLAN.md) — the task plan and the verification gate
- `.hermes/status.json` — current task/milestone (read this first)

## Architecture in one line

The **data layer** (trace contract, `agent_messages` adapter, force-directed layout,
visual-attribute mapping, timeline model) is pure and unit-tested; the **render layer**
is a thin consumer of it. That split is what keeps a rendering-heavy project buildable
by an automated loop.

## Getting started

```bash
npm ci
npm run dev      # dev server
npm run verify   # the full gate: lint + format + typecheck + test + build
```

> Install with `npm ci`, not `npm install` — these repos ship a pinned sibling
> lockfile; plain `npm install` hits a known npm arborist failure on this dep set.

## Scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | Vite dev server (interactive only — never run in the automated loop) |
| `npm run build` | `tsc -b` then a production Vite build |
| `npm run lint` | oxlint, warnings promoted to errors (`--deny-warnings`) |
| `npm run format` | prettier `--write` over the repo |
| `npm run format:check` | prettier check (no writes) — CI-safe |
| `npm run typecheck` | `tsc -b --noEmit` across all project references |
| `npm run test` | vitest, single run |
| `npm run test:watch` | vitest, watch mode |
| `npm run preview` | serve the last production build |
| `npm run verify` | **the gate** — lint → format:check → typecheck → test → build |

The gate's wiring is itself tested (`src/gate.test.ts`): dropping a step, flipping `test`
to watch mode, or letting lint stop failing on warnings trips that test rather than
silently weakening `verify`.
