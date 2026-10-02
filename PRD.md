# AgentScape — 3D Spatial Trace Visualizer for Multi-Agent AI Runs

**Product Requirements Document (PRD)**

| Field | Value |
|---|---|
| Idea ID | 178 |
| Category | 3D web / Three.js |
| Difficulty | Advanced |
| Status | Draft |
| Generated | 2026-10-01 (via Hermes Agent) |
| MVP Timeline | 2 weeks |

---

## 1. Executive Summary

AgentScape turns a multi-agent run into a **place you can walk around**. It ingests a
recorded agent trace and renders it as a spatial 3D scene: each agent is a glowing body
in a force-directed space, every message is an animated arc between bodies, every tool
call is an orbiting glyph, and a timeline scrubber lets you replay the whole run —
message by message, tool call by tool call — inside the structure of the run itself.

The product bet is narrow and deliberate: **flat timelines make the *sequence* of a
multi-agent run obvious and its *shape* invisible.** Fan-outs, handoff chains, runaway
sub-agent loops, dead branches and cost concentration are all spatial facts that a
linear timeline forces a human to reconstruct by eye. AgentScape renders them directly.

The project is also built to eat its own dogfood: the authoring machine already runs a
multi-agent fleet (`debian2_bot`, `hermes_bot`, `Rpi4_bot`) that coordinates through a
Supabase `agent_messages` table. AgentScape's first real trace is that fleet's own
traffic, exported on day one — the demo generates itself from data the pipeline already
produces.

## 2. Problem Statement

Agentic systems went from prototype to production through 2025–2026, and observability
is now one of the sharpest operational pains in the field: YC-backed startups
(Lucidic W25, BitBoard P25) and mature OSS tooling (agent-prism, TraceLab,
agentcanvas, Langfuse-class platforms) all exist because teams cannot see what their
agents did. The established rendering idiom is the **flat timeline or waterfall**:
nested spans, a scroll, a collapse/expand tree.

That idiom answers "what happened, in order?" It does not answer the questions that
actually dominate multi-agent debugging:

- **Where did the run fan out?** Which parent spawned how many children, and when did
  that branching happen?
- **Who talked to whom, and how much?** Message volume and direction across agents is
  visually flattened into interleaved rows.
- **Is something running away?** A sub-agent looping or spawning children without
  bound is a *growth* signal — trivially visible as a swelling cluster, nearly
  invisible as a longer list.
- **Where did the cost and latency concentrate?** Attribution across a graph is a
  spatial quantity being read off a linear list.
- **Which branch died?** Abandoned subtrees read the same as completed ones in a
  collapsed timeline.

The tooling market reflects the gap: 2D trace viewers have real traction
(evilmartians/agent-prism ★393, actively pushed; uw-syfi/TraceLab ★133;
vstorm-co/agentcanvas ★84), and interception tooling is a category of its own
(liaohch3/claude-tap ★3254). The **3D spatial slice is essentially unoccupied** —
GitHub search for "multi-agent trace 3d visualization" returns a total of one
repository, a 0★ project tied to a single framework (Agno). There is no
framework-agnostic spatial trace viewer.

## 3. Target Audience

**Primary**
- **Multi-agent / agent-platform engineers** debugging runs with 5–50 agents and
  thousands of messages, where the failure mode is structural (fan-out, loops,
  handoffs) rather than a single bad span.
- **Agent framework and harness authors** who need to explain run shape — in a doc, a
  bug report, or a demo — and today paste screenshots of a timeline.

**Secondary**
- **AI researchers / evaluation engineers** comparing run topologies across models or
  prompts (same task, different *shape* of solution).
- **AI/ML content creators and educators** — a walkable agent run is an explainer
  asset; trace-shaped animations read far better on video than a scrolling waterfall.
- **The authoring pipeline itself** — the `debian2_bot` fleet, whose own
  `agent_messages` traffic is the first ingest source.

## 4. Feature Requirements

### 4.1 Must-Have (MVP)

**Trace ingestion (one format, deliberately)**
- Load a **recorded trace JSON** — v1 supports exactly one source: an
  `agent_messages` export (the authoring pipeline's own coordination table).
- A defined, typed **trace contract** (`Run`, `Agent`, `Message`, `ToolCall`, `Event`)
  that all ingestion paths normalize into.
- Deterministic parsing: same input file → byte-identical `TraceModel`.

**Spatial layout (pure, deterministic)**
- Force-directed 3D layout over the agent graph, seeded so layout is reproducible.
- Layout derived from the trace's own structure (spawn/handoff edges, message
  volume), never hand-placed.
- Stable refinement: the layout must settle (no jitter) and re-layout identically.

