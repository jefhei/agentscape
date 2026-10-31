import './App.css'
import { useMemo } from 'react'
import { buildFixture } from './fixtures/index.ts'
import type { FixtureShape } from './fixtures/index.ts'
import { useFilter } from './filter/index.ts'
import { buildRunSummary } from './hud/index.ts'
import { evaluateSpatialCriterion } from './insight/index.ts'
import { useSelection } from './inspect/index.ts'
import { usePlayback } from './playback/index.ts'
import {
  DEFAULT_CAMERA_SNAPSHOT,
  bootState,
  browserStorage,
  readStoredSnapshot,
  useAutosave,
} from './persist/index.ts'
import AgentDetailPanel from './ui/AgentDetailPanel.tsx'
import FilterBar from './ui/FilterBar.tsx'
import InsightRail from './ui/InsightRail.tsx'
import RunHud from './ui/RunHud.tsx'
import TransportBar from './ui/TransportBar.tsx'
import Viewport from './Viewport'

/**
 * The run the app mounts when nothing else asks for one (M1-T6 → M3-T6).
 *
 * Fan-out is the shape the product is about — one orchestrator putting five workers
 * to work — so it is the run a visitor sees first: a wide, obviously *spatial*
 * structure that a linear transcript would flatten into six unrelated messages.
 *
 * This is a deliberate end-to-end mount, not a run picker: M3-T6's job is to prove
 * the path data → layout → render works in the real app. A real export
 * (the `debian2_bot` fleet dogfood) mounts through `?trace=fleet` (M5-T3), and the
 * autosave (M6-T1) remembers which of them was open.
 */
const DEFAULT_FIXTURE: FixtureShape = 'fan-out'

/** The run the app mounts — built through the real ingest path (M1-T4 + M1-T5). */
export const MOUNTED_RUN = buildFixture(DEFAULT_FIXTURE).run

/** The page's query string, or `''` outside a browser (tests, SSR). */
function currentSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search
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
 *
 * Since M5-T4 it mounts the **structural readout**: {@link InsightRail} prints the
 * criterion report `evaluateSpatialCriterion(run)` derives — the structural facts
 * the scene encodes (fan-out, a reciprocating loop, volume concentration), each
 * row a pointer back into the scene. The rail stands down while the inspector is
 * open, because the inspector owns that corner of the screen; and like the HUD it
 * is a function of the run alone, so scrubbing or filtering never rewrites it.
 *
 * Since M6-T1 it owns **persistence** instead of assuming a fresh start: the boot
 * (which run opens, and which saved view lands on it) is decided once by the pure
 * {@link bootState}, the saved playhead / lens / selection seed the three hooks
 * below, and {@link useAutosave} writes the view back to `localStorage` while the
 * app is used. The camera is the one part the shell cannot read — it lives in the
 * viewport — so the viewport reports it through a stable callback into the
 * autosave's ref, which keeps a drag from re-rendering the shell.
 */
export default function App() {
  // What the page asks for, and what the last visit left behind (M6-T1). Both are
  // read once: a URL is not state that can change under a mount, and a snapshot is
  // the *previous* session's answer, not a live source. Every child takes the run
  // by reference.
  const storage = useMemo(() => browserStorage(), [])
  const saved = useMemo(() => readStoredSnapshot(storage), [storage])
  const boot = useMemo(() => bootState(currentSearch(), saved, MOUNTED_RUN), [saved])
  const run = boot.run
  const restored = boot.restored

  const playback = usePlayback(run, restored?.playback)
  const selection = useSelection(run, restored?.selection)
  const filter = useFilter(run, restored?.filter)
  // The HUD's summary (M4-T6) is a pure function of the run, derived once for the
  // life of the mount — outside React state on purpose: it must not move with the
  // playhead or the lens, and there is nothing to invalidate it.
  const summary = useMemo(() => buildRunSummary(run), [run])
  // The criterion report (M5-T4) is the same kind of fact — a function of the run
  // alone — and the rail is its caption. Derived once: no playhead, no lens.
  const insight = useMemo(() => evaluateSpatialCriterion(run), [run])
  // The autosave (M6-T1) writes the view a burst at a time; the viewport reports
  // the camera into it because only the viewport holds one.
  const autosave = useAutosave({
    run,
    trace: boot.trace,
    elapsedMs: playback.state.playhead.elapsedMs,
    speed: playback.state.playhead.speed,
    filter: filter.filter,
    selection: selection.agentId,
    camera: restored?.camera ?? DEFAULT_CAMERA_SNAPSHOT,
  })

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
          initialCamera={restored?.camera ?? null}
          onCameraChange={autosave.onCameraChange}
        />
        <RunHud summary={summary} />
        {selection.agentId === null && (
          <InsightRail report={insight} onSelectAgent={selection.toggle} />
        )}
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
