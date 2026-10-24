/**
 * The filter controller hook (M4-T5) — the render layer's half of the lens.
 *
 * `filter.ts` owns every rule (what the three facets mean, what a toggle means,
 * what survives, what an empty selection means). This module owns only what a
 * pure module cannot: holding the state across renders, resolving the agent facet
 * against the run's own agent list, and keeping a tuned lens from outliving the
 * run it was tuned for.
 *
 * ## Pruning is a rule, not a cleanup
 *
 * When a run changes, a selection naming agents the new run does not have would
 * silently narrow to nothing; a window past the new run's end would match nothing.
 * `retainFilter` (pure, tested) drops the first and clamps the second, driven from
 * an effect keyed on the run — so swapping runs can never leave a lens describing
 * a ghost of the previous trace.
 *
 * ## The view is derived, never stored
 *
 * The counts the bar prints come from `buildFilterView`, memoized on (run, filter).
 * Storing them would create a second source of truth for "how much is in view";
 * deriving them means the numbers always describe the filter that is actually
 * applied to the scene.
 *
 * Callback identities change only when the state or the run does (the selection
 * helper needs the current state), which is fine here: the bar is a handful of
 * buttons, and `toggleAgent` is the only one that needs the run's agent list.
 */

import { useCallback, useEffect, useMemo, useReducer } from 'react'
import type { AgentId } from '../types/index.ts'
import type { TraceModel } from '../model/index.ts'
import {
  IDENTITY_FILTER,
  buildFilterView,
  isFilterActive,
  isolateAgentSelection,
  reduceFilter,
  retainFilter,
  toggleAgentSelection,
} from './filter.ts'
import type { FilterAction, FilterKind, FilterState, FilterView } from './filter.ts'

/** What a component gets from {@link useFilter}. */
export interface FilterController {
  /** The filter as it stands (dispatchable, immutable). */
  filter: FilterState
  /** The filter resolved against the run: canonical facets + surviving counts. */
  view: FilterView
  /** Whether the filter narrows anything. */
  active: boolean
  /** Keep `agentId` in the agent facet, or drop it from it. */
  toggleAgent: (agentId: AgentId) => void
  /** Keep only `agentId` (the double-click "focus on this agent" gesture). */
  isolateAgent: (agentId: AgentId) => void
  /** Keep `kind`, or drop it (dropping both kinds matches nothing). */
  toggleKind: (kind: FilterKind) => void
  /** Replace the time window (`null` for the whole run). */
  setWindow: (window: FilterState['window']) => void
  /** Back to the identity filter. */
  clear: () => void
  /** Escape hatch for anything the typed helpers above do not cover. */
  dispatch: (action: FilterAction) => void
}

/**
 * Hold a run's filter. `model` is the run the filter is *about*: agents it does
 * not contain are pruned, and a window past its end is clamped, on the next
 * render.
 */
export function useFilter(model: TraceModel): FilterController {
  const [filter, dispatch] = useReducer(reduceFilter, IDENTITY_FILTER)

  const knownIds = useMemo(() => model.agents.map((agent) => agent.id), [model])
  const spanMs = Math.max(0, model.endedAt - model.startedAt)

  // A lens cannot outlive the run it was tuned for (a swap, or a re-loaded
  // export). Derived from the model, so it always matches what is on screen.
  useEffect(() => {
    const retained = retainFilter(filter, knownIds, spanMs)
    if (retained !== filter) dispatch({ type: 'replace', filter: retained })
  }, [knownIds, spanMs, filter])

  const view = useMemo(() => buildFilterView(model, filter), [model, filter])

  const toggleAgent = useCallback(
    (agentId: AgentId) => {
      dispatch({
        type: 'setAgents',
        agentIds: toggleAgentSelection(filter, agentId, knownIds),
      })
    },
    [filter, knownIds],
  )
  const toggleKind = useCallback((kind: FilterKind) => {
    dispatch({ type: 'toggleKind', kind })
  }, [])
  const isolateAgent = useCallback(
    (agentId: AgentId) => {
      dispatch({
        type: 'setAgents',
        agentIds: isolateAgentSelection(agentId, knownIds),
      })
    },
    [knownIds],
  )
  const setWindow = useCallback((window: FilterState['window']) => {
    dispatch({ type: 'setWindow', window })
  }, [])
  const clear = useCallback(() => {
    dispatch({ type: 'clear' })
  }, [])

  return {
    filter,
    view,
    active: isFilterActive(filter),
    toggleAgent,
    isolateAgent,
    toggleKind,
    setWindow,
    clear,
    dispatch,
  }
}
