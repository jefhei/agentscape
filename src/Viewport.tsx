import { useState } from 'react'
import { Canvas } from '@react-three/fiber'
import type { TraceModel } from './model/index.ts'
import AgentNodeLayer from './scene/AgentNodeLayer.tsx'
import MessageArcLayer from './scene/MessageArcLayer.tsx'

/**
 * The AgentScape viewport (M1-T1, extended M3-T1 and M3-T2).
 *
 * A thin render-layer shell around the React Three Fiber `<Canvas>`. With no
 * `run` it is the empty scene M1-T1 landed (a single background colour) — the
 * app shell boots and the renderer comes up with nothing to draw.
 *
 * Given a `run` (M1-T5), it mounts the scene layers: the agent-node layer
 * (M3-T1, one `InstancedMesh` of glowing nodes over the settled layout) and the
 * message-arc layer (M3-T2, one batched geometry of animated tubes, one per
 * communication link). Mounting a *fixture* into the app (data → layout →
 * render, end to end) is M3-T6; this task lands the arc layer and its seam.
 *
 * Each layer derives the layout it needs from the same run, and both are pure
 * and deterministic, so the nodes and the arcs agree exactly on the shape. M3-T6
 * consolidates the two derivations into one shared scene pass — the right place
 * for it is the task that owns the mounted scene.
 *
 * `ready` flips once `onCreated` fires, which is the only honest signal that
 * separates "renderer created and rendering" from "blank canvas". It is what
 * lets the headless tests (jsdom has no GPU) assert the boot path ran.
 */
export interface ViewportProps {
  /** The normalized run to render; omit for an empty scene. */
  run?: TraceModel
}

export default function Viewport({ run }: ViewportProps) {
  const [ready, setReady] = useState(false)

  return (
    <div className="viewport" data-testid="viewport">
      <Canvas
        camera={{ fov: 55, near: 0.1, far: 2000, position: [0, 0, 12] }}
        gl={{ antialias: true }}
        onCreated={() => setReady(true)}
      >
        {/* M1-T1 scene: background only until a run is handed in (M3-T6 mounts one). */}
        <color attach="background" args={['#05070d']} />
        {run !== undefined && <AgentNodeLayer run={run} />}
        {run !== undefined && <MessageArcLayer run={run} />}
      </Canvas>
      {ready && (
        <span className="viewport-ready" data-testid="viewport-ready">
          viewport ready
        </span>
      )}
    </div>
  )
}
