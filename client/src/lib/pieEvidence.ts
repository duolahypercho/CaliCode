import * as THREE from "three";

/**
 * Snapshot of a PerspectiveCamera's pose and projection state.
 *
 * The integration calls `snapshotCameraPose` before mutating the camera
 * during `frameProject` and stores the result on the runtime. If a later
 * frame has to bail (non-finite bounds, zero-scale scene, etc.) we restore
 * the camera from this snapshot so the user's last valid view survives the
 * failure and the next capture does not see black.
 */
export interface CameraPoseSnapshot {
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  readonly near: number;
  readonly far: number;
  readonly fov: number;
  readonly aspect: number;
}

export type BoundsValidation =
  | { readonly ok: true; readonly bounds: THREE.Box3 }
  | { readonly ok: false; readonly reason: string };

/**
 * Pure bounds validator. Returns a tagged result so the caller can decide
 * between throwing, returning a sentinel, or retrying — no exceptions for
 * the expected empty/non-finite cases, since the agent capture loop has to
 * distinguish "black frame" from "broken runtime".
 *
 * A NaN-poisoned transform propagates through `Box3.setFromObject` into
 * the bounds, which the GPU then filters out vertex-by-vertex. The render
 * appears black with no console error, so the only signal is the bounds
 * themselves.
 */
export function validateProjectBounds(bounds: THREE.Box3): BoundsValidation {
  // Check emptiness first. A default Box3 (min = +Infinity, max = -Infinity)
  // from an empty scene reports isEmpty() as true, but every component is
  // also non-finite. Treating the empty case as "no visible bounds" is the
  // more actionable diagnostic; the finite-check below still catches NaN-
  // poisoned scenes (where isEmpty() is false because NaN comparisons are).
  if (bounds.isEmpty()) {
    return {
      ok: false,
      reason:
        "PIE project has no visible bounds — add at least one entity with non-zero scale before capturing.",
    };
  }
  for (const point of [bounds.min, bounds.max]) {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      !Number.isFinite(point.z)
    ) {
      return {
        ok: false,
        reason:
          `PIE project bounds are non-finite (likely NaN-poisoned transforms); ` +
          `min=${formatVec3(bounds.min)} max=${formatVec3(bounds.max)}. ` +
          `Restore the entity transforms and retry the capture.`,
      };
    }
  }
  return { ok: true, bounds };
}

export function snapshotCameraPose(camera: THREE.PerspectiveCamera): CameraPoseSnapshot {
  return {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    near: camera.near,
    far: camera.far,
    fov: camera.fov,
    aspect: camera.aspect,
  };
}

export function restoreCameraPose(camera: THREE.PerspectiveCamera, snap: CameraPoseSnapshot): void {
  camera.position.copy(snap.position);
  camera.quaternion.copy(snap.quaternion);
  camera.near = snap.near;
  camera.far = snap.far;
  camera.fov = snap.fov;
  camera.aspect = snap.aspect;
  camera.updateProjectionMatrix();
  // updateMatrixWorld so OrbitControls / view matrices see the recovered pose.
  camera.updateMatrixWorld(true);
}

function formatVec3(v: THREE.Vector3): string {
  return `[${formatNumber(v.x)}, ${formatNumber(v.y)}, ${formatNumber(v.z)}]`;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toFixed(3);
}
