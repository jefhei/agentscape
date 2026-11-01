/**
 * Which trace the URL asks for.
 *
 * The app boots one run and the query parameter is how a browser (or a headless
 * probe) asks for a different one. Two schemes exist, and there is exactly one
 * parser for both:
 *
 * - `?trace=scale:<n>` — a synthetic run of `n` agents, for the frame-budget
 *   measurement (M5-T2). `&mpa=<1..8>` raises the messages each agent sends.
 * - `?trace=fleet` — the real `debian2_bot` fleet run, built from the committed
 *   `agent_messages` export snapshot (M5-T3).
 * - `?trace=fixture:<shape>` — one of the four deterministic fixtures (M1-T6).
 *   Added in M6-T2 so that *every* run the app can mount has a name a link can
 *   carry: without it, the default fixture — the run most visitors see — could
 *   not be shared at all.
 *
 * The rules the module keeps:
 *
 * - **one place, one prefix table.** Nothing else in the app parses `?trace=`. A
 *   second loader is how the ingest path and the mounted run drift apart.
 * - **bounded.** `scale` is clamped to {@link MAX_SCALE_AGENTS}: a URL is user
 *   input, and an unbounded one would let a shared link freeze a tab in the
 *   layout relaxation.
 * - **pure, and no browser API.** The query string is parsed by hand rather than
 *   with `URLSearchParams`, so the module has no DOM dependency at all and
 *   `parseTraceRequest('?trace=fleet')` is a plain function call in a test.
 * - **null, never throw.** Anything the module does not fully understand is
 *   `null`, so the app keeps its default mount and a mistyped URL can never
 *   blank the scene.
 *
 * The pure half only *describes* what was asked for; {@link mountTrace} builds
 * it — the scale run through {@link buildScaleRun}, the fleet run through the
 * real ingest path — so what the app mounts is exactly what the probes measure
 * and what the tests assert.
 */

import { FIXTURE_SHAPES, buildFixture } from '../fixtures/index.ts'
import type { FixtureShape } from '../fixtures/index.ts'
import { FLEET_RUN, FLEET_RUN_LABEL } from '../fixtures/real/index.ts'
import type { TraceModel } from '../model/index.ts'
import { buildScaleRun } from '../scale/scaleRun.ts'
import type { ScaleRun } from '../scale/scaleRun.ts'
import { readQueryParam } from './query.ts'

/** The query parameter that selects a run. */
export const TRACE_PARAM = 'trace'

/** The prefix that marks a synthetic scale run in the `trace` parameter. */
export const SCALE_TRACE_SCHEME = 'scale:'

/** The value that selects the real fleet run. */
export const FLEET_TRACE_VALUE = 'fleet'

/** The prefix that marks a deterministic fixture in the `trace` parameter. */
export const FIXTURE_TRACE_SCHEME = 'fixture:'

/** The query parameter that raises messages-per-agent (default {@link DEFAULT_MESSAGES_PER_AGENT}). */
export const SCALE_MESSAGES_PARAM = 'mpa'

/** Default messages each agent sends to its hub. */
export const DEFAULT_MESSAGES_PER_AGENT = 1

/**
 * Upper bound on a URL-requested agent count. 4000 is double the PRD's stated
 * 2k ceiling — room to measure past the claim, still bounded enough that a
 * hostile link cannot hang a tab.
 */
export const MAX_SCALE_AGENTS = 4000

/** Messages per agent allowed from a URL (a dense run is a stress case, not a knob). */
export const MAX_MESSAGES_PER_AGENT = 8

/** A parsed `?trace=scale:<n>` request. */
export interface ScaleTraceRequest {
  kind: 'scale'
  /** Agents to build. */
  agents: number
  /** Messages each agent sends to its hub. */
  messagesPerAgent: number
  /** Run label, naming what was asked for. */
  label: string
}

/** A parsed `?trace=fleet` request. */
export interface FleetTraceRequest {
  kind: 'fleet'
  /** The run's own label (the export snapshot it is built from). */
  label: string
}

/** A parsed `?trace=fixture:<shape>` request. */
export interface FixtureTraceRequest {
  kind: 'fixture'
  /** Which deterministic fixture to build. */
  shape: FixtureShape
}

/** What the URL asked for. */
export type TraceRequest = ScaleTraceRequest | FleetTraceRequest | FixtureTraceRequest

/** A built run, plus what asked for it. */
export interface MountedTrace {
  /** Which scheme produced it. */
  kind: TraceRequest['kind']
  /** The normalized run to mount. */
  run: TraceModel
  /** The run's label. */
  label: string
  /** The scale detail plan's source run, for `kind: 'scale'` (probes only). */
  scale?: ScaleRun
}

/**
 * The one query-string reader is `./query.ts` (M6-T2): the trace selector and the
 * share link read parameters through the same code, and this module only interprets
 * what it finds. Re-exported so the barrel's surface is unchanged.
 */
export { readQueryParam } from './query.ts'

/** A whole number in `[1, max]`, or `null`. */
function boundedInt(raw: string, max: number): number | null {
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) return null
  return Math.min(value, max)
}

