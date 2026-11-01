/**
 * The shareable view link (M6-T2) — a URL that reproduces *this* view.
 *
 * The autosave (M6-T1) keeps a view for the person who left it. A share link is
 * the other half of persistence: it hands the same answer to someone else. Two
 * things have to be true for that to be honest:
 *
 * 1. **The link names the run, not its rows.** A run is reproducible from its
 *    reference (M5-T3's `?trace=` vocabulary), so the link carries that reference
 *    and the recipient rebuilds the trace through the one ingest path — exactly
 *    like the autosave stores a reference rather than 2000 agents' worth of rows.
 * 2. **The link names the shape.** The layout is a pure function of the trace
 *    *and its seed* (M2-T1/M2-T2). The seed is derived from the run today, but it
 *    is an input, not a constant: pinning it in the link means the recipient sees
 *    the same cloud the sharer saw, even if a later build derives a different
 *    default seed for the same trace. That is what makes "the same view" a fact
 *    rather than a hope.
 *
 * ## One serializer, not two
 *
 * The view half of the link is the **same {@link ViewSnapshot} the autosave
 * writes**, captured by the same {@link captureSnapshot} and validated by the
 * same {@link normalizeSnapshot}. The only thing this module adds is transport:
 * the JSON goes into the URL as base64url so ids, braces and quotes survive the
 * trip. If the snapshot schema changes, the link's meaning changes with it — the
 * autosave's version guard is the link's version guard too.
 *
 * ## A URL is untrusted input
 *
 * Every entry point here returns `null` (or omits the view, see below) instead of
 * throwing: a link with a mangled payload, a foreign run's view, an absurd seed
 * or a 100 kB blob must leave the app on a valid view. The rules:
 *
 * - **bounded** — an encoded view over {@link MAX_SHARE_VIEW_LENGTH} is not
 *   decoded, and a share link that cannot carry its view still carries the run and
 *   the seed (the recipient gets the same run and shape, just their own view);
 * - **exact base64url only** — anything outside the alphabet is rejected before
 *   `atob` sees it;
 * - **the snapshot validator is the only validator** — a decoded payload that
 *   `normalizeSnapshot` rejects is no payload at all;
 * - **a seed is a `uint32`** — the same range the seeded PRNG consumes
 *   (`mulberry32` masks to 32 bits), so a value outside it would silently mean a
 *   different seed than the one the link names.
 *
 * Pure: no `window`, no `location`, no clock. The base URL is an argument.
 */

import { readQueryParam } from '../trace/query.ts'
import { decodeBase64UrlText, encodeBase64Url } from './base64url.ts'
import { normalizeSnapshot, serializeSnapshot } from './snapshot.ts'
import type { ViewSnapshot } from './snapshot.ts'

/** The query parameter that carries the encoded view (the autosave's own value). */
export const SHARE_VIEW_PARAM = 'view'

/** The query parameter that pins the layout seed. */
export const SHARE_SEED_PARAM = 'seed'

/**
 * The largest encoded view this module will write or read, in characters.
 *
 * 8 kB is the conservative ceiling a static host (and a chat client) will carry
 * without truncation, and it holds a full lens over hundreds of agents. A view
 * that does not fit is *omitted* rather than truncated: half a lens is a lie.
 */
export const MAX_SHARE_VIEW_LENGTH = 8000

/**
 * The largest layout seed, matching what `mulberry32` consumes. Anything outside
 * `[0, MAX_LAYOUT_SEED]` is not a seed this app can reproduce.
 */
export const MAX_LAYOUT_SEED = 0xffff_ffff

// ── Seed ────────────────────────────────────────────────────────────────────

/**
 * A whole number in `[0, MAX_LAYOUT_SEED]`, or `null`.
 *
 * Accepts a number (a parsed URL value, a live plan's seed) — strings are read by
 * {@link parseLayoutSeed}, which also rejects `1e3`, `+1` and `1.0` rather than
 * letting `Number` reinterpret them.
 */
export function normalizeLayoutSeed(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < 0 || value > MAX_LAYOUT_SEED) return null
  return value
}

/** A raw `seed=` value as a layout seed, or `null` when it is not one. */
export function parseLayoutSeed(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw)) return null
  return normalizeLayoutSeed(Number(raw))
}

/** The layout seed a query string pins, or `null` when it pins none. */
export function readShareSeed(search: string): number | null {
  if (typeof search !== 'string') return null
  return parseLayoutSeed(readQueryParam(search, SHARE_SEED_PARAM))
}

