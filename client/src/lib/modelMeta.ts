// Per-model reasoning metadata, opencode-style, sourced through the official
// typed models.dev client (`@opencode-ai/models` — the same catalog opencode's
// picker is built on) and reduced to the one question our picker asks: which
// reasoning-effort values does this model accept? Non-reasoning models get [],
// reasoning models get their declared effort values, and budget/toggle models
// get sensible presets.

import { Models } from "@opencode-ai/models";
import type { Model, ProviderMap } from "@opencode-ai/models";

// v4 adds the per-provider guardian model used by Auto-mode review.
const CACHE_KEY = "calicode-modeldev-v4";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** model id (bare or provider-prefixed) → accepted effort values; [] = none. */
export type EffortIndex = Record<string, string[]>;

function levelsFrom(model: Model): { levels: string[]; explicit: boolean } {
  if (!model.reasoning) return { levels: [], explicit: false };
  const options = model.reasoning_options ?? [];
  for (const option of options) {
    if (option.type === "effort") {
      // `null` means "reasoning can be disabled" and `default` means "let the
      // provider pick" — neither is a level worth listing in the submenu.
      const values = option.values.filter(
        (value): value is Exclude<typeof value, null | "default"> => value !== null && value !== "default",
      );
      if (values.length > 0) return { levels: values, explicit: true };
    }
  }
  // Thinking-budget models: expose budget presets under effort names.
  if (options.some((option) => option.type === "budget_tokens")) {
    return { levels: ["low", "medium", "high"], explicit: false };
  }
  if (options.some((option) => option.type === "toggle")) return { levels: ["off", "on"], explicit: false };
  // Reasoning model with no declared options (o-series style default).
  return { levels: ["low", "medium", "high"], explicit: false };
}

/** Canonical ordering for effort names across providers. */
const EFFORT_ORDER = ["none", "off", "minimal", "low", "medium", "on", "high", "xhigh", "max"];

const sortEfforts = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort((left, right) => {
    const a = EFFORT_ORDER.indexOf(left);
    const b = EFFORT_ORDER.indexOf(right);
    return (a === -1 ? EFFORT_ORDER.length : a) - (b === -1 ? EFFORT_ORDER.length : b);
  });

interface Candidate {
  levels: string[];
  explicit: boolean;
  /** Declared by the model's own vendor rather than an aggregator. */
  home: boolean;
}

export function reduceRegistry(data: ProviderMap): EffortIndex {
  // The same model id appears under many providers — the vendor plus a crowd
  // of aggregators, each declaring its own (sometimes narrower) effort set.
  // Resolution order per model: the vendor's explicit declaration, else the
  // most commonly declared explicit set, else a derived default.
  const candidates = new Map<string, Candidate[]>();
  for (const [providerId, provider] of Object.entries(data)) {
    for (const [id, model] of Object.entries(provider.models ?? {})) {
      const bare = id.split("/").pop() ?? id;
      const entry = levelsFrom(model);
      const home = bare.toLowerCase().startsWith(providerId.toLowerCase());
      for (const key of new Set([id, bare])) {
        const list = candidates.get(key) ?? [];
        list.push({ ...entry, home });
        candidates.set(key, list);
      }
    }
  }

  const index: EffortIndex = {};
  for (const [key, list] of candidates) {
    const explicit = list.filter((candidate) => candidate.explicit);
    if (explicit.length > 0) {
      const homeCandidate = explicit.find((candidate) => candidate.home);
      if (homeCandidate) {
        index[key] = sortEfforts(homeCandidate.levels);
      } else {
        // Plurality vote across aggregators.
        const counts = new Map<string, { count: number; levels: string[] }>();
        for (const candidate of explicit) {
          const sorted = sortEfforts(candidate.levels);
          const tag = sorted.join("|");
          const bucket = counts.get(tag) ?? { count: 0, levels: sorted };
          bucket.count += 1;
          counts.set(tag, bucket);
        }
        index[key] = [...counts.values()].sort((a, b) => b.count - a.count)[0].levels;
      }
      continue;
    }
    index[key] = list.find((candidate) => candidate.levels.length > 0)?.levels ?? [];
  }
  return index;
}

/**
 * Model ids a provider currently offers that an agent harness can actually
 * drive: not deprecated, tool-calling, text-out. Newest release first.
 */
export function reduceCatalog(data: ProviderMap): Record<string, string[]> {
  const catalog: Record<string, string[]> = {};
  for (const [providerId, provider] of Object.entries(data)) {
    const usable = Object.values(provider.models ?? {})
      .filter(
        (model) =>
          model.status !== "deprecated" &&
          model.tool_call === true &&
          model.modalities?.output?.includes("text") &&
          // Realtime/speech models also emit text but are not chat-loop models.
          !model.modalities.output.includes("audio"),
      )
      .sort((a, b) => String(b.release_date ?? "").localeCompare(String(a.release_date ?? "")))
      .map((model) => model.id);
    if (usable.length > 0) catalog[providerId] = usable;
  }
  return catalog;
}

/** provider id → cheapest usable text model for Auto-mode review. */
export type GuardianModels = Record<string, string>;

export function reduceGuardianModels(data: ProviderMap): GuardianModels {
  const cheapest: GuardianModels = {};
  for (const [providerId, provider] of Object.entries(data)) {
    let best: { id: string; price: number } | null = null;
    for (const model of Object.values(provider.models ?? {})) {
      const price = model.cost?.input;
      if (typeof price !== "number" || !Number.isFinite(price) || price < 0) continue;
      if (model.status === "deprecated") continue;
      if (!model.modalities?.output?.includes("text") || model.modalities.output.includes("audio")) continue;
      if (!best || price < best.price || (price === best.price && model.id < best.id)) {
        best = { id: model.id, price };
      }
    }
    if (best) cheapest[providerId] = best.id;
  }
  return cheapest;
}

