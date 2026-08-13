import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LiveBar } from "./LiveBar";

const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");

afterEach(() => {
  cleanup();
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
});

describe("LiveBar", () => {
  it("labels a throttled background runtime instead of reporting a false stall", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const { container } = render(
      <LiveBar
        stats={{ fps: 60, frameMs: 16.7, drawCalls: 3, entities: 2, loadMs: 40 }}
        pieState="running"
        logs={[]}
      />,
    );
    const chips = container.querySelector("[data-live-stats]");
    expect(chips?.textContent).toContain("SIG RUNNING");

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    expect(chips?.textContent).toContain("SIG BACKGROUND");
  });

  it("counts errors on the console control and opens it on the first one", () => {
    const stats = { fps: 0, frameMs: 0, drawCalls: null, entities: 0, loadMs: 40 };
    const { rerender } = render(<LiveBar stats={stats} pieState="idle" logs={[]} />);

    // The console ships collapsed; a save failure must not need to be
    // suspected before it can be found.
    expect(screen.getByRole("button", { name: "CONSOLE" }).getAttribute("aria-expanded")).toBe("false");

    rerender(
      <LiveBar
        stats={stats}
        pieState="idle"
        logs={[
          { id: "1", level: "info", message: "saved demo", time: "10:00:00" },
          { id: "2", level: "error", message: "save failed: core offline", time: "10:00:01" },
          { id: "3", level: "error", message: "file tree failed", time: "10:00:02" },
        ]}
      />,
    );

    const control = screen.getByRole("button", { name: "CONSOLE, 2 errors" });
    expect(control.getAttribute("aria-expanded")).toBe("true");
    expect(control.querySelector("[data-console-errors]")?.textContent).toBe("2");
    expect(screen.getByText(/save failed: core offline/)).toBeTruthy();
  });

  it("leaves the console closed once the user closes it again", () => {
    const stats = { fps: 0, frameMs: 0, drawCalls: null, entities: 0, loadMs: 40 };
    const logs = [{ id: "1", level: "error" as const, message: "save failed", time: "10:00:00" }];
    const { rerender } = render(<LiveBar stats={stats} pieState="idle" logs={logs} />);

    fireEvent.click(screen.getByRole("button", { name: "CONSOLE, 1 error" }));
    rerender(
      <LiveBar
        stats={stats}
        pieState="idle"
        logs={[...logs, { id: "2", level: "error", message: "save failed again", time: "10:00:01" }]}
      />,
    );

    expect(screen.getByRole("button", { name: "CONSOLE, 2 errors" }).getAttribute("aria-expanded")).toBe("false");
  });
});
