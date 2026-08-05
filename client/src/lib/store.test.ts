import { describe, expect, it } from "vitest";
import { addEntity, addScript, removeEntity, starterProject, updateEntity } from "./store";

describe("project store", () => {
  it("serializes to stable JSON", () => {
    const project = starterProject();
    const roundtrip = JSON.parse(JSON.stringify(project));
    expect(roundtrip).toEqual(project);
    expect(project.slug).toBe("starter");
  });

  it("adds, updates, and removes entities", () => {
    let project = addEntity(starterProject(), { name: "Test", kind: "sphere" });
    const entity = project.entities[project.entities.length - 1];
    expect(entity.name).toBe("Test");
    project = updateEntity(project, entity.id, { name: "Updated" });
    expect(project.entities.find((item) => item.id === entity.id)?.name).toBe("Updated");
    project = removeEntity(project, entity.id);
    expect(project.entities.find((item) => item.id === entity.id)).toBeUndefined();
  });

  it("adds scripts", () => {
    const project = addScript(starterProject(), { name: "logic" });
    expect(project.scripts.at(-1)?.name).toBe("logic");
  });
});

