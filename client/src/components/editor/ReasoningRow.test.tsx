import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReasoningRow } from "./ReasoningRow";

afterEach(cleanup);

describe("ReasoningRow", () => {
  it("renders nothing when there is no reasoning and nothing is streaming", () => {
    const { container } = render(<ReasoningRow text="" streaming={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("shimmers a Thinking… header while streaming, even with no text yet", () => {
    render(<ReasoningRow text="" streaming />);
    const label = screen.getByText("Thinking…");
    expect(label.className).toContain("cb-shimmer");
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
  });

  it("switches to a duration label once streaming ends", () => {
    const { rerender } = render(<ReasoningRow text="step one" streaming />);
    rerender(<ReasoningRow text="step one" streaming={false} durationMs={4_200} />);
    expect(screen.getByText("Thought for 4s")).toBeTruthy();
    expect(screen.queryByText("Thinking…")).toBeNull();

    rerender(<ReasoningRow text="step one" streaming={false} durationMs={72_000} />);
    expect(screen.getByText("Thought for 1m 12s")).toBeTruthy();
  });

  it("shows the reasoning text while open and hides it once collapsed", () => {
    render(<ReasoningRow text={"first\nsecond"} streaming />);
    expect(screen.getByText(/first/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText(/first/)).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });

  it("auto-collapses shortly after streaming ends", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<ReasoningRow text="thought" streaming />);
      rerender(<ReasoningRow text="thought" streaming={false} durationMs={1_000} />);
      act(() => {
        vi.advanceTimersByTime(1_500);
      });
      expect(screen.queryByText("thought")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a manual toggle through the auto-collapse timer", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<ReasoningRow text="thought" streaming />);
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByRole("button"));
      rerender(<ReasoningRow text="thought" streaming={false} durationMs={1_000} />);
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.getByText("thought")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts collapsed and stays collapsed while streaming when defaultCollapsed is set", () => {
    render(<ReasoningRow text="saved thought" streaming defaultCollapsed />);
    expect(screen.queryByText("saved thought")).toBeNull();
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("saved thought")).toBeTruthy();
  });

  it("names the region for assistive technology", () => {
    render(<ReasoningRow text="thought" streaming={false} durationMs={2_000} />);
    expect(screen.getByRole("region", { name: "Model reasoning" })).toBeTruthy();
  });
});
