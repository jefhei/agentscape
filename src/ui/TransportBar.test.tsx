import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { buildFixture } from '../fixtures/index.ts'
import { buildScrubber, createPlayback, reducePlayback } from '../playback/playback.ts'
import type { PlaybackState } from '../playback/playback.ts'
import TransportBar from './TransportBar.tsx'

/**
 * Wiring tests for the transport bar (M4-T1).
 *
 * The bar decides nothing — every rule lives in the pure reducer — so what is
 * asserted here is exactly the wiring: the right controls exist, they dispatch
 * the right actions, they reflect the state they are handed, and the readout is
 * the pure one. The look is human-held (M5-T5).
 */

const RUN = buildFixture('fan-out').run
const MINUTE = 60_000

/** Render the bar for `state` with a recording dispatch. */
function renderBar(state: PlaybackState = createPlayback(RUN)) {
  const onAction = vi.fn()
  render(
    <TransportBar
      state={state}
      scrubber={buildScrubber(state.timeline)}
      onAction={onAction}
    />,
  )
  return onAction
}

describe('TransportBar — controls (M4-T1)', () => {
  it('renders one labelled transport group with a play control', () => {
    renderBar()
    expect(screen.getByTestId('transport')).toHaveAccessibleName('Playback')
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
  })

  it('shows pause (and hides play) while running', () => {
    renderBar(reducePlayback(createPlayback(RUN), { type: 'play' }))
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull()
  })

  it('dispatches play/pause, step, speed and restart', () => {
    const onAction = renderBar()
    fireEvent.click(screen.getByTestId('transport-toggle'))
    expect(onAction).toHaveBeenCalledWith({ type: 'togglePlay' })

    fireEvent.click(screen.getByTestId('transport-step-backward'))
    expect(onAction).toHaveBeenCalledWith({ type: 'stepBackward' })

    fireEvent.click(screen.getByTestId('transport-step-forward'))
    expect(onAction).toHaveBeenCalledWith({ type: 'stepForward' })

    fireEvent.click(screen.getByTestId('transport-faster'))
    expect(onAction).toHaveBeenCalledWith({ type: 'faster' })

    fireEvent.click(screen.getByTestId('transport-slower'))
    expect(onAction).toHaveBeenCalledWith({ type: 'slower' })

    fireEvent.click(screen.getByTestId('transport-restart'))
    expect(onAction).toHaveBeenCalledWith({ type: 'restart' })
  })

  it('disables step-forward at the end of the run', () => {
    const finished = reducePlayback(createPlayback(RUN), { type: 'finish' })
    renderBar(finished)
    expect(screen.getByRole('button', { name: 'Next event' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous event' })).toBeEnabled()
  })
})

describe('TransportBar — the scrubber (M4-T1)', () => {
  it('reflects the playhead and spans the whole run', () => {
    const state = reducePlayback(createPlayback(RUN), {
      type: 'seek',
      elapsedMs: 2 * MINUTE,
    })
    renderBar(state)
    const slider = screen.getByRole('slider', { name: 'Trace position' })
    expect(slider).toHaveValue('120000')
    expect(slider).toHaveAttribute('max', String(4 * MINUTE))
    expect(slider).toHaveAttribute('min', '0')
  })

  it('announces its position as text, not as milliseconds', () => {
    const state = reducePlayback(createPlayback(RUN), {
      type: 'seek',
      elapsedMs: MINUTE,
    })
    renderBar(state)
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      '1:00 of 4:00, 5 of 12 events',
    )
  })

  it('dispatches a seek with the chosen position', () => {
    const onAction = renderBar()
    fireEvent.change(screen.getByTestId('transport-scrubber'), {
      target: { value: String(3 * MINUTE) },
    })
    expect(onAction).toHaveBeenCalledWith({ type: 'seek', elapsedMs: 3 * MINUTE })
  })

  it('draws one mark per (thinned) event instant and one bar per density bucket', () => {
    const { container } = render(
      <TransportBar
        state={createPlayback(RUN)}
        scrubber={buildScrubber(createPlayback(RUN).timeline, {
          maxMarks: 3,
          buckets: 8,
        })}
        onAction={() => undefined}
      />,
    )
    expect(container.querySelectorAll('.transport-mark')).toHaveLength(3)
    expect(container.querySelectorAll('.transport-bucket')).toHaveLength(8)
    // The decoration is not semantics: the slider carries the position.
    expect(screen.getByTestId('transport-marks')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('transport-density')).toHaveAttribute(
      'aria-hidden',
      'true',
    )
  })

  it('keeps the slider usable on a zero-span run', () => {
    const state = createPlayback(RUN)
    const instant: PlaybackState = {
      timeline: {
        ...state.timeline,
        stops: [state.timeline.startedAt],
        endedAt: state.timeline.startedAt,
        spanMs: 0,
      },
      playhead: { elapsedMs: 0, speed: 1, playing: false },
    }
    renderBar(instant)
    const slider = screen.getByRole('slider')
    expect(slider).toHaveAttribute('max', '1')
    expect(slider).toHaveValue('0')
  })
})

describe('TransportBar — readout (M4-T1)', () => {
  it('prints the position, the event count and the live agents', () => {
    const state = reducePlayback(createPlayback(RUN), {
      type: 'seek',
      elapsedMs: MINUTE,
    })
    renderBar(state)
    expect(screen.getByTestId('transport-time')).toHaveTextContent('1:00 / 4:00')
    expect(screen.getByTestId('transport-events')).toHaveTextContent('5 / 12 events')
    // At t=1min the orchestrator has touched alpha and beta.
    expect(screen.getByTestId('transport-agents')).toHaveTextContent('3 / 6 agents')
    expect(screen.getByTestId('transport-speed')).toHaveTextContent('1×')
  })

  it('reports the speed the playhead is running at', () => {
    const state = reducePlayback(createPlayback(RUN), { type: 'faster' })
    renderBar(state)
    expect(screen.getByTestId('transport-speed')).toHaveTextContent('2×')
  })
})
