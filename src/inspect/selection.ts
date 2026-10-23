/**
 * Node selection (M4-T4) — the pure half of "click a node, inspect the agent".
 *
 * Selecting a node is two rules and one mapping, and each of them is the kind of
 * thing that silently goes wrong when a component owns it:
 *
 * 1. **What a click means** — an `InstancedMesh` reports an `instanceId`, not an
 *    agent. The mapping from instance index to `AgentId` is the node plan's own
 *    canonical order (`buildNodeScenePlan`, M3-T1), so it lives here, next to the
 *    rest of the inspection rules, rather than in the render layer. A drag that
 *    ends over a node is **not** a click: R3F reports how far the pointer moved
 *    (`event.delta`, px), so anything past {@link CLICK_SLOP_PX} is a camera
 *    gesture and selects nothing — otherwise orbiting the run would open a panel
 *    every time you let go over the cloud.
 * 2. **What toggling means** — clicking the selected node deselects it, clicking
 *    another node switches. That is one reducer, so "the panel is open on exactly
 *    the agent you clicked" is a tested property, not a hope.
 * 3. **What a stale selection means** — a selection that names an agent the
 *    current run does not have is cleared (`retainSelection`), so swapping runs
 *    can never leave a panel describing a different run's agent.
 *
 * There is deliberately **no** "click the background to close" rule: the
 * background is also the drag surface, and a last-frame orbit gesture would then
 * close the panel the viewer just opened. The panel's own close button is the
 * dismiss affordance; the reducer just needs to be able to clear.
 *
 * Pure by construction — no React, no DOM, no three.js, no clock — so it is
 * fully unit-testable in jsdom (the React plumbing is `useSelection.ts`).
 */

import type { AgentId } from '../types/index.ts'

// ── Selection state ─────────────────────────────────────────────────────────

/** Which agent the inspector is open on. `null` means nothing is selected. */
export interface SelectionState {
  agentId: AgentId | null
}

/** The empty selection: no panel, the scene exactly as it was. */
export const EMPTY_SELECTION: SelectionState = Object.freeze({ agentId: null })

/** Every way the selection can be driven. */
export type SelectionAction =
  | { type: 'select'; agentId: AgentId }
  | { type: 'toggle'; agentId: AgentId }
  | { type: 'clear' }

/** A non-empty agent id, or `null` for anything that cannot name an agent. */
function validAgentId(agentId: AgentId | null | undefined): AgentId | null {
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : null
}

/**
 * A selection holding `agentId` (a new object each call; the state is treated as
 * immutable), or the empty selection for a missing/blank id.
 */
export function createSelection(agentId: AgentId | null = null): SelectionState {
  const id = validAgentId(agentId)
  return id === null ? EMPTY_SELECTION : { agentId: id }
}

/**
 * Apply one selection action. Pure: an action that changes nothing returns the
 * **same state object**, so a click that only re-affirms the selection does not
 * re-render the scene.
 *
 * A blank id is treated as a clear rather than as a selection of a non-existent
 * agent — a UI-fed value (a data attribute, a URL fragment later) can arrive
 * empty, and "select nothing" is the only sane reading.
 */
export function reduceSelection(
  state: SelectionState,
  action: SelectionAction,
): SelectionState {
  switch (action.type) {
    case 'select': {
      const id = validAgentId(action.agentId)
      if (id === null) return state.agentId === null ? state : EMPTY_SELECTION
      return state.agentId === id ? state : { agentId: id }
    }
    case 'toggle': {
      const id = validAgentId(action.agentId)
      if (id === null) return state.agentId === null ? state : EMPTY_SELECTION
      return state.agentId === id ? EMPTY_SELECTION : { agentId: id }
    }
    case 'clear':
      return state.agentId === null ? state : EMPTY_SELECTION
  }
}

/** Whether `agentId` is the selected agent. */
export function isSelected(state: SelectionState, agentId: AgentId): boolean {
  return state.agentId !== null && state.agentId === agentId
}

/**
 * The selection, kept only when `knownAgentIds` still contains it. Used when a
 * new run loads: an agent that no longer exists cannot stay selected, and the
 * panel must not describe a ghost.
 */
export function retainSelection(
  state: SelectionState,
  knownAgentIds: readonly AgentId[],
): SelectionState {
  if (state.agentId === null) return state
  return knownAgentIds.includes(state.agentId) ? state : EMPTY_SELECTION
}

// ── Click → agent ───────────────────────────────────────────────────────────

/**
 * How far (px) the pointer may travel between press and release and still count
 * as a click on a node. R3F's own click detection fires however far the pointer
 * travelled; the camera rigs bind drags to the same canvas, so without this a
 * 200 px orbit would select whatever node happened to be under the cursor at
 * release. Four pixels is roughly the width of a hand tremor.
 */
export const CLICK_SLOP_PX = 4

/** The part of a node plan a pick needs: one entry per instance, in draw order. */
export interface PickablePlan {
  /** Node instances in canonical (id-sorted) draw order — `NodeScenePlan.instances`. */
  instances: readonly { agentId: AgentId }[]
}

/**
 * The agent drawn as instance `instanceId`, or `null` when there is no such
 * instance (R3F reports `undefined` on a miss; a stale plan index, a negative or
 * fractional index, or an id past the end all mean "nothing was hit").
 */
export function agentIdForInstance(
  plan: PickablePlan,
  instanceId: number | null | undefined,
): AgentId | null {
  if (typeof instanceId !== 'number' || !Number.isInteger(instanceId)) return null
  if (instanceId < 0 || instanceId >= plan.instances.length) return null
  const instance = plan.instances[instanceId]
  return instance === undefined ? null : instance.agentId
}

/**
 * The agent a click event picked, or `null` when the gesture was a drag (past
 * {@link CLICK_SLOP_PX}) or hit nothing.
 *
 * Takes a structural shape rather than R3F's `ThreeEvent` so it can be tested
 * with a plain object: the layer passes the event straight through.
 */
export function agentIdForClick(
  plan: PickablePlan,
  event: { instanceId?: number | null; delta?: number | null },
): AgentId | null {
  const travelled = typeof event.delta === 'number' ? event.delta : 0
  if (!Number.isFinite(travelled) || travelled > CLICK_SLOP_PX) return null
  return agentIdForInstance(plan, event.instanceId)
}

// ── Selection highlight ─────────────────────────────────────────────────────

/**
 * How much brighter the selected node's glow is drawn. A gain on the node plan's
 * *calibrated* radiance (like the reveal's, M4-T1), not a second calibration:
 * the selected node is the same colour at 1.6× the radiance, so it reads as
 * "that one" without becoming a white blob, and it still dims with the reveal
 * when its first event has not fired.
 */
export const SELECTED_NODE_GAIN = 1.6

/**
 * The radiance gain for one node: {@link SELECTED_NODE_GAIN} for the selected
 * agent, `1` for everyone else. Pure, so the render layer multiplies by a number
 * it was handed rather than deciding a highlight rule inline.
 */
export function selectionGain(
  selectedAgentId: AgentId | null | undefined,
  agentId: AgentId,
): number {
  return selectedAgentId !== null && selectedAgentId === agentId
    ? SELECTED_NODE_GAIN
    : 1
}
