import { describe, expect, it, vi } from "vitest";

vi.mock("./rpc", () => ({ rpc: vi.fn() }));

import {
  contextWindowOf,
  DEFAULT_CONTEXT_LENGTH,
  sandboxSummary,
  type CoreConfig,
} from "./coreConfig";

const withOverride = (context_length: number | undefined): CoreConfig =>
  ({ compaction: { context_length } }) as unknown as CoreConfig;

describe("contextWindowOf", () => {
  it("uses the active model's advertised window when config names none", () => {
    // The meter and core's compaction budget must agree; this mirrors
    // `context_budget_tokens` in core/src/agent.rs.
    expect(contextWindowOf(withOverride(undefined), 1_000_000)).toBe(1_000_000);
    expect(contextWindowOf(null, 200_000)).toBe(200_000);
  });

  it("lets an explicit config override outrank the model's own limit", () => {
    // Someone who wrote `compaction.context_length` is usually correcting a
    // model whose advertised limit is wrong, so it wins.
    expect(contextWindowOf(withOverride(50_000), 1_000_000)).toBe(50_000);
  });

  it("falls back to the fixed default only when nothing else is known", () => {
    expect(contextWindowOf(null, null)).toBe(DEFAULT_CONTEXT_LENGTH);
    expect(contextWindowOf(null)).toBe(DEFAULT_CONTEXT_LENGTH);
    expect(contextWindowOf(withOverride(undefined), undefined)).toBe(DEFAULT_CONTEXT_LENGTH);
  });
});

describe("sandboxSummary", () => {
  it("says nothing at all when core has not reported", () => {
    // An old or unreachable core must not be turned into a claim either way.
    expect(sandboxSummary(undefined)).toBeNull();
  });

  it("names the reason confinement is off when there is one", () => {
    expect(
      sandboxSummary({
        enabled: false,
        allowNetwork: false,
        confineTerminal: false,
        unavailable: "sandbox-exec is missing",
      }),
    ).toBe("not sandboxed — sandbox-exec is missing");
    // Off by configuration rather than by circumstance: no reason to give.
    expect(
      sandboxSummary({ enabled: false, allowNetwork: false, confineTerminal: false }),
    ).toBe("not sandboxed");
  });

  it("scopes the claim to spawned processes, and reports network", () => {
    // The agent's own writes are path-confined, not sandboxed — describing
    // them as sandboxed would be the same untruth in the other direction.
    expect(
      sandboxSummary({ enabled: true, allowNetwork: false, confineTerminal: true }),
    ).toBe("spawns sandboxed · no network");
    expect(
      sandboxSummary({ enabled: true, allowNetwork: true, confineTerminal: true }),
    ).toBe("spawns sandboxed · network allowed");
  });
});
