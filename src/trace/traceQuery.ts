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

import { FLEET_RUN, FLEET_RUN_LABEL } from '../fixtures/real/index.ts'
import type { TraceModel } from '../model/index.ts'
import { buildScaleRun } from '../scale/scaleRun.ts'
import type { ScaleRun } from '../scale/scaleRun.ts'

/** The query parameter that selects a run. */
export const TRACE_PARAM = 'trace'

/** The prefix that marks a synthetic scale run in the `trace` parameter. */
export const SCALE_TRACE_SCHEME = 'scale:'

/** The value that selects the real fleet run. */
export const FLEET_TRACE_VALUE = 'fleet'

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

/** What the URL asked for. */
export type TraceRequest = ScaleTraceRequest | FleetTraceRequest

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

/** The raw value of `name` in an `a=1&b=2` query string, or `null`. */
function rawParam(search: string, name: string): string | null {
  // Accept a leading `?` (or a full URL's tail) exactly as `location.search` has it.
  let query = search
  const question = query.indexOf('?')
  if (question >= 0) query = query.slice(question + 1)
  const hash = query.indexOf('#')
  if (hash >= 0) query = query.slice(0, hash)
  if (query === '') return null

  for (const pair of query.split('&')) {
    const equals = pair.indexOf('=')
    if (equals < 0) continue
    const key = pair.slice(0, equals)
    if (key !== name) continue
    return decodeSafe(pair.slice(equals + 1))
  }
  return null
}

/** `decodeURIComponent`, but a malformed escape reads as the raw text (never throws). */
function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

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

  const messages = rawParam(search, SCALE_MESSAGES_PARAM)
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
  const trace = rawParam(search, TRACE_PARAM)
  if (trace === null) return null

  if (trace === FLEET_TRACE_VALUE) {
    return { kind: 'fleet', label: FLEET_RUN_LABEL }
  }
  return parseScaleValue(trace, search)
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
  const scale = buildScaleRun(request)
  return { kind: 'scale', run: scale.run, label: request.label, scale }
}
