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
`BUILD_PLAN.md`. The R3F viewport (M1-T1) is landed — an empty scene wired into the app
shell, waiting on the trace data layer to give it something to draw. The five-part build
gate is wired (M1-T2): `npm run verify` runs lint → format → typecheck → test → build.
The typed trace contract (M1-T3) is landed in [`src/types/`](src/types/trace.ts) —
`Run`, `Agent`, `Message`, `ToolCall` and the `Event` union every other module speaks.
Next: **M1-T4 — `agent_messages` export adapter (Supabase rows → trace contract)**.

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
