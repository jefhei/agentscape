/**
 * Boot: which run opens, and which saved view lands on it (M6-T1, share links M6-T2).
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
 * ## Where a share link sits in that order (M6-T2)
 *
 * A share link's `view=` payload is a **view instruction for this visit**, so it
 * outranks the local memory: a recipient must see what the sharer saw, not their
 * own last lens. It does not outrank the link's own `?trace=` — it *belongs* to
 * that run, and {@link restoreView}'s run-id guard rejects it if it does not match,
 * in which case the local save for **that** run is the honest fallback and
 * anything else is no restore at all. A payload that names its run (and a link
 * with no `?trace=`) is enough to pick the run too, so a hand-trimmed link still
 * opens the trace it carries.
 *
 * The **layout seed** the link pins rides along with the run: it is a property of
 * the shape, not of the view state, so it is returned as its own field and the
 * shell hands it to the scene. It is deliberately not part of the autosave — a
 * seed is an address (`?seed=`), and a reload of a seeded link still has the
 * address in the URL.
 *
 * The saved *view* is restored only if it was saved for the run that actually
 * opens ({@link restoreView} guards by run id), so a stale view can never describe
 * a trace that is not on screen.
 *
 * Pure: a search string, a snapshot and a fallback run in; a run, the fragment that
 * names it, the pinned seed and a verdict out. The app calls it once per mount.
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
import { readShareRequest } from './share.ts'
import type { ViewSnapshot } from './snapshot.ts'

/** What the app opens with, and how it was decided. */
export interface BootState {
  /** The run to mount. */
  run: TraceModel
  /**
   * The canonical `?trace=` fragment that names it, or `null` for the default
   * mount. This is what the autosave writes as "the loaded run" and what a share
   * link (M6-T2) carries, so both rebuild the same trace from the same one parser.
   */
  trace: string | null
  /**
   * The layout seed the URL pins, or `null` for the run's own contract seed. A
   * seeded view is a *shape*: the shell passes this to the scene's settlement so a
   * shared link draws the cloud the sharer drew.
   */
  seed: number | null
  /** The view state to restore onto it, or `null` for a fresh view. */
  restored: RestoredView | null
}

/** Optional boot inputs the shell supplies. */
export interface BootOptions {
  /**
   * The reference that names `fallback` — so that even a boot with nothing asked
   * for and nothing saved can be *shared* (M6-T2). A caller that omits it gets the
   * old behaviour: the default mount names nothing.
   */
  fallbackTrace?: string | null
}

/**
 * The boot state for a run that was chosen, with its saved view guarded by id.
 *
 * `shared` is the view the URL carried and `saved` the one the last visit left.
 * Both are offered to {@link restoreView}; the first that belongs to `run` wins,
 * so a corrupt or foreign link payload degrades to local memory rather than to a
 * view aimed at a cloud that is not there.
 */
function opening(
  run: TraceModel,
  trace: string | null,
  shared: ViewSnapshot | null,
  saved: ViewSnapshot | null,
  seed: number | null,
): BootState {
  return {
    run,
    trace,
    seed,
    restored: restoreView(shared, run) ?? restoreView(saved, run),
  }
}

/**
 * Mount the run a query string names, with the canonical fragment that names it
 * (a `?trace=` *value* is not enough: `scale` also needs its `mpa` sibling).
 */
function fromQuery(search: string): { run: TraceModel; trace: string } | null {
  const mounted = mountTrace(search)
  if (mounted === null) return null
  const trace = traceRequestQuery(parseTraceRequest(search))
  if (trace === null) return null
  return { run: mounted.run, trace }
}

/** Mount the run a remembered fragment (`trace=…&mpa=…`) names, or `null`. */
function fromFragment(
  fragment: string | null,
): { run: TraceModel; trace: string } | null {
  if (fragment === null || fragment.trim() === '') return null
  return fromQuery(`?${fragment}`)
}

/**
 * Resolve the run and the view for a boot. See the module doc for the precedence.
 *
 * `search` is `location.search` (`'?trace=fleet'` or `''`); it is parsed by the one
 * trace parser and the one share parser, so a boot and a URL probe can never
 * disagree about what a link means.
 */
export function bootState(
  search: string,
  snapshot: ViewSnapshot | null,
  fallback: TraceModel,
  options: BootOptions = {},
): BootState {
  const share = readShareRequest(search)
  const raw = readTraceParam(search)

  if (raw !== null) {
    const mounted = fromQuery(search)
    if (mounted !== null) {
      return opening(mounted.run, mounted.trace, share.snapshot, snapshot, share.seed)
    }
    // A link that names a run we cannot build: the default, never the saved run.
    // Its seed is not trusted either: it described a layout for a run that did not
    // open, so applying it to the default would be a different shape under the same
    // name.
    return opening(
      fallback,
      options.fallbackTrace ?? null,
      share.snapshot,
      snapshot,
      null,
    )
  }

  // With no `?trace=`: the link's own payload first, then the last visit's run.
  const named =
    fromFragment(share.snapshot?.run.trace ?? null) ??
    fromFragment(snapshot?.run.trace ?? null)
  if (named !== null) {
    return opening(named.run, named.trace, share.snapshot, snapshot, share.seed)
  }

  return opening(
    fallback,
    options.fallbackTrace ?? null,
    share.snapshot,
    snapshot,
    share.seed,
  )
}
