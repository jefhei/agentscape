import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIXTURES } from '../fixtures/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import { normalizeTrace } from '../model/index.ts'
import { findHandAuthoredCoordinates, settleLayout } from '../layout/index.ts'
import {
  BLOOM_KNEE_DISPLAY_LUMINANCE,
  DEFAULT_BACKGROUND_HEX,
  DEFAULT_EMISSIVE_CALIBRATION,
  DEFAULT_FOG_HEX,
  DEFAULT_VIEW_DISTANCE,
  ENVIRONMENT_DRAW_CALLS,
  ENVIRONMENT_POST_PROCESS_PASSES,
  EnvironmentRigError,
  HOT_DISPLAY_LUMINANCE,
  QUIET_DISPLAY_LUMINANCE,
  blooms,
  buildEnvironmentPlan,
  displayLuminance,
  glowColor,
  glowRadiance,
  resolveCalibration,
} from './environment.ts'
import {
  LUMINANCE_WEIGHTS,
  hexToLinearRgb,
  isHexColor,
  luminanceOf,
  scaleToLuminance,
} from './color.ts'
import type { Rgb } from './color.ts'
import { ToneMappingError, acesFilmic, inverseAcesFilmic } from './toneMapping.ts'

/**
 * M3-T4 — environment, lighting and bloom-honest emissive calibration.
 *
 * jsdom has no GPU, so nothing here asserts what the scene *looks* like: the look
 * is human-reviewed (M5-T5). What is gated is the arithmetic the look rests on —
 * the tone curve and its inverse, the calibration solved from its anchors, the
 * bloom knee, the no-clipping bound, the rig derived from the cloud's extent, and
 * determinism. Every one of those is a pure function, which is why they can be
 * pinned hard in a headless test.
 */

const CAL = DEFAULT_EMISSIVE_CALIBRATION

/** Look a fixture up by shape, failing loudly if the registry changed. */
function fixture(shape: string) {
  const found = FIXTURES.find((candidate) => candidate.shape === shape)
  if (found === undefined) throw new Error(`no fixture ${shape}`)
  return found
}

// ── the tone-mapping model ──────────────────────────────────────────────────

