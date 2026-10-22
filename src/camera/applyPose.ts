import * as THREE from 'three'
import type { SceneCamera } from '../scene/scenePlan.ts'

/**
 * Copy a {@link SceneCamera} onto the renderer's camera (M4-T3) — the one place
 * that applies a pose.
 *
 * Both camera modes (`OrbitCameraRig`, `FlyCameraRig`) have to do exactly this,
 * and a second copy of it is a second chance to forget `updateProjectionMatrix`
 * (which is what makes a changed fov/near/far take effect at all). The *numbers*
 * have never been the render layer's to choose — they come from the pure camera
 * model — so this helper decides nothing and only moves floats onto the GPU-side
 * object.
 *
 * Not part of the data layer and not registered in the coordinate scanner: it
 * imports three.js by design, and it authors no coordinate (it copies the pose's).
 */
export function applySceneCamera(target: THREE.Camera, pose: SceneCamera): void {
  target.position.set(pose.position.x, pose.position.y, pose.position.z)
  target.lookAt(pose.target.x, pose.target.y, pose.target.z)
  if (target instanceof THREE.PerspectiveCamera) {
    target.fov = pose.fov
    target.near = pose.near
    target.far = pose.far
    target.updateProjectionMatrix()
  }
}
