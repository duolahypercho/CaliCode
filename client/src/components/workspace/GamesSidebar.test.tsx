import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GamesSidebar } from "./GamesSidebar";
import type { Project } from "../../lib/types";

const project: Project = {
  schemaVersion: 1,
  slug: "starter",
  title: "CaliCode Starter",
  entities: [],
  scripts: [],
  assets: [],
  tests: [],
  settings: {},
};

afterEach(cleanup);

function renderSidebar(onProjectAction = vi.fn()) {
  window.PointerEvent = MouseEvent as typeof PointerEvent;
  return render(
    <GamesSidebar
      projects={[project]}
      activeSlug={project.slug}
      sessions={{}}
      activeSessionId={null}
      onOpenProject={() => {}}
      onSelectSession={() => {}}
      onNewSession={() => {}}
      onNewGame={() => {}}
      onProjectAction={onProjectAction}
      workspace={null}
      onOpenFolder={() => {}}
    />,
  );
}

describe("GamesSidebar project actions", () => {
  it("opens the reference menu with a left click", async () => {
    // jsdom does not provide PointerEvent; Radix deliberately opens mouse
    // menus on pointer-down so a click can immediately move into the menu.
    renderSidebar();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Open actions for CaliCode Starter" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(await screen.findByRole("menuitem", { name: "Pin project" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Reveal in Finder" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Create permanent worktree" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Edit project" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Archive chats" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Remove" })).toBeTruthy();
  });

  it("opens the same menu when the project row is right-clicked", async () => {
    renderSidebar();

    fireEvent.contextMenu(screen.getByRole("button", { name: "CaliCode Starter 0" }));

    expect(await screen.findByRole("menuitem", { name: "Pin project" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Remove" })).toBeTruthy();
  });

  it("keeps the ellipsis hidden until hover or keyboard focus", () => {
    renderSidebar();

    const trigger = screen.getByRole("button", { name: "Open actions for CaliCode Starter" });
    expect(trigger.className).toContain("opacity-0");
    expect(trigger.className).toContain("group-hover:opacity-100");
    expect(trigger.className).toContain("group-focus-within:opacity-100");
  });

  it("dispatches each selected action for the project", async () => {
    const onProjectAction = vi.fn();
    renderSidebar(onProjectAction);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Open actions for CaliCode Starter" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit project" }));

    expect(onProjectAction).toHaveBeenCalledWith(project, "edit");
  });

  it("shows unpin for a pinned project and dispatches the pin toggle", async () => {
    const onProjectAction = vi.fn();
    window.PointerEvent = MouseEvent as typeof PointerEvent;
    render(
      <GamesSidebar
        projects={[project]}
        activeSlug={project.slug}
        sessions={{}}
        activeSessionId={null}
        onOpenProject={() => {}}
        onSelectSession={() => {}}
        onNewSession={() => {}}
        onNewGame={() => {}}
        pinnedProjectSlugs={[project.slug]}
        onProjectAction={onProjectAction}
        workspace={null}
        onOpenFolder={() => {}}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "CaliCode Starter 0" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin project" }));
    expect(onProjectAction).toHaveBeenCalledWith(project, "pin");
  });
});
