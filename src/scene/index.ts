/**
 * Public entry point for the scene layer (M3).
 *
 * Import from `../scene` (or `./scene`), not from the deep module path — this
 * barrel is the seam that lets the scene grow (arcs M3-T2, glyphs M3-T3, the
 * lighting rig M3-T4) without touching every consumer.
 *
 * Each layer follows the same PRD §5 split — a pure plan plus a thin mesh:
 *
 * - **nodes (M3-T1)** — {@link buildNodeScenePlan} settles the layout, maps the
 *   visual attributes and joins them into one instance per agent (with a
 *   finished instance matrix); {@link AgentNodeLayer} copies that onto one
 *   `InstancedMesh`.
 * - **arcs (M3-T2)** — {@link buildArcScenePlan} sweeps one tube per
 *   communication link into a single batched geometry, with the animation rule
 *   ({@link arcPulseParameter}) derived from the trace's traffic;
 *   {@link MessageArcLayer} uploads those buffers and runs the GLSL pulse.
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

export {
  ARC_ATTRIBUTE_NAMES,
  ARC_ATTRIBUTE_SIZES,
  ARC_CUSTOM_ATTRIBUTES,
  ARC_LAYER_DRAW_CALLS,
  DEFAULT_ARC_BASE_COLOR,
  DEFAULT_ARC_BULGE,
  DEFAULT_ARC_PULSE_COLOR,
  DEFAULT_ARC_SEGMENTS,
  DEFAULT_ARC_SIDES,
  DEFAULT_MAX_PULSE_HZ,
  DEFAULT_MIN_PULSE_HZ,
  DEFAULT_PULSE_WIDTH,
  PARKED_PULSE_PHASE,
  arcAnimationFor,
  arcControlPoint,
  arcInstanceFor,
  arcPulseParameter,
  buildArcScenePlan,
  perpendicularOf,
  quadraticPoint,
  quadraticTangent,
} from './arcs.ts'

export type {
  ArcAnimation,
  ArcAttributeName,
  ArcBuffers,
  ArcFlow,
  ArcInstance,
  ArcSceneOptions,
  ArcScenePlan,
  ArcSceneStyle,
} from './arcs.ts'

export {
  ARC_FRAGMENT_SHADER,
  ARC_UNIFORMS,
  ARC_VERTEX_SHADER,
  DEFAULT_ARC_BASE_GLOW,
  DEFAULT_ARC_MIN_BRIGHTNESS,
  DEFAULT_ARC_PULSE_GAIN,
  DEFAULT_ARC_RIM_DIM,
  buildArcUniforms,
} from './arcShader.ts'

export type {
  ArcMaterialOptions,
  ArcUniform,
  ArcUniformName,
  ArcUniforms,
} from './arcShader.ts'

export { default as MessageArcLayer } from './MessageArcLayer.tsx'
export type { MessageArcLayerProps } from './MessageArcLayer.tsx'
