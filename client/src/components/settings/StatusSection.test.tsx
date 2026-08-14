import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StatusSection } from "./StatusSection";
import type { UsageStats } from "../../lib/types";

vi.mock("../../lib/rpc", () => ({ rpc: vi.fn(), currentCoreStatus: vi.fn(() => "offline") }));

import { currentCoreStatus, rpc } from "../../lib/rpc";

const mockRpc = vi.mocked(rpc);
const mockCoreStatus = vi.mocked(currentCoreStatus);

/** Day keys counting back from a fixed "today", so the grid is deterministic. */
const TODAY = "2026-08-14";
const dayKey = (offset: number): string =>
  new Date(Date.UTC(2026, 7, 14) - offset * 86_400_000).toISOString().slice(0, 10);

const day = (offset: number, tokens: number, rate: number | null): UsageStats["days"][number] => ({
  date: dayKey(offset),
  requests: 2,
  promptTokens: Math.round(tokens * 0.3),
  cacheReadTokens: Math.round(tokens * 0.6),
  cacheWriteTokens: 0,
  completionTokens: Math.round(tokens * 0.1),
  totalTokens: tokens,
  promptTotal: Math.round(tokens * 0.9),
  cacheHitRate: rate,
});

const stats = (): UsageStats => ({
  since: 1_760_000_000,
  today: TODAY,
  days: [day(4, 4_000, 0.4), day(3, 9_000, 0.9), day(2, 1_000, 0.1), day(1, 6_000, 0.6), day(0, 8_000, 0.8)],
  activity: {
    activeDays: 5,
    currentStreak: 5,
    longestStreak: 5,
    busiestDay: { date: dayKey(3), totalTokens: 9_000 },
  },
  models: [
    {
      key: "anthropic/claude-opus-5",
      provider: "anthropic",
      model: "claude-opus-5",
      requests: 12,
      promptTokens: 1_000,
      cacheReadTokens: 9_000,
      cacheWriteTokens: 0,
      completionTokens: 500,
      totalTokens: 10_500,
      promptTotal: 10_000,
      cacheHitRate: 0.9,
    },
    {
      key: "openai/gpt-5",
      provider: "openai",
      model: "gpt-5",
      requests: 3,
      promptTokens: 400,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      completionTokens: 50,
      totalTokens: 550,
      promptTotal: 500,
      cacheHitRate: 0.2,
    },
  ],
  totals: {
    requests: 15,
    promptTokens: 1_400,
    cacheReadTokens: 9_100,
    cacheWriteTokens: 0,
    completionTokens: 550,
    totalTokens: 11_050,
    promptTotal: 10_500,
    cacheHitRate: 0.8667,
  },
});

beforeEach(() => {
  mockCoreStatus.mockReturnValue("offline");
  mockRpc.mockImplementation(async (method: string) => {
    if (method === "usage_stats" || method === "usage_reset") return stats();
    throw new Error(`unexpected rpc: ${method}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StatusSection", () => {
  it("renders core's totals and one row per model, busiest first", async () => {
    render(<StatusSection />);

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("usage_stats"));

    // Totals come from core verbatim — 0.8667 rounds for display only.
    const totals = screen.getByRole("region", { name: "Token usage" });
    expect(within(totals).getByText("87%")).toBeTruthy();
    // Compact in the strip, exact in the table below it.
    expect(within(totals).getByText("11.1K")).toBeTruthy();
    expect(within(totals).getByText("9.1K")).toBeTruthy();
    expect(within(totals).getByText("5d")).toBeTruthy();

    const rows = await screen.findAllByRole("row");
    // Header plus one row per model.
    expect(rows).toHaveLength(3);
    // claude-opus-5 has the larger totalTokens, so it sorts first.
    expect(within(rows[1]).getByText("claude-opus-5")).toBeTruthy();
    expect(within(rows[1]).getByText("90%")).toBeTruthy();
    expect(within(rows[2]).getByText("gpt-5")).toBeTruthy();
    expect(within(rows[2]).getByText("20%")).toBeTruthy();
  });

  it("draws a heatmap cell per day and a trend bar per active day", async () => {
    render(<StatusSection />);
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("usage_stats"));

    const heatmap = screen.getByRole("region", { name: "Token activity" });
    // 53 whole weeks, so the column count never jitters as the year rolls.
    expect(heatmap.querySelectorAll("span[title]").length).toBeGreaterThan(300);
    // The busiest day is titled with its real total, not a bucket index.
    expect(within(heatmap).getByTitle(/9,000 tokens/)).toBeTruthy();

    const trend = screen.getByRole("region", { name: "Cache hit rate over time" });
    expect(within(trend).getAllByTitle(/prompt tokens$/)).toHaveLength(5);
    // (40+90+10+60+80)/5 = 56%
    expect(within(trend).getByText(/56% average over 5 active days/)).toBeTruthy();
  });

  it("drops idle days from the trend rather than plotting them as a zero-rate collapse", async () => {
    mockRpc.mockImplementation(async () => ({
      ...stats(),
      days: [day(2, 5_000, 0.5), { ...day(1, 0, null), promptTotal: 0 }, day(0, 5_000, 0.7)],
    }));

    render(<StatusSection />);
    const trend = await screen.findByRole("region", { name: "Cache hit rate over time" });
    await waitFor(() => expect(within(trend).getAllByTitle(/prompt tokens$/)).toHaveLength(2));
    expect(within(trend).getByText(/60% average over 2 active days/)).toBeTruthy();
  });

  it("shows an empty state rather than a zeroed table before any model call", async () => {
    mockRpc.mockImplementation(async () => ({
      since: 1_760_000_000,
      today: TODAY,
      days: [],
      activity: { activeDays: 0, currentStreak: 0, longestStreak: 0, busiestDay: null },
      models: [],
      totals: {
        requests: 0,
        promptTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        promptTotal: 0,
        cacheHitRate: null,
      },
    }));

    render(<StatusSection />);

    expect(await screen.findByText("No model calls recorded yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    // A null rate is a dash, never 0% — an unasked cache is not a failing one.
    const totals = screen.getByRole("region", { name: "Token usage" });
    expect(within(totals).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("reports core being unreachable instead of rendering zeros as fact", async () => {
    mockRpc.mockImplementation(async () => {
      throw new Error("offline");
    });

    render(<StatusSection />);

    expect(await screen.findByText(/Core is unavailable/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("blames the call, not the network, when core answered and refused", async () => {
    // The transport is up — rpc.ts published "ready" — so an outage message
    // here would hide the only sentence that says what actually went wrong.
    mockCoreStatus.mockReturnValue("ready");
    mockRpc.mockImplementation(async () => {
      throw new Error("Method not found: usage_stats");
    });

    render(<StatusSection />);

    expect(await screen.findByText(/Method not found: usage_stats/)).toBeTruthy();
    expect(screen.queryByText(/Core is unavailable/)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("reset asks core and adopts the ledger core returns", async () => {
    render(<StatusSection />);
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("usage_stats"));

    fireEvent.click(screen.getByRole("button", { name: /Reset/ }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("usage_reset"));
  });
});
