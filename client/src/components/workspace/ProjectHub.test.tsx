import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Project } from "../../lib/types";
import { ProjectHub } from "./ProjectHub";

afterEach(cleanup);

const project: Project = {
  schemaVersion: 1,
  slug: "skyline",
  title: "Skyline",
  entities: [],
  scripts: [],
  assets: [],
  tests: [],
  settings: {},
  workspaceRoot: "/Users/dev/games/skyline",
};

describe("ProjectHub", () => {
  it("lists projects with their workspace context and opens one", () => {
    const onOpenProject = vi.fn();
    render(
      <ProjectHub
        projects={[project]}
        sessions={{ skyline: [] }}
        activeSlug={project.slug}
        onOpenProject={onOpenProject}
        onNewProject={() => undefined}
      />,
    );

    expect(screen.getByRole("heading", { name: "Choose a game to work on." })).toBeTruthy();
    expect(screen.getByText("skyline")).toBeTruthy();
    expect(screen.getByText("No chats yet")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open Skyline" }));
    expect(onOpenProject).toHaveBeenCalledWith("skyline");
  });

  it("offers a create action when the project list is empty", () => {
    const onNewProject = vi.fn();
    render(
      <ProjectHub
        projects={[]}
        sessions={{}}
        activeSlug="starter"
        coreStatus="offline"
        onOpenProject={() => undefined}
        onNewProject={onNewProject}
      />,
    );

    expect(screen.getByRole("heading", { name: "Start with a game" })).toBeTruthy();
    expect(screen.getByText("Core is offline. Reconnect to load saved projects.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create or open a game" }));
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });
});

