import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  restoreCameraPose,
  snapshotCameraPose,
  validateProjectBounds,
} from "./pieEvidence";

/** A scene with one finite mesh that contributes one Box3 worth of bounds. */
function makeSceneBox(position: [number, number, number] = [0, 0, 0]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.position.set(position[0], position[1], position[2]);
  return mesh;
}

/** A project group populated with the given children. */
function makeProjectGroup(children: THREE.Object3D[]): THREE.Group {
  const group = new THREE.Group();
  group.name = "test-project";
  for (const child of children) group.add(child);
  return group;
}

describe("validateProjectBounds", () => {
  it("returns ok with finite bounds for a normal scene", () => {
    const group = makeProjectGroup([makeSceneBox([2, 1, -3])]);
    const bounds = new THREE.Box3().setFromObject(group);

    const result = validateProjectBounds(bounds);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 1x1x1 box centered at (2,1,-3) -> x in [1.5, 2.5], etc.
      expect(result.bounds.min.x).toBeCloseTo(1.5, 6);
      expect(result.bounds.max.x).toBeCloseTo(2.5, 6);
      expect(Number.isFinite(result.bounds.min.x)).toBe(true);
      expect(Number.isFinite(result.bounds.max.y)).toBe(true);
      expect(result.bounds.isEmpty()).toBe(false);
    }
  });

  it("fails an empty scene with no entities", () => {
    // Default Box3 from setFromObject on a childless group: min = +Infinity,
    // max = -Infinity. isEmpty() returns true here, which is exactly the
    // case an empty project falls into.
    const group = makeProjectGroup([]);
    const bounds = new THREE.Box3().setFromObject(group);

    const result = validateProjectBounds(bounds);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no visible bounds/i);
    }
  });

  it("fails a scene whose entity positions are NaN", () => {
    const mesh = makeSceneBox();
    mesh.position.set(NaN, NaN, NaN);
    const group = makeProjectGroup([mesh]);
    const bounds = new THREE.Box3().setFromObject(group);

    const result = validateProjectBounds(bounds);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/non-finite/i);
      // The error embeds the actual bounds so the agent can locate the
      // offending entity without re-running the capture.
      expect(result.reason).toMatch(/NaN/);
    }
  });

  it("fails a scene whose entity positions are Infinity", () => {
    const mesh = makeSceneBox();
    mesh.position.set(Infinity, -Infinity, 0);
    const group = makeProjectGroup([mesh]);
    const bounds = new THREE.Box3().setFromObject(group);

    const result = validateProjectBounds(bounds);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/non-finite/i);
    }
  });

  it("fails when only a single axis is non-finite", () => {
    // A single NaN axis is enough to poison the render; the validator must
    // not rely on a quick `isEmpty()` short-circuit.
    const mesh = makeSceneBox([0, 0, 0]);
    mesh.position.set(0, NaN, 0);
    const group = makeProjectGroup([mesh]);
    const bounds = new THREE.Box3().setFromObject(group);

    const result = validateProjectBounds(bounds);

    expect(result.ok).toBe(false);
  });

  it("fails when an entity's scale is non-finite", () => {
    // NaN scale poisons matrixWorld the same way NaN position does.
    const mesh = makeSceneBox([1, 1, 1]);
    mesh.scale.set(NaN, 1, 1);
    const group = makeProjectGroup([mesh]);
    const bounds = new THREE.Box3().setFromObject(group);

    const result = validateProjectBounds(bounds);

    expect(result.ok).toBe(false);
  });

  it("recovers after a transient NaN is fixed and re-validated", () => {
    // The integration scenario: a script briefly writes NaN, the validator
    // rejects, the agent fixes the transform, the next call succeeds with
    // the same Box3 instance rebuilt from the live scene.
    const mesh = makeSceneBox([0, 0, 0]);
    const group = makeProjectGroup([mesh]);

    mesh.position.set(NaN, NaN, NaN);
    const poisoned = new THREE.Box3().setFromObject(group);
    expect(validateProjectBounds(poisoned).ok).toBe(false);

    mesh.position.set(1, 2, 3);
    const recovered = new THREE.Box3().setFromObject(group);
    const result = validateProjectBounds(recovered);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bounds.min.x).toBeCloseTo(0.5, 6);
      expect(result.bounds.max.x).toBeCloseTo(1.5, 6);
    }
  });

  it("keeps a multi-entity finite scene renderable", () => {
    // Regression: an earlier draft of the validator only walked the first
    // child, which would have missed poisoned siblings.
    const a = makeSceneBox([-3, 0, 0]);
    const b = makeSceneBox([3, 0, 0]);
    const c = makeSceneBox([0, 5, 0]);
    const group = makeProjectGroup([a, b, c]);
    const bounds = new THREE.Box3().setFromObject(group);

    const result = validateProjectBounds(bounds);

    expect(result.ok).toBe(true);
  });
});

describe("snapshotCameraPose / restoreCameraPose", () => {
  it("captures the current camera state and is immune to later mutation", () => {
    const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 100);
    camera.position.set(3, 4, 5);
    camera.near = 0.2;
    camera.far = 200;

    const snap = snapshotCameraPose(camera);

    camera.position.set(99, 99, 99);
    camera.near = 0.01;
    camera.far = 9999;

    expect(snap.position.x).toBe(3);
    expect(snap.position.y).toBe(4);
    expect(snap.position.z).toBe(5);
    expect(snap.near).toBe(0.2);
    expect(snap.far).toBe(200);
    expect(snap.fov).toBe(50);
    expect(snap.aspect).toBe(1.5);
  });

  it("restores every pose field after the camera was moved and looked elsewhere", () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(3, 4, 5);
    camera.near = 0.2;
    camera.far = 200;
    const snap = snapshotCameraPose(camera);

    camera.position.set(99, 99, 99);
    camera.near = 0.01;
    camera.far = 9999;
    camera.lookAt(7, 7, 7);

    restoreCameraPose(camera, snap);

    expect(camera.position.x).toBe(3);
    expect(camera.position.y).toBe(4);
    expect(camera.position.z).toBe(5);
    expect(camera.near).toBe(0.2);
    expect(camera.far).toBe(200);
    expect(camera.fov).toBe(50);
    expect(camera.aspect).toBe(1);
    // The quaternion is rebuilt from the snap, so a lookAt elsewhere does
    // not survive the restore. projectionMatrix is derived from fov/aspect/
    // near/far, so it is recomputed by restoreCameraPose and not snapshotted.
    expect(camera.quaternion.equals(snap.quaternion)).toBe(true);
  });

  it("clears a NaN-poisoned camera back to finite pose values", () => {
    // The recovery path the integrator uses when frameProject throws mid-
    // mutation: even if the camera was halfway to NaN, restoreCameraPose
    // hands back a finite, last-known-good pose.
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(1, 2, 3);
    camera.near = 0.4;
    const snap = snapshotCameraPose(camera);

    camera.position.set(NaN, NaN, NaN);
    camera.near = NaN;
    camera.far = NaN;

    restoreCameraPose(camera, snap);

    expect(Number.isFinite(camera.position.x)).toBe(true);
    expect(Number.isFinite(camera.position.y)).toBe(true);
    expect(Number.isFinite(camera.position.z)).toBe(true);
    expect(Number.isFinite(camera.near)).toBe(true);
    expect(Number.isFinite(camera.far)).toBe(true);
    expect(camera.position.x).toBe(1);
    expect(camera.position.y).toBe(2);
    expect(camera.position.z).toBe(3);
    expect(camera.near).toBe(0.4);
  });
});
