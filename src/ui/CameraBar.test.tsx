import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { buildFixture } from '../fixtures/index.ts'
import { buildScenePlan } from '../scene/scenePlan.ts'
import { describeCamera } from '../camera/cameraState.ts'
import { createFlyCamera } from '../camera/fly.ts'
import { cameraModeHint } from '../camera/modes.ts'
import type { CameraMode } from '../camera/modes.ts'
import {
  ORBIT_MAX_ZOOM,
  ORBIT_MIN_ZOOM,
  createOrbitCamera,
  orbitBy,
  setOrbitZoom,
} from '../camera/orbit.ts'
import CameraBar from './CameraBar.tsx'
import type { CameraBarProps } from './CameraBar.tsx'

/**
 * Wiring tests for the camera bar (M4-T2, two modes since M4-T3).
 *
 * The bar decides nothing: it renders the pure readout and dispatches one control
 * per button. jsdom has no layout, so nothing here is asserted for how it *looks*
 * (M5-T5); what is asserted is that every control of the active mode exists, that it
 * dispatches the transition it claims, that the mode chip really is the switch, and
 * that a dolly limit disables the button it should.
 */

const PLAN = buildScenePlan(buildFixture('fan-out').run)
const EXTENT = PLAN.environment.extentRadius
const ORBIT = createOrbitCamera(PLAN.camera, EXTENT)
const FLY = createFlyCamera(PLAN.camera, EXTENT)

afterEach(() => {
  cleanup()
})

function renderBar(
  mode: CameraMode = 'orbit',
  overrides: Partial<CameraBarProps> = {},
) {
  const onZoom = vi.fn()
  const onAdvance = vi.fn()
  const onReset = vi.fn()
  const onToggleMode = vi.fn()
  render(
    <CameraBar
      readout={describeCamera(mode, ORBIT, FLY)}
      hint={cameraModeHint(mode)}
      onToggleMode={onToggleMode}
      onZoom={onZoom}
      onAdvance={onAdvance}
      onReset={onReset}
      canZoomIn
      canZoomOut
      {...overrides}
    />,
  )
  return { onZoom, onAdvance, onReset, onToggleMode }
}

describe('CameraBar — the mode chip is the switch (M4-T3)', () => {
  it('labels the active mode', () => {
    renderBar()
    expect(screen.getByTestId('camera-bar')).toBeInTheDocument()
    expect(screen.getByTestId('camera-mode')).toHaveTextContent('Orbit')
    expect(screen.getByTestId('camera-mode')).toHaveAttribute('data-mode', 'orbit')
  })

  it('offers the other mode and dispatches the switch', () => {
    const { onToggleMode } = renderBar()
    const chip = screen.getByTestId('camera-mode')
    expect(chip).toHaveAccessibleName('Switch to fly camera')
    expect(chip.tagName).toBe('BUTTON')
    fireEvent.click(chip)
    expect(onToggleMode).toHaveBeenCalledTimes(1)
  })

  it('offers orbit while flying', () => {
    const { onToggleMode } = renderBar('fly')
    const chip = screen.getByTestId('camera-mode')
    expect(chip).toHaveTextContent('Fly')
    expect(chip).toHaveAttribute('data-mode', 'fly')
    expect(chip).toHaveAccessibleName('Switch to orbit camera')
    fireEvent.click(chip)
    expect(onToggleMode).toHaveBeenCalledTimes(1)
  })
})

