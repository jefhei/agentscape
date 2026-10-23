import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import App, { MOUNTED_RUN } from './App'
import { DRAW_CALL_CEILING } from './scene/index.ts'

/**
 * jsdom has no WebGL, so the real R3F <Canvas> cannot mount in tests. Swap it
 * for a stub that renders a <canvas> element and fires `onCreated` on mount —
 * enough to prove the shell mounts a viewport and the renderer boot path runs
 * (the `ready` chip depends on it). This is the same split the whole project
 * rests on: the data layer is gated hard in jsdom, the render layer is a thin
 * consumer that only gets wiring tests, and the actual look is human-held
 * (M5-T5).
 */
vi.mock('@react-three/fiber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-three/fiber')>()
  const { useEffect, createElement } = await import('react')
  return {
    ...actual,
    Canvas: ({ onCreated }: { onCreated?: () => void }) => {
      useEffect(() => {
        onCreated?.()
      }, [onCreated])
      return createElement('canvas', { 'data-testid': 'viewport-canvas' })
    },
  }
})

describe('App shell (M1-T1)', () => {
  it('renders the project title and thesis in the header', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'AgentScape' })).toBeInTheDocument()
    expect(
      screen.getByText('3D spatial trace visualizer for multi-agent AI runs'),
    ).toBeInTheDocument()
  })

  it('mounts the 3D viewport with an R3F canvas inside the main area', () => {
    render(<App />)
    const main = screen.getByRole('main')
    const viewport = screen.getByTestId('viewport')
    expect(viewport).toBeInTheDocument()
    expect(main).toContainElement(viewport)
    expect(screen.getByTestId('viewport-canvas')).toBeInTheDocument()
  })

  it('flips to "ready" when the renderer boot callback fires', async () => {
    render(<App />)
    // The mock Canvas fires onCreated on mount; the chip proves the boot path
    // — renderer created — reached React state.
    expect(await screen.findByTestId('viewport-ready')).toHaveTextContent(
      'viewport ready',
    )
  })

  it('mounts a fixture trace end to end (M3-T6)', () => {
    render(<App />)
    const viewport = screen.getByTestId('viewport')
    // The run really reached the renderer: the id is the fixture's, and the
    // fixture is a product of the real ingest path, not a hand-built Run.
    expect(viewport).toHaveAttribute('data-run-id', MOUNTED_RUN.id)
    expect(MOUNTED_RUN.source).toBe('agent_messages')
    expect(MOUNTED_RUN.label.startsWith('fixture:')).toBe(true)
    expect(MOUNTED_RUN.meta.agentCount).toBeGreaterThan(0)
    // ...and the scene composed for it is inside the geometry budget.
    expect(viewport).toHaveAttribute('data-draw-calls', String(DRAW_CALL_CEILING))
  })

  it('mounts the playback transport over the scene (M4-T1)', () => {
    render(<App />)
    const main = screen.getByRole('main')
    expect(main).toContainElement(screen.getByTestId('transport'))
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
    // The run opens paused at 0, so the scene is at its opening reveal.
    expect(screen.getByTestId('viewport')).toHaveAttribute('data-playback-elapsed', '0')
    expect(screen.getByTestId('viewport')).toHaveAttribute('data-reveal-arcs', '1')
    expect(screen.getByTestId('viewport')).toHaveAttribute('data-reveal-glyphs', '1')
  })

  it('drives the scene from the transport: stepping reveals the next event (M4-T1)', () => {
    render(<App />)
    const viewport = screen.getByTestId('viewport')
    // A step is a scene action, not a UI decoration: the playhead moves, and the
    // viewport reports the reveal it was handed at that instant. (Stepping never
    // starts the clock, so this stays deterministic in jsdom.)
    fireEvent.click(screen.getByRole('button', { name: 'Next event' }))
    expect(viewport).toHaveAttribute('data-playback-elapsed', '60000')
    // A second link now has traffic, and a second glyph has fired.
    expect(viewport).toHaveAttribute('data-reveal-arcs', '2')
    expect(viewport).toHaveAttribute('data-reveal-glyphs', '2')

    fireEvent.click(screen.getByRole('button', { name: 'Previous event' }))
    expect(viewport).toHaveAttribute('data-playback-elapsed', '0')
  })

  it('mounts the orbit camera over the scene and reports its state (M4-T2)', () => {
    render(<App />)
    const viewport = screen.getByTestId('viewport')
    expect(screen.getByTestId('camera-bar')).toBeInTheDocument()
    expect(screen.getByTestId('camera-mode')).toHaveTextContent('Orbit')
    // The viewport reports the camera it is driving the renderer with, derived
    // from the scene plan's own opening shot.
    expect(viewport).toHaveAttribute('data-camera-mode', 'orbit')
    expect(viewport).toHaveAttribute('data-camera-azimuth', '90')
    expect(viewport).toHaveAttribute('data-camera-elevation', '18')
    expect(viewport).toHaveAttribute('data-camera-distance', '12.000')
  })

  it('dollies the camera from the camera bar (M4-T2)', () => {
    render(<App />)
    const viewport = screen.getByTestId('viewport')
    // One dolly step closer at the orbit model's own step size: the camera bar
    // dispatches a transition, the hook holds it, and the viewport reports the
    // resulting framing — the whole camera path, headlessly.
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(viewport).toHaveAttribute('data-camera-distance', (12 / 1.15).toFixed(3))
    expect(screen.getByTestId('camera-zoom')).toHaveTextContent('1.15×')
    // ...and azimuth is untouched by a dolly.
    expect(viewport).toHaveAttribute('data-camera-azimuth', '90')

    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }))
    expect(viewport).toHaveAttribute('data-camera-distance', '12.000')
    expect(screen.getByTestId('camera-zoom')).toHaveTextContent('1.00×')
  })

  it('mounts the inspector closed, with nothing selected (M4-T4)', () => {
    render(<App />)
    // The panel is a selection's consequence: with no node clicked there is no
    // panel and the viewport reports no selected agent. (The click path itself
    // needs WebGL raycasting, so it is verified in a browser probe, not here.)
    expect(screen.queryByTestId('detail-panel')).toBeNull()
    expect(screen.getByTestId('viewport')).not.toHaveAttribute('data-selected-agent')
  })
})
