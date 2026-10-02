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
`BUILD_PLAN.md`. Current task: **M1-T1 — land the React Three Fiber viewport**.

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
npm run verify   # lint + typecheck + test + build
```

> Install with `npm ci`, not `npm install` — these repos ship a pinned sibling
> lockfile; plain `npm install` hits a known npm arborist failure on this dep set.