/** model id (bare and provider-prefixed) → advertised context window in tokens. */
export type ContextLimits = Record<string, number>;

/**
 * Each model's advertised context window, so compaction sizes itself to the
 * model actually running instead of one fixed guess.
 *
 * Keyed both bare and provider-prefixed for the same reason `reduceRegistry`
 * is: the active model arrives as either form. A model is recorded under a
 * larger window when providers disagree — the vendor's own listing is the one
 * that tends to be current, and under-reporting compacts early, which costs
 * real work.
 *
 * `limit.context` of 0 means "not applicable" (image and embedding entries
 * carry it), never "no context", so those are skipped rather than recorded.
 */
export function reduceContextLimits(data: ProviderMap): ContextLimits {
  const limits: ContextLimits = {};
  const record = (key: string, context: number) => {
    const current = limits[key];
    if (current === undefined || context > current) limits[key] = context;
  };
  for (const [providerId, provider] of Object.entries(data)) {
    for (const model of Object.values(provider.models ?? {})) {
      const context = model.limit?.context;
      if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) continue;
      record(model.id, context);
      record(`${providerId}/${model.id}`, context);
    }
  }
  return limits;
}

/** The window for a model id, tolerating a provider prefix. `null` = unknown. */
export function contextLimitFor(limits: ContextLimits | null, modelId: string): number | null {
  if (!limits || !modelId) return null;
  const direct = limits[modelId];
  if (typeof direct === "number") return direct;
  // "openrouter/anthropic/claude-x" → try progressively barer ids.
  const parts = modelId.split("/");
  for (let i = 1; i < parts.length; i += 1) {
    const candidate = limits[parts.slice(i).join("/")];
    if (typeof candidate === "number") return candidate;
  }
  return null;
}

export interface ModelDevData {
  index: EffortIndex;
  catalog: Record<string, string[]>;
  contextLimits: ContextLimits;
  guardians: GuardianModels;
}

interface CachedIndex {
  at: number;
  index: EffortIndex;
  catalog: Record<string, string[]>;
  contextLimits: ContextLimits;
  guardians: GuardianModels;
}

function readCache(): CachedIndex | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedIndex;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.at !== "number") return null;
    if (typeof parsed.catalog !== "object" || parsed.catalog === null) return null;
    // A cache written before context limits existed would answer "unknown" for
    // every model for a full day. The key is versioned, but check anyway.
    if (typeof parsed.contextLimits !== "object" || parsed.contextLimits === null) return null;
    if (typeof parsed.guardians !== "object" || parsed.guardians === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The effort index: a day-fresh cache when possible, the live registry when
 * not, then a stale cache, then the package's bundled snapshot (lazy-imported
 * so its ~4MB of catalog never enters the main bundle). `{}` only when even
 * the snapshot import fails; callers treat that as "unknown" and fall back to
 * `heuristicLevels`.
 */
export async function loadModelDev(): Promise<ModelDevData> {
  const cached = readCache();
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { index: cached.index, catalog: cached.catalog, contextLimits: cached.contextLimits, guardians: cached.guardians };
  }
  try {
    const providers = await Models.make().providers();
    const data: ModelDevData = {
      index: reduceRegistry(providers),
      catalog: reduceCatalog(providers),
      contextLimits: reduceContextLimits(providers),
      guardians: reduceGuardianModels(providers),
    };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), ...data } satisfies CachedIndex));
    } catch {
      /* cache is an optimisation, not a requirement */
    }
    return data;
  } catch {
    // Offline: a stale answer still beats guessing, and the bundled snapshot
    // (regenerated with every package release) beats an empty index.
    if (cached) return { index: cached.index, catalog: cached.catalog, contextLimits: cached.contextLimits, guardians: cached.guardians };
    try {
      const snapshot = await import("@opencode-ai/models/snapshot");
      return {
        index: reduceRegistry(snapshot.providers),
        catalog: reduceCatalog(snapshot.providers),
        contextLimits: reduceContextLimits(snapshot.providers),
        guardians: reduceGuardianModels(snapshot.providers),
      };
    } catch {
      return { index: {}, catalog: {}, contextLimits: {}, guardians: {} };
    }
  }
}

/** Name-based fallback for models the registry has never heard of. */
export function heuristicLevels(modelId: string): string[] {
  const id = modelId.toLowerCase();
  // Router transport aliases are not catalogued by models.dev, but Luna
  // accepts an explicit max effort. Keep this before the generic gpt-5 rule
  // so an offline registry never hides a saved max selection.
  if (id.includes("luna")) {
    return ["low", "medium", "high", "max"];
  }
  if (/(^|[^a-z0-9])(o[134])([^a-z0-9]|$)|gpt-5|r1|reasoner|thinking|grok-4|gemini-2\.5/.test(id)) {
    return ["low", "medium", "high"];
  }
  return [];
}

/** Effort values a model accepts; [] means the model has no effort control. */
export function effortLevelsFor(index: EffortIndex | null, modelId: string): string[] {
  if (!modelId) return [];
  if (index) {
    const hit = index[modelId] ?? index[modelId.split("/").pop() ?? modelId];
    if (hit !== undefined) return hit;
  }
  return heuristicLevels(modelId);
}

/** A sensible default when the user has not picked an effort for a model. */
export function defaultEffort(levels: string[]): string | null {
  if (levels.length === 0) return null;
  if (levels.includes("medium")) return "medium";
  return levels[Math.floor((levels.length - 1) / 2)];
}
