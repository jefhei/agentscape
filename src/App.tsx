import './App.css'
import { useMemo } from 'react'
import { buildFixture } from './fixtures/index.ts'
import type { FixtureShape } from './fixtures/index.ts'
import { useFilter } from './filter/index.ts'
import { buildRunSummary } from './hud/index.ts'
import { useSelection } from './inspect/index.ts'
import type { TraceModel } from './model/index.ts'
import { usePlayback } from './playback/index.ts'
import { mountTrace } from './trace/index.ts'
import AgentDetailPanel from './ui/AgentDetailPanel.tsx'
import FilterBar from './ui/FilterBar.tsx'
import RunHud from './ui/RunHud.tsx'
import TransportBar from './ui/TransportBar.tsx'
import Viewport from './Viewport'

/**
 * The fixture the app mounts on boot (M1-T6 → M3-T6).
 *
 * Fan-out is the shape the product is about — one orchestrator putting five workers
 * to work — so it is the run a visitor sees first: a wide, obviously *spatial*
 * structure that a linear transcript would flatten into six unrelated messages.
 *
 * This is a deliberate end-to-end mount, not a run picker: M3-T6's job is to prove
 * the path data → layout → render works in the real app. Loading a real export
 * (the `debian2_bot` fleet dogfood) is M5-T3, and choosing between runs is a loader
 * that lands after the playback UI (M4).
 */
const DEFAULT_FIXTURE: FixtureShape = 'fan-out'

/** The run the app mounts — built through the real ingest path (M1-T4 + M1-T5). */
export const MOUNTED_RUN = buildFixture(DEFAULT_FIXTURE).run

/**
 * The run to mount for the current URL (M5-T2's profiling affordance, M5-T3's
 * dogfood).
 *
 * `?trace=scale:2000` mounts a synthetic run of that size, `?trace=fleet` mounts
 * the real `debian2_bot` export snapshot; anything else — the normal case, and
 * every mistyped URL — mounts {@link MOUNTED_RUN}. The choice itself belongs to
 * the pure `mountTrace` (one parser, both schemes), so this function only picks
 * the default when the URL asked for nothing.
 */
function resolveMountedRun(): TraceModel {
  if (typeof window !== 'undefined') {
    const mounted = mountTrace(window.location.search)
    if (mounted !== null) return mounted.run
  }
  return MOUNTED_RUN
}

/**
 * AgentScape app shell (M1-T1): header + 3D viewport + playback transport.
 *
 * The header carries the project name and its one-line thesis. The main area is
 * the R3F viewport, which since M3-T6 mounts a real trace: a deterministic fixture
 * run, laid out, lit and drawn (nodes, arcs, glyphs, bloom) by the scene layer.
 *
 * Since M4-T1 the shell also owns the **transport**: `usePlayback` holds the
 * playhead, the clock and the key bindings, the {@link TransportBar} overlays the
 * viewport, and the frame it produces is handed to the viewport, which reveals the
 * scene at that instant (`src/scene/reveal.ts`). The three pieces stay separate on
 * purpose — the transport decides *when*, the reveal decides *how lit*, the scene
 * decides *where*. None of them re-derives another's answer.
 *
 * Since M4-T4 it owns the **selection** as well: `useSelection` holds the
 * inspected agent (clicked in the viewport, pruned when the run changes), the
 * viewport highlights it, and {@link AgentDetailPanel} renders its detail at the
 * current playhead. The shell is the right owner because the click, the scene and
 * the panel are three consumers of one fact — putting the state in any one of
 * them would make the other two reach into it.
 *
 * Since M4-T5 it owns the **filter** too: `useFilter` holds the three facets (agent,
 * event type, time window), {@link FilterBar} is their control surface, and the
 * viewport draws the scene through the lens. The filter and the selection are
 * separate on purpose — one narrows the population, the other asks about a single
 * agent — so opening the inspector does not filter the run and filtering does not
 * close the panel: a dimmed agent is still a describable one.
 *
 * Since M4-T6 it mounts the **run HUD**: {@link RunHud} prints the summary
 * `buildRunSummary(MOUNTED_RUN)` derives — the run's own fixed totals (agents,
 * messages, tool calls, duration, tokens, cost). That summary is derived from the
 * run and shared by nothing else on screen — the transport reports the playhead,
 * the filter bar reports the lens, and only the HUD describes the trace itself.
 */
export default function App() {
  // The mounted run (M5-T2): the default fixture, unless the URL asked for a
  // synthetic scale run. Resolved once — a URL is not state that can change
  // under a mount, and every child takes the run by reference.
  const run = useMemo(resolveMountedRun, [])
  const playback = usePlayback(run)
  const selection = useSelection(run)
  const filter = useFilter(run)
  // The HUD's summary (M4-T6) is a pure function of the run, derived once for the
  // life of the mount — outside React state on purpose: it must not move with the
  // playhead or the lens, and there is nothing to invalidate it.
  const summary = useMemo(() => buildRunSummary(run), [run])

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">AgentScape</h1>
        <p className="app-tagline">
          3D spatial trace visualizer for multi-agent AI runs
        </p>
      </header>
      <main className="app-main">
        <Viewport
          run={run}
          frame={playback.frame}
          selectedAgentId={selection.agentId}
          onSelectAgent={selection.toggle}
          filter={filter.filter}
        />
        <RunHud summary={summary} />
        <FilterBar
          agents={run.agents}
          view={filter.view}
          onToggleAgent={filter.toggleAgent}
          onIsolateAgent={filter.isolateAgent}
          onToggleKind={filter.toggleKind}
          onWindow={filter.setWindow}
          onClear={filter.clear}
        />
        <TransportBar
          state={playback.state}
          scrubber={playback.scrubber}
          onAction={playback.dispatch}
        />
        <AgentDetailPanel
          run={run}
          agentId={selection.agentId}
          elapsedMs={playback.frame.elapsedMs}
          onClose={selection.clear}
        />
      </main>
    </div>
  )
}
