/**
 * Public entry point for the spatial layout engine (M2).
 *
 * Import from `../layout` (or `./layout`), not from the deep module path — this
 * barrel is the seam that lets the engine grow (settlement rules M2-T2, attribute
 * mapping M2-T3, the edge model M2-T4) without touching every consumer.
 *
 * Two placement primitives live behind it, sharing one force law:
 * {@link layoutTrace} (M2-T1) runs a fixed iteration budget; {@link settleLayout}
 * (M2-T2) relaxes until the shape settles and reports how it converged.
 * {@link mapTraceAttributes} (M2-T3) then maps the trace's facts to the visual
 * magnitudes (node size/emissive, arc width) the render layer draws with, and
 * {@link deriveEdgeModel} (M2-T4) derives the typed spawn/handoff/message edges
 * — and each agent's role and parent — from the trace.
 */
export {
  DEFAULT_IDEAL_DISTANCE,
  DEFAULT_ITERATIONS,
  MIN_DISTANCE,
  deriveLayoutLinks,
  layoutTrace,
  positionById,
} from './forceLayout.ts'

export type {
  ForceLayout,
  LayoutBounds,
  LayoutLink,
  LayoutNode,
  LayoutOptions,
  Vec3,
} from './forceLayout.ts'

export {
  DEFAULT_DECAY,
  DEFAULT_ENERGY_TOLERANCE,
  DEFAULT_MAX_ITERATIONS,
  isSettled,
  settleLayout,
} from './settlement.ts'

export type { Settlement, SettlementOptions } from './settlement.ts'

export {
  DEFAULT_MAX_ARC_WIDTH,
  DEFAULT_MAX_EMISSIVE,
  DEFAULT_MAX_NODE_SIZE,
  DEFAULT_MIN_ARC_WIDTH,
  DEFAULT_MIN_EMISSIVE,
  DEFAULT_MIN_NODE_SIZE,
  NEUTRAL_INTENSITY,
  linkAttribute,
  mapTraceAttributes,
  nodeAttribute,
} from './attributes.ts'

export type {
  AttributeOptions,
  AttributeRange,
  LinkAttribute,
  NodeActivity,
  NodeAttribute,
  TraceAttributes,
} from './attributes.ts'

export {
  DerivedEdgeError,
  EDGE_KINDS,
  HANDOFF_VERBS,
  SPAWN_VERBS,
  classifyAction,
  deriveEdgeModel,
  edgeBetween,
  lineageOf,
  withDerivedLineage,
} from './edges.ts'

export type { DerivedEdge, DerivedLineage, EdgeKind, EdgeModel } from './edges.ts'

export {
  InvariantError,
  assertInvariants,
  checkAttributeInvariants,
  checkEdgeInvariants,
  checkLayoutInvariants,
  checkSceneInvariants,
  findHandAuthoredCoordinates,
} from './invariants.ts'

export type {
  AttributeInvariantOptions,
  InvariantViolation,
  LayoutInvariantOptions,
} from './invariants.ts'
