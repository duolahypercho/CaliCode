/** Bounds persistent script state before it crosses another frame boundary. */

export const MAX_STATE_DEPTH = 5;
export const MAX_STATE_ENTRIES = 64;
export const MAX_STATE_STRING = 1024;

export interface SanitizeResult {
  value: unknown;
  logs: string[];
}

/** Coerces script-written values to bounded JSON data and reports each drop. */
export function sanitizeScriptState(
  value: unknown,
  path: string = "<root>",
  depth: number = 0,
  seen: WeakSet<object> = new WeakSet(),
): SanitizeResult {
  if (depth > MAX_STATE_DEPTH) {
    return { value: undefined, logs: [`script state at ${path}: depth exceeded`] };
  }
  if (value === null) return { value: null, logs: [] };
  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      return { value: 0, logs: [`script state at ${path}: non-finite number coerced to 0`] };
    }
    return { value, logs: [] };
  }
  if (type === "string") {
    const text = value as string;
    if (text.length > MAX_STATE_STRING) {
      return {
        value: text.slice(0, MAX_STATE_STRING),
        logs: [`script state at ${path}: string truncated to ${MAX_STATE_STRING} chars`],
      };
    }
    return { value: text, logs: [] };
  }
  if (type === "boolean") return { value, logs: [] };
  if (type === "undefined" || type === "function" || type === "symbol" || type === "bigint") {
    return { value: undefined, logs: [`script state at ${path}: unsupported type ${type} dropped`] };
  }
  if (type !== "object") {
    return { value: undefined, logs: [`script state at ${path}: unsupported type ${type} dropped`] };
  }
  if (seen.has(value as object)) {
    return { value: undefined, logs: [`script state at ${path}: circular reference dropped`] };
  }
  seen.add(value as object);
  if (Array.isArray(value)) {
    const logs: string[] = [];
    const out: unknown[] = [];
    const length = Math.min(value.length, MAX_STATE_ENTRIES);
    if (value.length > length) logs.push(`script state at ${path}: array truncated to ${length} entries`);
    for (let i = 0; i < length; i += 1) {
      const child = sanitizeScriptState(value[i], `${path}[${i}]`, depth + 1, seen);
      if (child.logs.length > 0) logs.push(...child.logs);
      out.push(child.value);
    }
    return { value: out, logs };
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const logs: string[] = [];
  const out: Record<string, unknown> = {};
  const length = Math.min(keys.length, MAX_STATE_ENTRIES);
  if (keys.length > length) logs.push(`script state at ${path}: object truncated to ${length} keys`);
  for (let i = 0; i < length; i += 1) {
    const key = keys[i];
    const child = sanitizeScriptState(obj[key], `${path}.${key}`, depth + 1, seen);
    if (child.logs.length > 0) logs.push(...child.logs);
    out[key] = child.value;
  }
  return { value: out, logs };
}

/**
 * Deep-freezes a JSON-safe value so a script cannot mutate a snapshot it
 * has been handed. Operates on already-sanitized input, so cycles are
 * impossible and the recursion terminates.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null) return value;
  const type = typeof value;
  if (type !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Plain-JS mirror of `sanitizeScriptState` for embedding inside the
 * frame-sandbox worker (which has no module loader and is constructed from
 * a single `String.raw` blob). Keep in sync with the TS version above.
 */
export const SCRIPT_STATE_NORMALIZER_SOURCE = String.raw`
var MAX_STATE_DEPTH = 5;
var MAX_STATE_ENTRIES = 64;
var MAX_STATE_STRING = 1024;

function sanitizeScriptState(value, path, depth, seen) {
  if (path === undefined) path = "<root>";
  if (depth === undefined) depth = 0;
  if (seen === undefined) seen = new WeakSet();
  if (depth > MAX_STATE_DEPTH) return { value: undefined, logs: ["script state at " + path + ": depth exceeded"] };
  if (value === null) return { value: null, logs: [] };
  var type = typeof value;
  if (type === "number") {
    if (!isFinite(value)) return { value: 0, logs: ["script state at " + path + ": non-finite number coerced to 0"] };
    return { value: value, logs: [] };
  }
  if (type === "string") {
    if (value.length > MAX_STATE_STRING) {
      return {
        value: value.slice(0, MAX_STATE_STRING),
        logs: ["script state at " + path + ": string truncated to " + MAX_STATE_STRING + " chars"]
      };
    }
    return { value: value, logs: [] };
  }
  if (type === "boolean") return { value: value, logs: [] };
  if (type === "undefined" || type === "function" || type === "symbol" || type === "bigint") {
    return { value: undefined, logs: ["script state at " + path + ": unsupported type " + type + " dropped"] };
  }
  if (type !== "object") {
    return { value: undefined, logs: ["script state at " + path + ": unsupported type " + type + " dropped"] };
  }
  if (seen.has(value)) {
    return { value: undefined, logs: ["script state at " + path + ": circular reference dropped"] };
  }
  seen.add(value);
  if (Array.isArray(value)) {
    var logs = [];
    var out = [];
    var length = Math.min(value.length, MAX_STATE_ENTRIES);
    if (value.length > length) logs.push("script state at " + path + ": array truncated to " + length + " entries");
    for (var i = 0; i < length; i++) {
      var child = sanitizeScriptState(value[i], path + "[" + i + "]", depth + 1, seen);
      if (child.logs.length > 0) logs.push.apply(logs, child.logs);
      out.push(child.value);
    }
    return { value: out, logs: logs };
  }
  var keys = Object.keys(value);
  var objLogs = [];
  var objOut = {};
  var keyLength = Math.min(keys.length, MAX_STATE_ENTRIES);
  if (keys.length > keyLength) objLogs.push("script state at " + path + ": object truncated to " + keyLength + " keys");
  for (var j = 0; j < keyLength; j++) {
    var key = keys[j];
    var child2 = sanitizeScriptState(value[key], path + "." + key, depth + 1, seen);
    if (child2.logs.length > 0) objLogs.push.apply(objLogs, child2.logs);
    objOut[key] = child2.value;
  }
  return { value: objOut, logs: objLogs };
}

function deepFreeze(value) {
  if (value === null) return value;
  var type = typeof value;
  if (type !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) deepFreeze(value[i]);
  } else {
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) deepFreeze(value[keys[k]]);
  }
  return value;
}
`;
