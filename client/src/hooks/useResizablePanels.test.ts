import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clampWidth, readStoredWidth, writeStoredWidth } from "./useResizablePanels";

const BOUNDS = { defaultWidth: 384, minWidth: 280, maxWidth: 640 };
const KEY = "test-panel-width";

// jsdom's global localStorage binding is unreliable across Node versions.
// A deterministic stub avoids depending on which version of Node / jsdom
// happens to be installed and keeps the tests fast.
let store: Map<string, string>;

beforeAll(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => void store.clear(),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("clampWidth", () => {
  it("returns a width that is already inside the range", () => {
    expect(clampWidth(400, 280, 640)).toBe(400);
  });

  it("raises a width below the minimum", () => {
    expect(clampWidth(120, 280, 640)).toBe(280);
  });

  it("lowers a width above the maximum", () => {
    expect(clampWidth(2000, 280, 640)).toBe(640);
  });

  it("rounds fractional widths to whole pixels", () => {
    expect(clampWidth(383.6, 280, 640)).toBe(384);
  });

  it("falls back to the minimum for a non-finite width", () => {
    expect(clampWidth(Number.NaN, 280, 640)).toBe(280);
    expect(clampWidth(Number.POSITIVE_INFINITY, 280, 640)).toBe(280);
  });

  it("keeps the minimum when the range is inverted", () => {
    expect(clampWidth(500, 400, 200)).toBe(400);
  });
});

describe("readStoredWidth", () => {
  beforeEach(() => {
    store.clear();
  });

  it("returns the default when nothing is stored", () => {
    expect(readStoredWidth(KEY, BOUNDS)).toBe(384);
  });

  it("restores a previously stored width", () => {
    store.set(KEY, "512");

    expect(readStoredWidth(KEY, BOUNDS)).toBe(512);
  });

  it("clamps a stored width that no longer fits the bounds", () => {
    store.set(KEY, "5000");

    expect(readStoredWidth(KEY, BOUNDS)).toBe(640);
  });

  it("falls back to the default for a non-numeric stored value", () => {
    store.set(KEY, "wide-please");

    expect(readStoredWidth(KEY, BOUNDS)).toBe(384);
  });

  it("clamps the default itself when it sits outside the bounds", () => {
    expect(readStoredWidth(KEY, { defaultWidth: 100, minWidth: 280, maxWidth: 640 })).toBe(280);
  });

  it("reads back exactly what writeStoredWidth persisted", () => {
    writeStoredWidth(KEY, 333);

    expect(readStoredWidth(KEY, BOUNDS)).toBe(333);
  });

  it("keeps each panel's width under its own key", () => {
    writeStoredWidth("panel-a", 300);
    writeStoredWidth("panel-b", 600);

    expect(readStoredWidth("panel-a", BOUNDS)).toBe(300);
    expect(readStoredWidth("panel-b", BOUNDS)).toBe(600);
  });
});
