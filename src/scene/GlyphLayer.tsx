import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { TraceModel } from '../model/index.ts'
import { buildGlyphScenePlan, writeGlyphMatrices } from './glyphs.ts'
import type { GlyphSceneOptions, GlyphScenePlan } from './glyphs.ts'

/**
 * Tool-call glyphs orbiting their calling agent node (M3-T3) — the render half.
 *
 * A deliberately *thin* consumer of the pure glyph plan
 * ({@link buildGlyphScenePlan}, `./glyphs.ts`). Per the PRD §5 architectural
 * rule, the render layer owns no logic the data layer could own:
 *
 * - **what to draw** — one glyph per tool call: its orbit centre, radius, angle,
 *   rate, plane, size and colour are all decided in `./glyphs.ts`;
 * - **how to draw it** — a single `InstancedMesh` over a unit octahedron, so the
 *   whole glyph population costs ONE draw call (the PRD geometry budget: *"one
 *   instanced mesh for nodes, one batched geometry for arcs, one for glyphs"*).
 *   A glyph is deliberately not a sphere: the mark must read as a **mark** on a
 *   node rather than as a second, smaller agent;
 * - **the clock** — the only thing the render layer owns that the data layer
 *   cannot. `useFrame` advances the orbit by handing the pure rule
 *   ({@link glyphMatrixAt}, called through {@link writeGlyphMatrices}) a time and
 *   copying the matrices it returns onto the GPU. The *rule* stays pure and
 *   testable; only the tick lives here.
 *
 * ## Where the kind's hue actually shows
 *
 * The plan encodes the call's relationship kind (M2-T4) primarily as **size**,
 * which survives additive bloom, and secondarily as a per-instance hue on the
 * lit surface: a standard material's `emissive` is a uniform, so only the
 * diffuse colour can vary per instance. The glow therefore stays the layer's
 * neutral base colour while the kind's hue rides the lit side. Making the hue
 * carry through the glow too needs a vertex-coloured material — M3-T4's
 * calibration pass is the right place to decide that.
 *
 * ## Not gated, by design
 *
 * jsdom has no GPU, so nothing about the rendered look is asserted in tests
 * (PRD §5). What *is* tested is the pure plan and the orbit rule this component
 * consumes; the look itself is human-reviewed (M5-T5). The lighting rig and the
 * bloom-honest emissive calibration are M3-T4 — the material below is a working
 * default, not a calibrated one.
 *
 * A run with no tool calls renders nothing (the layer returns `null`), matching
 * the plan's `drawCalls: 0` for an empty layer.
 *
 * ## Headless note
 *
 * Like the node and arc layers, this module imports three.js directly and calls
 * `useFrame`, so it must be mounted inside an R3F `<Canvas>`; neither is
 * exercised by the jsdom tests (which cannot create a renderer). It also logs
 * three's `Multiple instances of Three.js being imported` warning under jsdom
 * for the same harness reason documented in `AgentNodeLayer.tsx`.
 */
export interface GlyphLayerProps {
  /** The normalized run to draw (M1-T5). */
  run: TraceModel
  /**
   * A plan already built for this run — from {@link buildScenePlan} (M3-T6), so the
   * whole scene shares one settlement. Used as-is; when omitted the layer derives
   * its own plan from `run` (the standalone path).
   */
  plan?: GlyphScenePlan
  /** Optional plan overrides (settlement / attributes / style / reuse) — ignored when `plan` is given. */
  options?: GlyphSceneOptions
}

export default function GlyphLayer({ run, plan, options }: GlyphLayerProps) {
  // Rebuilding the plan is pure and cheap relative to a frame; memoized so a
  // re-render with the same run/options does not re-settle the layout. A supplied
  // plan wins, which is how the mounted scene pays for one settlement, not four.
  const resolved = useMemo(
    () => plan ?? buildGlyphScenePlan(run, options),
    [plan, run, options],
  )
  const meshRef = useRef<THREE.InstancedMesh | null>(null)

  // The glyph surface is drawn neutral; the per-instance colour below supplies
  // the kind's hue (see the module note on why the glow cannot).
  const surfaceColor = useMemo(() => new THREE.Color(1, 1, 1), [])
  const glowColor = useMemo(
    () => new THREE.Color(...resolved.style.baseColor),
    [resolved.style.baseColor],
  )

  // Static per-instance data: the plan's colours, and the orbits at time zero so
  // the very first frame is already correct (a paused renderer never ticks).
  useEffect(() => {
    const mesh = meshRef.current
    if (mesh === null) return
    const color = new THREE.Color()
    for (let index = 0; index < resolved.glyphs.length; index += 1) {
      const glyph = resolved.glyphs[index]
      color.setRGB(glyph.color[0], glyph.color[1], glyph.color[2])
      mesh.setColorAt(index, color)
    }
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true
    const buffer = mesh.instanceMatrix.array as Float32Array
    writeGlyphMatrices(resolved.glyphs, 0, buffer)
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [resolved])

  // The one tick the render layer owns: advance the orbits. The rule it feeds
  // (./glyphs.ts `glyphMatrixAt`) is pure and unit-tested. Called
  // unconditionally, before the empty-plan early return below.
  useFrame((state) => {
    const mesh = meshRef.current
    if (mesh === null) return
    const buffer = mesh.instanceMatrix.array as Float32Array
    writeGlyphMatrices(resolved.glyphs, state.clock.elapsedTime * 1000, buffer)
    mesh.instanceMatrix.needsUpdate = true
  })

  if (resolved.count === 0) return null

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, resolved.count]}
      frustumCulled={false}
    >
      <octahedronGeometry args={[1, resolved.style.detail]} />
      {/* Emissive calibration (bloom rig) is M3-T4; this is a working default. */}
      <meshStandardMaterial
        color={surfaceColor}
        emissive={glowColor}
        emissiveIntensity={resolved.style.emissiveIntensity}
        roughness={0.35}
        metalness={0}
        toneMapped={false}
      />
    </instancedMesh>
  )
}
