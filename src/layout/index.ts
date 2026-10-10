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
