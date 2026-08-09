import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TitleBar } from "./TitleBar";

/** Pretend the bundle is running inside the macOS Tauri webview. */
function enterDesktopShell() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
}

function leaveDesktopShell() {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  Object.defineProperty(navigator, "platform", { value: "", configurable: true });
}

function renderTitleBar() {
  return render(
    <TitleBar
      projectTitle="Neon Drift"
      modelList={null}
      onToggleSidebar={() => {}}
      onToggleAgent={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  leaveDesktopShell();
});

describe("TitleBar", () => {
  it("makes the whole header subtree a drag region so the window can be moved", () => {
    // A bare attribute only fires when the mousedown target *is* the header;
    // clicking the wordmark or project name would not drag. "deep" covers the
    // subtree, which is what makes the bar feel like a real title bar.

    // Arrange / Act
    renderTitleBar();

    // Assert
    const header = screen.getByRole("banner");
    expect(header.getAttribute("data-tauri-drag-region")).toBe("deep");
  });

  it("leaves the drag region declared once, on the header", () => {
    // Tauri's handler already exempts buttons inside a deep region, so nested
    // declarations would only be able to break the exemption.

    // Arrange / Act
    const { container } = renderTitleBar();

    // Assert
    expect(container.querySelectorAll("[data-tauri-drag-region]")).toHaveLength(1);
  });

  it("draws decorative dots and normal padding in the browser", () => {
    // Arrange / Act
    const { container } = renderTitleBar();

    // Assert
    const header = screen.getByRole("banner");
    expect(header.className).toContain("pl-4");
    expect(container.querySelectorAll("span.rounded-full")).toHaveLength(3);
  });

  it("drops the decorative dots and reserves the gutter under native traffic lights", () => {
    // Arrange
    enterDesktopShell();

    // Act
    const { container } = renderTitleBar();

    // Assert
    const header = screen.getByRole("banner");
    expect(header.className).toContain("pl-[82px]");
    expect(header.className).not.toContain("pl-4 ");
    expect(container.querySelectorAll("span.rounded-full")).toHaveLength(0);
  });
});
