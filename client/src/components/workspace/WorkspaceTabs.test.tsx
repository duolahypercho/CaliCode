import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_TABS, WorkspaceTabs, type WorkspaceTab } from "./WorkspaceTabs";

afterEach(cleanup);

const ALL = [...WORKSPACE_TABS];

function renderTabs(overrides: Partial<Parameters<typeof WorkspaceTabs>[0]> = {}) {
  const props = {
    openTabs: ALL as WorkspaceTab[],
    active: "art" as WorkspaceTab,
    onChange: vi.fn(),
    onAdd: vi.fn(),
    onClose: vi.fn(),
    badges: {},
    expanded: false,
    onToggleExpand: vi.fn(),
    ...overrides,
  };
  // jsdom has no PointerEvent, and Radix opens mouse menus on pointer-down.
  window.PointerEvent = MouseEvent as typeof PointerEvent;
  render(<WorkspaceTabs {...props} />);
  return props;
}

describe("WorkspaceTabs", () => {
  it("exposes the game workspace tools with stable accessible names", () => {
    renderTabs({ badges: { test: 2 } });

    for (const name of ALL) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    expect(screen.getByRole("tab", { name: "art" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "test" }).textContent).toContain("2");
  });

  it("moves through tools with arrow keys", () => {
    const { onChange } = renderTabs({ active: "play" });

    fireEvent.keyDown(screen.getByRole("tab", { name: "play" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("code");
  });

  it("supports Home and End for keyboard users", () => {
    const { onChange } = renderTabs({ active: "scene" });

    fireEvent.keyDown(screen.getByRole("tab", { name: "scene" }), { key: "Home" });
    fireEvent.keyDown(screen.getByRole("tab", { name: "scene" }), { key: "End" });

    expect(onChange).toHaveBeenNthCalledWith(1, "play");
    expect(onChange).toHaveBeenNthCalledWith(2, "reports");
  });

  it("arrows wrap within the open strip, not the full view list", () => {
    // A closed view must not be reachable by keyboard — it has no panel.
    const { onChange } = renderTabs({ openTabs: ["play", "test"], active: "test" });

    fireEvent.keyDown(screen.getByRole("tab", { name: "test" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("play");
  });

  it("renders only the open tabs", () => {
    renderTabs({ openTabs: ["play", "code"], active: "play" });

    expect(screen.getByRole("tab", { name: "play" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "scene" })).toBeNull();
  });

  it("closes a tab through its own control", () => {
    const { onClose } = renderTabs({ openTabs: ["play", "code"], active: "play" });

    fireEvent.click(screen.getByRole("button", { name: "Close Play tab" }));
    expect(onClose).toHaveBeenCalledWith("play");
  });

  it("hides the close control when one tab is left, so the dock cannot be emptied", () => {
    renderTabs({ openTabs: ["play"], active: "play" });

    expect(screen.queryByRole("button", { name: /Close .* tab/ })).toBeNull();
  });

  it("offers only unopened views under the add button", async () => {
    const { onAdd } = renderTabs({ openTabs: ["play", "code"], active: "play" });

    fireEvent.pointerDown(screen.getByRole("button", { name: "Add view" }), { button: 0, ctrlKey: false });
    // Radix renders the menu in a portal; the already-open views are absent.
    const scene = await screen.findByRole("menuitem", { name: "Scene" });
    expect(screen.queryByRole("menuitem", { name: "Play" })).toBeNull();

    fireEvent.click(scene);
    expect(onAdd).toHaveBeenCalledWith("scene");
  });

  it("disables the add button once every view is open", () => {
    renderTabs();
    expect(screen.getByRole("button", { name: "Add view" }).hasAttribute("disabled")).toBe(true);
  });

  it("toggles full screen and names the action for its current state", () => {
    const { onToggleExpand } = renderTabs();
    fireEvent.click(screen.getByRole("button", { name: "Expand to full screen" }));
    expect(onToggleExpand).toHaveBeenCalled();

    cleanup();
    renderTabs({ expanded: true });
    expect(screen.getByRole("button", { name: "Exit full screen" })).toBeTruthy();
  });

  it("offers the hide control only when the host supplies one", () => {
    renderTabs({ onCollapse: vi.fn() });
    expect(screen.getByRole("button", { name: "Hide tools panel" })).toBeTruthy();

    cleanup();
    renderTabs();
    expect(screen.queryByRole("button", { name: "Hide tools panel" })).toBeNull();
  });
});
