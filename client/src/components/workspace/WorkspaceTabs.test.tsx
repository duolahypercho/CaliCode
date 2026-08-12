import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "./WorkspaceTabs";

afterEach(cleanup);

describe("WorkspaceTabs", () => {
  it("exposes the game workspace tools with stable accessible names", () => {
    render(<WorkspaceTabs active="art" onChange={() => {}} badges={{ test: 2 }} />);

    for (const name of ["play", "code", "art", "build", "scene", "test", "reports"]) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    expect(screen.getByRole("tab", { name: "art" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "test" }).textContent).toContain("2");
  });

  it("moves through tools with arrow keys", () => {
    const onChange = vi.fn();
    render(<WorkspaceTabs active="play" onChange={onChange} badges={{}} />);

    fireEvent.keyDown(screen.getByRole("tab", { name: "play" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("code");
  });

  it("supports Home and End for keyboard users", () => {
    const onChange = vi.fn();
    render(<WorkspaceTabs active="scene" onChange={onChange} badges={{}} />);

    fireEvent.keyDown(screen.getByRole("tab", { name: "scene" }), { key: "Home" });
    fireEvent.keyDown(screen.getByRole("tab", { name: "scene" }), { key: "End" });

    expect(onChange).toHaveBeenNthCalledWith(1, "play");
    expect(onChange).toHaveBeenNthCalledWith(2, "reports");
  });
});
