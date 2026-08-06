import { useMemo } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { rpc } from "./rpc";
import { addAsset, addScript, uid, updateAsset, updateScript } from "./store";
import { assetObject, renderThumbnail } from "./procedural";
import { runTests } from "./testRunner";
import type { PieRuntime } from "./pie";
import type { Asset, BrowserTool, Entity, ModelList, Project, TestResult } from "./types";

export interface BrowserToolDeps {
  project: Project;
  setProject: Dispatch<SetStateAction<Project>>;
  runtimeRef: MutableRefObject<PieRuntime | null>;
  setModelList: Dispatch<SetStateAction<ModelList | null>>;
  setTestResults: Dispatch<SetStateAction<TestResult[]>>;
  setSelectedEntityId: Dispatch<SetStateAction<string | null>>;
  pushLog: (message: string, level?: "info" | "error") => void;
}

const VEC3 = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 } as const;
const GEOMETRY_KINDS = ["box", "sphere", "cylinder", "cone", "torus", "terrain", "plane"] as const;

/**
 * The editor's tool surface. Every entry is registered with the Rust core so
 * the agent drives the real editor rather than a mirrored copy of its state.
 */
export function useBrowserTools({
  project,
  setProject,
  runtimeRef,
  setModelList,
  setTestResults,
  setSelectedEntityId,
  pushLog,
}: BrowserToolDeps): BrowserTool[] {
  return useMemo<BrowserTool[]>(
    () => [
      {
        name: "editor_scene_inspect",
        description: "Inspect the current scene graph, entities, scripts, assets, and tests.",
        parameters: { type: "object", properties: {} },
        handler: async () => ({
          project: {
            slug: project.slug,
            entities: project.entities.map((entity) => ({
              id: entity.id,
              name: entity.name,
              kind: entity.kind,
              position: entity.transform.position,
              rotation: entity.transform.rotation,
              scale: entity.transform.scale,
              assetId: entity.assetId,
            })),
            scripts: project.scripts.map((script) => ({ id: script.id, name: script.name })),
            assets: project.assets.map((asset) => ({ id: asset.id, name: asset.name, type: asset.type, tags: asset.tags })),
            tests: project.tests.map((test) => ({ id: test.id, name: test.name })),
          },
        }),
      },
      {
        name: "editor_object_add",
        description: "Add an entity to the scene.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            kind: { type: "string", enum: [...GEOMETRY_KINDS, "light"] },
            position: VEC3,
            color: { type: "string" },
          },
          required: ["name", "kind"],
        },
        handler: async (args) => {
          const entity: Entity = {
            id: uid("entity"),
            name: String(args.name ?? "New Entity"),
            kind: String(args.kind ?? "box"),
            transform: {
              position: (args.position as [number, number, number]) ?? [0, 0.5, 0],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
            },
            material: { color: args.color ?? "#6b7280", metalness: 0.1, roughness: 0.7 },
            light: args.kind === "light" ? { type: "directional", intensity: 2, color: args.color ?? "#ffffff" } : {},
            scriptIds: [],
            assetId: null,
          };
          setProject((current) => ({ ...current, entities: [...current.entities, entity] }));
          return entity;
        },
      },
      {
        name: "editor_object_remove",
        description: "Remove an entity from the scene by id.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        handler: async (args) => {
          const id = String(args.id);
          setProject((current) => ({ ...current, entities: current.entities.filter((entity) => entity.id !== id) }));
          return { removed: id };
        },
      },
      {
        name: "editor_update_transform",
        description: "Update an entity transform.",
        parameters: {
          type: "object",
          properties: { id: { type: "string" }, position: VEC3, rotation: VEC3, scale: VEC3 },
          required: ["id"],
        },
        handler: async (args) => {
          const id = String(args.id);
          setProject((current) => ({
            ...current,
            entities: current.entities.map((entity) =>
              entity.id === id
                ? {
                    ...entity,
                    transform: {
                      position: (args.position as [number, number, number]) ?? entity.transform.position,
                      rotation: (args.rotation as [number, number, number]) ?? entity.transform.rotation,
                      scale: (args.scale as [number, number, number]) ?? entity.transform.scale,
                    },
                  }
                : entity,
            ),
          }));
          return { updated: id };
        },
      },
      {
        name: "editor_script_write",
        description: "Create or update a game script.",
        parameters: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" }, code: { type: "string" } },
          required: ["name", "code"],
        },
        handler: async (args) => {
          const script = { id: String(args.id ?? ""), name: String(args.name), code: String(args.code) };
          setProject((current) => {
            const existing = current.scripts.find((item) => item.id === script.id);
            return existing
              ? updateScript(current, existing.id, { name: script.name, code: script.code })
              : addScript(current, { name: script.name, code: script.code });
          });
          return { saved: script.name };
        },
      },
      {
        name: "editor_run_pie",
        description: "Start PIE so scripts and game logic run.",
        parameters: { type: "object", properties: { frames: { type: "number" } } },
        handler: async (args) => {
          const target = runtimeRef.current;
          if (!target) return { error: "runtime not ready" };
          target.start();
          await target.waitFrames(Number(args.frames ?? 12));
          target.pause();
          return { frames: target.frames, captures: target.frames };
        },
      },
      {
        name: "editor_capture_frame",
        description: "Capture the current frame as a screenshot.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
          const target = runtimeRef.current;
          if (!target) return { error: "runtime not ready" };
          return { dataUrl: target.capture() };
        },
      },
      {
        name: "editor_run_tests",
        description: "Run the project test suite and return pass/fail results.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
          const target = runtimeRef.current;
          if (!target) return { error: "runtime not ready" };
          const results = await runTests(project, target, project.tests, pushLog);
          setTestResults(results);
          return results;
        },
      },
      {
        name: "editor_asset_generate",
        description: "Generate a procedural asset in the workbench.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            kind: { type: "string", enum: [...GEOMETRY_KINDS] },
            color: { type: "string" },
            metalness: { type: "number" },
            roughness: { type: "number" },
          },
          required: ["name", "kind"],
        },
        handler: async (args) => {
          const asset: Asset = {
            id: uid("asset"),
            name: String(args.name),
            type: "procedural",
            source: `procedural:${args.kind}`,
            tags: ["agent"],
            usage: [],
            thumbnail: null,
            metadata: {
              generator: args.kind,
              color: args.color ?? "#f97316",
              metalness: args.metalness ?? 0.2,
              roughness: args.roughness ?? 0.45,
            },
          };
          setProject((current) => addAsset(current, asset));
          return asset;
        },
      },
      {
        name: "editor_asset_preview",
        description: "Render an asset thumbnail.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        handler: async (args) => {
          const asset = project.assets.find((item) => item.id === args.id);
          if (!asset) return { error: "asset not found" };
          const thumbnail = renderThumbnail(assetObject(asset));
          setProject((current) => updateAsset(current, asset.id, { thumbnail }));
          return { thumbnail };
        },
      },
      {
        name: "editor_promote_asset",
        description: "Add an asset to the scene as a new entity.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        handler: async (args) => {
          const asset = project.assets.find((item) => item.id === args.id);
          if (!asset) return { error: "asset not found" };
          const entity: Entity = {
            id: uid("entity"),
            name: asset.name,
            kind: String((asset.metadata?.generator as string) ?? "box"),
            transform: { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            material: { color: (asset.metadata?.color as string) ?? "#6b7280", metalness: 0.2, roughness: 0.5 },
            light: {},
            scriptIds: [],
            assetId: asset.id,
          };
          setProject((current) => ({
            ...current,
            entities: [...current.entities, entity],
            assets: current.assets.map((item) =>
              item.id === asset.id ? { ...item, usage: [...item.usage, entity.id] } : item,
            ),
          }));
          return entity;
        },
      },
      {
        name: "editor_project_save",
        description: "Persist the current scene, assets, scripts, and tests to the CaliCode project store.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
          await rpc("project_save", { project });
          return { saved: true, slug: project.slug };
        },
      },
      {
        name: "editor_project_checkpoint",
        description: "Create a revertible checkpoint of the current project.",
        parameters: { type: "object", properties: {} },
        handler: async () => rpc<{ id: string }>("project_checkpoint", { slug: project.slug }),
      },
      {
        name: "editor_model_switch",
        description: "Switch the CaliCode harness provider and model.",
        parameters: {
          type: "object",
          properties: { provider: { type: "string" }, model: { type: "string" } },
          required: ["provider", "model"],
        },
        handler: async (args) => {
          const list = await rpc<ModelList>("model_switch", {
            provider: String(args.provider),
            model: String(args.model),
          });
          setModelList(list);
          return { switched: true, provider: args.provider, model: args.model };
        },
      },
      {
        name: "editor_console_log",
        description: "Write a line to the editor console.",
        parameters: {
          type: "object",
          properties: { message: { type: "string" }, level: { type: "string", enum: ["info", "error"] } },
          required: ["message"],
        },
        handler: async (args) => {
          pushLog(String(args.message), args.level === "error" ? "error" : "info");
          return { logged: true };
        },
      },
      {
        name: "editor_select_entity",
        description: "Select or deselect an entity in the scene graph.",
        parameters: { type: "object", properties: { id: { type: "string" } } },
        handler: async (args) => {
          const id = args.id ? String(args.id) : null;
          setSelectedEntityId(id);
          return { selected: id };
        },
      },
      {
        name: "editor_test_add",
        description: "Add a scripted game test to the project.",
        parameters: {
          type: "object",
          properties: { name: { type: "string" }, script: { type: "string" } },
          required: ["name", "script"],
        },
        handler: async (args) => {
          const test = { id: uid("test"), name: String(args.name), script: String(args.script ?? "") };
          setProject((current) => ({ ...current, tests: [...current.tests, test] }));
          return test;
        },
      },
      {
        name: "editor_asset_import_file",
        description: "Import a base64-encoded image or 3D file into the asset library.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            data: { type: "string" },
            mime: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["name", "data", "mime"],
        },
        handler: async (args) => {
          const result = await rpc("asset_import_file", {
            slug: project.slug,
            name: String(args.name),
            data: String(args.data),
            mime: String(args.mime),
            tags: Array.isArray(args.tags) ? args.tags : [],
          });
          setProject(await rpc<Project>("project_open", { slug: project.slug }));
          return result;
        },
      },
    ],
    [project, pushLog, runtimeRef, setModelList, setProject, setSelectedEntityId, setTestResults],
  );
}
