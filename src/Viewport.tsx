import { useLayoutEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useThree } from '@react-three/fiber'
import type { TraceModel } from './model/index.ts'
import Scene from './scene/Scene.tsx'
import EnvironmentRig from './scene/EnvironmentRig.tsx'
import { buildEnvironmentPlan } from './scene/environment.ts'
import type { EnvironmentPlan } from './scene/environment.ts'
import { buildScenePlan, sceneCamera } from './scene/scenePlan.ts'
import type { SceneCamera } from './scene/scenePlan.ts'

/** The rig's tone-mapping name (M3-T4) → the three.js constant that applies it. */
const TONE_MAPPING: Record<EnvironmentPlan['toneMapping'], THREE.ToneMapping> = {
  ACESFilmic: THREE.ACESFilmicToneMapping,
}

/**
 * Applies the scene's camera plan to the renderer's camera.
 *
 * The camera *numbers* — position, look-at target, fov, near, far — are decided by
 * the pure layer (`sceneCamera`, M3-T6), which frames the settled cloud's centre
 * with the rig's own framing distance and field of view. This component is the
 * only place that touches the `PerspectiveCamera`, which is exactly the kind of
 * thing the data layer cannot do. R3F creates its default camera looking at the
 * origin; without this, a cloud that settled off-centre would render off-centre.
 */
function CameraRig({ camera }: { camera: SceneCamera }) {
  const three = useThree((state) => state.camera)
  useLayoutEffect(() => {
    three.position.set(camera.position.x, camera.position.y, camera.position.z)
    three.lookAt(camera.target.x, camera.target.y, camera.target.z)
    if (three instanceof THREE.PerspectiveCamera) {
      three.fov = camera.fov
      three.near = camera.near
      three.far = camera.far
      three.updateProjectionMatrix()
    }
  }, [three, camera])
  return null
}

/**
 * The AgentScape viewport (M1-T1, mounted scene since M3-T6).
 *
 * A thin render-layer shell around the React Three Fiber `<Canvas>`. With no
 * `run` it is the empty scene M1-T1 landed: the rig's background, fog and lights,
 * and nothing to draw.
 *
 * Given a `run` (M1-T5), it composes the scene **once** — {@link buildScenePlan},
 * one settlement, one attribute map, all four layer plans — and mounts it as one
 * `<Scene>`. Composing here rather than inside each layer is what makes the whole
 * scene agree structurally: the nodes, arcs, glyphs and rig are built from the
 * same layout object and attribute map, not from four independent derivations, and
 * the camera, the fog band and the framing distance all come from the same plan.
 *
 * The shell owns two things the scene graph cannot: the renderer's tone mapping /
 * exposure (read from the rig plan, so the emissive calibration and the renderer
 * cannot disagree) and the camera plan application ({@link CameraRig}). Everything
 * else — what to draw and where — was decided in `src/scene/`.
 *
 * The `data-*` attributes on the wrapper are not UI: they are how a headless test
 * asserts that a run really reached the renderer (jsdom has no GPU, so a mounted
 * scene cannot be inspected any other way). They are the run id and the measured
 * draw-call total of the scene that was composed.
 *
 * `ready` flips once `onCreated` fires, which is the only honest signal that
 * separates "renderer created and rendering" from "blank canvas".
 */
export interface ViewportProps {
  /** The normalized run to render; omit for an empty scene. */
  run?: TraceModel
}

export default function Viewport({ run }: ViewportProps) {
  const [ready, setReady] = useState(false)

  // One scene pass for the whole run, memoized on the run alone: every plan below
  // (and the camera) is derived from it. Pure and deterministic, so re-rendering
  // with the same run rebuilds nothing.
  const scene = useMemo(() => (run === undefined ? null : buildScenePlan(run)), [run])

  // The empty scene still needs a rig — and a camera — so its frame matches what a
  // loaded run would be framed with. Both fall back to the rig's own defaults.
  const environment = useMemo(
    () => scene?.environment ?? buildEnvironmentPlan(),
    [scene],
  )
  const camera = useMemo(
    () => scene?.camera ?? sceneCamera(environment, null),
    [scene, environment],
  )

  return (
    <div
      className="viewport"
      data-testid="viewport"
      data-run-id={scene?.runId}
      data-draw-calls={scene?.drawCalls}
    >
      <Canvas
        camera={{
          fov: camera.fov,
          near: camera.near,
          far: camera.far,
          position: [camera.position.x, camera.position.y, camera.position.z],
        }}
        gl={{
          antialias: true,
          // The rig plan's tone mapping/exposure — the same numbers the emissive
          // calibration was solved against.
          toneMapping: TONE_MAPPING[environment.toneMapping],
          toneMappingExposure: environment.exposure,
        }}
        onCreated={() => setReady(true)}
      >
        <CameraRig camera={camera} />
        {scene !== null ? (
          <Scene plan={scene} />
        ) : (
          <EnvironmentRig plan={environment} />
        )}
      </Canvas>
      {ready && (
        <span className="viewport-ready" data-testid="viewport-ready">
          viewport ready
        </span>
      )}
    </div>
  )
}
