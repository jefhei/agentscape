/**
 * Public entry point for the camera layer (M4-T2).
 *
 * The camera follows the same PRD §5 split as the scene: a **pure** orbit model
 * (`./orbit.ts` — pose, drag/dolly transitions, clamps, wheel mapping, readout)
 * and a **thin** consumer (`OrbitCameraRig.tsx` — applies the pose and measures
 * the pointer). {@link useOrbitCamera} is the React state seam between them.
 *
 * M4-T3 (fly mode) extends this barrel rather than reaching past it.
 */
export {
  CAMERA_MODE_LABELS,
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

export type {
  CameraMode,
  OrbitCamera,
  OrbitDelta,
  OrbitOptions,
  OrbitReadout,
} from './orbit.ts'

export { default as OrbitCameraRig, ORBITING_CLASS } from './OrbitCameraRig.tsx'
export type { OrbitCameraRigProps } from './OrbitCameraRig.tsx'

export { useOrbitCamera } from './useOrbitCamera.ts'
export type { OrbitController } from './useOrbitCamera.ts'
