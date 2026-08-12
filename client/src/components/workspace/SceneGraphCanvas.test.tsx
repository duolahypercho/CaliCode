import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../lib/types";
import { SceneGraphCanvas } from "./SceneGraphCanvas";

afterEach(cleanup);

const project: Project = {
  schemaVersion: 1,
  slug: "scene-test",
  title: "Scene test",
  entities: [
    {
      id: "hero",
      name: "Hero",
      kind: "box",
      transform: { position: [1, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      material: { color: "#6b7280", metalness: 0.1, roughness: 0.7 },
      light: {},
      scriptIds: [],
      assetId: null,
    },
  ],
  scripts: [],
  assets: [],
  tests: [],
  settings: {},
};

describe("SceneGraphCanvas", () => {
  it("selects an entity from one click on either its title or body", () => {
    const onSelect = vi.fn();
    render(
      <SceneGraphCanvas
        project={project}
        selectedEntityId={null}
        onSelect={onSelect}
        onAddEntity={() => {}}
        onPatchEntity={() => {}}
        onRemoveEntity={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Hero" }));
    expect(onSelect).toHaveBeenCalledWith("hero");

    onSelect.mockClear();
    fireEvent.click(screen.getByText(/1\.0, 0\.5, 0\.0/));
    expect(onSelect).toHaveBeenCalledWith("hero");
  });
});
