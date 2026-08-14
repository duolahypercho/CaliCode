import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStatusPill } from "./RunStatusPill";
import type { GoalState } from "../../lib/goal";

const NOW = 1_700_000_000_000;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const goal = (overrides: Partial<GoalState> = {}): GoalState => ({
  goal: "make the jump test pass",
  startedAtMs: NOW - 12_000,
  evaluations: 3,
  ...overrides,
});

describe("RunStatusPill", () => {
  it("renders nothing when no goal or loop is running", () => {
    const { container } = render(<RunStatusPill goal={null} loop={null} onStop={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("names an active goal, its checks, and how long it has run", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<RunStatusPill goal={goal()} loop={null} onStop={() => undefined} />);

    expect(screen.getByText("Goal")).toBeTruthy();
    expect(screen.getByText("make the jump test pass")).toBeTruthy();
    expect(screen.getByText("3 checks")).toBeTruthy();
    expect(screen.getByText("12s")).toBeTruthy();
  });

  it("counts a single evaluation in the singular", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<RunStatusPill goal={goal({ evaluations: 1 })} loop={null} onStop={() => undefined} />);
    expect(screen.getByText("1 check")).toBeTruthy();
  });

  it("names a running loop and offers to stop it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const onStop = vi.fn();
    render(
      <RunStatusPill
        goal={null}
        loop={{ objective: "ship the arena", startedAtMs: NOW - 3_600_000 - 247_000 }}
        onStop={onStop}
      />,
    );

    expect(screen.getByText("Loop")).toBeTruthy();
    expect(screen.getByText("ship the arena")).toBeTruthy();
    expect(screen.getByText("1h 04m 07s")).toBeTruthy();
    // A loop reports no evaluator checks; showing "0 checks" would be a lie.
    expect(screen.queryByText(/check/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Stop loop" }));
    expect(onStop).toHaveBeenCalledWith("loop");
  });

  it("clears the goal from the pill", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const onStop = vi.fn();
    render(<RunStatusPill goal={goal()} loop={null} onStop={onStop} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear goal" }));
    expect(onStop).toHaveBeenCalledWith("goal");
  });

  it("ticks the elapsed label while the run continues", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<RunStatusPill goal={goal()} loop={null} onStop={() => undefined} />);

    expect(screen.getByText("12s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText("13s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("1m 13s")).toBeTruthy();
  });

  it("stops ticking once nothing is running", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { rerender } = render(<RunStatusPill goal={goal()} loop={null} onStop={() => undefined} />);
    expect(vi.getTimerCount()).toBe(1);

    rerender(<RunStatusPill goal={null} loop={null} onStop={() => undefined} />);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prefers the loop when a stale goal is still set — the loop owns Stop", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(
      <RunStatusPill goal={goal()} loop={{ objective: "ship the arena", startedAtMs: NOW }} onStop={() => undefined} />,
    );
    expect(screen.getByText("Loop")).toBeTruthy();
    expect(screen.queryByText("Goal")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop loop" })).toBeTruthy();
  });
});
