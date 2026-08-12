// Per-model reasoning metadata, opencode-style, sourced through the official
// typed models.dev client (`@opencode-ai/models` — the same catalog opencode's
// picker is built on) and reduced to the one question our picker asks: which
// reasoning-effort values does this model accept? Non-reasoning models get [],
// reasoning models get their declared effort values, and budget/toggle models
// get sensible presets.

import { Models } from "@opencode-ai/models";
import type { Model, ProviderMap } from "@opencode-ai/models";

const CACHE_KEY = "calicode-modeldev-v2";
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

export interface ModelDevData {
  index: EffortIndex;
  catalog: Record<string, string[]>;
}

interface CachedIndex {
  at: number;
  index: EffortIndex;
  catalog: Record<string, string[]>;
}

function readCache(): CachedIndex | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedIndex;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.at !== "number") return null;
    if (typeof parsed.catalog !== "object" || parsed.catalog === null) return null;
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
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { index: cached.index, catalog: cached.catalog };
  try {
    const providers = await Models.make().providers();
    const data: ModelDevData = { index: reduceRegistry(providers), catalog: reduceCatalog(providers) };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), ...data } satisfies CachedIndex));
    } catch {
      /* cache is an optimisation, not a requirement */
    }
    return data;
  } catch {
    // Offline: a stale answer still beats guessing, and the bundled snapshot
    // (regenerated with every package release) beats an empty index.
    if (cached) return { index: cached.index, catalog: cached.catalog };
    try {
      const snapshot = await import("@opencode-ai/models/snapshot");
      return { index: reduceRegistry(snapshot.providers), catalog: reduceCatalog(snapshot.providers) };
    } catch {
      return { index: {}, catalog: {} };
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
