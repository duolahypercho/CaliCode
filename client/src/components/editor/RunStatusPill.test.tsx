import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStatusPill } from "./RunStatusPill";

const NOW = 1_700_000_000_000;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RunStatusPill", () => {
  it("renders nothing when no loop is running", () => {
    const { container } = render(<RunStatusPill loop={null} onStop={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("names a running loop and offers to stop it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const onStop = vi.fn();
    render(
      <RunStatusPill
        loop={{ objective: "ship the arena", startedAtMs: NOW - 3_600_000 - 247_000 }}
        onStop={onStop}
      />,
    );

    expect(screen.getByText("Loop")).toBeTruthy();
    expect(screen.getByText("ship the arena")).toBeTruthy();
    expect(screen.getByText("1h 04m 07s")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop loop" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("labels a paced loop as a watch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(
      <RunStatusPill
        loop={{ objective: "watch CI", startedAtMs: NOW, every: "15m" }}
        onStop={() => undefined}
      />,
    );
    expect(screen.getByText("every 15m")).toBeTruthy();
  });

  it("ticks the elapsed label while the loop continues", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(
      <RunStatusPill
        loop={{ objective: "ship the arena", startedAtMs: NOW - 12_000 }}
        onStop={() => undefined}
      />,
    );

    expect(screen.getByText("12s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByText("1m 13s")).toBeTruthy();
  });

  it("stops ticking once the loop is gone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { rerender } = render(
      <RunStatusPill loop={{ objective: "ship", startedAtMs: NOW }} onStop={() => undefined} />,
    );
    expect(vi.getTimerCount()).toBe(1);

    rerender(<RunStatusPill loop={null} onStop={() => undefined} />);
    expect(vi.getTimerCount()).toBe(0);
  });
});
