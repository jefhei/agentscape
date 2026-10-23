/**
 * The selection controller hook (M4-T4) — the render layer's half of the
 * inspector.
 *
 * `selection.ts` owns every rule (what a click means, what a toggle means, what
 * a stale selection means); this module owns only what a pure module cannot:
 * holding the state across renders and keeping it coherent with the run.
 *
 * ## Pruning is a rule, not a cleanup
 *
 * When the run changes, an agent that no longer exists cannot stay selected —
 * otherwise the panel would describe a ghost of a previous trace. The prune is
 * `retainSelection` (pure, tested) driven from an effect keyed on the run: the
 * stale id renders nothing for the one frame before the effect runs (the detail
 * builder returns `null` for an absent agent), so there is no flash of the wrong
 * agent's data.
 *
 * Callback identities are stable (`useReducer`'s dispatch wrapped once), which
 * is what lets the scene's click handler and the panel's close button be passed
 * straight down without re-binding a component's props every render.
 */

import { useCallback, useEffect, useMemo, useReducer } from 'react'
import type { Agent, AgentId } from '../types/index.ts'
import type { TraceModel } from '../model/index.ts'
import { EMPTY_SELECTION, reduceSelection, retainSelection } from './selection.ts'

/** What a component gets from {@link useSelection}. */
export interface SelectionController {
  /** The selected agent's id, or `null`. */
  agentId: AgentId | null
  /** The selected agent's record, or `null` when nothing (or nothing present) is selected. */
  agent: Agent | null
  /** Whether `agentId` is the one selected. */
  isSelected: (agentId: AgentId) => boolean
  /** Open the inspector on `agentId`. */
  select: (agentId: AgentId) => void
  /** Select `agentId`, or deselect it when it is already selected. */
  toggle: (agentId: AgentId) => void
  /** Close the inspector. */
  clear: () => void
}

/**
 * Hold a run's selection. `model` is the run the selection is *about*: agents it
 * does not contain are pruned on the next render.
 */
export function useSelection(model: TraceModel): SelectionController {
  const [state, dispatch] = useReducer(reduceSelection, EMPTY_SELECTION)

  // A selection cannot outlive the agent it names (a run swap, or a re-loaded
  // export). Derived from the model, so it always matches what is on screen.
  const knownIds = useMemo(() => model.agents.map((agent) => agent.id), [model])
  useEffect(() => {
    const retained = retainSelection(state, knownIds)
    if (retained !== state) dispatch({ type: 'clear' })
  }, [knownIds, state])

  const select = useCallback((agentId: AgentId) => {
    dispatch({ type: 'select', agentId })
  }, [])
  const toggle = useCallback((agentId: AgentId) => {
    dispatch({ type: 'toggle', agentId })
  }, [])
  const clear = useCallback(() => {
    dispatch({ type: 'clear' })
  }, [])

  const agentId = state.agentId
  const agent = useMemo(
    () =>
      agentId === null
        ? null
        : (model.agents.find((entry) => entry.id === agentId) ?? null),
    [model, agentId],
  )
  const isSelected = useCallback(
    (candidate: AgentId) => state.agentId !== null && state.agentId === candidate,
    [state.agentId],
  )

  return { agentId, agent, isSelected, select, toggle, clear }
}
