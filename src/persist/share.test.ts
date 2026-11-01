/**
 * Tests for the shareable view link (M6-T2).
 *
 * A share link is the autosave's snapshot plus a transport and a run reference. The
 * rules these tests pin:
 *
 * - **round-trip** — a link built from a view re-reads as the same view, so a
 *   recipient gets what the sharer had;
 * - **determinism** — the same view always encodes to the same link (a link is an
 *   address, and an address that changes per click is not one);
 * - **the run is named** — `?trace=` (not the id) is what rebuilds the trace, and
 *   the seed rides beside it;
 * - **bounded and never throwing** — an over-long view is omitted rather than
 *   truncated, and garbage is `null` rather than an exception or a half-value.
 */

import { describe, expect, it } from 'vitest'
import { buildFixture } from '../fixtures/index.ts'
import { captureSnapshot } from './snapshot.ts'
import type { CameraSnapshot, ViewSnapshot } from './snapshot.ts'
import {
  MAX_LAYOUT_SEED,
  MAX_SHARE_VIEW_LENGTH,
  SHARE_SEED_PARAM,
  SHARE_VIEW_PARAM,
  decodeShareView,
  encodeShareView,
  normalizeLayoutSeed,
  parseLayoutSeed,
  readShareRequest,
  readShareSeed,
  readShareView,
  shareHref,
  shareQuery,
} from './share.ts'

const RUN = buildFixture('fan-out').run

/** A pose and a lens that are unmistakably not the opening shot. */
const CAMERA: CameraSnapshot = {
  mode: 'fly',
  orbit: { azimuthDeg: 45, elevationDeg: 20, zoom: 1.5 },
  fly: { position: { x: 1.5, y: -2, z: 3.25 }, yawDeg: 270, pitchDeg: -10 },
}

/** The view a sharer would be looking at. */
function view(
  overrides: Partial<Parameters<typeof captureSnapshot>[0]> = {},
): ViewSnapshot {
  return captureSnapshot({
    runId: RUN.id,
    trace: 'trace=fixture:fan-out',
    elapsedMs: 60_000,
    speed: 2,
    filter: {
      agentIds: ['a_worker_alpha'],
      kinds: ['message'],
      window: { startMs: 0, endMs: 90_000 },
    },
    selection: 'a_worker_alpha',
    camera: CAMERA,
    savedAt: 0,
    ...overrides,
  })
}

describe('layout seed', () => {
  it('accepts exactly the uint32 range the PRNG consumes', () => {
    expect(normalizeLayoutSeed(0)).toBe(0)
    expect(normalizeLayoutSeed(42)).toBe(42)
    expect(normalizeLayoutSeed(MAX_LAYOUT_SEED)).toBe(MAX_LAYOUT_SEED)
  })

  it('rejects anything a seed could not be', () => {
    expect(normalizeLayoutSeed(-1)).toBeNull()
    expect(normalizeLayoutSeed(1.5)).toBeNull()
    expect(normalizeLayoutSeed(MAX_LAYOUT_SEED + 1)).toBeNull()
    expect(normalizeLayoutSeed(Number.NaN)).toBeNull()
    expect(normalizeLayoutSeed('42')).toBeNull()
    expect(normalizeLayoutSeed(null)).toBeNull()
  })

  it('reads a raw URL value without letting Number reinterpret it', () => {
    expect(parseLayoutSeed('0')).toBe(0)
    expect(parseLayoutSeed('4294967295')).toBe(MAX_LAYOUT_SEED)
    // `Number` would accept every one of these, and each would be a different seed
    // than the link appears to name.
    for (const raw of [
      '',
      ' 1',
      '1e3',
      '-1',
      '1.0',
      '+1',
      '0x10',
      '4294967296',
      'seed',
    ]) {
      expect(parseLayoutSeed(raw), raw).toBeNull()
    }
    expect(parseLayoutSeed(null)).toBeNull()
  })

  it('reads the seed out of a query string', () => {
    expect(readShareSeed('?seed=7')).toBe(7)
    expect(readShareSeed('seed=7&trace=fleet')).toBe(7)
    expect(readShareSeed('?trace=fleet')).toBeNull()
    expect(readShareSeed('')).toBeNull()
  })
})

