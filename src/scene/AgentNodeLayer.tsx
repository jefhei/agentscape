import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import type { AgentId } from '../types/index.ts'
import type { TraceModel } from '../model/index.ts'
import { agentIdForClick, selectionGain } from '../inspect/selection.ts'
import { buildNodeScenePlan } from './nodes.ts'
import type { NodeSceneOptions, NodeScenePlan } from './nodes.ts'
import type { SceneReveal } from './reveal.ts'

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
 * `size` attribute becomes its scale. The glow rides on the InstancedMesh's
 * per-instance colour — the only per-instance channel an unlit material exposes —
 * and, since M3-T4, that colour *is* the node's calibrated HDR radiance: the
 * material is deliberately **unlit** (`meshBasicMaterial`), because a node emits
 * light rather than being lit by it. A standard material's `instanceColor` only
 * tints its diffuse term, so the per-node glow would never reach the screen; the
 * unlit material makes the calibrated radiance the pixel value, which is also what
 * lets the bloom pass (M3-T4) key off it. Tone mapping stays ON, so the hot end of
 * the radiance range rolls off instead of clipping.
 *
 * ## Not gated, by design
 *
 * jsdom has no GPU, so nothing about the rendered look is asserted in tests
 * (PRD §5). What *is* tested is the pure plan this component consumes; the look
 * itself is human-reviewed (M5-T5).
 *
 * A run with no agents renders nothing (the layer returns `null`), matching the
 * plan's `drawCalls: 0` for an empty layer.
 *
 * ## Clicking a node (M4-T4)
 *
 * The mesh also reports clicks: R3F raycasts the instances and hands back an
 * `instanceId`, which is an index into the same canonical instance order the
 * plan was built in — so the instance → agent mapping is `agentIdForClick`
 * (`src/inspect/selection.ts`), not a lookup invented here. That helper also
 * decides that a gesture the pointer travelled across is a camera drag, not a
 * click; this component only forwards the answer. Selection *state* is the app
 * shell's (`useSelection`), never the scene's, and the only thing the layer does
 * with it is scale the selected node's glow by `selectionGain` — the same
 * multiply-by-a-scalar-is-radiance idiom the reveal uses.
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
  /**
   * A plan already built for this run — from {@link buildScenePlan} (M3-T6), so the
   * whole scene shares one settlement. Used as-is; when omitted the layer derives
   * its own plan from `run` (the standalone path).
   */
  plan?: NodeScenePlan
  /** Optional plan overrides (settlement / attributes / style) — ignored when `plan` is given. */
  options?: NodeSceneOptions
  /**
   * What the run has revealed as of the current playhead (M4-T1). Each instance's
   * colour is scaled by its agent's `glow` — dormant until the run touches the
   * agent, then full. Omitted / `null` draws every node lit (the static scene).
   */
  reveal?: SceneReveal | null
  /**
   * Called with the agent a click picked (M4-T4). A click is a tap, not a drag:
   * the pick rule ({@link agentIdForClick}) ignores a gesture the pointer
   * travelled across, so orbiting the cloud never opens a panel on release.
   * Omit to make the nodes inert.
   */
  onSelect?: (agentId: AgentId) => void
  /**
   * The selected agent (M4-T4), drawn at {@link SELECTED_NODE_GAIN} its own
   * calibrated radiance. `null`/omitted draws every node at exactly its plan's
   * brightness.
   */
  selectedAgentId?: AgentId | null
}

export default function AgentNodeLayer({
  run,
  plan,
  options,
  reveal,
  onSelect,
  selectedAgentId = null,
}: AgentNodeLayerProps) {
  // Rebuilding the plan is pure and cheap relative to a frame; memoized so a
  // re-render with the same run/options does not re-settle the layout. A supplied
  // plan wins, which is how the mounted scene pays for one settlement, not four.
  const resolved = useMemo(
    () => plan ?? buildNodeScenePlan(run, options),
    [plan, run, options],
  )
  const meshRef = useRef<THREE.InstancedMesh | null>(null)

  useEffect(() => {
    const mesh = meshRef.current
    if (mesh === null) return
    // Write the plan's finished transforms/colours straight onto the instances:
    // Matrix4.fromArray reads our column-major tuple with no conversion.
    const matrix = new THREE.Matrix4()
    const color = new THREE.Color()
    for (let index = 0; index < resolved.instances.length; index += 1) {
      const instance = resolved.instances[index]
      matrix.fromArray(instance.matrix)
      mesh.setMatrixAt(index, matrix)
      // The reveal (M4-T1) scales the calibrated radiance: a dormant agent is
      // drawn at `DORMANT_NODE_GLOW` of its own colour, an active one at full.
      // Multiplying a linear RGB glow by a scalar IS scaling its radiance
      // linearly, which is why no second calibration curve is needed here.
      // Since M4-T4 the selected node is scaled by the pure `selectionGain` on
      // top of that — the same rule in the same place, one number further.
      const glow =
        (reveal?.nodes[index]?.glow ?? 1) *
        selectionGain(selectedAgentId, instance.agentId)
      color.setRGB(
        instance.color[0] * glow,
        instance.color[1] * glow,
        instance.color[2] * glow,
      )
      mesh.setColorAt(index, color)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [resolved, reveal, selectedAgentId])

  if (resolved.count === 0) return null

  /**
   * A click picks the instance under the pointer (M4-T4). The whole rule — the
   * instance → agent mapping and the "a drag is not a click" guard — is the pure
   * `agentIdForClick`; this handler only reports what it decided. `stopPropagation`
   * keeps one click from selecting a closer node *and* a farther one behind it.
   */
  const onClick = (event: ThreeEvent<MouseEvent>): void => {
    if (onSelect === undefined) return
    const agentId = agentIdForClick(resolved, event)
    if (agentId === null) return
    event.stopPropagation()
    onSelect(agentId)
  }

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, resolved.count]}
      frustumCulled={false}
      onClick={onClick}
    >
      <sphereGeometry args={[1, resolved.style.segments, resolved.style.segments]} />
      {/* Unlit emitter (M3-T4): the per-instance colour carries the calibrated
          HDR radiance, and tone mapping (the rig sets ACESFilmic) rolls the hot
          end off instead of clipping it. White base so the instance colour is
          not modulated twice. */}
      <meshBasicMaterial color="#ffffff" toneMapped />
    </instancedMesh>
  )
}
