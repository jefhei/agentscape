import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
