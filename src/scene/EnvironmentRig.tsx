import { Bloom, EffectComposer } from '@react-three/postprocessing'
import type { EnvironmentPlan } from './environment.ts'

/**
 * The environment, lighting and bloom rig (M3-T4) — the render half.
 *
 * A deliberately *thin* consumer of the pure rig plan ({@link buildEnvironmentPlan},
 * `./environment.ts`), exactly like the node/arc/glyph layers: every number below
 * — the background, the fog band, the four light colours/intensities/offsets, the
 * bloom threshold, the exposure — is decided in the pure layer and merely applied
 * here. The one thing this component owns is *how* to hand those numbers to
 * three.js, which is not a decision the data layer can make.
 *
 * ## Why the bloom threshold comes from the plan
 *
 * Bloom is what makes a bright node read as "hot"; it is also what makes a scene
 * look blown out when the threshold is picked by eye against one trace. The
 * threshold here is the emissive calibration's own knee radiance (M3-T4), solved
 * from *display* anchors, so it follows what the viewer sees and moves with the
 * exposure instead of being a magic constant. The node layer's per-instance colour
 * is the radiance that threshold is compared against — one solve, two consumers.
 *
 * ## Not gated, by design
 *
 * jsdom has no GPU and no WebGL context, so nothing about this component's output
 * is asserted in tests: the bloom pass, the fog and the light rig are exactly the
 * kind of thing the PRD (§5) hands to a human (M5-T5). The pure plan it consumes
 * is gated hard in `environment.test.ts`. The renderer's tone mapping / exposure
 * are applied by the `<Canvas>` `gl` props in `Viewport.tsx`, because they belong
 * to the renderer rather than the scene graph — this component carries them in its
 * plan so the two cannot disagree.
 *
 * `EffectComposer` is mounted only when the plan enables bloom (a run is loaded),
 * so the empty boot scene costs no post-processing pass.
 */
export interface EnvironmentRigProps {
  /** The solved rig plan (M3-T4). */
  plan: EnvironmentPlan
}

export default function EnvironmentRig({ plan }: EnvironmentRigProps) {
  const { lights } = plan

  return (
    <>
      <color attach="background" args={[plan.backgroundHex]} />
      {plan.fog.enabled && (
        <fog attach="fog" args={[plan.fog.hex, plan.fog.near, plan.fog.far]} />
      )}

      {/* Soft base: keeps the marks (glyphs) readable without flattening them. */}
      <ambientLight color={lights.ambient.hex} intensity={lights.ambient.intensity} />
      {/* Sky/ground gradient: the cheapest way to give a cloud of spheres volume. */}
      <hemisphereLight
        color={lights.hemisphere.skyHex}
        groundColor={lights.hemisphere.groundHex}
        intensity={lights.hemisphere.intensity}
      />
      {/* Key: high, front-right — the light that shapes a sphere. */}
      <directionalLight
        color={lights.key.hex}
        intensity={lights.key.intensity}
        position={[lights.key.offset.x, lights.key.offset.y, lights.key.offset.z]}
      />
      {/* Rim: low, behind-left — separates the cloud from the background. */}
      <directionalLight
        color={lights.rim.hex}
        intensity={lights.rim.intensity}
        position={[lights.rim.offset.x, lights.rim.offset.y, lights.rim.offset.z]}
      />

      {plan.bloom.enabled && (
        <EffectComposer multisampling={0}>
          <Bloom
            intensity={plan.bloom.intensity}
            luminanceThreshold={plan.bloom.luminanceThreshold}
            luminanceSmoothing={plan.bloom.luminanceSmoothing}
            radius={plan.bloom.radius}
            mipmapBlur={plan.bloom.mipmapBlur}
          />
        </EffectComposer>
      )}
    </>
  )
}
