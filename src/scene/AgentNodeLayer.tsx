import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { TraceModel } from '../model/index.ts'
import { buildNodeScenePlan } from './nodes.ts'
import type { NodeSceneOptions } from './nodes.ts'

/**
 * Agent nodes as instanced glowing meshes (M3-T1) — the render half.
 *
 * A deliberately *thin* consumer of the pure node scene plan
 * ({@link buildNodeScenePlan}, `./nodes.ts`). Per the PRD §5 architectural rule,
 * the render layer owns no logic the data layer could own:
 *
 * - **what to draw** — one instance per agent: its matrix, its glow colour —
 *   is decided in `./nodes.ts` and merely copied here;
 * - **how to draw it** — a single `InstancedMesh` over a unit sphere, so the
 *   whole agent population costs ONE draw call (the PRD geometry budget: "one
 *   instanced mesh for nodes … every repeated element is instanced; the
 *   draw-call ceiling is a gate"). No per-node mesh exists anywhere.
 *
 * The instance matrix in the plan is translation × uniform scale, so the sphere
 * can be a plain unit-radius `sphereGeometry` (`radius = 1`) and each node's
 * `size` attribute becomes its scale. The glow gradient rides on the
 * InstancedMesh's per-instance colour — the only per-instance channel a standard
 * material exposes.
 *
 * ## Not gated, by design
 *
 * jsdom has no GPU, so nothing about the rendered look is asserted in tests
 * (PRD §5). What *is* tested is the pure plan this component consumes; the look
 * itself is human-reviewed (M5-T5). The lighting rig and the bloom-honest
 * emissive calibration are M3-T4 — the material below is a working default, not
 * a calibrated one.
 *
 * A run with no agents renders nothing (the layer returns `null`), matching the
 * plan's `drawCalls: 0` for an empty layer.
 *
 * ## Headless note
 *
 * This is the first source module to import three.js directly, and in the jsdom
 * test env that makes three log `Multiple instances of Three.js being imported`:
 * the externalized `@react-three/fiber` dependency resolves its own copy of
 * three while a source-level import resolves another. It is a test-harness
 * artifact only — the production build carries exactly one three instance — and
 * it is harmless, so it is left alone rather than papered over with a `deps`
 * config hack.
 */
export interface AgentNodeLayerProps {
  /** The normalized run to draw (M1-T5). */
  run: TraceModel
  /** Optional plan overrides (settlement / attributes / style). */
  options?: NodeSceneOptions
}

export default function AgentNodeLayer({ run, options }: AgentNodeLayerProps) {
  // Rebuilding the plan is pure and cheap relative to a frame; memoized so a
  // re-render with the same run/options does not re-settle the layout.
  const plan = useMemo(() => buildNodeScenePlan(run, options), [run, options])
  const meshRef = useRef<THREE.InstancedMesh | null>(null)

  // The one shared material colour: the per-instance colour below modulates it.
  const baseColor = useMemo(
    () => new THREE.Color(...plan.style.baseColor),
    [plan.style.baseColor],
  )

  useEffect(() => {
    const mesh = meshRef.current
    if (mesh === null) return
    // Write the plan's finished transforms/colours straight onto the instances:
    // Matrix4.fromArray reads our column-major tuple with no conversion.
    const matrix = new THREE.Matrix4()
    const color = new THREE.Color()
    for (let index = 0; index < plan.instances.length; index += 1) {
      const instance = plan.instances[index]
      matrix.fromArray(instance.matrix)
      mesh.setMatrixAt(index, matrix)
      color.setRGB(instance.color[0], instance.color[1], instance.color[2])
      mesh.setColorAt(index, color)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [plan])

  if (plan.count === 0) return null

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, plan.count]}
      frustumCulled={false}
    >
      <sphereGeometry args={[1, plan.style.segments, plan.style.segments]} />
      {/* Emissive calibration (bloom rig) is M3-T4; this is a working default. */}
      <meshStandardMaterial
        color={baseColor}
        emissive={baseColor}
        emissiveIntensity={plan.style.emissiveIntensity}
        roughness={0.3}
        metalness={0}
        toneMapped={false}
      />
    </instancedMesh>
  )
}
