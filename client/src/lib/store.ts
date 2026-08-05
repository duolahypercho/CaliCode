import type { Asset, Entity, GameTest, Project, Script, Vec3 } from "./types";

export function uid(prefix = "id"): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function starterProject(): Project {
  return {
    schemaVersion: 1,
    slug: "starter",
    title: "Starter",
    entities: [
      {
        id: "floor",
        name: "Floor",
        kind: "plane",
        transform: { position: [0, 0, 0], rotation: [-Math.PI / 2, 0, 0], scale: [8, 8, 1] },
        material: { color: "#e7e0d6", metalness: 0.05, roughness: 0.9 },
        light: {},
        scriptIds: [],
        assetId: null,
      },
      {
        id: "hero",
        name: "Hero Cube",
        kind: "box",
        transform: { position: [0, 0.6, 0], rotation: [0, 0.7, 0], scale: [1, 1, 1] },
        material: { color: "#f97316", metalness: 0.2, roughness: 0.45 },
        light: {},
        scriptIds: ["spin"],
        assetId: "asset-cube",
      },
      {
        id: "key",
        name: "Key Light",
        kind: "light",
        transform: { position: [4, 6, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
        material: {},
        light: { type: "directional", intensity: 2.2, color: "#ffffff" },
        scriptIds: [],
        assetId: null,
      },
    ],
    scripts: [
      {
        id: "spin",
        name: "spin",
        code: "function update(entity, state, delta) {\n  entity.rotation.y += delta * 0.8;\n  return state;\n}",
      },
    ],
    assets: [
      {
        id: "asset-cube",
        name: "Cali Cube",
        type: "procedural",
        source: "procedural:box",
        tags: ["prop", "starter"],
        usage: ["hero"],
        thumbnail: null,
        metadata: { generator: "box" },
      },
    ],
    tests: [
      {
        id: "test-floor",
        name: "Floor exists",
        script: "assert(scene.entities.some((e) => e.name === 'Floor'), 'Floor is missing');",
      },
      {
        id: "test-hero",
        name: "Hero moves",
        script:
          "const before = entityFor('Hero Cube').rotation.y; await step(30); assert(Math.abs(entityFor('Hero Cube').rotation.y - before) > 0.1, 'Hero did not rotate');",
      },
    ],
    settings: { pie: { captureEvery: 3, fixedStepHz: 60 } },
  };
}

export function addEntity(project: Project, entity: Partial<Entity>): Project {
  const next: Entity = {
    id: uid("entity"),
    name: entity.name ?? "New Entity",
    kind: entity.kind ?? "box",
    transform: entity.transform ?? { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material: entity.material ?? { color: "#6b7280", metalness: 0.1, roughness: 0.7 },
    light: entity.light ?? {},
    scriptIds: entity.scriptIds ?? [],
    assetId: entity.assetId ?? null,
  };
  return { ...project, entities: [...project.entities, next] };
}

export function updateEntity(project: Project, id: string, patch: Partial<Entity>): Project {
  return {
    ...project,
    entities: project.entities.map((entity) => (entity.id === id ? { ...entity, ...patch } : entity)),
  };
}

export function removeEntity(project: Project, id: string): Project {
  return { ...project, entities: project.entities.filter((entity) => entity.id !== id) };
}

export function addScript(project: Project, script: Partial<Script>): Project {
  const next: Script = {
    id: uid("script"),
    name: script.name ?? "script",
    code: script.code ?? "function update(entity, state, delta) {\n  return state;\n}",
  };
  return { ...project, scripts: [...project.scripts, next] };
}

export function updateScript(project: Project, id: string, patch: Partial<Script>): Project {
  return {
    ...project,
    scripts: project.scripts.map((script) => (script.id === id ? { ...script, ...patch } : script)),
  };
}

export function addAsset(project: Project, asset: Partial<Asset>): Project {
  const next: Asset = {
    id: uid("asset"),
    name: asset.name ?? "Asset",
    type: asset.type ?? "procedural",
    source: asset.source ?? "procedural:box",
    tags: asset.tags ?? [],
    usage: asset.usage ?? [],
    thumbnail: asset.thumbnail ?? null,
    metadata: asset.metadata ?? {},
  };
  return { ...project, assets: [...project.assets, next] };
}

export function updateAsset(project: Project, id: string, patch: Partial<Asset>): Project {
  return {
    ...project,
    assets: project.assets.map((asset) => (asset.id === id ? { ...asset, ...patch } : asset)),
  };
}

export function addTest(project: Project, test: Partial<GameTest>): Project {
  const next: GameTest = {
    id: uid("test"),
    name: test.name ?? "New test",
    script: test.script ?? "assert(true, 'passes');",
  };
  return { ...project, tests: [...project.tests, next] };
}

export function clampVec3(value: Vec3): Vec3 {
  return value.map((v) => (Number.isFinite(v) ? v : 0)) as Vec3;
}

