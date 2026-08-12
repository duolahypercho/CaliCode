import { cleanup, fireEvent, render } from "@testing-library/react";
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
});
