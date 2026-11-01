import './App.css'
import { useCallback, useMemo } from 'react'
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
  shareHref,
  useAutosave,
} from './persist/index.ts'
import { traceRequestQuery } from './trace/index.ts'
import AgentDetailPanel from './ui/AgentDetailPanel.tsx'
import FilterBar from './ui/FilterBar.tsx'
import InsightRail from './ui/InsightRail.tsx'
import RunHud from './ui/RunHud.tsx'
import ShareLink from './ui/ShareLink.tsx'
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

/**
 * The canonical `?trace=` fragment that names the default mount (M6-T2).
 *
 * A share link must name the run it shows, so *every* run the app can mount needs
 * a reference — including this one, which used to be nameless (it was simply
 * whatever loaded with no URL). `traceRequestQuery` returns a fragment for every
 * fixture shape by construction, so the fallback below is unreachable; it is there
 * because the type is `string | null` for the parser's general contract.
 */
const DEFAULT_TRACE =
  traceRequestQuery({ kind: 'fixture', shape: DEFAULT_FIXTURE }) ?? ''

/** The page's query string, or `''` outside a browser (tests, SSR). */
function currentSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search
}

/**
 * The page's own address without its query or fragment — the base a share link is
 * built on (`https://host/path/`). `''` outside a browser.
 */
function currentBase(): string {
  if (typeof window === 'undefined') return ''
  return `${window.location.origin}${window.location.pathname}`
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
 *
 * Since M6-T2 it also **shares**: {@link ShareLink} puts a URL on the clipboard
 * that names the run, the layout seed and the same view the autosave would write,
 * so a recipient rebuilds the trace through the ingest path and settles it at the
 * sharer's seed. The shell supplies the run's reference (the URL's, or the default
 * fixture's own) and the seed the scene is settled with; the link's *contents* are
 * `src/persist/share.ts`'s business.
 */
export default function App() {
  // What the page asks for, and what the last visit left behind (M6-T1). Both are
  // read once: a URL is not state that can change under a mount, and a snapshot is
  // the *previous* session's answer, not a live source. Every child takes the run
  // by reference.
  const storage = useMemo(() => browserStorage(), [])
  const saved = useMemo(() => readStoredSnapshot(storage), [storage])
  const boot = useMemo(
    () =>
      bootState(currentSearch(), saved, MOUNTED_RUN, { fallbackTrace: DEFAULT_TRACE }),
    [saved],
  )
  const run = boot.run
  const restored = boot.restored
  // The one reference that names what is mounted — the URL's, or the default's
  // (M6-T2). The autosave writes it and a share link carries it.
  const trace = boot.trace ?? DEFAULT_TRACE
  // The seed the shape is settled with: the link's if it pinned one, else the run's
  // own contract seed. `buildScenePlan` reports the same value back as `plan.seed`.
  const layoutSeed = boot.seed ?? run.seed

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
    trace,
    elapsedMs: playback.state.playhead.elapsedMs,
    speed: playback.state.playhead.speed,
    filter: filter.filter,
    selection: selection.agentId,
    camera: restored?.camera ?? DEFAULT_CAMERA_SNAPSHOT,
  })
  // A share link (M6-T2) is built on click, not on render: it names the *live*
  // view (which moves every frame while a run plays), and building it is one
  // base64 encode of the very snapshot the autosave would write.
  const capture = autosave.capture
  const shareHrefFor = useCallback(
    () =>
      shareHref(currentBase(), {
        trace,
        seed: layoutSeed,
        snapshot: capture(0),
      }),
    [capture, layoutSeed, trace],
  )

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">AgentScape</h1>
        <p className="app-tagline">
          3D spatial trace visualizer for multi-agent AI runs
        </p>
        <ShareLink buildHref={shareHrefFor} />
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
          layoutSeed={layoutSeed}
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
