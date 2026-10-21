import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { buildFixture } from '../fixtures/index.ts'
import { buildScenePlan } from '../scene/scenePlan.ts'
import {
  ORBIT_MAX_ZOOM,
  ORBIT_MIN_ZOOM,
  createOrbitCamera,
  orbitBy,
  setOrbitZoom,
} from '../camera/orbit.ts'
import CameraBar from './CameraBar.tsx'

/**
 * Wiring tests for the camera bar (M4-T2).
 *
 * The bar decides nothing: it renders the pure readout and dispatches one control
 * per button. jsdom has no layout, so nothing here is asserted for how it *looks*
 * (M5-T5); what is asserted is that every control exists, that it dispatches the
 * transition it claims, that it reflects the state it is given, and that a dolly
 * limit really disables the button.
 */

const PLAN = buildScenePlan(buildFixture('fan-out').run)
const OPENING = createOrbitCamera(PLAN.camera, PLAN.environment.extentRadius)

function renderBar(
  orbit = OPENING,
  overrides: Partial<Parameters<typeof CameraBar>[0]> = {},
) {
  const onZoom = vi.fn()
  const onReset = vi.fn()
  render(
    <CameraBar
      mode="orbit"
      orbit={orbit}
      onZoom={onZoom}
      onReset={onReset}
      canZoomIn
      canZoomOut
      {...overrides}
    />,
  )
  return { onZoom, onReset }
}

describe('CameraBar (M4-T2)', () => {
  it('labels the active mode', () => {
    renderBar()
    expect(screen.getByTestId('camera-bar')).toBeInTheDocument()
    expect(screen.getByTestId('camera-mode')).toHaveTextContent('Orbit')
    expect(screen.getByTestId('camera-mode')).toHaveAttribute('data-mode', 'orbit')
  })

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
    renderBar(setOrbitZoom(orbitBy(OPENING, { dxPx: -40, dyPx: -10 }), 1.5))
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

  it('dispatches a reset', () => {
    const { onReset } = renderBar()
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('disables the zoom-in button at the near end of the dolly range', () => {
    renderBar(setOrbitZoom(OPENING, ORBIT_MAX_ZOOM), { canZoomIn: false })
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled()
  })

  it('disables the zoom-out button at the far end of the dolly range', () => {
    renderBar(setOrbitZoom(OPENING, ORBIT_MIN_ZOOM), { canZoomOut: false })
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled()
  })

  it('keeps every control a real, labelled button (keyboard reachable)', () => {
    renderBar()
    for (const name of ['Zoom in', 'Zoom out', 'Reset view']) {
      const button = screen.getByRole('button', { name })
      expect(button.tagName).toBe('BUTTON')
      expect(button).toHaveAttribute('type', 'button')
    }
  })
})