**Scene construction**
- Agents as instanced glowing nodes (size/emissive driven by activity).
- Messages as animated arcs between nodes (batched GLSL, not one mesh per message).
- Tool calls as orbiting glyphs attached to their calling agent.
- Bloom-honest emissive calibration so bright nodes read as "hot", not blown out.
- Draw-call budget enforced as a hard gate (measured, not asserted).

**Playback, controls & inspection**
- Timeline scrubber with play / pause / speed / step-to-next-event.
- Two camera modes: orbit (survey the shape) and fly (move inside the run).
- Click a node → detail panel: agent identity, its messages, tool calls, timing,
  tokens/cost attribution.
- Filter & focus: by agent, by event type, by time window.

**Performance**
- 1,000–2,000 nodes (agents + glyphs) at interactive frame rates via instancing.

**Persistence**
- Autosave the loaded run + view state to localStorage.
- Shareable URL encoding the trace reference + layout seed.

### 4.2 Nice-to-Have (Post-MVP)

- Additional ingestion adapters behind the same parser interface: OpenTelemetry GenAI
  semantic conventions, LangGraph JSON.
- Live tail mode (subscribe to a running agent's event stream) as opposed to recorded
  replay.
- Diff two runs side by side (same task, two models) — topology comparison.
- Cost/latency heat overlays (color the graph by spend rather than by activity).
- Export the run as a glTF scene or a rendered flythrough clip.
- WebXR walkthrough of a run.
- Annotation layer: pin a note to a node/timestamp for triage handoff.

## 5. Technical Architecture (High-Level)

```
┌──────────────────────────────────────────────────────────────┐
│                      Browser (Client-Only)                    │
│                                                               │
│  ┌─────────────────────────────┐                              │
│  │ DATA LAYER  (pure, tested)  │                              │
│  │  trace contract (types)     │                              │
│  │  agent_messages adapter     │                              │
│  │  TraceModel normalization   │                              │
│  │  force-directed 3D layout   │   ── vitest-gated ──         │
│  │  visual-attribute mapping   │      (no GPU needed)         │
│  │  timeline/playhead model    │                              │
│  └──────────────┬──────────────┘                              │
│                 │  TraceModel + Layout + Attrs                │
│                 ▼                                             │
│  ┌─────────────────────────────┐                              │
│  │ RENDER LAYER (thin)         │                              │
│  │  R3F scene: instanced nodes │                              │
│  │  GLSL message arcs          │                              │
│  │  tool-call glyphs           │                              │
│  │  environment + bloom rig    │   ── human-held look review ─│
│  │  orbit/fly controls         │                              │
│  │  UI overlay + timeline      │                              │
│  └─────────────────────────────┘                              │
│                 │                                             │
│                 ▼                                             │
│  localStorage autosave  ·  shareable URL (seed + ref)         │
└──────────────────────────────────────────────────────────────┘
```

- **Stack**: Vite + TypeScript + React + React Three Fiber + drei +
  @react-three/postprocessing + Zustand.
- **The critical architectural rule**: the data layer (parser, layout, attribute
  mapping, timeline model) is **pure and fully unit-testable in jsdom**, and the
  render layer is a thin consumer of it. Rendering cannot be verified headlessly, so
  the automation gates the pure half hard and the visual half is reviewed by a human —
  the same split that let a heavily-visual project (torchship) stay mostly
  cron-drivable, with its look held for humans.
- **Rendering path**: WebGL2 first (compatibility), with a WebGPU path behind the same
  scene contract where it measurably helps large traces. WebGPU is an optimization, not
  a v1 requirement.
- **Geometry budget**: one instanced mesh for nodes, one batched geometry for arcs, one
  for glyphs. Every repeated element is instanced; the draw-call ceiling is a gate.
- **Determinism**: layout is seeded; the same trace always renders the same shape, so
  screenshots and reviews are reproducible.
- **Build pattern**: multi-agent parallel streams — *trace contract + parser*,
  *layout/graph*, *arcs & materials*, *glyphs*, *environment/lighting*, *controls/camera*,
  *UI overlay*, *performance (instancing, draw calls)* — integrate, then iterative
  review loops: walk the run, list defects, fix, repeat until clean.

## 6. Milestones & Timeline (2-Week MVP)

| Milestone | Name | Days | Exit Criteria |
|---|---|---|---|
| M1 | Foundation, Trace Contract & Data Layer | 1–2 | App boots; typed trace contract defined; agent_messages adapter + parser green on fixtures; timeline model tested |
| M2 | Spatial Layout Engine (pure) | 2–4 | Deterministic seeded force layout over the agent graph; visual-attribute mapping; invariants tested |
| M3 | Scene Construction & Rendering | 4–7 | Instanced nodes, batched animated arcs, orbiting tool glyphs, calibrated bloom rig; draw-call ceiling met |
| M4 | Playback, Controls & Inspection UI | 7–9 | Scrubber + playback, orbit/fly cameras, node detail panel, filter/focus, HUD summary |
| M5 | Scale, the "3D earns its keep" proof & polish | 9–11 | 1–2k nodes interactive; frame budget measured; the real fleet run rendered; the spatial-insight criterion demonstrated; visual review loop done |
| M6 | Persistence, QA & Launch | 11–14 | Shareable URL + autosave; defect pass converging to zero; public demo deployed; README with screenshots/GIF |

## 7. Success Metrics

- **The 3D-earns-its-keep criterion (primary, gated):** the scene must surface at least
  two structural facts *faster than a timeline does* on the reference run — candidate
  facts: total fan-out per agent, an unbounded/looping sub-agent, message-volume
  imbalance between agents, and cost concentration. These are named in the demo
  scenario and demonstrated side by side against a timeline view. **If this cannot be
  demonstrated, the project ships as a demo, not a tool, and is reported as such.**
- **Performance:** 1,000+ nodes interactive; draw calls under the enforced ceiling;
  frame budget met on a mid-range laptop; measured and reported, not asserted.
- **Correctness:** the rendered scene is a verified function of the trace — every node,
  arc and glyph traces to a real event; parser/layout determinism pinned by tests.
- **Time-to-first-insight:** a new user identifies an agent's fan-out count in < 60 s
  on the reference run without reading docs.
- **Dogfood:** the first shipped trace is the authoring pipeline's own
  `debian2_bot` fleet run, ingested end-to-end.
- **Traction (open-source):** 100+ GitHub stars in the first month; the demo GIF is
  usable as an explainer by someone who has never installed it.

## 8. Risks, Non-Goals & Open Questions

**Risks**
- *3D-for-debugging is an unproven product bet.* The traction in this space is 2D. A
  force-directed 3D graph can be **harder** to read than a scrubber for step-by-step
  diagnosis. Mitigation: the success criterion in §7 is mandatory and is demonstrated
  against a timeline, not assumed.
- *Rendering is not verifiable in the automation harness.* jsdom has no GPU. Mitigation:
  the pure/render split in §5; visual correctness is a human-held review (a planned,
  funded step in M5, not a surprise).
- *Format sprawl.* Three ingestion formats are tempting. v1 takes exactly one
  (`agent_messages`); OTel/LangGraph adapters are explicitly post-MVP.
- *Adjacency in the backlog.* `AgentReplay` (idea 168), `traceview` (97), `tracediff`
  (150) already cover linear replay/search/diff. AgentScape must not drift into being a
  worse timeline — **the spatial view is the product.**

**Non-Goals (v1)**
- Not a live production observability platform (no streaming tail, no alerting, no
  retention).
- Not a replacement for Langfuse/Phoenix/agent-prism — it reads their exported traces;
  it is a *view*, not a backend.
- Not a general graph editor — layout is derived, never hand-authored.
- Not a real-time collaborative tool.

**Open Questions**
- Which single structural fact is the hero of the demo? (Recommend: runaway/looping
  sub-agent growth, and per-agent fan-out.)
- Does the WebGPU path earn its place in v1, or is WebGL2 + instancing sufficient at
  2k nodes? (Measure in M5; do not pre-commit.)
- Is a companion timeline pane required for credibility (so users can cross-check), and
  does that undercut the "3D is the product" thesis?

## 9. Task List (JSON, grouped by milestone)

```json
{
  "project": "AgentScape — 3D Spatial Trace Visualizer for Multi-Agent AI Runs",
  "milestones": [
    {
      "id": "M1",
      "name": "Foundation, Trace Contract & Data Layer",
      "days": "1-2",
      "tasks": [
        {"id": "M1-T1", "title": "Scaffold Vite + TypeScript + React + React Three Fiber app", "estimate_h": 2},
        {"id": "M1-T2", "title": "Add lint/format/typecheck/vitest/build gate and dev scripts", "estimate_h": 2},
        {"id": "M1-T3", "title": "Define the typed trace contract: Run, Agent, Message, ToolCall, Event", "estimate_h": 4},
        {"id": "M1-T4", "title": "agent_messages export adapter (Supabase rows -> trace contract)", "estimate_h": 4},
        {"id": "M1-T5", "title": "TraceModel normalization pass with deterministic output, plus tests", "estimate_h": 3},
        {"id": "M1-T6", "title": "Deterministic trace fixtures: synthetic multi-agent runs (fan-out, loop, dead branch, handoff chain)", "estimate_h": 3},
        {"id": "M1-T7", "title": "Timeline/playhead model over the event stream, plus tests", "estimate_h": 3}
      ]
    },
    {
      "id": "M2",
      "name": "Spatial Layout Engine (pure)",
      "days": "2-4",
      "tasks": [
        {"id": "M2-T1", "title": "Force-directed 3D layout over the agent graph (seeded, deterministic)", "estimate_h": 6},
        {"id": "M2-T2", "title": "Layout settlement rules: stable convergence, no jitter, reproducible re-layout", "estimate_h": 4},
        {"id": "M2-T3", "title": "Visual-attribute mapping: node size/emissive from activity, arc width from message volume", "estimate_h": 3},
        {"id": "M2-T4", "title": "Derived edge model: spawn/handoff/message edges from the trace, never hand-placed", "estimate_h": 4},
        {"id": "M2-T5", "title": "Layout + attribute invariant tests across all fixtures", "estimate_h": 4}
      ]
    },
    {
      "id": "M3",
      "name": "Scene Construction & Rendering",
      "days": "4-7",
      "tasks": [
        {"id": "M3-T1", "title": "Agent nodes as instanced glowing meshes (one InstancedMesh, per-node attrs)", "estimate_h": 5},
        {"id": "M3-T2", "title": "Message arcs as batched animated GLSL curves (not one mesh per message)", "estimate_h": 6},
        {"id": "M3-T3", "title": "Tool-call glyphs orbiting their calling agent node", "estimate_h": 4},
        {"id": "M3-T4", "title": "Environment and lighting rig with bloom-honest emissive calibration", "estimate_h": 4},
        {"id": "M3-T5", "title": "Draw-call budget gate measured against fixtures (ceiling enforced in tests)", "estimate_h": 3},
        {"id": "M3-T6", "title": "Scene mounts a fixture trace end to end (data -> layout -> render)", "estimate_h": 3}
      ]
    },
    {
      "id": "M4",
      "name": "Playback, Controls & Inspection UI",
      "days": "7-9",
      "tasks": [
        {"id": "M4-T1", "title": "Timeline scrubber with play/pause/speed/step-to-next-event", "estimate_h": 5},
        {"id": "M4-T2", "title": "Orbit camera mode (survey the run shape)", "estimate_h": 3},
        {"id": "M4-T3", "title": "Fly camera mode (move inside the run)", "estimate_h": 4},
        {"id": "M4-T4", "title": "Node click -> detail panel: agent, messages, tool calls, timing, cost attribution", "estimate_h": 4},
        {"id": "M4-T5", "title": "Filter and focus: by agent, by event type, by time window", "estimate_h": 4},
        {"id": "M4-T6", "title": "HUD overlay: run summary (agents, messages, duration, tokens, cost)", "estimate_h": 3}
      ]
    },
    {
      "id": "M5",
      "name": "Scale, the 3D-Earns-Its-Keep Proof & Polish",
      "days": "9-11",
      "tasks": [
        {"id": "M5-T1", "title": "Scale to 1-2k nodes via instancing + level-of-detail; measure frame budget", "estimate_h": 6},
        {"id": "M5-T2", "title": "Frame-budget profiling report on a mid-range target (measured, not asserted)", "estimate_h": 3},
        {"id": "M5-T3", "title": "Render the real debian2_bot fleet run from an agent_messages export (dogfood scenario)", "estimate_h": 4},
        {"id": "M5-T4", "title": "Implement and demonstrate the spatial-insight criterion vs a timeline (fan-out + runaway loop)", "estimate_h": 5},
        {"id": "M5-T5", "title": "Human-held visual review loop: walk the run, list defects, fix, repeat", "estimate_h": 4}
      ]
    },
    {
      "id": "M6",
      "name": "Persistence, QA & Launch",
      "days": "11-14",
      "tasks": [
        {"id": "M6-T1", "title": "localStorage autosave of loaded run + view state", "estimate_h": 2},
        {"id": "M6-T2", "title": "Shareable URL: trace reference + layout seed", "estimate_h": 3},
        {"id": "M6-T3", "title": "Full defect pass and fix loop until the defect count converges to zero", "estimate_h": 4},
        {"id": "M6-T4", "title": "Deploy public demo (static hosting) with README, screenshots and a demo GIF", "estimate_h": 4},
        {"id": "M6-T5", "title": "Post-MVP backlog triage (OTel/LangGraph adapters, live tail, run diff, WebXR, annotations)", "estimate_h": 2}
      ]
    }
  ]
}
```

---

*Generated by Hermes Agent · AgentScape PRD v1.0 (draft)*
