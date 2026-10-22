import { useMemo, useState } from 'react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import type { TimelineFrame } from './timeline/index.ts'
import type { TraceModel } from './model/index.ts'
import Scene from './scene/Scene.tsx'
import EnvironmentRig from './scene/EnvironmentRig.tsx'
import { buildEnvironmentPlan } from './scene/environment.ts'
import type { EnvironmentPlan } from './scene/environment.ts'
import { buildRevealTrack, revealAt } from './scene/reveal.ts'
import { buildScenePlan, sceneCamera } from './scene/scenePlan.ts'
import { FlyCameraRig, OrbitCameraRig, useCamera } from './camera/index.ts'
import CameraBar from './ui/CameraBar.tsx'

/** The rig's tone-mapping name (M3-T4) → the three.js constant that applies it. */
const TONE_MAPPING: Record<EnvironmentPlan['toneMapping'], THREE.ToneMapping> = {
  ACESFilmic: THREE.ACESFilmicToneMapping,
}

/**
 * The AgentScape viewport (M1-T1, mounted scene since M3-T6, two camera modes
 * since M4-T3).
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
 * The shell owns four things the scene graph cannot: the renderer's tone mapping
 * / exposure (read from the rig plan, so the emissive calibration and the renderer
 * cannot disagree), the **camera** (since M4-T2 orbit, since M4-T3 orbit *or* fly:
 * {@link useCamera} holds both states and the active mode, the mode's rig applies
 * the pose and measures that mode's input, {@link CameraBar} is the accessible
 * control surface and the switch) and the playback reveal handed down by the app
 * shell (M4-T1). Everything else — what to draw and where — was decided in
 * `src/scene/`; how the camera frames it was decided in `src/scene/scenePlan.ts`
 * (the opening shot) and `src/camera/` (the two pose rules).
 *
 * Exactly one camera rig is mounted at a time. They are not merged into one
 * "smart" rig because their gestures genuinely differ (drag-to-orbit vs
 * drag-to-look, wheel-dolly vs wheel-advance, and only fly needs a held-key frame
 * loop): one component with a mode branch inside would be two components pretending
 * to be one.
 *
 * The `data-*` attributes on the wrapper are not UI: they are how a headless test
 * asserts that a run really reached the renderer and that the camera really
 * moved (jsdom has no GPU, so a mounted scene cannot be inspected any other way).
 * They are the run id, the measured draw-call total of the scene that was
 * composed, the reveal at the playhead, and the camera mode / angles / distance /
 * eye.
 *
 * `ready` flips once `onCreated` fires, which is the only honest signal that
 * separates "renderer created and rendering" from "blank canvas".
 */
export interface ViewportProps {
  /** The normalized run to render; omit for an empty scene. */
  run?: TraceModel
  /**
   * The playback frame to reveal the scene at (M4-T1). Omit to draw the run fully
   * lit — the static scene a mount gets before a transport exists. The frame's
   * `elapsedMs` alone is what the scene needs; the rest is the transport's.
   */
  frame?: TimelineFrame
}

export default function Viewport({ run, frame }: ViewportProps) {
  const [ready, setReady] = useState(false)

  // One scene pass for the whole run, memoized on the run alone: every plan below
  // (and the camera) is derived from it. Pure and deterministic, so re-rendering
  // with the same run rebuilds nothing.
  const scene = useMemo(() => (run === undefined ? null : buildScenePlan(run)), [run])

  // The reveal is indexed once per scene (the O(n) half of M4-T1's reveal) and
  // then looked up per frame — so scrubbing at 60 fps never re-scans the trace.
  const revealTrack = useMemo(
    () => (scene === null ? null : buildRevealTrack(scene)),
    [scene],
  )
  const reveal = useMemo(
    () =>
      revealTrack === null || frame === undefined
        ? null
        : revealAt(revealTrack, frame.elapsedMs),
    [revealTrack, frame],
  )

  // The empty scene still needs a rig — and a camera — so its frame matches what a
  // loaded run would be framed with. Both fall back to the rig's own defaults.
  const environment = useMemo(
    () => scene?.environment ?? buildEnvironmentPlan(),
    [scene],
  )
  const openingCamera = useMemo(
    () => scene?.camera ?? sceneCamera(environment, null),
    [scene, environment],
  )

  // The opening shot is the scene plan's (M3-T6); the camera state is this
  // viewport's, since only it can bind the pointer and the keys to the canvas. Both
  // modes reset when the framing camera changes, i.e. when a different run loads.
  const camera = useCamera(openingCamera, environment.extentRadius)
  const pose = camera.camera

  return (
    <div
      className="viewport"
      data-testid="viewport"
      data-run-id={scene?.runId}
      data-draw-calls={scene?.drawCalls}
      data-playback-elapsed={reveal === null ? undefined : Math.round(reveal.elapsedMs)}
      data-reveal-arcs={reveal?.counts.firedArcs}
      data-reveal-glyphs={reveal?.counts.visibleGlyphs}
      data-camera-mode={camera.mode}
      data-camera-azimuth={Math.round(camera.angles.azimuthDeg)}
      data-camera-elevation={Math.round(camera.angles.elevationDeg)}
      data-camera-distance={pose.distance.toFixed(3)}
      data-camera-position={[
        pose.position.x.toFixed(2),
        pose.position.y.toFixed(2),
        pose.position.z.toFixed(2),
      ].join(',')}
    >
      <Canvas
        camera={{
          fov: pose.fov,
          near: pose.near,
          far: pose.far,
          position: [pose.position.x, pose.position.y, pose.position.z],
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
        {camera.mode === 'fly' ? (
          <FlyCameraRig
            camera={pose}
            onLook={camera.lookBy}
            onAdvance={camera.advance}
            onMove={camera.move}
          />
        ) : (
          <OrbitCameraRig
            camera={pose}
            onOrbit={camera.orbitBy}
            onZoom={camera.zoomBy}
          />
        )}
        {scene !== null ? (
          <Scene plan={scene} reveal={reveal} />
        ) : (
          <EnvironmentRig plan={environment} />
        )}
      </Canvas>
      {ready && (
        <span className="viewport-ready" data-testid="viewport-ready">
          viewport ready
        </span>
      )}
      <CameraBar
        readout={camera.readout}
        hint={camera.hint}
        onToggleMode={camera.toggleMode}
        onZoom={camera.zoomBy}
        onAdvance={camera.advance}
        onReset={camera.reset}
        canZoomIn={camera.canZoomIn}
        canZoomOut={camera.canZoomOut}
      />
    </div>
  )
}
