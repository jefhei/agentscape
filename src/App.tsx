import './App.css'

/**
 * AgentScape app shell.
 *
 * Deliberately does NOT mount a React Three Fiber scene: landing the R3F
 * viewport is M1-T1 (see BUILD_PLAN.md). Keeping three.js out of the init
 * commit means the first build task has real work to do rather than
 * re-deriving a scaffold.
 */
export default function App() {
  return (
    <main className="app-shell">
      <h1 className="app-title">AgentScape</h1>
      <p className="app-tagline">3D spatial trace visualizer for multi-agent AI runs</p>
      <p className="app-status">App shell online. The R3F viewport lands in M1-T1.</p>
    </main>
  )
}
