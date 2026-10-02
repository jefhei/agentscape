import { useState } from 'react'
import { Canvas } from '@react-three/fiber'

/**
 * The AgentScape viewport (M1-T1).
 *
 * A thin render-layer shell around the React Three Fiber `<Canvas>`. The
 * scene is deliberately EMPTY right now — a single background colour — because
 * nothing in the data layer that feeds it exists yet: the typed trace contract
 * (M1-T3), the `agent_messages` adapter (M1-T4), the normalized trace model
 * (M1-T5) and the force-directed layout (M2) all land before a single node,
 * arc or glyph can be drawn (M3). This task proves the viewport mounts and the
 * renderer boots; it does not attempt to render trace data.
 *
 * Why an empty scene is the correct scope here: per the load-bearing
 * architectural rule (PRD §5), the render layer is a thin *consumer* of a pure,
 * fully unit-tested data layer. Landing render scaffolding before the data
 * contract exists would invert that dependency. So this is the shell half of
 * the split — the canvas, the camera and the boot callback — with the data
 * half arriving next.
 *
 * `ready` flips once `onCreated` fires, which is the only honest signal that
 * separates "renderer created and rendering" from "blank canvas". It is what
 * lets the headless tests (jsdom has no GPU) assert the boot path ran.
 */
export default function Viewport() {
  const [ready, setReady] = useState(false)

  return (
    <div className="viewport" data-testid="viewport">
      <Canvas
        camera={{ fov: 55, near: 0.1, far: 2000, position: [0, 0, 12] }}
        gl={{ antialias: true }}
        onCreated={() => setReady(true)}
      >
        {/* M1-T1 scene: background only. Nodes/arcs/glyphs land in M3. */}
        <color attach="background" args={['#05070d']} />
      </Canvas>
      {ready && (
        <span className="viewport-ready" data-testid="viewport-ready">
          viewport ready
        </span>
      )}
    </div>
  )
}
