/**
 * Tests for the boot precedence (M6-T1).
 *
 * Two sources can name a run at boot — an explicit `?trace=` link and the run the
 * autosave remembers — and the order between them is the product decision these
 * tests pin: a link always wins, a *broken* link never quietly mounts the saved
 * run instead, and only a boot that names nothing falls back to memory.
 */

import { describe, expect, it } from 'vitest'
import { buildFixture } from '../fixtures/index.ts'
import { FLEET_RUN } from '../fixtures/real/index.ts'
import { parseTraceRequest, traceRequestQuery } from '../trace/index.ts'
import { bootState } from './boot.ts'
import { encodeShareView } from './share.ts'
import type { ViewSnapshot } from './snapshot.ts'

const FAN_OUT = buildFixture('fan-out').run
const LOOP = buildFixture('loop').run

/** The camera block every fixture snapshot carries; boot never inspects it. */
const CAMERA = {
  mode: 'orbit' as const,
  orbit: { azimuthDeg: 45, elevationDeg: 20, zoom: 1.5 },
  fly: null,
}

/** A snapshot saved while `run` was mounted, optionally naming its trace fragment. */
function snapshot(run = FAN_OUT, trace: string | null = null): ViewSnapshot {
  return {
    version: 1,
    savedAt: 1_700_000_000_000,
    run: { id: run.id, trace },
    playback: { elapsedMs: 900, speed: 1 },
    filter: { agentIds: [], kinds: ['message', 'tool_call'], window: null },
    selection: null,
    camera: CAMERA,
  }
}

describe('bootState (M6-T1)', () => {
  it('opens the default run with nothing asked for and nothing saved', () => {
    const boot = bootState('', null, FAN_OUT)
    expect(boot.run).toBe(FAN_OUT)
    expect(boot.trace).toBeNull()
    expect(boot.restored).toBeNull()
  })

  it('opens the saved run when the URL names none', () => {
    const boot = bootState('', snapshot(FLEET_RUN, 'trace=fleet'), FAN_OUT)
    expect(boot.run).toBe(FLEET_RUN)
    expect(boot.trace).toBe('trace=fleet')
    expect(boot.restored?.playback.elapsedMs).toBe(900)
  })

  it('lets an explicit link override the saved run', () => {
    const boot = bootState('?trace=fleet', snapshot(FAN_OUT), FAN_OUT)
    // The link wins *which run* opens — and because the save belongs to another
    // trace, none of its view state is restored onto it.
    expect(boot.run).toBe(FLEET_RUN)
    expect(boot.trace).toBe('trace=fleet')
    expect(boot.restored).toBeNull()
  })

  it('restores the view when the link and the save name the same run', () => {
    const boot = bootState('?trace=fleet', snapshot(FLEET_RUN, 'trace=fleet'), FAN_OUT)
    expect(boot.run).toBe(FLEET_RUN)
    expect(boot.restored?.playback.elapsedMs).toBe(900)
  })

  it('mounts the default, not the saved run, for a link it cannot parse', () => {
    // A mistyped link asked for something specific; mounting a different run than
    // it named would be a lie, and mounting the saved one would be a different lie.
    const boot = bootState('?trace=fleetx', snapshot(LOOP, 'trace=scale:3'), FAN_OUT)
    expect(boot.run).toBe(FAN_OUT)
    expect(boot.trace).toBeNull()
    expect(boot.restored).toBeNull()
  })

  it('cannot rebuild a run a save does not name: it falls back, and restores nothing', () => {
    // A save of the default run carries no `?trace=` fragment, so it names its run
    // only by id. With a different fallback run there is nothing to build — and the
    // id guard means no view state leaks onto the run that did open.
    const boot = bootState('', snapshot(FAN_OUT, null), LOOP)
    expect(boot.run).toBe(LOOP)
    expect(boot.trace).toBeNull()
    expect(boot.restored).toBeNull()
  })

  it('ignores a saved trace this build cannot build', () => {
    const boot = bootState('', snapshot(LOOP, 'trace=nonsense'), FAN_OUT)
    expect(boot.run).toBe(FAN_OUT)
    expect(boot.restored).toBeNull()
  })

  it('round-trips a saved scale trace through the one parser', () => {
    const boot = bootState('?trace=scale:6&mpa=2', null, FAN_OUT)
    expect(boot.trace).toBe('trace=scale:6&mpa=2')
    expect(boot.run.agents).toHaveLength(6)
    // The fragment it remembers is the fragment a link would carry.
    const reparsed = parseTraceRequest(`?${boot.trace}`)
    expect(reparsed).toEqual({
      kind: 'scale',
      agents: 6,
      messagesPerAgent: 2,
      label: 'scale:6 agents',
    })
  })

  it('omits the default messages-per-agent from the remembered fragment', () => {
    const boot = bootState('?trace=scale:5&mpa=1', null, FAN_OUT)
    expect(boot.trace).toBe('trace=scale:5')
  })
})

