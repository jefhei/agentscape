import './App.css'
import Viewport from './Viewport'

/**
 * AgentScape app shell (M1-T1): header + 3D viewport.
 *
 * The header carries the project name and its one-line thesis. The main area
 * is the R3F viewport — an empty scene for now (see `Viewport.tsx`): the trace
 * data layer (M1-T3..M1-T7) and the spatial layout (M2) have to exist before
 * there is anything to draw, so this task wires the shell, not the scene.
 */
export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">AgentScape</h1>
        <p className="app-tagline">
          3D spatial trace visualizer for multi-agent AI runs
        </p>
      </header>
      <main className="app-main">
        <Viewport />
      </main>
    </div>
  )
}
