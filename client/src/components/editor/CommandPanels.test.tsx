import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CommandPanelView } from "./CommandPanels";
import type { CommandPanel } from "../../lib/types";

afterEach(cleanup);

const usage = (overrides: Partial<Extract<CommandPanel, { kind: "usage" }>> = {}) =>
  ({
    kind: "usage",
    promptTokens: 120_000,
    completionTokens: 8_400,
    cacheReadTokens: 96_000,
    totalTokens: 128_400,
    lastPromptTokens: 45_000,
    lastCacheReadTokens: 30_000,
    contextWindow: 200_000,
    autoCompactAt: 0.75,
    ...overrides,
  }) as Extract<CommandPanel, { kind: "usage" }>;

describe("usage panel", () => {
  it("reads context occupancy as a percentage of the window", () => {
    render(<CommandPanelView panel={usage()} />);
    expect(screen.getByText("23%")).toBeTruthy();
    expect(screen.getByText("45k / 200k")).toBeTruthy();
  });

  it("names the auto-compaction state in words, not colour alone", () => {
    render(<CommandPanelView panel={usage()} />);
    expect(screen.getByText("Auto-compacts at 75%")).toBeTruthy();
  });

  it("says so when the context has passed the compaction mark", () => {
    render(<CommandPanelView panel={usage({ lastPromptTokens: 180_000 })} />);
    expect(screen.getByText(/Over the 75% auto-compaction mark/)).toBeTruthy();
  });

  it("says so when auto-compaction is off rather than implying a threshold", () => {
    render(<CommandPanelView panel={usage({ autoCompactAt: null })} />);
    expect(screen.getByText("Auto-compaction is off")).toBeTruthy();
  });

  it("survives a zero window instead of rendering NaN%", () => {
    render(<CommandPanelView panel={usage({ contextWindow: 0, lastPromptTokens: 0 })} />);
    expect(screen.getByText("0%")).toBeTruthy();
  });
});

describe("help panel", () => {
  const help: CommandPanel = {
    kind: "help",
    commands: [
      { name: "loop", usage: "[interval] <goal>", summary: "Work toward a goal" },
      { name: "playtest", usage: "[task]", summary: "Drive the game", kind: "skill" as const },
      { name: "review", usage: "<pr>", summary: "Review a PR", kind: "command" as const },
    ],
  };

  it("groups skills and file commands apart from built-in commands", () => {
    render(<CommandPanelView panel={help} />);
    expect(screen.getByText("Commands")).toBeTruthy();
    expect(screen.getByText("Skills")).toBeTruthy();
    expect(screen.getByText("Your commands")).toBeTruthy();
    expect(screen.getByText("/loop")).toBeTruthy();
    expect(screen.getByText("/playtest")).toBeTruthy();
    expect(screen.getByText("/review")).toBeTruthy();
  });

  it("drops the skills and file-command groups entirely when none exist", () => {
    render(<CommandPanelView panel={{ ...help, commands: [help.commands[0]] }} />);
    expect(screen.queryByText("Skills")).toBeNull();
    expect(screen.queryByText("Your commands")).toBeNull();
  });
});
