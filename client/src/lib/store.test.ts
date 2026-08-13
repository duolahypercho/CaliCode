import { describe, expect, it } from "vitest";
import { addEntity, addScript, removeAsset, removeEntity, starterProject, updateEntity } from "./store";

describe("project store", () => {
  it("ships awaited, evolution-safe starter checks with positive messages", () => {
    const tests = starterProject().tests;
    expect(tests.find((test) => test.id === "test-floor")).toMatchObject({
      name: "Playable surface exists",
      script: expect.stringContaining("await assert(scene.entities.some((e) => e.kind === 'plane')"),
    });
    expect(tests.find((test) => test.id === "test-hero")?.script).toContain(
      "await assert(Math.abs(entityFor('Hero Cube').rotation.y - before) > 0.1, 'Hero moves during PIE')",
    );
  });

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

  it("releases entities that referenced a removed asset instead of orphaning them", () => {
    const before = starterProject();
    expect(before.entities.find((entity) => entity.id === "hero")?.assetId).toBe("asset-cube");

    const project = removeAsset(before, "asset-cube");

    expect(project.assets.find((asset) => asset.id === "asset-cube")).toBeUndefined();
    // The reference is cleared, not left dangling: a stale id renders nothing
    // and reports no error, and the project autosaves with no undo.
    expect(project.entities.find((entity) => entity.id === "hero")?.assetId).toBeNull();
    // The entity itself survives with everything else intact — it loses its
    // mesh, which is exactly what the confirmation promises.
    expect(project.entities).toHaveLength(before.entities.length);
    expect(project.entities.find((entity) => entity.id === "hero")).toMatchObject({
      name: "Hero Cube",
      scriptIds: ["spin"],
      transform: before.entities.find((entity) => entity.id === "hero")?.transform,
    });
    // Unrelated entities are untouched.
    expect(project.entities.find((entity) => entity.id === "floor")).toEqual(
      before.entities.find((entity) => entity.id === "floor"),
    );
  });

  it("leaves the scene alone when the removed asset is unused", () => {
    const before = starterProject();
    const project = removeAsset(before, "asset-does-not-exist");
    expect(project.entities).toEqual(before.entities);
    expect(project.assets).toEqual(before.assets);
  });

  it("adds scripts", () => {
    const project = addScript(starterProject(), { name: "logic" });
    expect(project.scripts.at(-1)?.name).toBe("logic");
  });
});
