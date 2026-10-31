/**
 * Boot: which run opens, and which saved view lands on it (M6-T1).
 *
 * The app used to answer one question at boot — "what does the URL ask for?" — and
 * a reload therefore always returned to the default fixture unless the URL said
 * otherwise. With the autosave there are now **two** sources asking, and their
 * order is a product decision, not an implementation detail:
 *
 * 1. **An explicit `?trace=` wins.** A link is an instruction about *this* visit; a
 *    saved view is a memory of the last one. A shared link must open what it names.
 * 2. **A mistyped `?trace=` does not fall back to the saved run.** If the URL named
 *    a run and none of the schemes understood it, the visitor followed a broken
 *    link — mounting a *different* run than the link asked for would be a lie. The
 *    default fixture opens instead (`traceQuery`'s own "never blank the scene"
 *    rule).
 * 3. **With no `?trace=` at all**, the saved run opens — that is the whole point of
 *    the autosave: close the tab on the fleet run, reopen it, still on the fleet.
 * 4. **Nothing saved, nothing asked** → the default fixture.
 *
 * The saved *view* (playhead, lens, selection, camera) is then restored only if it
 * was saved for the run that actually opens ({@link restoreView} guards by run id),
 * so a stale view can never describe a trace that is not on screen.
 *
 * Pure: a search string, a snapshot and a fallback run in; a run, the fragment that
 * names it and a verdict out. The app calls it once per mount.
 */

import type { TraceModel } from '../model/index.ts'
import {
  mountTrace,
  parseTraceRequest,
  readTraceParam,
  traceRequestQuery,
} from '../trace/index.ts'
import { restoreView } from './restore.ts'
import type { RestoredView } from './restore.ts'
import type { ViewSnapshot } from './snapshot.ts'

/** What the app opens with, and how it was decided. */
export interface BootState {
  /** The run to mount. */
  run: TraceModel
  /**
   * The canonical `?trace=` fragment that names it, or `null` for the default
   * mount. This is what the autosave writes as "the loaded run", so the next boot
   * can rebuild the same trace from the same one parser.
   */
  trace: string | null
  /** The view state to restore onto it, or `null` for a fresh view. */
  restored: RestoredView | null
}

/** The boot state for a run that was chosen, with its saved view guarded by id. */
function opening(
  run: TraceModel,
  trace: string | null,
  snapshot: ViewSnapshot | null,
): BootState {
  return { run, trace, restored: restoreView(snapshot, run) }
}

/**
 * Resolve the run and the view for a boot. See the module doc for the precedence.
 *
 * `search` is `location.search` (`'?trace=fleet'` or `''`); it is parsed by the one
 * trace parser, so a boot and a URL probe can never disagree about what a link
 * means.
 */
export function bootState(
  search: string,
  snapshot: ViewSnapshot | null,
  fallback: TraceModel,
): BootState {
  const raw = readTraceParam(search)
  if (raw !== null) {
    const mounted = mountTrace(search)
    if (mounted !== null) {
      return opening(
        mounted.run,
        traceRequestQuery(parseTraceRequest(search)),
        snapshot,
      )
    }
    // A link that names a run we cannot build: the default, never the saved run.
    return opening(fallback, null, snapshot)
  }

  const savedTrace = snapshot === null ? null : snapshot.run.trace
  if (savedTrace !== null) {
    const savedSearch = `?${savedTrace}`
    const mounted = mountTrace(savedSearch)
    if (mounted !== null) {
      return opening(
        mounted.run,
        traceRequestQuery(parseTraceRequest(savedSearch)),
        snapshot,
      )
    }
  }

  return opening(fallback, null, snapshot)
}
