import { afterEach, describe, expect, it } from "vitest";
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

describe("GamesSidebar project actions", () => {
  it("opens the reference menu with a left click", async () => {
    // jsdom does not provide PointerEvent; Radix deliberately opens mouse
    // menus on pointer-down so a click can immediately move into the menu.
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
        workspace={null}
        onOpenFolder={() => {}}
      />,
    );

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
});
