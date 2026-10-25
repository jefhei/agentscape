/**
 * Public entry point for the run HUD (M4-T6).
 *
 * Import from `../hud`, not from the deep module path — this barrel is the seam
 * that keeps the summary's internals free to move while the app shell and the
 * overlay depend only on the shipped API.
 *
 * - **pure** (`hud.ts`) — {@link buildRunSummary}: the run's fixed totals
 *   (agents, messages and broadcasts, tool calls, duration, tokens, cost) as one
 *   formatted, tested model, with absent token/cost figures reported rather than
 *   zeroed and a drift check against the run's own `RunMeta`.
 * - the render half is `ui/RunHud.tsx`, which prints the facts and decides
 *   nothing.
 *
 * There is deliberately no React hook here: the summary is a pure function of the
 * run, so it is derived once (the shell memoizes it) and never re-derived from a
 * clock, a playhead or a filter.
 */

export {
  HUD_FACT_IDS,
  HudError,
  MISSING_FIGURE,
  buildRunSummary,
  hudFact,
} from './hud.ts'

export type { HudFact, HudFactId, RunSummary, RunSummaryCounts } from './hud.ts'
