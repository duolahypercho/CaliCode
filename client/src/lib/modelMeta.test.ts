import { describe, expect, it } from "vitest";
import snapshot from "@opencode-ai/models/snapshot";
import {
  contextLimitFor,
  defaultEffort,
  effortLevelsFor,
  heuristicLevels,
  reduceCatalog,
  reduceContextLimits,
  reduceGuardianModels,
  reduceRegistry,
} from "./modelMeta";

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

describe("reduceGuardianModels", () => {
  const guardians = reduceGuardianModels(snapshot.providers);

  it("picks a cheaper model than the provider's flagship", () => {
    const anthropic = guardians.anthropic;
    expect(anthropic).toBeTruthy();
    const models = snapshot.providers.anthropic?.models ?? {};
    const chosen = Object.values(models).find((model) => model.id === anthropic);
    const priced = Object.values(models)
      .map((model) => model.cost?.input)
      .filter((price): price is number => typeof price === "number");
    expect(chosen?.cost?.input).toBe(Math.min(...priced));
  });

  it("never picks a model with no published price", () => {
    for (const [providerId, modelId] of Object.entries(guardians)) {
      const model = Object.values(snapshot.providers[providerId]?.models ?? {}).find(
        (candidate) => candidate.id === modelId,
      );
      expect(typeof model?.cost?.input).toBe("number");
    }
  });

  it("never picks a deprecated or non-text model", () => {
    for (const [providerId, modelId] of Object.entries(guardians)) {
      const model = Object.values(snapshot.providers[providerId]?.models ?? {}).find(
        (candidate) => candidate.id === modelId,
      );
      expect(model?.status).not.toBe("deprecated");
      expect(model?.modalities?.output).toContain("text");
      expect(model?.modalities?.output).not.toContain("audio");
    }
  });

  it("chooses the cheapest priced text model and stable tie breaks", () => {
    const providers = {
      test: {
        id: "test",
        models: {
          zeta: makeModel("zeta", 0.1),
          alpha: makeModel("alpha", 0.1),
          old: { ...makeModel("old", 0), status: "deprecated" },
          audio: { ...makeModel("audio", 0), modalities: { input: ["text"], output: ["audio"] } },
        },
      },
    } as unknown as typeof snapshot.providers;
    expect(reduceGuardianModels(providers).test).toBe("alpha");
  });

  it("omits providers whose models have no published price", () => {
    const providers = {
      mystery: {
        id: "mystery",
        models: { a: { ...makeModel("a", 0), cost: undefined } },
      },
    } as unknown as typeof snapshot.providers;
    expect(reduceGuardianModels(providers).mystery).toBeUndefined();
  });
});

function makeModel(id: string, input: number) {
  return {
    id,
    name: id,
    description: "",
    attachment: false,
    reasoning: false,
    tool_call: true,
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    modalities: { input: ["text"], output: ["text"] },
    open_weights: false,
    limit: { context: 100, output: 100 },
    cost: { input, output: input },
  };
}

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

describe("reduceContextLimits over the models.dev snapshot", () => {
  const limits = reduceContextLimits(snapshot.providers);

  it("reports each model's real window, not one shared assumption", () => {
    // The defect this replaces: every model was treated as 128k, so a 1M model
    // compacted at 88k and a small one hundreds of turns late.
    expect(contextLimitFor(limits, "claude-fable-5")).toBe(1_000_000);
    expect(contextLimitFor(limits, "claude-haiku-4-5")).toBe(200_000);
    expect(contextLimitFor(limits, "gpt-3.5-turbo")).toBe(16_385);
  });

  it("resolves a provider-prefixed id by falling back to the bare one", () => {
    expect(contextLimitFor(limits, "anthropic/claude-haiku-4-5")).toBe(200_000);
    // Aggregator-style triples still reach the model.
    expect(contextLimitFor(limits, "openrouter/anthropic/claude-haiku-4-5")).toBe(200_000);
  });

  it("skips entries whose limit is 0 rather than recording no context", () => {
    // Image/embedding entries carry `context: 0`, which means "not applicable".
    expect(contextLimitFor(limits, "chatgpt-image-latest")).toBeNull();
  });

  it("answers null for an unknown model so callers can fall back", () => {
    expect(contextLimitFor(limits, "not-a-real-model")).toBeNull();
    expect(contextLimitFor(null, "claude-haiku-4-5")).toBeNull();
  });
});
