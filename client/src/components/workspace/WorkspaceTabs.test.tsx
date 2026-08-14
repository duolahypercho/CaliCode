import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_TABS, WorkspaceTabs, nextTabId, tabKind, type WorkspaceTabId } from "./WorkspaceTabs";

afterEach(cleanup);

const ALL = [...WORKSPACE_TABS];

function renderTabs(overrides: Partial<Parameters<typeof WorkspaceTabs>[0]> = {}) {
  const props = {
    openTabs: ALL as WorkspaceTabId[],
    active: "art" as WorkspaceTabId,
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
  // jsdom implements no scrolling; the strip calls scrollIntoView on select.
  HTMLElement.prototype.scrollIntoView = vi.fn();
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

  it("scrolls the selected tab into view, so the strip cannot hide it", () => {
    // Opening a view from elsewhere — the header's side-chat button — can
    // select a tab sitting past the fade, leaving every visible tab inactive.
    renderTabs({ active: "reports" });

    const active = document.getElementById("workspace-tab-reports");
    expect(active?.scrollIntoView).toHaveBeenCalled();
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

  it("gives every tab a close control, revealed on hover", () => {
    // jsdom does not apply :hover, so the contract asserted here is that the
    // control exists and is reachable for each tab; the active one is visible
    // outright and the rest fade in with group-hover.
    renderTabs({ openTabs: ["play", "code"], active: "play" });

    expect(screen.getByRole("button", { name: "Close Play tab" }).className).toContain("opacity-100");
    const inactive = screen.getByRole("button", { name: "Close Code tab" });
    expect(inactive.className).toContain("opacity-0");
    expect(inactive.className).toContain("group-hover:opacity-100");
  });

  it("closes an inactive tab without selecting it first", () => {
    const { onClose, onChange } = renderTabs({ openTabs: ["play", "code"], active: "play" });

    fireEvent.click(screen.getByRole("button", { name: "Close Code tab" }));
    expect(onClose).toHaveBeenCalledWith("code");
    // Closing must not double as selecting — the pointer never hit the tab.
    expect(onChange).not.toHaveBeenCalled();
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

  it("shows the browser's own page title and favicon on its tab", () => {
    renderTabs({
      tabTitles: { browser: "Spaceship 3D models - Sketchfab" },
      tabIcons: { browser: "data:image/png;base64,ICON" },
    });
    const tab = screen.getByRole("tab", { name: "browser" });
    expect(tab.textContent).toContain("Spaceship 3D models - Sketchfab");
    expect(tab.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,ICON");
    // The accessible name is the handle keyboard users and e2e specs address a
    // view by; a page title must never move it.
    expect(tab.getAttribute("aria-label")).toBe("browser");
    // Other tabs keep their own label and glyph.
    expect(screen.getByRole("tab", { name: "play" }).textContent).toContain("Play");
    expect(screen.getByRole("tab", { name: "play" }).querySelector("img")).toBeNull();
  });

  it("falls back to the view's own name when no page is open", () => {
    renderTabs({ tabTitles: { browser: "   " }, tabIcons: {} });
    const tab = screen.getByRole("tab", { name: "browser" });
    // A blank title is what an empty browser reports; showing it would leave
    // the tab nameless.
    expect(tab.textContent).toContain("Browser");
    expect(tab.querySelector("img")).toBeNull();
  });

  it("offers the hide control only when the host supplies one", () => {
    renderTabs({ onCollapse: vi.fn() });
    expect(screen.getByRole("button", { name: "Hide tools panel" })).toBeTruthy();

    cleanup();
    renderTabs();
    expect(screen.queryByRole("button", { name: "Hide tools panel" })).toBeNull();
  });
});

describe("repeatable views", () => {
  it("splits an instance id into its view", () => {
    expect(tabKind("sidechat")).toBe("sidechat");
    expect(tabKind("sidechat-4")).toBe("sidechat");
  });

  it("allocates the bare id first, then numbers the rest", () => {
    expect(nextTabId("sidechat", ["play"])).toBe("sidechat");
    expect(nextTabId("sidechat", ["play", "sidechat"])).toBe("sidechat-2");
    expect(nextTabId("sidechat", ["play", "sidechat", "sidechat-2"])).toBe("sidechat-3");
    // A gap left by closing the middle one is reused rather than skipped.
    expect(nextTabId("sidechat", ["sidechat", "sidechat-3"])).toBe("sidechat-2");
  });

  it("shows one tab per side chat, each addressable on its own", () => {
    const { onClose } = renderTabs({
      openTabs: ["play", "sidechat", "sidechat-2"],
      active: "sidechat-2",
      tabTitles: { "sidechat-2": "Side chat 2" },
    });

    // The first keeps the bare name the e2e specs address a view by.
    expect(screen.getByRole("tab", { name: "sidechat" }).textContent).toContain("Side chat");
    const second = screen.getByRole("tab", { name: "sidechat-2" });
    expect(second.textContent).toContain("Side chat 2");
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(second.getAttribute("aria-controls")).toBe("workspace-panel-sidechat-2");

    // Close buttons are named for the tab they close, not the view.
    fireEvent.click(screen.getByRole("button", { name: "Close Side chat 2 tab" }));
    expect(onClose).toHaveBeenCalledWith("sidechat-2");
  });

  it("keeps Add view for closed views only, so a second side chat is deliberate", () => {
    renderTabs({ openTabs: ALL, active: "play" });
    expect(screen.getByRole("button", { name: "Add view" }).hasAttribute("disabled")).toBe(true);
  });
});
