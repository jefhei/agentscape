import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findHandAuthoredCoordinates } from '../layout/index.ts'
import {
  CAMERA_MODE_LABELS,
  CAMERA_MODES,
  cameraModeHint,
  cameraModeSwitchLabel,
  isCameraMode,
  nextCameraMode,
} from './modes.ts'
import type { CameraMode } from './modes.ts'

/**
 * Tests for the camera mode vocabulary (M4-T3).
 *
 * Small module, load-bearing job: it is the only place that says which modes exist
 * and what the switch offers, so the two pose modules and the UI cannot disagree.
 * The hint and the switch label are rules (the gesture really does differ per mode),
 * so they are pinned here rather than left to the component's copy.
 */

describe('the mode union (M4-T3)', () => {
  it('has exactly the two modes this build implements', () => {
    expect(CAMERA_MODES).toEqual(['orbit', 'fly'])
    expect(CAMERA_MODE_LABELS.orbit).toBe('Orbit')
    expect(CAMERA_MODE_LABELS.fly).toBe('Fly')
    // Every mode has a label — the bar prints it in a chip.
    for (const mode of CAMERA_MODES) {
      expect(CAMERA_MODE_LABELS[mode].length).toBeGreaterThan(0)
    }
  })

  it('recognizes its own modes and rejects anything else', () => {
    expect(isCameraMode('orbit')).toBe(true)
    expect(isCameraMode('fly')).toBe(true)
    expect(isCameraMode('walk')).toBe(false)
    expect(isCameraMode('')).toBe(false)
    expect(isCameraMode(null)).toBe(false)
    expect(isCameraMode(undefined)).toBe(false)
    expect(isCameraMode({ mode: 'fly' })).toBe(false)
  })

  it('switches orbit ↔ fly, and round-trips', () => {
    expect(nextCameraMode('orbit')).toBe('fly')
    expect(nextCameraMode('fly')).toBe('orbit')
    expect(nextCameraMode(nextCameraMode('orbit'))).toBe('orbit')
  })

  it('offers the other mode as the switch action', () => {
    expect(cameraModeSwitchLabel('orbit')).toBe('Fly')
    expect(cameraModeSwitchLabel('fly')).toBe('Orbit')
    // The label names the destination, never the current mode.
    for (const mode of CAMERA_MODES) {
      expect(cameraModeSwitchLabel(mode)).not.toBe(CAMERA_MODE_LABELS[mode])
    }
  })
})

describe('the mode hint (M4-T3)', () => {
  it('describes a different gesture per mode', () => {
    const orbit = cameraModeHint('orbit')
    const fly = cameraModeHint('fly')
    expect(orbit).not.toBe(fly)
    expect(orbit).toMatch(/orbit/i)
    expect(fly).toMatch(/fly/i)
  })

  it('names the keys that actually move the fly camera', () => {
    // The hint is documentation the viewer reads: it must not promise controls the
    // rig does not bind.
    expect(cameraModeHint('fly')).toMatch(/WASD/)
    expect(cameraModeHint('fly')).toMatch(/drag/)
    expect(cameraModeHint('orbit')).toMatch(/drag/)
    expect(cameraModeHint('orbit')).toMatch(/scroll/)
  })

  it('is a pure function of the mode', () => {
    const first = cameraModeHint('fly')
    const second = cameraModeHint('fly')
    expect(first).toBe(second)
  })
})

describe('purity (M4-T3)', () => {
  it('imports nothing and reads no clock, randomness, three.js or DOM', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/camera/modes.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    // A leaf module: every pose rule imports *it*, so it may not import anything.
    expect(code).not.toMatch(/\bfrom\s+'\.\//)
    expect(code).not.toMatch(/\bfrom\s+'\.\.\//)
    expect(code).not.toMatch(/\bDate\.now\s*\(/)
    expect(code).not.toMatch(/\bMath\.random\s*\(/)
    expect(code).not.toMatch(/from\s+'three'/)
    expect(code).not.toMatch(/\bdocument\./)
    expect(code).not.toMatch(/\bwindow\./)
    expect(findHandAuthoredCoordinates(code)).toEqual([])
  })
})

describe('the mode type is exhaustive (M4-T3)', () => {
  it('switches on every mode without a fallthrough', () => {
    // A compile-time guard: if a third mode is added, this record stops compiling
    // and the implementer is forced to give it a hint and a label.
    const labels: Record<CameraMode, string> = { orbit: 'Orbit', fly: 'Fly' }
    expect(Object.keys(labels).sort()).toEqual([...CAMERA_MODES].sort())
    expect(labels).toEqual(CAMERA_MODE_LABELS)
  })
})