describe('traceRequestQuery (M6-T1)', () => {
  it('is the inverse of parseTraceRequest for both schemes', () => {
    for (const search of [
      '?trace=fleet',
      '?trace=scale:12',
      '?trace=scale:3&mpa=8',
      '?trace=scale:4000',
    ]) {
      const request = parseTraceRequest(search)
      const query = traceRequestQuery(request)
      expect(query).not.toBeNull()
      expect(parseTraceRequest(`?${query}`)).toEqual(request)
    }
  })

  it('names no run when none was asked for', () => {
    expect(traceRequestQuery(null)).toBeNull()
  })
})

describe('bootState — share links (M6-T2)', () => {
  /** A view captured while `run` was on screen, as a share link carries it. */
  function shared(run = FAN_OUT, elapsedMs = 1200): ViewSnapshot {
    return {
      version: 1,
      savedAt: 0,
      run: { id: run.id, trace: 'trace=fixture:fan-out' },
      playback: { elapsedMs, speed: 4 },
      filter: { agentIds: [], kinds: ['message', 'tool_call'], window: null },
      selection: 'a_orchestrator',
      camera: CAMERA,
    }
  }

  it('lets the link’s view beat the local save for the same run', () => {
    // A recipient's own autosave is their *last* view; a link is an instruction
    // about this one. The sharer's playhead, speed, selection and camera win.
    const boot = bootState(
      '?trace=fixture:fan-out',
      snapshot(FAN_OUT), // the recipient's memory: elapsed 900, no selection
      FAN_OUT,
    )
    expect(boot.restored?.playback.elapsedMs).toBe(900)

    const link = encodeShareView(shared())
    const sharedBoot = bootState(
      `?trace=fixture:fan-out&view=${link}`,
      snapshot(FAN_OUT),
      FAN_OUT,
    )
    expect(sharedBoot.run.id).toBe(FAN_OUT.id)
    expect(sharedBoot.restored?.playback.elapsedMs).toBe(1200)
    expect(sharedBoot.restored?.playback.speed).toBe(4)
    expect(sharedBoot.restored?.selection).toBe('a_orchestrator')
    expect(sharedBoot.restored?.camera).toEqual(CAMERA)
  })

  it('ignores a link payload saved for another run, and falls back to the local save', () => {
    const foreign = encodeShareView(shared(FLEET_RUN))
    const boot = bootState(
      `?trace=fixture:fan-out&view=${foreign}`,
      snapshot(FAN_OUT),
      FAN_OUT,
    )
    // The link's view does not describe the mounted run... so the honest answer is
    // the local save *for that run*, not a camera aimed at another cloud.
    expect(boot.restored?.playback.elapsedMs).toBe(900)
    expect(boot.restored?.selection).toBeNull()
  })

  it('mounts the run a payload names when the URL names none', () => {
    // A payload-only link (a hand-trimmed one) still opens the trace it carries:
    // the snapshot's `run.trace` is the same reference the autosave stores.
    const boot = bootState(`?view=${encodeShareView(shared())}`, null, LOOP)
    expect(boot.run.id).toBe(FAN_OUT.id)
    expect(boot.trace).toBe('trace=fixture:fan-out')
    expect(boot.restored?.playback.elapsedMs).toBe(1200)
  })

  it('reads the pinned layout seed, and reads nothing when none is pinned', () => {
    expect(bootState('?trace=fixture:fan-out&seed=42', null, FAN_OUT).seed).toBe(42)
    expect(bootState('?trace=fixture:fan-out&seed=0', null, FAN_OUT).seed).toBe(0)
    expect(bootState('?trace=fixture:fan-out', null, FAN_OUT).seed).toBeNull()
    expect(bootState('?trace=fixture:fan-out&seed=abc', null, FAN_OUT).seed).toBeNull()
  })

  it('keeps the seed on a bare boot, but trusts no seed from a broken link', () => {
    expect(bootState('?seed=7', null, FAN_OUT).seed).toBe(7)
    // A link that named a run we cannot build: its seed described *that* run's
    // layout, so applying it to the default would be a shape the link never showed.
    expect(bootState('?trace=file:run.json&seed=7', null, FAN_OUT).seed).toBeNull()
  })

  it('names the fallback run when the shell supplies its reference', () => {
    // Without this, the app's default mount would be the one view that cannot be
    // shared: a link has to name a run, and nothing in the URL names the default.
    const boot = bootState('', null, FAN_OUT, {
      fallbackTrace: 'trace=fixture:fan-out',
    })
    expect(boot.run).toBe(FAN_OUT)
    expect(boot.trace).toBe('trace=fixture:fan-out')
  })

  it('round-trips a share link built from its own boot state', () => {
    const first = bootState('?trace=fixture:fan-out&seed=1234', null, FAN_OUT)
    const fragment = (first.trace ?? '').replace(/^trace=/, '')
    const link =
      `?trace=${fragment}&seed=${first.seed}` +
      `&view=${encodeShareView(shared(FAN_OUT, 3000))}`
    const second = bootState(link, null, LOOP)
    expect(second.run.id).toBe(first.run.id)
    expect(second.seed).toBe(1234)
    expect(second.restored?.playback.elapsedMs).toBe(3000)
  })
})
