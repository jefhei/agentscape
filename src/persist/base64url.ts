/**
 * base64url for URL payloads (M6-T2).
 *
 * The share link carries a JSON snapshot in a query parameter, and JSON is full
 * of characters a URL cannot hold raw (`{`, `"`, `,`). base64url is the smallest
 * correct transport: it needs no percent-encoding, survives every chat client and
 * link previewer, and decodes to exactly the bytes that were written.
 *
 * The codec works on **UTF-8 bytes**, not on UTF-16 code units: a run label with a
 * non-ASCII character in it must round-trip (the trackers phase of this project
 * already bit us once on an encoding assumption), and `btoa` throws on any code
 * unit above 0xFF.
 *
 * Decoding is strict: the alphabet is base64url only (`-`, `_`; never `+`, `/`),
 * padding is not required, an illegal character is rejected before `atob` runs,
 * and a decode that is not valid UTF-8 is rejected rather than replaced with
 * U+FFFD — a mangled payload must read as "no payload", never as a different one.
 */

/** The base64url alphabet this codec writes, and the only one it reads. */
const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]+$/

/**
 * Encode `text` as unpadded base64url.
 *
 * Pure and deterministic. An empty string encodes to an empty string.
 */
export function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * Decode unpadded base64url into UTF-8 bytes, or `null` when the text is not
 * valid base64url (or is longer than `maxLength`).
 *
 * `maxLength` is required: every caller is decoding untrusted input, and a bound
 * is the difference between "a link" and "a denial of service".
 */
export function decodeBase64Url(
  encoded: string | null | undefined,
  maxLength: number,
): Uint8Array | null {
  if (typeof encoded !== 'string' || encoded.length === 0) return null
  if (encoded.length > maxLength) return null
  if (!BASE64URL_ALPHABET.test(encoded)) return null
  // A base64 stream cannot leave a single trailing character.
  if (encoded.length % 4 === 1) return null

  const standard = encoded.replaceAll('-', '+').replaceAll('_', '/')
  const padding = '='.repeat((4 - (standard.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(standard + padding)
  } catch {
    return null
  }

  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * Decode unpadded base64url into a string, or `null` when it is not valid
 * base64url *or* not valid UTF-8.
 */
export function decodeBase64UrlText(
  encoded: string | null | undefined,
  maxLength: number,
): string | null {
  const bytes = decodeBase64Url(encoded, maxLength)
  if (bytes === null) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
