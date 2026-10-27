/**
 * A scale run chosen from the URL (M5-T2's profiling affordance).
 *
 * The profiling report needs to measure the *real app* drawing a **1–2k node**
 * scene, and the app boots one small fixture. Rather than add a run picker
 * (that is M5-T3's loader) this module reads one optional query parameter —
 * `?trace=scale:2000` — and the shell mounts that synthetic run instead.
 *
 * It is deliberately the smallest possible seam:
 *
 * - **one scheme, one prefix.** Only `scale:<n>` is understood here; a real
 *   export path, a file drop or a shareable run id is not this module's job.
 *   Anything else returns `null`, so the app keeps its default mount and a
 *   mistyped URL can never blank the scene.
 * - **bounded.** `agents` is clamped to {@link MAX_SCALE_AGENTS}: a URL is user
 *   input, and an unbounded one would let a shared link freeze a tab in the
 *   layout relaxation. The bound is far above the 1–2k the PRD claims, so it
 *   never limits a real measurement.
 * - **pure, and no browser API.** The parameter string is parsed by hand rather
 *   than with `URLSearchParams`, so the module has no DOM dependency at all and
 *   `parseScaleTrace('?trace=scale:2000')` is a plain function call in a test.
 *
 * The pure half only *describes* the run; {@link scaleTraceRun} builds it
 * through the real ingest path (`buildScaleRun`), so what the app mounts is
 * exactly what the scale probes measure.
 */

import type { ScaleRun } from './scaleRun.ts'
import { buildScaleRun } from './scaleRun.ts'

/** The prefix that marks a synthetic scale run in the `trace` parameter. */
export const SCALE_TRACE_SCHEME = 'scale:'

/** The query parameter that selects a run. */
export const SCALE_TRACE_PARAM = 'trace'

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
  /** Agents to build. */
  agents: number
  /** Messages each agent sends to its hub. */
  messagesPerAgent: number
  /** Run label, naming what was asked for. */
  label: string
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

/**
 * Parse a scale-run request out of a query string.
 *
 * Returns `null` when the URL does not ask for one (no `trace` parameter, a
 * non-`scale:` scheme, or an agent count that is not a positive whole number) —
 * never throws, because a URL is untrusted input and the default mount is
 * always a valid answer.
 *
 * Pure: a function of the string only.
 */
export function parseScaleTrace(search: string): ScaleTraceRequest | null {
  if (typeof search !== 'string') return null
  const trace = rawParam(search, SCALE_TRACE_PARAM)
  if (trace === null || !trace.startsWith(SCALE_TRACE_SCHEME)) return null

  const agents = boundedInt(trace.slice(SCALE_TRACE_SCHEME.length), MAX_SCALE_AGENTS)
  if (agents === null) return null

  const messages = rawParam(search, SCALE_MESSAGES_PARAM)
  const messagesPerAgent =
    messages === null
      ? DEFAULT_MESSAGES_PER_AGENT
      : (boundedInt(messages, MAX_MESSAGES_PER_AGENT) ?? DEFAULT_MESSAGES_PER_AGENT)

  return {
    agents,
    messagesPerAgent,
    label: `scale:${agents} agents`,
  }
}

/**
 * Build the run a query string asks for, or `null` when it asks for none.
 *
 * Goes through {@link buildScaleRun} — the same builder the scale tests and the
 * profiling probe use — so a URL-mounted scene and a measured scene are the
 * same scene.
 */
export function scaleTraceRun(search: string): ScaleRun | null {
  const request = parseScaleTrace(search)
  if (request === null) return null
  return buildScaleRun(request)
}
