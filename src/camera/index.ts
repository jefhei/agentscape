/**
 * Public entry point for the camera layer (M4-T2, two modes since M4-T3).
 *
 * The camera follows the same PRD §5 split as the scene: **pure** models
 * (`./orbit.ts` — the outside view; `./fly.ts` — the first-person view;
 * `./modes.ts` — the mode vocabulary; `./cameraState.ts` — the dispatch between
 * them) and **thin** consumers (`OrbitCameraRig.tsx`, `FlyCameraRig.tsx` — apply a
 * pose, measure the pointer and the keys). {@link useCamera} is the React state
 * seam over both, and {@link useOrbitCamera} is the orbit-only seam it composes.
 *
 * The import graph is a DAG by construction: `modes.ts` imports nothing, the two
 * pose modules import it, `cameraState.ts` imports both pose modules, and the hooks
 * and rigs sit on top.
 */
export {
  CAMERA_MODE_LABELS,
  CAMERA_MODES,
  cameraModeHint,
  cameraModeSwitchLabel,
  isCameraMode,
  nextCameraMode,
} from './modes.ts'

export type { CameraMode } from './modes.ts'

export {
  cameraAngles,
  describeCamera,
  modeCameraPose,
  switchCameraMode,
} from './cameraState.ts'

export type { CameraAngles, CameraReadout, CameraSwitch } from './cameraState.ts'

export {
  FLY_ADVANCE_RADII_PER_STEP,
  FLY_BOOST,
  FLY_DEGREES_PER_PIXEL,
  FLY_ENVELOPE_RADII,
  FLY_KEYS,
  FLY_MAX_FRAME_MS,
  FLY_MAX_PITCH_DEG,
  FLY_MIN_ENVELOPE,
  FLY_MIN_LOOKAHEAD,
  FLY_MIN_PITCH_DEG,
  FLY_MIN_SCALE,
  FLY_SPEED_RADII_PER_SEC,
  clampPitch,
  createFlyCamera,
  describeFly,
  flyAdvance,
  flyAxisForKey,
  flyCameraPose,
  flyForward,
  flyInputFromKeys,
  flyIsMoving,
  flyLookAhead,
  flyLookBy,
  flyMove,
  flyRight,
  flyScale,
  flySpeed,
  flyVelocity,
  resetFly,
} from './fly.ts'

export type { FlyAxes, FlyCamera, FlyDelta, FlyInput, FlyReadout } from './fly.ts'

export {
  ORBIT_DEGREES_PER_PIXEL,
  ORBIT_MAX_ELEVATION_DEG,
  ORBIT_MAX_ZOOM,
  ORBIT_MIN_ELEVATION_DEG,
  ORBIT_MIN_ZOOM,
  ORBIT_WHEEL_LINE_PIXELS,
  ORBIT_WHEEL_MAX_STEPS,
  ORBIT_WHEEL_PAGE_PIXELS,
  ORBIT_WHEEL_PIXELS_PER_STEP,
  ORBIT_ZOOM_STEP,
  canZoomIn,
  canZoomOut,
  clampElevation,
  createOrbitCamera,
  describeOrbit,
  normalizeAzimuth,
  orbitBy,
  orbitCameraPose,
  orbitDistance,
  orbitDistanceRange,
  resetOrbit,
  setOrbitZoom,
  sphericalFromOffset,
  wheelZoomSteps,
  zoomBy,
} from './orbit.ts'

export type { OrbitCamera, OrbitDelta, OrbitOptions, OrbitReadout } from './orbit.ts'

export { applySceneCamera } from './applyPose.ts'

export { default as OrbitCameraRig, ORBITING_CLASS } from './OrbitCameraRig.tsx'
export type { OrbitCameraRigProps } from './OrbitCameraRig.tsx'

export { default as FlyCameraRig, FLYING_CLASS } from './FlyCameraRig.tsx'
export type { FlyCameraRigProps } from './FlyCameraRig.tsx'

export { useCamera } from './useCamera.ts'
export type { CameraController } from './useCamera.ts'

export { useOrbitCamera } from './useOrbitCamera.ts'
export type { OrbitController } from './useOrbitCamera.ts'
