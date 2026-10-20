import './App.css'
import { buildFixture } from './fixtures/index.ts'
import type { FixtureShape } from './fixtures/index.ts'
import { usePlayback } from './playback/index.ts'
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
 */
export default function App() {
  const playback = usePlayback(MOUNTED_RUN)

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">AgentScape</h1>
        <p className="app-tagline">
          3D spatial trace visualizer for multi-agent AI runs
        </p>
      </header>
      <main className="app-main">
        <Viewport run={MOUNTED_RUN} frame={playback.frame} />
        <TransportBar
          state={playback.state}
          scrubber={playback.scrubber}
          onAction={playback.dispatch}
        />
      </main>
    </div>
  )
}