describe('encodeShareView / decodeShareView', () => {
  it('round-trips a whole view, camera included', () => {
    const snapshot = view()
    const decoded = decodeShareView(encodeShareView(snapshot))
    expect(decoded).toEqual(snapshot)
  })

  it('encodes the same view to the same text', () => {
    expect(encodeShareView(view())).toBe(encodeShareView(view()))
  })

  it('is the autosave’s own validator: a foreign or unknown payload is null', () => {
    // Not JSON.
    expect(decodeShareView('bm90IGpzb24')).toBeNull()
    // JSON, but not a snapshot.
    expect(decodeShareView(encodeShareView(view()).replace(/^./, 'x'))).toBeNull()
    // Garbage and absence never throw.
    expect(decodeShareView('!!!')).toBeNull()
    expect(decodeShareView('')).toBeNull()
    expect(decodeShareView(null)).toBeNull()
  })

  it('refuses a payload over the length bound', () => {
    const huge = encodeShareView(view()).repeat(MAX_SHARE_VIEW_LENGTH)
    expect(huge.length).toBeGreaterThan(MAX_SHARE_VIEW_LENGTH)
    expect(decodeShareView(huge)).toBeNull()
  })
})

describe('shareQuery', () => {
  it('carries the run reference, the seed and the view, in that order', () => {
    const query = shareQuery({
      trace: 'trace=fixture:fan-out',
      seed: 7,
      snapshot: view(),
    })
    const fields = query.split('&')
    expect(fields[0]).toBe('trace=fixture:fan-out')
    expect(fields[1]).toBe(`${SHARE_SEED_PARAM}=7`)
    expect(fields[2].startsWith(`${SHARE_VIEW_PARAM}=`)).toBe(true)
  })

  it('is deterministic', () => {
    const parts = { trace: 'trace=fleet', seed: 1, snapshot: view() }
    expect(shareQuery(parts)).toBe(shareQuery(parts))
  })

  it('omits a view too long for a URL, but keeps the run and the shape', () => {
    // A lens over thousands of agents is a real value the autosave can hold, and a
    // real value that cannot be a link. The link degrades to run + seed.
    const wide = view({
      filter: {
        agentIds: Array.from({ length: 2000 }, (_, index) => `a_agent_${index}`),
        kinds: ['message', 'tool_call'],
        window: null,
      },
    })
    const query = shareQuery({ trace: 'trace=fleet', seed: 9, snapshot: wide })
    expect(query).toBe('trace=fleet&seed=9')
    expect(query).not.toContain(`${SHARE_VIEW_PARAM}=`)
    // The same view still encodes for the autosave (8022 characters or more).
    expect(encodeShareView(wide).length).toBeGreaterThan(MAX_SHARE_VIEW_LENGTH)
  })

  it('treats an unseedable value as “no seed” rather than inventing one', () => {
    const query = shareQuery({ trace: 'trace=fleet', seed: -3, snapshot: view() })
    expect(query).not.toContain(`${SHARE_SEED_PARAM}=`)
    expect(query.startsWith('trace=fleet&view=')).toBe(true)
  })
})

describe('shareHref', () => {
  it('drops the base’s own query and fragment', () => {
    const href = shareHref('https://example.test/app/?trace=fleet&seed=1#camera', {
      trace: 'trace=fixture:fan-out',
      seed: 12,
      snapshot: view(),
    })
    expect(
      href.startsWith('https://example.test/app/?trace=fixture:fan-out&seed=12&view='),
    ).toBe(true)
    expect(href).not.toContain('#')
    expect(href.match(/\?/g)).toHaveLength(1)
  })

  it('builds a relative link for an empty base', () => {
    const href = shareHref('', { trace: 'trace=fleet', seed: null, snapshot: view() })
    expect(href.startsWith('?trace=fleet&view=')).toBe(true)
  })
})

describe('readShareRequest', () => {
  it('reads a link it just built', () => {
    const snapshot = view()
    const href = shareHref('https://example.test/', {
      trace: 'trace=fixture:fan-out',
      seed: 1234,
      snapshot,
    })
    const search = href.slice(href.indexOf('?'))
    expect(readShareRequest(search)).toEqual({ snapshot, seed: 1234 })
    expect(readShareView(search)).toEqual(snapshot)
  })

  it('fails the parts separately: a corrupt view does not lose the seed', () => {
    expect(readShareRequest('?trace=fleet&seed=5&view=!!!')).toEqual({
      snapshot: null,
      seed: 5,
    })
    expect(readShareRequest('?trace=fleet&seed=nope&view=!!!')).toEqual({
      snapshot: null,
      seed: null,
    })
  })

  it('is null-safe for a page with no query at all', () => {
    expect(readShareRequest('')).toEqual({ snapshot: null, seed: null })
    expect(readShareRequest(undefined as unknown as string)).toEqual({
      snapshot: null,
      seed: null,
    })
  })
})
