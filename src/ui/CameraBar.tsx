import type { CameraReadout } from '../camera/cameraState.ts'
import { cameraModeSwitchLabel } from '../camera/modes.ts'

/**
 * The camera bar (M4-T2, two modes since M4-T3) — the render half of the camera
 * controls.
 *
 * A deliberately dumb overlay, exactly like the transport bar: it renders the
 * readout the pure layer hands it ({@link CameraReadout}, a discriminated union the
 * mode switch produces) and dispatches one control per button. It decides no rule —
 * not the drag sensitivity, not the dolly range, not the flight speed, not what
 * "reset" means — because those are the models' and the models are unit-tested.
 *
 * ## Why buttons at all when the canvas already takes a drag and a wheel
 *
 * **The camera must be operable without a precise pointing device**, and a zoom
 * step / a mode switch / a metre of forward flight has to be reachable from a
 * keyboard and a screen reader. The buttons are the honest accessible path to the
 * same transitions the pointer drives, and they double as the only way to verify the
 * camera in a headless run. So each mode gets its own control group:
 *
 * - **orbit** — dolly out / in, and reset;
 * - **fly** — advance back / forward, and reset (looking around needs a pointer, but
 *   moving does not).
 *
 * The mode chip is itself the switch: clicking "Orbit" offers "Fly" — a label that
 * does nothing is the one thing a two-mode bar must not have.
 *
 * Positioning (top-left, clear of the transport at the bottom and the boot chip at
 * the top-right) lives in `App.css`; nothing here asserts how it looks — that is the
 * human review's job (M5-T5).
 */
export interface CameraBarProps {
  /** The active mode's readout (from `describeCamera`). */
  readout: CameraReadout
  /** The active mode's one-line pointer hint (from `cameraModeHint`). */
  hint: string
  /** Switch to the other camera mode. */
  onToggleMode: () => void
  /** Orbit: dolly by `steps` (positive = closer). */
  onZoom: (steps: number) => void
  /** Fly: advance along the look direction by `steps` (positive = forward). */
  onAdvance: (steps: number) => void
  /** Return the active mode to its opening shot. */
  onReset: () => void
  /** Orbit: whether the dolly can still come closer. */
  canZoomIn: boolean
  /** Orbit: whether the dolly can still go further out. */
  canZoomOut: boolean
}

export default function CameraBar({
  readout,
  hint,
  onToggleMode,
  onZoom,
  onAdvance,
  onReset,
  canZoomIn,
  canZoomOut,
}: CameraBarProps) {
  const switchTo = cameraModeSwitchLabel(readout.mode)

  return (
    <section className="camera-bar" data-testid="camera-bar" aria-label="Camera">
      <button
        type="button"
        className="camera-mode"
        data-testid="camera-mode"
        data-mode={readout.mode}
        aria-label={`Switch to ${switchTo.toLowerCase()} camera`}
        title={`Switch to ${switchTo.toLowerCase()} camera`}
        onClick={() => onToggleMode()}
      >
        {readout.modeLabel}
      </button>

      <span className="camera-readout" data-testid="camera-readout">
        {readout.mode === 'orbit' ? (
          <>
            <span data-testid="camera-azimuth">{readout.azimuthLabel}</span>
            {' / '}
            <span data-testid="camera-elevation">{readout.elevationLabel}</span>
            {' · '}
            <span data-testid="camera-distance">{readout.distanceLabel}</span>
          </>
        ) : (
          <>
            <span data-testid="camera-heading">{readout.headingLabel}</span>
            {' / '}
            <span data-testid="camera-pitch">{readout.pitchLabel}</span>
            {' · '}
            <span data-testid="camera-altitude">{readout.altitudeLabel}</span>
          </>
        )}
      </span>

      <div className="camera-controls">
        {readout.mode === 'orbit' ? (
          <>
            <button
              type="button"
              className="camera-button"
              data-testid="camera-zoom-out"
              aria-label="Zoom out"
              title="Zoom out"
              disabled={!canZoomOut}
              onClick={() => onZoom(-1)}
            >
              −
            </button>
            <span className="camera-zoom" data-testid="camera-zoom">
              {readout.zoomLabel}
            </span>
            <button
              type="button"
              className="camera-button"
              data-testid="camera-zoom-in"
              aria-label="Zoom in"
              title="Zoom in"
              disabled={!canZoomIn}
              onClick={() => onZoom(1)}
            >
              +
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="camera-button"
              data-testid="camera-advance-back"
              aria-label="Fly back"
              title="Fly back"
              onClick={() => onAdvance(-1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="camera-button"
              data-testid="camera-advance-forward"
              aria-label="Fly forward"
              title="Fly forward"
              onClick={() => onAdvance(1)}
            >
              ↑
            </button>
          </>
        )}
        <button
          type="button"
          className="camera-button"
          data-testid="camera-reset"
          aria-label="Reset view"
          title="Reset view"
          onClick={() => onReset()}
        >
          ⌂
        </button>
      </div>

      <span className="camera-hint" data-testid="camera-hint">
        {hint}
      </span>
    </section>
  )
}
