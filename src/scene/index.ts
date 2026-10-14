/**
 * Public entry point for the scene layer (M3).
 *
 * Import from `../scene` (or `./scene`), not from the deep module path — this
 * barrel is the seam that lets the scene grow (arcs M3-T2, glyphs M3-T3, the
 * lighting rig M3-T4) without touching every consumer.
 *
 * {@link buildNodeScenePlan} (M3-T1) is the pure half: it settles the layout,
 * maps the visual attributes and joins them into one instance per agent (with a
 * finished instance matrix), plus the layer's draw-call cost. {@link AgentNodeLayer}
 * is the thin render half — a single `InstancedMesh` that copies that plan onto
 * the GPU.
 */
export {
  DEFAULT_BASE_COLOR,
  DEFAULT_EMISSIVE_INTENSITY,
  DEFAULT_SEGMENTS,
  NODE_LAYER_DRAW_CALLS,
  ScenePlanError,
  buildNodeScenePlan,
  composeNodeMatrix,
  nodeInstance,
} from './nodes.ts'

export type {
  Matrix16,
  NodeInstance,
  NodeSceneOptions,
  NodeScenePlan,
  NodeSceneStyle,
  Rgb,
} from './nodes.ts'

export { default as AgentNodeLayer } from './AgentNodeLayer.tsx'
export type { AgentNodeLayerProps } from './AgentNodeLayer.tsx'
