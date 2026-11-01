/**
 * Tests for the base64url codec (M6-T2).
 *
 * The share link puts JSON in a URL; this codec is the only thing between "a view"
 * and "a link". What matters is that it round-trips *bytes* (UTF-8, not UTF-16 code
 * units), that it refuses anything that is not the alphabet it writes, and that it
 * is bounded — the payloads come from users and from other users' links.
 */

import { describe, expect, it } from 'vitest'
import { decodeBase64Url, decodeBase64UrlText, encodeBase64Url } from './base64url.ts'

describe('encodeBase64Url', () => {
  it('writes the base64url alphabet only', () => {
    // 0xfb 0xff would be `+/` in base64; base64url must use `-_`.
    const encoded = encodeBase64Url(' hello?~')
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(encoded).not.toContain('=')
  })

  it('is deterministic', () => {
    expect(encodeBase64Url('{"a":1}')).toBe(encodeBase64Url('{"a":1}'))
  })

  it('encodes the empty string to the empty string', () => {
    expect(encodeBase64Url('')).toBe('')
  })
})

describe('decodeBase64Url', () => {
  it('round-trips ASCII', () => {
    const text = '{"version":1,"run":{"id":"run_abc"}}'
    expect(
      new TextDecoder().decode(decodeBase64Url(encodeBase64Url(text), 1000)!),
    ).toBe(text)
  })

  it('round-trips UTF-8 (a non-ASCII label must survive)', () => {
    // The autosave stores labels verbatim; `btoa` would throw on these code units.
    const text = 'fixture: Fan-out — orchestrator ✓ 委派'
    const encoded = encodeBase64Url(text)
    expect(decodeBase64UrlText(encoded, 1000)).toBe(text)
  })

  it('rejects the standard (non-URL) alphabet', () => {
    // `/` and `+` are what a careless caller would produce with plain `btoa`.
    expect(decodeBase64Url('a+b/', 100)).toBeNull()
    expect(decodeBase64Url('a_b-', 100)).not.toBeNull()
  })

  it('rejects a stream that could not have been base64', () => {
    expect(decodeBase64Url('a', 100)).toBeNull() // length % 4 === 1
    expect(decodeBase64Url('', 100)).toBeNull()
    expect(decodeBase64Url(null, 100)).toBeNull()
    expect(decodeBase64Url(undefined, 100)).toBeNull()
  })

  it('enforces the caller’s bound (untrusted input is bounded, not attempted)', () => {
    const encoded = encodeBase64Url('x'.repeat(200))
    expect(decodeBase64Url(encoded, 10)).toBeNull()
    expect(decodeBase64Url(encoded, encoded.length)).not.toBeNull()
  })

  it('rejects bytes that are not valid UTF-8 instead of replacing them', () => {
    // 0xff is not a UTF-8 lead byte: a naive decoder would give U+FFFD and parse a
    // different payload than the one that was written.
    expect(decodeBase64Url('_w', 10)).not.toBeNull()
    expect(decodeBase64UrlText('_w', 10)).toBeNull()
  })
})
