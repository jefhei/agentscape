import { useMemo, useState } from 'react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import type { TraceModel } from './model/index.ts'
import AgentNodeLayer from './scene/AgentNodeLayer.tsx'
import MessageArcLayer from './scene/MessageArcLayer.tsx'
import GlyphLayer from './scene/GlyphLayer.tsx'
import EnvironmentRig from './scene/EnvironmentRig.tsx'
import { buildEnvironmentPlan } from './scene/environment.ts'

/**
 * The AgentScape viewport (M1-T1, extended M3-T1..M3-T4).
 *
 * A thin render-layer shell around the React Three Fiber `<Canvas>`. With no
 * `run` it is the empty scene M1-T1 landed: the rig's background and lights, and
 * nothing to draw.
 *
 * Given a `run` (M1-T5), it mounts the scene layers: the environment/lighting/
 * bloom rig (M3-T4), the agent-node layer (M3-T1, one `InstancedMesh` of glowing
 * nodes over the settled layout), the message-arc layer (M3-T2, one batched
 * geometry of animated tubes, one per communication link) and the tool-call glyph
 * layer (M3-T3, one `InstancedMesh` of marks orbiting the agent that made each
 * call). Mounting a *fixture* into the app (data → layout → render, end to end) is
 * M3-T6.
 *
 * This shell owns two things the scene graph cannot: the camera framing, and the
 * renderer's tone mapping and exposure. Both are read from the rig plan rather
 * than written here, so the fog band, the framing distance and the emissive
 * calibration are single-sourced (`scene/environment.ts`) and cannot drift apart.
 *
 * Each layer derives the layout it needs from the same run, and all of them are
 * pure and deterministic, so the nodes, the arcs, the glyphs and the rig agree
 * exactly on the shape. M3-T6 consolidates those derivations into one shared scene
 * pass — the right place for it is the task that owns the mounted scene, and it is
 * also where the double settle an M3-T2 note flagged gets paid down.
 *
 * `ready` flips once `onCreated` fires, which is the only honest signal that
 * separates "renderer created and rendering" from "blank canvas". It is what lets
 * the headless tests (jsdom has no GPU) assert the boot path ran.
 */
export interface ViewportProps {
  /** The normalized run to render; omit for an empty scene. */
  run?: TraceModel
}

export default function Viewport({ run }: ViewportProps) {
  const [ready, setReady] = useState(false)
  // Pure and deterministic, so this is safe to memoize on the run alone; the rig
  // scales itself to the settled cloud's extent (M3-T4).
  const environment = useMemo(() => buildEnvironmentPlan(run), [run])

  return (
    <div className="viewport" data-testid="viewport">
      <Canvas
        camera={{
          fov: environment.fov,
          near: 0.1,
          far: environment.viewDistance * 10,
          position: [0, 0, environment.viewDistance],
        }}
        gl={{
          antialias: true,
          // The rig plan's tone mapping/exposure — the same numbers the emissive
          // calibration was solved against.
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: environment.exposure,
        }}
        onCreated={() => setReady(true)}
      >
        <EnvironmentRig plan={environment} />
        {run !== undefined && <AgentNodeLayer run={run} />}
        {run !== undefined && <MessageArcLayer run={run} />}
        {run !== undefined && <GlyphLayer run={run} />}
      </Canvas>
      {ready && (
        <span className="viewport-ready" data-testid="viewport-ready">
          viewport ready
        </span>
      )}
    </div>
  )
}
