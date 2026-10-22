/**
 * Camera mode vocabulary (M4-T3) — the *leaf* module of the camera layer.
 *
 * M4-T2 landed one mode (**orbit**: survey the run shape from outside the cloud).
 * M4-T3 adds the second and the switch between them: **fly**, a first-person
 * camera you drive *inside* the run. Two modes need shared vocabulary — which mode
 * is active, what it is called, what the switch offers, what the hint says — and
 * that vocabulary is here, as plain data, so the UI cannot invent a third answer.
 *
 * ## Why the union lives here and not in `orbit.ts`
 *
 * `CameraMode` started life in `orbit.ts` as a one-member union, deliberately:
 * declaring `'fly'` before a fly camera existed would have been a mode the UI could
 * select and nothing could honour. Now that both modes exist the union belongs to
 * neither of them — it is the thing that chooses between them — so it moved here,
 * where `orbit.ts`, `fly.ts` and `cameraState.ts` all import it and **this module
 * imports neither of them** (a leaf, so there is no import cycle).
 *
 * The parts that need to *know* both modes — the active pose, the readout, the
 * switch — are in `./cameraState.ts`, which is the only module allowed to import
 * both pose rules.
 *
 * ## Purity (PRD §5)
 *
 * Pure and deterministic: no three.js, no DOM, no clock, no `Math.random`, no
 * mutation of any argument, and no imports at all. Nothing about the rendered
 * *look* is asserted — that is human-held (M5-T5).
 */

/** The camera modes this build has. Two, on purpose: orbit (outside) and fly (inside). */
export type CameraMode = 'orbit' | 'fly'

/** Every mode, in the order the switch cycles them. */
export const CAMERA_MODES: readonly CameraMode[] = ['orbit', 'fly']

/** Human-readable mode names, for the camera bar. */
export const CAMERA_MODE_LABELS: Record<CameraMode, string> = {
  orbit: 'Orbit',
  fly: 'Fly',
}

/** Whether a value is a camera mode (a URL or a stored state may carry garbage). */
export function isCameraMode(value: unknown): value is CameraMode {
  return value === 'orbit' || value === 'fly'
}

/**
 * The mode a switch moves to: orbit ↔ fly. A single step of {@link CAMERA_MODES},
 * so adding a third mode later means extending the list only — the switch does not
 * have to learn about it.
 */
export function nextCameraMode(mode: CameraMode): CameraMode {
  const index = CAMERA_MODES.indexOf(mode)
  const next = index < 0 ? 0 : (index + 1) % CAMERA_MODES.length
  return CAMERA_MODES[next]
}

/** What the mode-switch button offers, e.g. `'Fly'` while orbiting. */
export function cameraModeSwitchLabel(mode: CameraMode): string {
  return CAMERA_MODE_LABELS[nextCameraMode(mode)]
}

/**
 * The one-line hint the bar shows for a mode: what the canvas does under the
 * pointer *in that mode*. The gesture differs (drag-to-orbit vs drag-to-look), so
 * the hint has to as well — it is a rule about the modes, not copy.
 */
export function cameraModeHint(mode: CameraMode): string {
  return mode === 'fly'
    ? 'WASD to fly · drag to look · scroll to advance'
    : 'drag to orbit · scroll to dolly'
}