describe('CameraBar — orbit readout and controls (M4-T2)', () => {
  it('prints the orbit’s angles, distance and dolly', () => {
    renderBar()
    expect(screen.getByTestId('camera-azimuth')).toHaveTextContent('90°')
    expect(screen.getByTestId('camera-elevation')).toHaveTextContent('18°')
    expect(screen.getByTestId('camera-distance')).toHaveTextContent(
      PLAN.camera.distance.toFixed(1),
    )
    expect(screen.getByTestId('camera-zoom')).toHaveTextContent('1.00×')
  })

  it('follows the state it is given', () => {
    const moved = setOrbitZoom(orbitBy(ORBIT, { dxPx: -40, dyPx: -10 }), 1.5)
    renderBar('orbit', { readout: describeCamera('orbit', moved, FLY) })
    expect(screen.getByTestId('camera-azimuth')).toHaveTextContent('101°')
    expect(screen.getByTestId('camera-elevation')).toHaveTextContent('15°')
    expect(screen.getByTestId('camera-zoom')).toHaveTextContent('1.50×')
  })

  it('dispatches a dolly step in and out', () => {
    const { onZoom } = renderBar()
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(onZoom).toHaveBeenLastCalledWith(1)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(onZoom).toHaveBeenLastCalledWith(-1)
    expect(onZoom).toHaveBeenCalledTimes(2)
  })

  it('disables the zoom-in button at the near end of the dolly range', () => {
    renderBar('orbit', {
      readout: describeCamera('orbit', setOrbitZoom(ORBIT, ORBIT_MAX_ZOOM), FLY),
      canZoomIn: false,
    })
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled()
  })

  it('disables the zoom-out button at the far end of the dolly range', () => {
    renderBar('orbit', {
      readout: describeCamera('orbit', setOrbitZoom(ORBIT, ORBIT_MIN_ZOOM), FLY),
      canZoomOut: false,
    })
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled()
  })

  it('offers no flight controls while orbiting', () => {
    renderBar()
    expect(screen.queryByRole('button', { name: 'Fly forward' })).toBeNull()
    expect(screen.queryByTestId('camera-heading')).toBeNull()
  })
})

describe('CameraBar — fly readout and controls (M4-T3)', () => {
  it('prints the heading, pitch and altitude', () => {
    renderBar('fly')
    expect(screen.getByTestId('camera-heading')).toHaveTextContent('270°')
    expect(screen.getByTestId('camera-pitch')).toHaveTextContent('-18°')
    expect(screen.getByTestId('camera-altitude')).toHaveTextContent(
      (FLY.position.y - FLY.home.y).toFixed(1),
    )
    // The orbit-only numbers belong to the other mode.
    expect(screen.queryByTestId('camera-azimuth')).toBeNull()
    expect(screen.queryByTestId('camera-zoom')).toBeNull()
  })

  it('dispatches forward and back flight', () => {
    const { onAdvance } = renderBar('fly')
    fireEvent.click(screen.getByRole('button', { name: 'Fly forward' }))
    expect(onAdvance).toHaveBeenLastCalledWith(1)
    fireEvent.click(screen.getByRole('button', { name: 'Fly back' }))
    expect(onAdvance).toHaveBeenLastCalledWith(-1)
    expect(onAdvance).toHaveBeenCalledTimes(2)
  })

  it('offers no dolly controls while flying', () => {
    renderBar('fly')
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Zoom out' })).toBeNull()
  })
})

describe('CameraBar — shared controls and hint (M4-T3)', () => {
  it('dispatches a reset from either mode', () => {
    for (const mode of ['orbit', 'fly'] as const) {
      const { onReset } = renderBar(mode)
      fireEvent.click(screen.getByRole('button', { name: 'Reset view' }))
      expect(onReset).toHaveBeenCalledTimes(1)
      cleanup()
    }
  })

  it('prints the hint for the active mode', () => {
    renderBar()
    expect(screen.getByTestId('camera-hint')).toHaveTextContent('drag to orbit')
    cleanup()
    renderBar('fly')
    expect(screen.getByTestId('camera-hint')).toHaveTextContent('WASD')
  })

  it('keeps every control a real, labelled button (keyboard reachable)', () => {
    for (const mode of ['orbit', 'fly'] as const) {
      renderBar(mode)
      for (const button of screen.getAllByRole('button')) {
        expect(button.tagName).toBe('BUTTON')
        expect(button).toHaveAttribute('type', 'button')
        expect(button).toHaveAccessibleName()
      }
      cleanup()
    }
  })
})