/** Parse a `scale:<n>` value, or `null` when it is not one. */
function parseScaleValue(trace: string, search: string): ScaleTraceRequest | null {
  if (!trace.startsWith(SCALE_TRACE_SCHEME)) return null

  const agents = boundedInt(trace.slice(SCALE_TRACE_SCHEME.length), MAX_SCALE_AGENTS)
  if (agents === null) return null

  const messages = readQueryParam(search, SCALE_MESSAGES_PARAM)
  const messagesPerAgent =
    messages === null
      ? DEFAULT_MESSAGES_PER_AGENT
      : (boundedInt(messages, MAX_MESSAGES_PER_AGENT) ?? DEFAULT_MESSAGES_PER_AGENT)

  return {
    kind: 'scale',
    agents,
    messagesPerAgent,
    label: `scale:${agents} agents`,
  }
}

/** Whether `raw` names one of the deterministic fixtures. */
function isFixtureShape(raw: string): raw is FixtureShape {
  return (FIXTURE_SHAPES as readonly string[]).includes(raw)
}

/**
 * Parse a `fixture:<shape>` value, or `null` when it is not one.
 *
 * The shape must be one the registry knows: a `fixture:` value naming a fixture
 * that does not exist is a mistyped link, not a request for something to invent,
 * so it reads as `null` (the default mount) exactly like any other unknown scheme.
 */
function parseFixtureValue(trace: string): FixtureTraceRequest | null {
  if (!trace.startsWith(FIXTURE_TRACE_SCHEME)) return null
  const shape = trace.slice(FIXTURE_TRACE_SCHEME.length)
  if (!isFixtureShape(shape)) return null
  return { kind: 'fixture', shape }
}

/**
 * Parse what run the query string asks for.
 *
 * Returns `null` when it asks for none (no `trace` parameter, an unknown scheme,
 * a scale count that is not a positive whole number) — never throws, because a
 * URL is untrusted input and the default mount is always a valid answer.
 *
 * Pure: a function of the string only.
 */
export function parseTraceRequest(search: string): TraceRequest | null {
  if (typeof search !== 'string') return null
  const trace = readQueryParam(search, TRACE_PARAM)
  if (trace === null) return null

  if (trace === FLEET_TRACE_VALUE) {
    return { kind: 'fleet', label: FLEET_RUN_LABEL }
  }
  return parseFixtureValue(trace) ?? parseScaleValue(trace, search)
}

/**
 * Parse a `scale:` request only (M5-T2's profiling seam).
 *
 * Kept beside {@link parseTraceRequest} so the scale probes and their tests keep
 * one obvious entry point; it is the same parse, filtered.
 */
export function parseScaleTrace(search: string): ScaleTraceRequest | null {
  const request = parseTraceRequest(search)
  return request !== null && request.kind === 'scale' ? request : null
}

/**
 * The raw `?trace=` value a query string carries, or `null` when it carries none.
 *
 * A caller that has to tell **"nothing asked for a run"** from **"something asked
 * for a run these parsers did not understand"** needs the raw value: the first
 * means "mount the saved/default run", the second means "this link is mistyped,
 * mount the default" — never "silently mount something else".
 */
export function readTraceParam(search: string): string | null {
  return typeof search === 'string' ? readQueryParam(search, TRACE_PARAM) : null
}

/**
 * The canonical query fragment that asks for `request` — the inverse of
 * {@link parseTraceRequest}, used by the autosave (M6-T1) to remember *which* run
 * was mounted as a re-parseable string rather than as a second ad-hoc format.
 *
 * `null` in, `null` out (the default mount names no run). Round-trips: parsing the
 * fragment yields an equal request.
 */
export function traceRequestQuery(request: TraceRequest | null): string | null {
  if (request === null) return null
  if (request.kind === 'fleet') return `${TRACE_PARAM}=${FLEET_TRACE_VALUE}`
  if (request.kind === 'fixture') {
    return `${TRACE_PARAM}=${FIXTURE_TRACE_SCHEME}${request.shape}`
  }
  const base = `${TRACE_PARAM}=${SCALE_TRACE_SCHEME}${request.agents}`
  return request.messagesPerAgent === DEFAULT_MESSAGES_PER_AGENT
    ? base
    : `${base}&${SCALE_MESSAGES_PARAM}=${request.messagesPerAgent}`
}

/** Build the synthetic run a query string asks for, or `null` when it asks for none. */
export function scaleTraceRun(search: string): ScaleRun | null {
  const request = parseScaleTrace(search)
  if (request === null) return null
  return buildScaleRun(request)
}

/**
 * Build whatever run the query string asks for, or `null` when it asks for none.
 *
 * This is the single seam the app mounts through, so a URL-mounted scene and a
 * measured scene are the same scene.
 */
export function mountTrace(search: string): MountedTrace | null {
  const request = parseTraceRequest(search)
  if (request === null) return null
  if (request.kind === 'fleet') {
    return { kind: 'fleet', run: FLEET_RUN, label: FLEET_RUN_LABEL }
  }
  if (request.kind === 'fixture') {
    // The fixture registry builds through the real ingest path (M1-T6), so a
    // fixture link mounts the same run the default mount does — just named.
    const run = buildFixture(request.shape).run
    return { kind: 'fixture', run, label: run.label }
  }
  const scale = buildScaleRun(request)
  return { kind: 'scale', run: scale.run, label: request.label, scale }
}