// ── View payload ────────────────────────────────────────────────────────────

/**
 * Encode a snapshot for a URL. Byte-identical for the same snapshot — the caller
 * controls `savedAt`, and a share link is built with `savedAt: 0` so the same view
 * always produces the same link.
 */
export function encodeShareView(snapshot: ViewSnapshot): string {
  return encodeBase64Url(serializeSnapshot(snapshot))
}

/**
 * Read an encoded view back, or `null` when it is not one.
 *
 * Never throws. The decoded text is JSON-parsed and then validated by the
 * autosave's own {@link normalizeSnapshot}, so a payload can be no more trusted
 * than a stored snapshot — and needs no second set of rules.
 */
export function decodeShareView(text: string | null | undefined): ViewSnapshot | null {
  const decoded = decodeBase64UrlText(text, MAX_SHARE_VIEW_LENGTH)
  if (decoded === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(decoded)
  } catch {
    return null
  }
  return normalizeSnapshot(raw)
}

/** The view a query string carries, or `null` when it carries none (or a broken one). */
export function readShareView(search: string): ViewSnapshot | null {
  if (typeof search !== 'string') return null
  return decodeShareView(readQueryParam(search, SHARE_VIEW_PARAM))
}

// ── The link ────────────────────────────────────────────────────────────────

/** What a share link says. */
export interface ShareLinkParts {
  /**
   * The canonical `?trace=` fragment naming the mounted run
   * ({@link import('../trace/index.ts').traceRequestQuery}), e.g.
   * `trace=fixture:fan-out`. A share link always names a run: without it the
   * recipient would open *their* last run, which is the one thing a link must
   * never do.
   */
  trace: string
  /** The seed the layout was settled with — the shape, pinned. */
  seed: number | null
  /** The view to reproduce (playhead, lens, selection, camera). */
  snapshot: ViewSnapshot
}

/**
 * The query string a share link carries, e.g.
 * `trace=fixture:fan-out&seed=123&view=eyJ2ZXJzaW9uIjox…`.
 *
 * Deterministic: the same parts produce the same string. The view is omitted when
 * its encoding exceeds {@link MAX_SHARE_VIEW_LENGTH} (and when `trace` is empty,
 * though a caller with a mounted run always has one) — an over-long link is worse
 * than a link that reproduces the run and its shape but not the lens.
 */
export function shareQuery(parts: ShareLinkParts): string {
  const fields: string[] = []
  const trace = parts.trace.trim()
  if (trace !== '') fields.push(trace)

  const seed = normalizeLayoutSeed(parts.seed)
  if (seed !== null) fields.push(`${SHARE_SEED_PARAM}=${seed}`)

  const view = encodeShareView(parts.snapshot)
  if (view.length <= MAX_SHARE_VIEW_LENGTH) {
    fields.push(`${SHARE_VIEW_PARAM}=${view}`)
  }
  return fields.join('&')
}

/**
 * A shareable URL: `base`'s path (its own query and fragment dropped, so a link
 * built from a URL that already carries parameters does not nest them) plus
 * {@link shareQuery}.
 *
 * `base` may be absolute (`https://host/app/`) or a bare path (`/`); an empty base
 * yields a query-only link, which is still valid relative to the current page.
 */
export function shareHref(base: string, parts: ShareLinkParts): string {
  const withoutFragment = base.split('#', 1)[0] ?? ''
  const question = withoutFragment.indexOf('?')
  const path = question < 0 ? withoutFragment : withoutFragment.slice(0, question)
  const query = shareQuery(parts)
  if (query === '') return path
  return `${path}?${query}`
}

/** What a link asks for, as far as this module is concerned. */
export interface ShareRequest {
  /** The view it carries, or `null` when it carries none this app can read. */
  snapshot: ViewSnapshot | null
  /** The layout seed it pins, or `null`. */
  seed: number | null
}

/**
 * Read every share parameter out of a query string.
 *
 * Separate parameters fail separately on purpose: a link with a corrupt view but
 * a valid seed still reproduces the run and its shape, and a link with a bad seed
 * still reproduces the view.
 */
export function readShareRequest(search: string): ShareRequest {
  if (typeof search !== 'string') return { snapshot: null, seed: null }
  return { snapshot: readShareView(search), seed: readShareSeed(search) }
}
