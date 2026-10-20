import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { TraceModel } from '../model/index.ts'
import { ARC_ATTRIBUTE_NAMES, ARC_ATTRIBUTE_SIZES, buildArcScenePlan } from './arcs.ts'
import type { ArcSceneOptions, ArcScenePlan } from './arcs.ts'
import type { SceneReveal } from './reveal.ts'
import {
  ARC_FRAGMENT_SHADER,
  ARC_VERTEX_SHADER,
  buildArcUniforms,
} from './arcShader.ts'

/**
 * Message arcs as batched animated GLSL curves (M3-T2) — the render half.
 *
 * A deliberately *thin* consumer of the pure arc plan
 * ({@link buildArcScenePlan}, `./arcs.ts`). Per the PRD §5 architectural rule,
 * the render layer owns no logic the data layer could own:
 *
 * - **what to draw** — one tube per communication link: its curve, its ring
 *   vertices and normals, its triangle indices and its animation parameters —
 *   is decided in `./arcs.ts`. Every vertex's position, normal and parameters
 *   arrive as finished numbers.
 * - **how to draw it** — one `BufferGeometry` for the *whole* arc population,
 *   drawn in **one** call (`ARC_LAYER_DRAW_CALLS`) with a `ShaderMaterial` whose
 *   GLSL (`./arcShader.ts`) animates the pulse. There is no mesh per message
 *   anywhere — the PRD is explicit: *"messages as animated arcs between nodes
 *   (batched GLSL, not one mesh per message)"* — and no mesh per *link* either:
 *   every arc is welded into the same buffer.
 * - **the clock** — the only thing the render layer owns that the data layer
 *   cannot. `useFrame` advances the material's single `uTime` uniform, which is
 *   the GPU twin of the pure {@link arcPulseParameter} rule. The animation
 *   *rule* stays pure and testable; only the tick lives here.
 *
 * The animation the plan carries is derived from the trace, not decorative: the
 * pulse rate is the link's normalized message volume (M2-T3) and its direction
 * is the channel's net traffic, with a balanced channel parked (see `./arcs.ts`).
 *
 * ## Not gated, by design
 *
 * jsdom has no GPU, so nothing about the rendered look is asserted in tests
 * (PRD §5). What *is* tested is the pure plan and the geometry/shader contract
 * this component consumes; the look itself is human-reviewed (M5-T5). The
 * lighting rig and the bloom-honest emissive calibration are M3-T4 — the colours
 * and glow constants here are working defaults, not a calibration.
 *
 * A run with no communication links renders nothing (the layer returns `null`),
 * matching the plan's `drawCalls: 0` for an empty layer.
 *
 * ## Headless note
 *
 * Like `AgentNodeLayer`, this module imports three.js directly and calls
 * `useFrame`, so it must be mounted inside an R3F `<Canvas>`. Neither is
 * exercised by the jsdom tests (which cannot create a renderer) — they cover the
 * pure plan and the shader contract instead.
 */
export interface MessageArcLayerProps {
  /** The normalized run to draw (M1-T5). */
  run: TraceModel
  /**
   * A plan already built for this run — from {@link buildScenePlan} (M3-T6), so the
   * whole scene shares one settlement and one batched geometry. Used as-is; when
   * omitted the layer derives its own plan from `run` (the standalone path).
   */
  plan?: ArcScenePlan
  /** Optional plan overrides (settlement / attributes / style / reuse) — ignored when `plan` is given. */
  options?: ArcSceneOptions
  /**
   * What the run has revealed as of the current playhead (M4-T1). Each arc's
   * per-vertex `aIntensity` is multiplied by its channel's `intensity` — faint
   * before traffic, ramping to full as the link's messages fire. Omitted / `null`
   * draws every arc at its plan intensity (the static scene).
   */
  reveal?: SceneReveal | null
}

/**
 * Upload the plan's batched buffers as one geometry: every attribute the plan
 * declares, at the width it declares ({@link ARC_ATTRIBUTE_SIZES}), plus the
 * triangle index buffer. The plan's arrays are plain numbers, which three
 * converts to typed attributes — the render layer decides nothing about them.
 */
function buildArcGeometry(plan: ArcScenePlan): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  for (const name of ARC_ATTRIBUTE_NAMES) {
    geometry.setAttribute(
      name,
      new THREE.Float32BufferAttribute(plan.buffers[name], ARC_ATTRIBUTE_SIZES[name]),
    )
  }
  geometry.setIndex(plan.buffers.indices)
  geometry.computeBoundingSphere()
  return geometry
}

export default function MessageArcLayer({
  run,
  plan,
  options,
  reveal,
}: MessageArcLayerProps) {
  // Rebuilding the plan is pure; memoized so a re-render with the same
  // run/options does not re-settle the layout. A supplied plan wins, which is how
  // the mounted scene pays for one settlement, not four.
  const resolved = useMemo(
    () => plan ?? buildArcScenePlan(run, options),
    [plan, run, options],
  )
  const materialRef = useRef<THREE.ShaderMaterial | null>(null)

  // One geometry for the whole batch — or none, when there is nothing to draw
  // (an empty attribute buffer has no meaningful bounds).
  const geometry = useMemo(
    () => (resolved.count === 0 ? null : buildArcGeometry(resolved)),
    [resolved],
  )

  // Release the previous batch's GPU buffers when the plan changes or we unmount.
  useEffect(() => {
    if (geometry === null) return undefined
    return () => geometry.dispose()
  }, [geometry])

  // The plan's own per-vertex intensities — the static baseline the reveal
  // scales. A typed copy so the geometry attribute can be rewritten in place
  // every frame without ever touching the plan.
  const baseIntensity = useMemo(
    () =>
      resolved.count === 0 ? null : Float32Array.from(resolved.buffers.aIntensity),
    [resolved],
  )

  // Apply the reveal (M4-T1): every vertex of an arc scales with its channel's
  // lit factor. The channel *is* the link, whose vertex range the plan records,
  // so no per-arc bookkeeping is needed here — one pass, one upload.
  useEffect(() => {
    if (geometry === null || baseIntensity === null) return
    const attribute = geometry.getAttribute(
      'aIntensity',
    ) as unknown as THREE.BufferAttribute
    const array = attribute.array as Float32Array
    array.set(baseIntensity)
    if (reveal !== null && reveal !== undefined) {
      for (let index = 0; index < resolved.arcs.length; index += 1) {
        const arc = resolved.arcs[index]
        const intensity = reveal.arcs[index]?.intensity ?? 1
        const end = arc.vertexStart + arc.vertexCount
        for (let vertex = arc.vertexStart; vertex < end; vertex += 1) {
          array[vertex] = baseIntensity[vertex] * intensity
        }
      }
    }
    attribute.needsUpdate = true
  }, [geometry, baseIntensity, reveal, resolved])

  const uniforms = useMemo(() => buildArcUniforms(resolved.style), [resolved.style])

  // The one tick the render layer owns: advance the pulse clock. The rule it
  // feeds (./arcs.ts `arcPulseParameter`) is pure and unit-tested.
  useFrame((state) => {
    const material = materialRef.current
    if (material === null) return
    const uniform = material.uniforms.uTime
    if (uniform !== undefined) uniform.value = state.clock.elapsedTime
  })

  if (geometry === null) return null

  return (
    <mesh geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        ref={materialRef}
        vertexShader={ARC_VERTEX_SHADER}
        fragmentShader={ARC_FRAGMENT_SHADER}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </mesh>
  )
}
