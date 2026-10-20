import type { ChangeEvent } from 'react'
import { describePlayback } from '../playback/playback.ts'
import type { PlaybackAction, PlaybackState, Scrubber } from '../playback/playback.ts'

/**
 * The playback transport bar (M4-T1) — the render half.
 *
 * A deliberately dumb component: it renders the state the pure transport
 * ({@link describePlayback}, `src/playback/playback.ts`) hands it and dispatches
 * an action for every control. It decides no rule — not whether a step pauses,
 * not what play does at the end, not what 40% of the track means — because those
 * are the reducer's, and the reducer is unit-tested.
 *
 * ## What it is, and what it is not
 *
 * It is the **transport for the spatial scene**: its position drives
 * `src/scene/reveal.ts`, so dragging the scrubber lights the 3D scene up in run
 * order. It is not a transcript view and carries no event log — a linear replay
 * surface is exactly what this product is not (PRD §8).
 *
 * ## Composition
 *
 * Left to right: step back · play/pause · step forward, then the track (density
 * histogram, event marks, slider), then the readout (time, events, live agents),
 * then speed and restart. The track's decoration is `aria-hidden` — the slider
 * is the semantics — and the slider announces its own position as text via
 * `aria-valuetext`, so a screen reader gets "1.0s of 4:00, 3 of 12 events"
 * rather than a bare milliseconds number.
 *
 * ## Not gated, by design
 *
 * jsdom has no GPU and no layout, so nothing here is asserted for how it *looks*
 * (that is M5-T5); the tests assert the wiring: the controls exist, they
 * dispatch the right actions, they reflect the state they are given, and the
 * readout is the pure one.
 */
export interface TransportBarProps {
  /** The transport state to render. */
  state: PlaybackState
  /** The scrubber geometry for this state's timeline (memoized by `usePlayback`). */
  scrubber: Scrubber
  /** Dispatch one transport action. */
  onAction: (action: PlaybackAction) => void
}

/** Round a duration to the integer milliseconds a range input accepts. */
function sliderValue(state: PlaybackState): number {
  return Math.round(
    Math.min(Math.max(state.playhead.elapsedMs, 0), state.timeline.spanMs),
  )
}

export default function TransportBar({ state, scrubber, onAction }: TransportBarProps) {
  const readout = describePlayback(state)
  const span = Math.round(readout.spanMs)
  // A range input rejects max === min, so a zero-span run gets a 1ms track with
  // the thumb pinned at 0 — the slider still announces the right position text.
  const max = Math.max(1, span)

  const onScrub = (event: ChangeEvent<HTMLInputElement>): void => {
    onAction({ type: 'seek', elapsedMs: Number(event.currentTarget.value) })
  }

  return (
    <section className="transport" data-testid="transport" aria-label="Playback">
      <div className="transport-controls">
        <button
          type="button"
          className="transport-button"
          data-testid="transport-step-backward"
          aria-label="Previous event"
          title="Previous event (←)"
          onClick={() => onAction({ type: 'stepBackward' })}
        >
          ⏮
        </button>
        <button
          type="button"
          className="transport-button transport-button-play"
          data-testid="transport-toggle"
          aria-label={readout.playing ? 'Pause' : 'Play'}
          title={readout.playing ? 'Pause (space)' : 'Play (space)'}
          onClick={() => onAction({ type: 'togglePlay' })}
        >
          {readout.playing ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          className="transport-button"
          data-testid="transport-step-forward"
          aria-label="Next event"
          title="Next event (→)"
          disabled={readout.atEnd}
          onClick={() => onAction({ type: 'stepForward' })}
        >
          ⏭
        </button>
      </div>

      <div className="transport-track">
        <div
          className="transport-density"
          data-testid="transport-density"
          aria-hidden="true"
        >
          {scrubber.buckets.map((density, index) => (
            <span
              // Buckets are positional, not identified: the index IS the identity.
              key={index}
              className="transport-bucket"
              style={{ height: `${Math.round(density * 100)}%` }}
            />
          ))}
        </div>
        <div
          className="transport-marks"
          data-testid="transport-marks"
          aria-hidden="true"
        >
          {scrubber.marks.map((mark) => (
            <span
              key={mark.elapsedMs}
              className="transport-mark"
              style={{ left: `${mark.fraction * 100}%` }}
            />
          ))}
        </div>
        <input
          type="range"
          className="transport-range"
          data-testid="transport-scrubber"
          aria-label="Trace position"
          aria-valuetext={`${readout.elapsedLabel} of ${readout.spanLabel}, ${readout.firedCount} of ${readout.eventCount} events`}
          min={0}
          max={max}
          step={1}
          value={sliderValue(state)}
          onChange={onScrub}
        />
      </div>

      <div className="transport-readout">
        <span className="transport-time" data-testid="transport-time">
          {readout.elapsedLabel} / {readout.spanLabel}
        </span>
        <span className="transport-events" data-testid="transport-events">
          {readout.firedCount} / {readout.eventCount} events
        </span>
        <span className="transport-agents" data-testid="transport-agents">
          {readout.activeAgentCount} / {readout.agentCount} agents
        </span>
      </div>

      <div className="transport-controls">
        <button
          type="button"
          className="transport-button"
          data-testid="transport-slower"
          aria-label="Slower"
          title="Slower"
          onClick={() => onAction({ type: 'slower' })}
        >
          −
        </button>
        <span className="transport-speed" data-testid="transport-speed">
          {readout.speedLabel}
        </span>
        <button
          type="button"
          className="transport-button"
          data-testid="transport-faster"
          aria-label="Faster"
          title="Faster"
          onClick={() => onAction({ type: 'faster' })}
        >
          +
        </button>
        <button
          type="button"
          className="transport-button"
          data-testid="transport-restart"
          aria-label="Restart"
          title="Restart"
          onClick={() => onAction({ type: 'restart' })}
        >
          ↺
        </button>
      </div>
    </section>
  )
}
