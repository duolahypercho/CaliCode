import type { SandboxEntity, SandboxVec3 } from "./scriptSandbox.worker";

/** Normalizes untrusted script transforms before they can NaN-poison Three.js. */

export interface Vec3ReadResult {
  vec: SandboxVec3;
  invalid: boolean;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Accepts both game-document arrays and sandbox `{x,y,z}` vectors. */
export function normalizeVec3(value: unknown, fallback: SandboxVec3): Vec3ReadResult {
  if (Array.isArray(value)) {
    if (
      value.length >= 3 &&
      isFiniteNumber(value[0]) &&
      isFiniteNumber(value[1]) &&
      isFiniteNumber(value[2])
    ) {
      return { vec: { x: value[0], y: value[1], z: value[2] }, invalid: false };
    }
    return { vec: fallback, invalid: true };
  }
  if (value && typeof value === "object") {
    const candidate = value as Partial<SandboxVec3>;
    if (isFiniteNumber(candidate.x) && isFiniteNumber(candidate.y) && isFiniteNumber(candidate.z)) {
      return {
        vec: { x: candidate.x, y: candidate.y, z: candidate.z },
        invalid: false,
      };
    }
  }
  return { vec: fallback, invalid: true };
}

export interface EntityNormalization {
  entity: SandboxEntity;
  logs: string[];
}

const VEC3_FIELDS = ["position", "rotation", "scale"] as const;

/** Reverts malformed transforms to the pre-step snapshot with an actionable log. */
export function normalizeEntity(
  input: SandboxEntity,
  output: SandboxEntity,
  scriptName: string,
): EntityNormalization {
  const logs: string[] = [];
  const next: SandboxEntity = { ...output };
  for (const field of VEC3_FIELDS) {
    const result = normalizeVec3(output[field], input[field]);
    next[field] = result.vec;
    if (result.invalid) {
      logs.push(
        `script ${scriptName}: ${field} must be a finite vec3 (got ${describeValue(output[field])}); reverted to pre-step value`,
      );
    }
  }
  return { entity: next, logs };
}

export function snapshotEntity(entity: SandboxEntity): SandboxEntity {
  return {
    id: entity.id,
    name: entity.name,
    kind: entity.kind,
    visible: entity.visible,
    scriptIds: entity.scriptIds,
    position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    rotation: { x: entity.rotation.x, y: entity.rotation.y, z: entity.rotation.z },
    scale: { x: entity.scale.x, y: entity.scale.y, z: entity.scale.z },
  };
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length=${value.length})`;
  if (typeof value === "object") return "object";
  return typeof value;
}

/** Module-free equivalent embedded in the CSP frame's worker source. */
export const SCRIPT_VECTOR_NORMALIZER_SOURCE = String.raw`
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function normalizeVec3(value, fallback) {
  if (Array.isArray(value)) {
    if (
      value.length >= 3 &&
      isFiniteNumber(value[0]) &&
      isFiniteNumber(value[1]) &&
      isFiniteNumber(value[2])
    ) {
      return { vec: { x: value[0], y: value[1], z: value[2] }, invalid: false };
    }
    return { vec: fallback, invalid: true };
  }
  if (value && typeof value === "object") {
    var cx = value.x, cy = value.y, cz = value.z;
    if (isFiniteNumber(cx) && isFiniteNumber(cy) && isFiniteNumber(cz)) {
      return { vec: { x: cx, y: cy, z: cz }, invalid: false };
    }
  }
  return { vec: fallback, invalid: true };
}
function describeVec3Value(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array(length=" + value.length + ")";
  if (typeof value === "object") return "object";
  return typeof value;
}
function normalizeEntity(input, output, scriptName) {
  var logs = [];
  var next = {
    id: output.id,
    name: output.name,
    kind: output.kind,
    visible: output.visible,
    scriptIds: output.scriptIds,
    position: output.position,
    rotation: output.rotation,
    scale: output.scale,
  };
  var fields = ["position", "rotation", "scale"];
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    var result = normalizeVec3(output[field], input[field]);
    next[field] = result.vec;
    if (result.invalid) {
      logs.push(
        "script " + scriptName + ": " + field + " must be a finite vec3 (got " +
        describeVec3Value(output[field]) + "); reverted to pre-step value"
      );
    }
  }
  return { entity: next, logs: logs };
}
function snapshotEntity(entity) {
  return {
    id: entity.id,
    name: entity.name,
    kind: entity.kind,
    visible: entity.visible,
    scriptIds: entity.scriptIds,
    position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    rotation: { x: entity.rotation.x, y: entity.rotation.y, z: entity.rotation.z },
    scale: { x: entity.scale.x, y: entity.scale.y, z: entity.scale.z },
  };
}
`;
