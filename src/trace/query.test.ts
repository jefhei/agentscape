/**
 * Tests for the one query-string reader (M6-T2).
 *
 * Two features read the URL — the trace selector and the share link — so this small
 * module is where "what a URL means" is decided once. The rules it must keep are the
 * ones a browser's `location.search` actually produces, plus the defensive ones a
 * hand-rolled reader needs: never throw, decode when it can, and return the raw text
 * when it cannot.
 */

import { describe, expect, it } from 'vitest'
import { readQueryParam } from './query.ts'

describe('readQueryParam', () => {
  it('reads a plain query, with or without the leading question mark', () => {
    expect(readQueryParam('?trace=fleet', 'trace')).toBe('fleet')
    expect(readQueryParam('trace=fleet', 'trace')).toBe('fleet')
  })

  it('reads a full URL and ignores its fragment', () => {
    expect(readQueryParam('http://localhost:4173/app/?trace=scale:4#nodes', 'trace')).toBe(
      'scale:4',
    )
    expect(readQueryParam('?trace=fleet#view=1', 'trace')).toBe('fleet')
  })

  it('ignores other parameters and their order', () => {
    expect(readQueryParam('?a=1&trace=fleet&seed=3', 'seed')).toBe('3')
    expect(readQueryParam('?a=1&trace=fleet', 'seed')).toBeNull()
  })

  it('returns the first occurrence', () => {
    expect(readQueryParam('?trace=fleet&trace=scale:2', 'trace')).toBe('fleet')
  })

  it('decodes a percent-escaped value', () => {
    expect(readQueryParam('?label=fixture%3A%20Fan-out', 'label')).toBe('fixture: Fan-out')
  })

  it('reads a malformed escape as its raw text rather than throwing', () => {
    expect(() => readQueryParam('?label=%E0%A4%A', 'label')).not.toThrow()
    expect(readQueryParam('?label=%E0%A4%A', 'label')).toBe('%E0%A4%A')
  })

  it('is null for an empty query, a bare key, or a non-string', () => {
    expect(readQueryParam('', 'trace')).toBeNull()
    expect(readQueryParam('?', 'trace')).toBeNull()
    expect(readQueryParam('?trace', 'trace')).toBeNull()
    expect(readQueryParam(undefined as unknown as string, 'trace')).toBeNull()
  })

  it('does not confuse a key prefix for the key', () => {
    expect(readQueryParam('?traces=1&trace=fleet', 'trace')).toBe('fleet')
    expect(readQueryParam('?traces=1', 'trace')).toBeNull()
  })
})
