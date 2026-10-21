import { describeOrbit } from '../camera/orbit.ts'
import type { CameraMode, OrbitCamera } from '../camera/orbit.ts'

/**
 * The camera bar (M4-T2) — the render half of the orbit mode's controls.
 *
 * A deliberately dumb overlay, exactly like the transport bar: it renders the
 * state the pure orbit model ({@link describeOrbit}) hands it and dispatches one
 * control per button. It decides no rule — not the drag sensitivity, not the
 * dolly range, not what "reset" means — because those are the model's and the
 * model is unit-tested.
 *
 * Why buttons at all when the canvas already takes a drag and a wheel: **the
 * camera must be operable without a precise pointing device**, and a zoom step
 * has to be reachable from a keyboard and a screen reader. The buttons are the
 * honest accessible path to the same two transitions the pointer drives, and
 * they double as the only way to verify the camera in a headless run. The mode
 * chip is a label, not a control, until M4-T3 adds a second mode to select.
 *
 * Positioning (top-left, clear of the transport at the bottom and the boot chip
 * at the top-right) lives in `App.css`; nothing here asserts how it looks — that
 * is the human review's job (M5-T5).
 */
export interface CameraBarProps {
  /** The active camera mode. */
  mode: CameraMode
  /** The orbit state to render. */
  orbit: OrbitCamera
  /** Dolly by `steps` (positive = closer). */
  onZoom: (steps: number) => void
  /** Return to the scene's opening shot. */
  onReset: () => void
  /** Whether the dolly can still come closer. */
  canZoomIn: boolean
  /** Whether the dolly can still go further out. */
  canZoomOut: boolean
}

export default function CameraBar({
  mode,
  orbit,
  onZoom,
  onReset,
  canZoomIn,
  canZoomOut,
}: CameraBarProps) {
  const readout = describeOrbit(orbit)

  return (
    <section className="camera-bar" data-testid="camera-bar" aria-label="Camera">
      <span className="camera-mode" data-testid="camera-mode" data-mode={mode}>
        {readout.modeLabel}
      </span>

      <span className="camera-readout" data-testid="camera-readout">
        <span data-testid="camera-azimuth">{readout.azimuthLabel}</span>
        {' / '}
        <span data-testid="camera-elevation">{readout.elevationLabel}</span>
        {' · '}
        <span data-testid="camera-distance">{readout.distanceLabel}</span>
      </span>

      <div className="camera-controls">
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
    </section>
  )
}
