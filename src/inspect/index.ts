/**
 * Public entry point for the inspector (M4-T4).
 *
 * Import from `../inspect`, not from the deep module paths — this barrel is the
 * seam that keeps the inspector's internals free to move while the UI depends
 * only on the shipped API.
 *
 * - **pure** (`inspect.ts`) — {@link buildAgentDetail}: the agent's identity and
 *   derived lineage, its messages in both directions, its tool calls, its
 *   activity window and its itemised token/cost attribution, with a `fired` flag
 *   per row at a given playhead. Plus the formatters the panel prints.
 * - **pure** (`selection.ts`) — the selection reducer, the instance → agent pick
 *   ({@link agentIdForClick}) and the selected-node glow gain.
 * - **React** (`useSelection.ts`) — the state holder and the run prune: the one
 *   thing a pure module cannot own. Thin by construction.
 */

export {
  ARG_SUMMARY_LIMIT,
  ARG_VALUE_LIMIT,
  DETAIL_ROW_LIMIT,
  InspectError,
  buildAgentDetail,
  describeAgentTiming,
  describeMessageDirection,
  formatCost,
  formatShare,
  formatTokens,
  summarizeArgs,
} from './inspect.ts'

export type {
  AgentAttribution,
  AgentDetail,
  AgentMessageEntry,
  AgentRelations,
  AgentTiming,
  AgentToolCallEntry,
  DetailDirection,
  InspectOptions,
} from './inspect.ts'

export {
  CLICK_SLOP_PX,
  EMPTY_SELECTION,
  SELECTED_NODE_GAIN,
  agentIdForClick,
  agentIdForInstance,
  createSelection,
  isSelected,
  reduceSelection,
  retainSelection,
  selectionGain,
} from './selection.ts'

export type { PickablePlan, SelectionAction, SelectionState } from './selection.ts'

export { useSelection } from './useSelection.ts'
export type { SelectionController } from './useSelection.ts'
