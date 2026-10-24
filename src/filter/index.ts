/**
 * Public entry point for the filter layer (M4-T5).
 *
 * Import from `../filter`, not from the deep module paths — this barrel is the
 * seam that keeps the lens's internals free to move while the UI and the scene
 * depend only on the shipped API.
 *
 * - **pure** (`filter.ts`) — the three facets, the reducer, the predicates and
 *   the resolved {@link FilterView}: what a filter means and what survives it.
 * - **pure** (`filterTrack.ts`) — {@link filterRevealTrack}: the same meaning
 *   applied to the scene's reveal track, so filtering narrows activity and keeps
 *   the run's shape.
 * - **React** (`useFilter.ts`) — the state holder and the run prune: the one thing
 *   a pure module cannot own. Thin by construction.
 */

export {
  FILTER_KINDS,
  FILTER_KIND_LABELS,
  IDENTITY_FILTER,
  buildFilterView,
  createFilter,
  formatFilterWindow,
  inWindow,
  isFilterActive,
  isIdentity,
  isolateAgentSelection,
  keepsKind,
  matchesMessage,
  matchesToolCall,
  messageTouchesSelection,
  normalizeAgentIds,
  normalizeKinds,
  normalizeWindow,
  reduceFilter,
  resolveAgentIds,
  retainFilter,
  sameFilter,
  toggleAgentSelection,
} from './filter.ts'

export type {
  FilterAction,
  FilterCount,
  FilterKind,
  FilterState,
  FilterView,
  FilterWindow,
} from './filter.ts'

export { HIDDEN_GLYPH_AT, FilterError, filterRevealTrack } from './filterTrack.ts'

export { useFilter } from './useFilter.ts'
export type { FilterController } from './useFilter.ts'
