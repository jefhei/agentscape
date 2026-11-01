/**
 * The one query-string reader (M6-T2, extracted from M5-T3's trace parser).
 *
 * Two things read the page's query string — the trace selector and the share link
 * — and a second hand-rolled reader is how two parameters start disagreeing about
 * what a URL means (does a leading `?` count? a full URL? a `#fragment`?). This
 * module is that reader, and nothing else:
 *
 * - it accepts `location.search` (`'?a=1'`), a bare query (`'a=1'`) or a full URL,
 *   and ignores a fragment;
 * - it returns the **first** occurrence of a parameter, decoded;
 * - a malformed percent-escape reads as its raw text rather than throwing, because
 *   a URL is user input and no parameter is worth a blank scene.
 *
 * It does not interpret: bounding, defaults and rejections belong to the caller
 * (`traceQuery.ts` for `?trace=`, `persist/share.ts` for `?view=`/`?seed=`).
 *
 * Deliberately dependency-free (no `URLSearchParams`, no DOM) so it can be used by
 * a pure module — and by a probe running under `node --experimental-strip-types`
 * without dragging in the run builders.
 */

/** The raw value of `name` in an `a=1&b=2` query string, or `null`. */
function rawParam(search: string, name: string): string | null {
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

/**
 * The decoded value of `name` in a query string (or full URL), or `null`.
 *
 * See the module doc for the accepted shapes; the caller bounds and interprets.
 */
export function readQueryParam(search: string, name: string): string | null {
  if (typeof search !== 'string') return null
  return rawParam(search, name)
}
