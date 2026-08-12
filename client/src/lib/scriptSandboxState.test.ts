import { describe, expect, it } from "vitest";
import {
  MAX_STATE_DEPTH,
  MAX_STATE_ENTRIES,
  MAX_STATE_STRING,
  SCRIPT_STATE_NORMALIZER_SOURCE,
  deepFreeze,
  sanitizeScriptState,
} from "./scriptSandboxState";

/**
 * The sanitizer is the only barrier between a hostile or buggy script and a
 * megabyte / circular / function-shaped value that the next step would
 * otherwise have to clone. These cover each branch the recursion walks.
 */
describe("sanitizeScriptState", () => {
  it("passes primitives through", () => {
    expect(sanitizeScriptState(0).value).toBe(0);
    expect(sanitizeScriptState(-1.5).value).toBe(-1.5);
    expect(sanitizeScriptState("hello").value).toBe("hello");
    expect(sanitizeScriptState(true).value).toBe(true);
    expect(sanitizeScriptState(null).value).toBe(null);
  });

  it("coerces non-finite numbers to 0 and logs the script", () => {
    const result = sanitizeScriptState(NaN);
    expect(result.value).toBe(0);
    expect(result.logs.join("\n")).toMatch(/non-finite number/);
  });

  it("truncates oversized strings", () => {
    const huge = "x".repeat(MAX_STATE_STRING + 10);
    const result = sanitizeScriptState(huge);
    expect((result.value as string).length).toBe(MAX_STATE_STRING);
    expect(result.logs.join("\n")).toMatch(/truncated/);
  });

  it("drops functions, symbols and bigints from object values", () => {
    const result = sanitizeScriptState({
      fn: () => undefined,
      sym: Symbol("x"),
      big: 10n,
      keep: 1,
    });
    expect(result.value).toEqual({ keep: 1 });
    expect(result.logs.length).toBeGreaterThanOrEqual(3);
  });

  it("drops circular references and does not infinite-loop", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const result = sanitizeScriptState(a);
    // The circular entry must be replaced with undefined; the top-level
    // shape still terminates.
    expect(result.value).toBeDefined();
    expect(result.logs.join("\n")).toMatch(/circular/);
  });

  it("truncates arrays past the entry cap", () => {
    const arr = Array.from({ length: MAX_STATE_ENTRIES + 5 }, (_, i) => i);
    const result = sanitizeScriptState(arr);
    expect((result.value as unknown[]).length).toBe(MAX_STATE_ENTRIES);
    expect(result.logs.join("\n")).toMatch(/array truncated/);
  });

  it("truncates object keys past the entry cap", () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < MAX_STATE_ENTRIES + 5; i += 1) obj[`k${i}`] = i;
    const result = sanitizeScriptState(obj);
    expect(Object.keys(result.value as Record<string, unknown>).length).toBe(MAX_STATE_ENTRIES);
    expect(result.logs.join("\n")).toMatch(/object truncated/);
  });

  it("caps recursion at MAX_STATE_DEPTH", () => {
    let inner: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < MAX_STATE_DEPTH + 5; i += 1) {
      inner = { next: inner };
    }
    const result = sanitizeScriptState(inner);
    expect(result.value).toBeDefined();
    expect(result.logs.join("\n")).toMatch(/depth exceeded/);
  });
});

describe("deepFreeze", () => {
  it("freezes nested objects so a script cannot mutate a snapshot", () => {
    const value = deepFreeze({ position: { x: 1, y: 2, z: 3 }, items: [1, 2, 3] });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen((value as { position: object }).position)).toBe(true);
    expect(Object.isFrozen((value as { items: unknown[] }).items)).toBe(true);
  });

  it("returns primitive inputs untouched", () => {
    expect(deepFreeze(0)).toBe(0);
    expect(deepFreeze("x")).toBe("x");
    expect(deepFreeze(null)).toBe(null);
  });
});

/**
 * The frame-sandbox embeds an exact mirror of the TS sanitizer so the
 * iframe-hosted worker can normalize without a module loader. Drift here
 * breaks parity between the worker backends -- a test that compiles the
 * mirror and exercises it keeps the three implementations equivalent.
 */
describe("SCRIPT_STATE_NORMALIZER_SOURCE", () => {
  it("defines the same functions as the TS module", () => {
    const factory = new Function(
      `${SCRIPT_STATE_NORMALIZER_SOURCE}\nreturn { sanitizeScriptState, deepFreeze, MAX_STATE_DEPTH, MAX_STATE_ENTRIES, MAX_STATE_STRING };`,
    );
    const mirror = factory() as {
      sanitizeScriptState: (value: unknown) => { value: unknown; logs: string[] };
      deepFreeze: <T>(value: T) => T;
      MAX_STATE_DEPTH: number;
      MAX_STATE_ENTRIES: number;
      MAX_STATE_STRING: number;
    };
    expect(mirror.MAX_STATE_DEPTH).toBe(MAX_STATE_DEPTH);
    expect(mirror.MAX_STATE_ENTRIES).toBe(MAX_STATE_ENTRIES);
    expect(mirror.MAX_STATE_STRING).toBe(MAX_STATE_STRING);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = mirror.sanitizeScriptState(circular);
    expect(result.value).toBeDefined();
    expect(result.logs.join("\n")).toMatch(/circular/);

    const frozen = mirror.deepFreeze({ a: { b: 1 } });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen((frozen as { a: object }).a)).toBe(true);
  });
});
