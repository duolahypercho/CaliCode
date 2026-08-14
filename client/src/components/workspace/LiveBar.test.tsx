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
      <LiveBar stats={{ fps: 60, frameMs: 16.7, drawCalls: 3, entities: 2, loadMs: 40 }} pieState="running" />,
    );
    const chips = container.querySelector("[data-live-stats]");
    expect(chips?.textContent).toContain("SIG RUNNING");

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    expect(chips?.textContent).toContain("SIG BACKGROUND");
  });

  it("no longer carries a console: the log has one home, in the bottom dock", () => {
    // Two homes for one stream means the badge you notice is never the one you
    // have open, so the drawer moved out rather than being duplicated.
    render(<LiveBar stats={{ fps: 0, frameMs: 0, drawCalls: null, entities: 0, loadMs: 40 }} pieState="idle" />);

    expect(screen.queryByRole("button", { name: /CONSOLE/ })).toBeNull();
  });
});