describe('tone-mapping model (M3-T4)', () => {
  it('maps zero radiance to zero, and is monotone increasing below white', () => {
    expect(acesFilmic(0)).toBe(0)
    let previous = -1
    // Up to ~7 the fit is below white, where the ordering is strict.
    for (let step = 0; step <= 140; step += 1) {
      const value = acesFilmic(step / 20)
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThan(previous)
      previous = value
    }
  })

  it('saturates at white instead of exceeding it', () => {
    // The raw ACES fit's asymptote is 2.51/2.43 ≈ 1.033; the renderer saturates
    // it, so the model must too or a "display luminance" could read above white.
    for (const radiance of [1, 2, 5, 7, 10, 100, 1e6]) {
      expect(acesFilmic(radiance)).toBeLessThanOrEqual(1)
    }
    expect(acesFilmic(1e6)).toBe(1)
    expect(acesFilmic(1)).toBeLessThan(0.85)
  })

  it('treats negative or non-finite radiance as zero', () => {
    expect(acesFilmic(-3)).toBe(0)
    expect(acesFilmic(Number.NaN)).toBe(0)
    expect(acesFilmic(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('inverts itself across the whole display range', () => {
    for (const display of [0.01, 0.05, 0.22, 0.4, 0.5, 0.72, 0.82, 0.9, 0.95, 0.99]) {
      const radiance = inverseAcesFilmic(display)
      expect(radiance).toBeGreaterThan(0)
      expect(acesFilmic(radiance)).toBeCloseTo(display, 9)
    }
  })

  it('round-trips in the other direction too', () => {
    for (const radiance of [0.05, 0.5, 1, 1.77, 2.86]) {
      const display = acesFilmic(radiance)
      expect(inverseAcesFilmic(display)).toBeCloseTo(radiance, 9)
    }
  })

  it('refuses display values it cannot invert', () => {
    for (const bad of [0, 1, -0.2, 1.5, Number.NaN]) {
      expect(() => inverseAcesFilmic(bad)).toThrow(ToneMappingError)
    }
  })
})

// ── colour math ─────────────────────────────────────────────────────────────

describe('colour math (M3-T4)', () => {
  it('weights luminance by Rec.709', () => {
    expect(luminanceOf([1, 0, 0])).toBeCloseTo(LUMINANCE_WEIGHTS[0], 12)
    expect(luminanceOf([0, 1, 0])).toBeCloseTo(LUMINANCE_WEIGHTS[1], 12)
    expect(luminanceOf([0, 0, 1])).toBeCloseTo(LUMINANCE_WEIGHTS[2], 12)
    expect(luminanceOf([0, 0, 0])).toBe(0)
  })

  it('converts sRGB hex to linear RGB, and keeps 1.0 at 1.0', () => {
    expect(hexToLinearRgb('#ffffff')).toEqual([1, 1, 1])
    expect(hexToLinearRgb('#000000')).toEqual([0, 0, 0])
    // Mid grey is *not* 0.5 in linear light; the sRGB transfer curve is the point.
    const grey = hexToLinearRgb('#808080')
    expect(grey[0]).toBeCloseTo(0.2159, 3)
    // The short form expands to the long one.
    expect(hexToLinearRgb('#08f')).toEqual(hexToLinearRgb('#0088ff'))
  })

  it('recognizes only valid hex colours, and throws on garbage', () => {
    expect(isHexColor('#abc')).toBe(true)
    expect(isHexColor('#aabbcc')).toBe(true)
    expect(isHexColor('abc')).toBe(false)
    expect(isHexColor('#abcde')).toBe(false)
    expect(isHexColor(undefined)).toBe(false)
    expect(() => hexToLinearRgb('nope')).toThrow(/hex/)
  })

  it('rescales a hue to a target luminance without changing its ratios', () => {
    const base: Rgb = [0.62, 0.82, 1]
    const scaled = scaleToLuminance(base, 0.4)
    expect(luminanceOf(scaled)).toBeCloseTo(0.4, 12)
    expect(scaled[1] / scaled[0]).toBeCloseTo(base[1] / base[0], 12)
    expect(scaled[2] / scaled[0]).toBeCloseTo(base[2] / base[0], 12)
  })

  it('turns a colourless base into neutral grey at the target luminance', () => {
    expect(scaleToLuminance([0, 0, 0], 1.5)).toEqual([1.5, 1.5, 1.5])
    expect(scaleToLuminance([0, 0, 0], Number.NaN)).toEqual([0, 0, 0])
  })
})

// ── the emissive calibration ────────────────────────────────────────────────

describe('emissive calibration (M3-T4)', () => {
  it('solves its radiances by inverting ACES at the display anchors', () => {
    expect(CAL.quietRadiance).toBeCloseTo(
      inverseAcesFilmic(QUIET_DISPLAY_LUMINANCE),
      12,
    )
    expect(CAL.hotRadiance).toBeCloseTo(inverseAcesFilmic(HOT_DISPLAY_LUMINANCE), 12)
    expect(CAL.bloomThreshold).toBeCloseTo(
      inverseAcesFilmic(BLOOM_KNEE_DISPLAY_LUMINANCE),
      12,
    )
  })

  it('places the bloom knee where the anchors say, by construction', () => {
    // The curve is solved so it passes through the knee: that is what makes
    // "the top of the activity range blooms" a derived fact, not a tuning knob.
    expect(glowRadiance(CAL, CAL.bloomKneeEmissive)).toBeCloseTo(CAL.bloomThreshold, 12)
    expect(CAL.bloomKneeEmissive).toBeCloseTo(
      CAL.minEmissive + (CAL.maxEmissive - CAL.minEmissive) * CAL.bloomKneeActivity,
      12,
    )
  })

  it('solves a convex exponent — quiet agents recede, busy agents carry the eye', () => {
    expect(CAL.gamma).toBeGreaterThan(1)
    expect(CAL.gamma).toBeLessThan(4)
  })

  it('emits the quiet radiance at the activity floor and the hot one at its ceiling', () => {
    expect(glowRadiance(CAL, CAL.minEmissive)).toBeCloseTo(CAL.quietRadiance, 12)
    expect(glowRadiance(CAL, CAL.maxEmissive)).toBeCloseTo(CAL.hotRadiance, 12)
  })

  it('is monotone across the whole activity range', () => {
    let previous = -1
    for (let step = 0; step <= 100; step += 1) {
      const emissive =
        CAL.minEmissive + ((CAL.maxEmissive - CAL.minEmissive) * step) / 100
      const radiance = glowRadiance(CAL, emissive)
      expect(Number.isFinite(radiance)).toBe(true)
      expect(radiance).toBeGreaterThanOrEqual(previous)
      previous = radiance
    }
  })

  it('clamps activity outside its range instead of emitting NaN or black', () => {
    expect(glowRadiance(CAL, -5)).toBeCloseTo(CAL.quietRadiance, 12)
    expect(glowRadiance(CAL, 42)).toBeCloseTo(CAL.hotRadiance, 12)
    expect(glowRadiance(CAL, Number.NaN)).toBeCloseTo(CAL.quietRadiance, 12)
  })

  it('blooms exactly above the knee and not at or below it', () => {
    expect(blooms(CAL, CAL.minEmissive)).toBe(false)
    expect(blooms(CAL, CAL.bloomKneeEmissive)).toBe(false)
    expect(blooms(CAL, CAL.bloomKneeEmissive + 1e-6)).toBe(true)
    expect(blooms(CAL, CAL.maxEmissive)).toBe(true)
  })

  it('pins the hot end to "hot, not blown out"', () => {
    const hot = displayLuminance(CAL, CAL.maxEmissive)
    expect(hot).toBeCloseTo(HOT_DISPLAY_LUMINANCE, 9)
    // Strictly below clipping, with roll-off left above it.
    expect(hot).toBeLessThan(0.95)
    const quiet = displayLuminance(CAL, CAL.minEmissive)
    expect(quiet).toBeCloseTo(QUIET_DISPLAY_LUMINANCE, 9)
    expect(hot).toBeGreaterThan(quiet)
  })

  it('is not vacuous: an uncalibrated linear mapping never blooms at all', () => {
    // The pre-M3-T4 behaviour was `radiance = emissive`. Under the same threshold
    // that curve tops out below the knee radiance, so NOTHING blooms — and its
    // hottest node displays well short of the hot anchor. The calibration is what
    // supplies the HDR headroom the bloom pass needs.
    const naiveHotRadiance = CAL.maxEmissive
    expect(naiveHotRadiance).toBeLessThan(CAL.bloomThreshold)
    expect(acesFilmic(naiveHotRadiance)).toBeLessThan(HOT_DISPLAY_LUMINANCE - 0.05)
    expect(acesFilmic(naiveHotRadiance)).toBeLessThan(BLOOM_KNEE_DISPLAY_LUMINANCE)
  })

  it('tracks the exposure: doubling it halves the radiances and keeps the look', () => {
    const doubled = resolveCalibration({ exposure: 2 })
    expect(doubled.quietRadiance).toBeCloseTo(CAL.quietRadiance / 2, 12)
    expect(doubled.hotRadiance).toBeCloseTo(CAL.hotRadiance / 2, 12)
    expect(doubled.bloomThreshold).toBeCloseTo(CAL.bloomThreshold / 2, 12)
    expect(displayLuminance(doubled, doubled.maxEmissive)).toBeCloseTo(
      HOT_DISPLAY_LUMINANCE,
      9,
    )
  })

  it('re-solves when an anchor moves', () => {
    const tighter = resolveCalibration({ bloomKneeActivity: 0.9 })
    expect(tighter.bloomKneeEmissive).toBeGreaterThan(CAL.bloomKneeEmissive)
    expect(tighter.gamma).not.toBeCloseTo(CAL.gamma, 6)
    // The knee still lands exactly where its anchors put it.
    expect(glowRadiance(tighter, tighter.bloomKneeEmissive)).toBeCloseTo(
      tighter.bloomThreshold,
      12,
    )
  })

  it('fails loudly on anchors that cannot describe a calibration', () => {
    expect(() => resolveCalibration({ quietDisplay: 0.9 })).toThrow(EnvironmentRigError)
    expect(() => resolveCalibration({ hotDisplay: 0.5 })).toThrow(EnvironmentRigError)
    expect(() => resolveCalibration({ bloomKneeDisplay: 0.99 })).toThrow(
      EnvironmentRigError,
    )
  })

  it('keeps every base hue at the same brightness for the same activity', () => {
    const hues: Rgb[] = [
      [0.62, 0.82, 1],
      [1, 0.3, 0.2],
      [0.2, 1, 0.4],
      [3, 1, 0.5],
    ]
    for (const emissive of [CAL.minEmissive, 0.5, CAL.maxEmissive]) {
      const expected = glowRadiance(CAL, emissive)
      for (const hue of hues) {
        expect(luminanceOf(glowColor(CAL, hue, emissive))).toBeCloseTo(expected, 10)
      }
    }
  })

  it('is frozen, so no consumer can mutate the shared calibration', () => {
    expect(Object.isFrozen(CAL)).toBe(true)
  })
})

// ── the rig plan ────────────────────────────────────────────────────────────

describe('environment plan (M3-T4)', () => {
  it('frames the rig to the settled cloud for every fixture', () => {
    for (const { run, shape } of FIXTURES) {
      const plan = buildEnvironmentPlan(run)
      const settled = settleLayout(run)
      expect(plan.extentRadius, shape).toBeCloseTo(settled.layout.bounds.radius, 12)
      expect(plan.bounds?.radius, shape).toBeCloseTo(settled.layout.bounds.radius, 12)
      expect(plan.seed, shape).toBe(settled.layout.seed)
      expect(plan.settlement?.converged, shape).toBe(true)
      expect(plan.settlement?.iterations, shape).toBe(settled.iterations)
    }
  })

  it('is a dark scene: background and fog well under the bloom knee', () => {
    const plan = buildEnvironmentPlan(fixture('fan-out').run)
    expect(plan.backgroundHex).toBe(DEFAULT_BACKGROUND_HEX)
    expect(plan.fog.hex).toBe(DEFAULT_FOG_HEX)
    expect(luminanceOf(plan.background)).toBeLessThan(0.01)
    expect(luminanceOf(plan.fog.color)).toBeLessThan(0.02)
    expect(plan.toneMapping).toBe('ACESFilmic')
    expect(plan.exposure).toBe(CAL.exposure)
  })

  it('places a fog band around the framing distance, ordered and non-negative', () => {
    for (const { run, shape } of FIXTURES) {
      const plan = buildEnvironmentPlan(run)
      expect(plan.fog.enabled, shape).toBe(true)
      expect(plan.fog.near, shape).toBeGreaterThan(0)
      expect(plan.fog.far, shape).toBeGreaterThan(plan.fog.near)
      // The band brackets the default view distance, so the cloud sits in haze
      // rather than in front of it or behind it entirely.
      expect(plan.fog.near, shape).toBeLessThan(DEFAULT_VIEW_DISTANCE)
      expect(plan.fog.far, shape).toBeGreaterThan(DEFAULT_VIEW_DISTANCE)
    }
  })

  it('scales the fog band with the extent — a wider run fogs further out', () => {
    const wide = buildEnvironmentPlan(fixture('handoff-chain').run)
    const tight = buildEnvironmentPlan(fixture('loop').run)
    expect(wide.extentRadius).toBeGreaterThan(tight.extentRadius)
    expect(wide.fog.near).toBeLessThan(tight.fog.near)
    expect(wide.fog.far).toBeGreaterThan(tight.fog.far)
  })

  it('lights the scene with a four-light rig derived from the extent', () => {
    const plan = buildEnvironmentPlan(fixture('fan-out').run)
    const { ambient, hemisphere, key, rim } = plan.lights
    for (const light of [ambient, key, rim]) {
      expect(light.intensity).toBeGreaterThan(0)
      expect(luminanceOf(light.color)).toBeGreaterThan(0)
      expect(isHexColor(light.hex)).toBe(true)
    }
    expect(hemisphere.intensity).toBeGreaterThan(0)
    expect(luminanceOf(hemisphere.sky)).toBeGreaterThan(luminanceOf(hemisphere.ground))

    // Directions are unit vectors from spherical angles, never hand-placed.
    for (const light of [key, rim]) {
      const length = Math.hypot(light.direction.x, light.direction.y, light.direction.z)
      expect(length).toBeCloseTo(1, 12)
      const offsetLength = Math.hypot(light.offset.x, light.offset.y, light.offset.z)
      expect(offsetLength).toBeCloseTo(plan.extentRadius * 3.5, 12)
    }
    // Key and rim come from different sides, or the rig would be flat.
    expect(key.direction.x).not.toBeCloseTo(rim.direction.x, 3)
  })

  it('turns on bloom only when there is something that can bloom', () => {
    const withRun = buildEnvironmentPlan(fixture('loop').run)
    expect(withRun.bloom.enabled).toBe(true)
    expect(withRun.bloom.luminanceThreshold).toBe(withRun.calibration.bloomThreshold)
    expect(withRun.postProcessPasses).toBe(ENVIRONMENT_POST_PROCESS_PASSES)

    const empty = buildEnvironmentPlan()
    expect(empty.bloom.enabled).toBe(false)
    expect(empty.postProcessPasses).toBe(0)
    expect(empty.bounds).toBeNull()
    expect(empty.seed).toBeNull()
    expect(empty.settlement).toBeNull()
    expect(empty.extentRadius).toBeGreaterThan(0)
    expect(empty.fog.far).toBeGreaterThan(empty.fog.near)
    expect(empty.backgroundHex).toBe(DEFAULT_BACKGROUND_HEX)
  })

  it('adds no bloom pass to a scene with no extent, even when a layout is reused', () => {
    // A reused layout still yields bounds, so "bounds !== null" is not enough:
    // a cloud of radius 0 has no hot region to bloom, and paying for the pass
    // would be cost with no image (the M3-T5 measurement surfaced this).
    const empty = normalizeTrace(parseAgentMessagesExport([], { label: 'empty' }))
    const { layout } = settleLayout(empty)
    expect(layout.bounds.radius).toBe(0)
    const plan = buildEnvironmentPlan(empty, { layout })
    expect(plan.bounds).not.toBeNull()
    expect(plan.bloom.enabled).toBe(false)
    expect(plan.postProcessPasses).toBe(0)
  })

  it('costs no draw call — lights and fog are not geometry', () => {
    expect(ENVIRONMENT_DRAW_CALLS).toBe(0)
    expect(buildEnvironmentPlan(fixture('fan-out').run).drawCalls).toBe(0)
    expect(buildEnvironmentPlan().drawCalls).toBe(0)
  })

  it('reuses a layout another layer already settled', () => {
    const model = fixture('dead-branch').run
    const settled = settleLayout(model)
    const reused = buildEnvironmentPlan(model, { layout: settled.layout })
    const own = buildEnvironmentPlan(model)
    expect(reused.bounds).toEqual(own.bounds)
    expect(reused.seed).toBe(own.seed)
    expect(reused.extentRadius).toBeCloseTo(own.extentRadius, 12)
    // Reusing means the rig did not settle a second time.
    expect(reused.settlement).toBeNull()
  })

  it('sanitizes rig overrides instead of emitting nonsense', () => {
    const plan = buildEnvironmentPlan(fixture('loop').run, {
      rig: {
        backgroundHex: 'not-a-colour',
        fogHex: '#abc',
        viewDistance: Number.NaN,
        fov: 500,
        ambient: { intensity: -2, hex: '#123456' },
        key: { intensity: 3, azimuthDeg: 90, elevationDeg: 10 },
        bloom: { intensity: 2, radius: 5, luminanceSmoothing: -1 },
      },
    })
    expect(plan.backgroundHex).toBe(DEFAULT_BACKGROUND_HEX)
    expect(plan.fog.hex).toBe('#abc')
    expect(plan.viewDistance).toBe(DEFAULT_VIEW_DISTANCE)
    expect(plan.fov).toBe(179)
    expect(plan.lights.ambient.intensity).toBe(0)
    expect(plan.lights.ambient.hex).toBe('#123456')
    expect(plan.lights.key.intensity).toBe(3)
    expect(plan.lights.key.offset.y).toBeGreaterThan(0)
    expect(plan.bloom.intensity).toBe(2)
    expect(plan.bloom.radius).toBe(1)
    expect(plan.bloom.luminanceSmoothing).toBe(0)
    expect(luminanceOf(plan.fog.color)).toBeGreaterThan(0)
  })

  it('honours an explicit exposure in the plan and in the calibration', () => {
    const plan = buildEnvironmentPlan(fixture('loop').run, { rig: { exposure: 1.5 } })
    expect(plan.exposure).toBe(1.5)
    expect(plan.calibration.exposure).toBe(1.5)
    expect(plan.bloom.luminanceThreshold).toBe(plan.calibration.bloomThreshold)
  })

  it('is deterministic — the same trace yields a byte-identical plan', () => {
    for (const { run, shape } of FIXTURES) {
      const first = buildEnvironmentPlan(run)
      const second = buildEnvironmentPlan(run)
      expect(JSON.stringify(second), shape).toBe(JSON.stringify(first))
    }
  })
})

// ── purity guard ────────────────────────────────────────────────────────────

/** Walk up from cwd until the package manifest is found. */
function findRepoRoot(start: string): string {
  let dir = start
  for (;;) {
    if (existsSync(resolve(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('package.json not found above cwd')
    dir = parent
  }
}

describe('environment rig — purity (M3-T4)', () => {
  const root = findRepoRoot(process.cwd())
  const modules = [
    'src/scene/environment.ts',
    'src/scene/color.ts',
    'src/scene/toneMapping.ts',
  ]
  const sources = modules.map((relative) => ({
    relative,
    source: readFileSync(resolve(root, relative), 'utf8')
      // Drop comments so the modules' own prose cannot trip the scan.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, ''),
  }))

  it('reads no clock and no randomness', () => {
    for (const { relative, source } of sources) {
      expect(source, relative).not.toMatch(/\bDate\.now\s*\(/)
      expect(source, relative).not.toMatch(/\bperformance\.now\s*\(/)
      expect(source, relative).not.toMatch(/\bMath\.random\s*\(/)
    }
  })

  it('is data-layer code — no three.js and no DOM', () => {
    for (const { relative, source } of sources) {
      expect(source, relative).not.toMatch(/from ['"]three['"]/)
      expect(source, relative).not.toMatch(/@react-three/)
      expect(source, relative).not.toMatch(/\bdocument\./)
      expect(source, relative).not.toMatch(/\bwindow\./)
      expect(source, relative).not.toMatch(/\bnew\s+Vector3\b/)
    }
  })

  it('authors no coordinates — the rig derives every offset from the extent', () => {
    for (const { relative, source } of sources) {
      expect(findHandAuthoredCoordinates(source), relative).toEqual([])
    }
  })

  it('shares one tone curve with the rig — the calibration is not a second model', () => {
    const environment = sources[0].source
    expect(environment).toMatch(/\binverseAcesFilmic\b/)
    // The plan's exposure is the calibration's, not an independent constant.
    expect(environment).toMatch(/exposure:\s*calibration\.exposure/)
  })

  it('keeps the node plan fed from this calibration rather than its own curve', () => {
    const nodes = readFileSync(resolve(root, 'src/scene/nodes.ts'), 'utf8')
    expect(nodes).toMatch(/\bglowRadiance\b/)
    expect(nodes).toMatch(/\bglowColor\b/)
    expect(nodes).toMatch(/DEFAULT_EMISSIVE_CALIBRATION/)
  })
})
