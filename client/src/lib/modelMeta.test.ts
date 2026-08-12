import { describe, expect, it } from "vitest";
import snapshot from "@opencode-ai/models/snapshot";
import { defaultEffort, effortLevelsFor, heuristicLevels, reduceCatalog, reduceRegistry } from "./modelMeta";

// The reducer runs over the package's bundled snapshot — the same data shape
// `Models.make().providers()` returns live — so these tests exercise the real
// catalog rather than fixtures.
const index = reduceRegistry(snapshot.providers);

describe("reduceRegistry over the models.dev snapshot", () => {
  it("prefers the vendor's declared effort set over aggregators", () => {
    // deepseek declares [low, high, max]; aggregators disagree.
    expect(index["deepseek-v4-flash"]).toEqual(["low", "high", "max"]);
  });

  it("keeps anthropic's four-level set including max", () => {
    expect(index["claude-sonnet-4-6"]).toEqual(["low", "medium", "high", "max"]);
  });

  it("maps non-reasoning models to an empty set", () => {
    expect(index["gpt-4o"]).toEqual([]);
  });

  it("never emits null or 'default' as a level", () => {
    for (const levels of Object.values(index)) {
      expect(levels).not.toContain("default");
      expect(levels).not.toContain(null);
    }
  });
});

describe("effortLevelsFor", () => {
  it("resolves provider-prefixed ids to the bare entry", () => {
    expect(effortLevelsFor(index, "openai/gpt-4o")).toEqual([]);
  });

  it("falls back to name heuristics for unknown models", () => {
    expect(effortLevelsFor(index, "my-custom-thinking-model")).toEqual(["low", "medium", "high"]);
    expect(effortLevelsFor(index, "opencode-go-responses-gpt-5-6-luna")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(effortLevelsFor(index, "totally-unknown")).toEqual([]);
  });
});

describe("defaultEffort", () => {
  it("prefers medium, else the middle level, else null", () => {
    expect(defaultEffort(["low", "medium", "high"])).toBe("medium");
    expect(defaultEffort(["low", "high", "max"])).toBe("high");
    expect(defaultEffort([])).toBeNull();
  });
});

describe("heuristicLevels", () => {
  it("recognises reasoning-family names without false positives", () => {
    expect(heuristicLevels("o3-mini")).toEqual(["low", "medium", "high"]);
    expect(heuristicLevels("gpt-5.6-luna")).toContain("max");
    expect(heuristicLevels("gpt-4.1-mini")).toEqual([]);
  });
});

describe("reduceCatalog over the models.dev snapshot", () => {
  const catalog = reduceCatalog(snapshot.providers);

  it("lists openai's current models newest-first", () => {
    const openai = catalog.openai ?? [];
    expect(openai.length).toBeGreaterThan(10);
    // The newest tool-calling text model leads the list.
    expect(openai.indexOf("gpt-5.6")).toBeGreaterThanOrEqual(0);
    expect(openai.indexOf("gpt-5.6")).toBeLessThan(openai.indexOf("gpt-4o"));
  });

  it("excludes deprecated and non-tool-calling models", () => {
    for (const models of Object.values(catalog)) {
      expect(models).not.toContain("gpt-image-2");
      expect(models).not.toContain("gpt-realtime-2.1");
    }
  });
});
