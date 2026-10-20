import type { ScenePlan } from './scenePlan.ts'
import type { SceneReveal } from './reveal.ts'
import AgentNodeLayer from './AgentNodeLayer.tsx'
import MessageArcLayer from './MessageArcLayer.tsx'
import GlyphLayer from './GlyphLayer.tsx'
import EnvironmentRig from './EnvironmentRig.tsx'

/**
 * The mounted scene (M3-T6) — the render half of the whole-scene plan.
 *
 * This is the thinnest component in the app, and deliberately so: it takes **one**
 * {@link ScenePlan} (built once, by {@link buildScenePlan}) and hands each layer
 * *its own finished sub-plan*. Nothing is derived here, so mounting a scene cannot
 * settle a layout, map an attribute, or build a buffer — the pure layer already did
 * all of it, once.
 *
 * Before M3-T6 each layer took only `run` and derived its own layout; four layers
 * meant four settlements and four attribute maps, agreeing only because the
 * derivation is deterministic. Passing the plans down makes the agreement
 * structural (they are the same objects) and makes the scene's measured draw calls
 * describe exactly what is drawn.
 *
 * Draw order is nodes → arcs → glyphs under the rig, which is the order the
 * geometry budget lists the layers in. The rig is mounted first so its background,
 * fog, lights and bloom pass exist before any geometry draws.
 *
 * Since M4-T1 the scene also takes one **reveal** — what the run has revealed at
 * the playhead (`./reveal.ts`) — and hands it, unchanged, to the three element
 * layers. It is one object shared by all of them, exactly like the plans: the
 * nodes, arcs and glyphs are revealing the *same instant* of the *same run*, so
 * there is no per-layer notion of "now" that could drift.
 *
 * PropTypes are plans, not runs, on purpose: a caller that has a `TraceModel` and
 * no plan should call {@link buildScenePlan} (memoized on the run) rather than let
 * each layer derive its own view of the run.
 *
 * @example
 * ```tsx
 * const plan = useMemo(() => buildScenePlan(run), [run])
 * return <Scene plan={plan} />
 * ```
 */
export interface SceneProps {
  /** The whole scene, composed from one run by {@link buildScenePlan}. */
  plan: ScenePlan
  /**
   * What the run shows at the current playhead (M4-T1). Omit for the fully lit,
   * static scene a run gets before the transport exists.
   */
  reveal?: SceneReveal | null
}

export default function Scene({ plan, reveal }: SceneProps) {
  return (
    <>
      <EnvironmentRig plan={plan.environment} />
      <AgentNodeLayer run={plan.run} plan={plan.nodes} reveal={reveal} />
      <MessageArcLayer run={plan.run} plan={plan.arcs} reveal={reveal} />
      <GlyphLayer run={plan.run} plan={plan.glyphs} reveal={reveal} />
    </>
  )
}
