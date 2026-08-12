import { useCallback, useMemo, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { rpc } from "./rpc";
import { addAsset, uid, updateAsset, updateEntity, updateScript, updateTest } from "./store";
import { assetObject, renderThumbnail } from "./procedural";
import { runTests } from "./testRunner";
import {
  BUILDER_OPS_SCHEMA,
  describeSpec,
  emptySpec,
  specFromProcedural,
  type ApplyResult,
  type BuilderOp,
} from "./assetBuilderOps";
import type { CaliSpec } from "./assetPipeline";
import type { CameraFrameOptions, CameraFrameResult, PieRuntime } from "./pie";
import type {
  Asset,
  BrowserTool,
  CapturedFrame,
  Entity,
  GameTest,
  Project,
  Script,
  TestResult,
  Vec3,
} from "./types";

export interface BrowserToolDeps {
  project: Project;
  setProject: Dispatch<SetStateAction<Project>>;
  /** Mark a project snapshot as already persisted before adopting it live. */
  adoptSaved?: (project: Project) => Project;
  runtimeRef: MutableRefObject<PieRuntime | null>;
  setTestResults: Dispatch<SetStateAction<TestResult[]>>;
  setSelectedEntityId: Dispatch<SetStateAction<string | null>>;
  pushLog: (message: string, level?: "info" | "error") => void;
  /**
   * Snapshot of the editor console log buffer. Required for the
   * `editor_console_history` read tool; optional so a host that does not
   * expose its buffer (or wires the tool up later) compiles without a
   * change to its call site. When absent, the tool returns an empty list
   * with a notice the agent can act on.
   */
  getLogs?: () => readonly { id: string; level: "info" | "error"; message: string; time: string }[];
  /** Asset currently open in the 3D builder; the default target for builder tools. */
  builderAssetId: string | null;
  setBuilderAssetId: Dispatch<SetStateAction<string | null>>;
  /** Bring the BUILD workspace tab to the front so the user watches the agent build. */
  focusBuilderTab: () => void;
  /** App-owned single mutation path: applyOps + updateAsset + setProject. */
  applyBuilderOps: (assetId: string, ops: BuilderOp[]) => ApplyResult;
  /** Replace the spec wholesale (open-time conversion; no reducer). */
  replaceBuilderSpec: (assetId: string, spec: CaliSpec) => void;
  /** Persist project + `.cali.json`; falls back to project_save + project_asset_write. */
  saveBuilderAsset?: (assetId: string) => Promise<void>;
}

const VEC3 = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 } as const;
const GEOMETRY_KINDS = ["box", "sphere", "cylinder", "cone", "torus", "terrain", "plane"] as const;
const ENTITY_KINDS = [...GEOMETRY_KINDS, "light"] as const;

type ProjectMutation<T> = {
  project: Project;
  result: T;
};

type ToolError = { error: string };
type EntityToolResult = { updated: string } | ToolError;
type ScriptToolResult = { saved: string; id: string; created: boolean } | ToolError;
type TestToolResult = { saved: string; id: string; created: boolean } | ToolError;

export interface LiveImage3dMeshDeps {
  currentProject: () => Project;
  saveProject: (project: Project) => Promise<unknown>;
  generateMesh: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  openProject: (slug: string) => Promise<Project>;
  adoptProject: (project: Project) => Project;
}

/**
 * Run the image-to-mesh RPC as one live-editor transaction.
 *
 * Core mutates the saved project while the browser still has a React snapshot.
 * Saving first prevents those local edits from being dropped; reopening and
 * adopting immediately after generation makes a following promote call see
 * the new asset through the same synchronous live-project mirror.
 */
export async function orchestrateLiveImage3dMesh(
  args: Record<string, unknown>,
  deps: LiveImage3dMeshDeps,
): Promise<Record<string, unknown> | ToolError> {
  const current = deps.currentProject();
  const name = String(args.name ?? "").trim();
  if (!name) return { error: "name is required" };

  const image = args.image;
  const assetId = args.assetId;
  if (image !== undefined && typeof image !== "string") {
    return { error: "image must be a base64 string" };
  }
  if (assetId !== undefined && typeof assetId !== "string") {
    return { error: "assetId must be a string" };
  }
  if (typeof image !== "string" && typeof assetId !== "string") {
    return { error: "image or assetId is required" };
  }
  if (typeof image === "string" && typeof assetId === "string") {
    return { error: "pass image or assetId, not both" };
  }

  const params: Record<string, unknown> = {
    slug: current.slug,
    name,
    ...(typeof image === "string" ? { image } : { assetId }),
  };
  for (const key of ["mode", "depth", "resolution", "targetSize", "threshold"]) {
    if (args[key] !== undefined) params[key] = args[key];
  }

  await deps.saveProject(current);
  // The explicit save above establishes the baseline before core appends the
  // generated asset, so an older autosave cannot overwrite it afterward.
  deps.adoptProject(current);

  const generated = await deps.generateMesh(params);
  const generatedAssetId = generated.assetId;
  if (typeof generatedAssetId !== "string" || generatedAssetId.length === 0) {
    return { error: "image3d_mesh returned no assetId" };
  }

  const loaded = deps.adoptProject(await deps.openProject(current.slug));
  if (!loaded.assets.some((asset) => asset.id === generatedAssetId)) {
    return { error: `generated asset ${generatedAssetId} was not present after project reopen` };
  }
  return { ...generated, assetId: generatedAssetId, live: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseVec3(value: unknown, fallback: Vec3, field: string): { value: Vec3 } | ToolError {
  if (value === undefined) return { value: [...fallback] as Vec3 };
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    return { error: `${field} must be an array of three finite numbers` };
  }
  return { value: [...value] as Vec3 };
}

function parseStringArray(value: unknown, field: string): { value?: string[] } | ToolError {
  if (value === undefined) return {};
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    return { error: `${field} must be an array of non-empty strings` };
  }
  const unique = [...new Set(value)];
  return unique.length > 0 ? { value: unique } : { error: `${field} must not be empty` };
}

function isCameraFrameFailure(result: CameraFrameResult | boolean): result is Extract<CameraFrameResult, { ok: false }> {
  return typeof result === "object" && result !== null && result.ok === false;
}

function isCameraFrameSuccess(result: CameraFrameResult | boolean): result is Extract<CameraFrameResult, { ok: true }> {
  return typeof result === "object" && result !== null && result.ok === true;
}

function parseEntityKind(value: unknown): string | ToolError {
  if (typeof value !== "string" || !ENTITY_KINDS.includes(value as (typeof ENTITY_KINDS)[number])) {
    return { error: `kind must be one of ${ENTITY_KINDS.join(", ")}` };
  }
  return value;
}

function parseScriptIds(project: Project, value: unknown): string[] | ToolError {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return { error: "scriptIds must be an array of script ids" };
  }
  const ids = [...new Set(value as string[])];
  const unknownScript = ids.find((scriptId) => !project.scripts.some((script) => script.id === scriptId));
  return unknownScript ? { error: `script ${unknownScript} not found` } : ids;
}

/**
 * Apply the entity tool's full patch against one project snapshot.
 *
 * Keeping this pure is intentional: the handler can validate and mutate the
 * exact same snapshot, even when several tool calls are batched before React
 * has rendered again.
 */
export function patchEditorEntity(project: Project, args: Record<string, unknown>): ProjectMutation<EntityToolResult> {
  const id = String(args.id ?? "");
  if (!id) return { project, result: { error: "entity id is required" } };
  const current = project.entities.find((entity) => entity.id === id);
  if (!current) return { project, result: { error: `entity ${id} not found` } };

  const position = parseVec3(args.position, current.transform.position, "position");
  if ("error" in position) return { project, result: position };
  const rotation = parseVec3(args.rotation, current.transform.rotation, "rotation");
  if ("error" in rotation) return { project, result: rotation };
  const scale = parseVec3(args.scale, current.transform.scale, "scale");
  if ("error" in scale) return { project, result: scale };

  let kind = current.kind;
  if (args.kind !== undefined) {
    const parsedKind = parseEntityKind(args.kind);
    if (typeof parsedKind !== "string") return { project, result: parsedKind };
    kind = parsedKind;
  }

  let material = current.material;
  if (args.material !== undefined) {
    if (!isRecord(args.material)) return { project, result: { error: "material must be an object" } };
    material = { ...current.material, ...args.material };
  }
  let light = current.light;
  if (args.light !== undefined) {
    if (!isRecord(args.light)) return { project, result: { error: "light must be an object" } };
    light = { ...current.light, ...args.light };
  }

  let scriptIds = [...current.scriptIds];
  if (args.scriptIds !== undefined) {
    const parsedScriptIds = parseScriptIds(project, args.scriptIds);
    if ("error" in parsedScriptIds) return { project, result: parsedScriptIds };
    scriptIds = parsedScriptIds;
  }

  let assetId = current.assetId;
  if (Object.hasOwn(args, "assetId")) {
    if (args.assetId === null) {
      assetId = null;
    } else if (typeof args.assetId !== "string") {
      return { project, result: { error: "assetId must be a string or null" } };
    } else if (!project.assets.some((asset) => asset.id === args.assetId)) {
      return { project, result: { error: `asset ${args.assetId} not found` } };
    } else {
      assetId = args.assetId;
    }
  }

  const patch: Partial<Entity> = {
    ...(args.name !== undefined ? { name: String(args.name) } : {}),
    kind,
    transform: { position: position.value, rotation: rotation.value, scale: scale.value },
    material,
    light,
    scriptIds,
    assetId,
  };
  return { project: updateEntity(project, id, patch), result: { updated: id } };
}

/** Upsert a script by stable id, or by name when no id is supplied. */
export function upsertEditorScript(
  project: Project,
  args: { id?: unknown; name: unknown; code: unknown },
): ProjectMutation<ScriptToolResult> {
  const name = String(args.name ?? "").trim();
  if (!name) return { project, result: { error: "script name is required" } };
  const code = String(args.code ?? "");
  const requestedId = args.id === undefined || args.id === null ? "" : String(args.id).trim();
  const existing = requestedId
    ? project.scripts.find((script) => script.id === requestedId)
    : project.scripts.find((script) => script.name === name);
  if (project.scripts.some((script) => script.id !== existing?.id && script.name === name)) {
    return { project, result: { error: `script name ${name} is already in use` } };
  }

  if (existing) {
    return {
      project: updateScript(project, existing.id, { name, code }),
      result: { saved: name, id: existing.id, created: false },
    };
  }

  const script: Script = { id: requestedId || uid("script"), name, code };
  return {
    project: { ...project, scripts: [...project.scripts, script] },
    result: { saved: name, id: script.id, created: true },
  };
}

/** Upsert a test by inspected id, or by name when no id is supplied. */
export function upsertEditorTest(
  project: Project,
  args: { id?: unknown; name: unknown; script: unknown },
): ProjectMutation<TestToolResult> {
  const name = String(args.name ?? "").trim();
  if (!name) return { project, result: { error: "test name is required" } };
  const script = String(args.script ?? "");
  if (!script.trim()) return { project, result: { error: "test script is required" } };
  // String(args.id) on an array or object collapses to "[object Object]" and
  // would silently match nothing; reject those shapes explicitly instead.
  const rawId = args.id;
  const requestedId =
    rawId === undefined || rawId === null
      ? ""
      : typeof rawId === "string"
        ? rawId.trim()
        : typeof rawId === "number" || typeof rawId === "boolean"
          ? String(rawId).trim()
          : "";
  if (rawId !== undefined && rawId !== null && rawId !== "" && requestedId === "") {
    return {
      project,
      result: { error: `test id must be a string, number, or boolean (got ${typeof rawId})` },
    };
  }
  const existing = requestedId
    ? project.tests.find((test) => test.id === requestedId)
    : project.tests.find((test) => test.name === name);
  // Refuse when a *different* test already owns the name; the upsert-by-name
  // path is supposed to update the existing entry, not a cross-id rename.
  if (project.tests.some((test) => test.id !== existing?.id && test.name === name)) {
    return { project, result: { error: `test name "${name}" is already in use` } };
  }

  if (existing) {
    return {
      project: updateTest(project, existing.id, { name, script }),
      result: { saved: name, id: existing.id, created: false },
    };
  }

  const test: GameTest = { id: requestedId || uid("test"), name, script };
  return {
    project: { ...project, tests: [...project.tests, test] },
    result: { saved: name, id: test.id, created: true },
  };
}

/** Complete live-project snapshot for agents; this avoids wasting turns searching worktree files for editor state. */
export function describeEditorProject(project: Project) {
  return {
    project: {
      slug: project.slug,
      title: project.title,
      entities: project.entities.map((entity) => ({
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        position: [...entity.transform.position] as Vec3,
        rotation: [...entity.transform.rotation] as Vec3,
        scale: [...entity.transform.scale] as Vec3,
        material: cloneJson(entity.material),
        light: cloneJson(entity.light),
        scriptIds: [...entity.scriptIds],
        assetId: entity.assetId,
      })),
      scripts: project.scripts.map((script) => ({ id: script.id, name: script.name, code: script.code })),
      assets: project.assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        type: asset.type,
        source: asset.source,
        tags: [...asset.tags],
        usage: [...asset.usage],
        thumbnail: asset.thumbnail,
        metadata: cloneJson(asset.metadata),
      })),
      tests: project.tests.map((test) => ({ id: test.id, name: test.name, script: test.script })),
      settings: cloneJson(project.settings),
      workspaceRoot: project.workspaceRoot ?? null,
    },
  };
}

interface MotionCaptureRuntime {
  readonly frames: number;
  readonly timeMs: number;
  pause(): void;
  stepOnce(): Promise<void>;
  capture(): string;
  captureWhenReady?: (timeoutMs?: number) => Promise<string>;
}

export async function captureFrameWhenReady(
  runtime: Pick<MotionCaptureRuntime, "capture" | "captureWhenReady">,
  timeoutMs?: number,
): Promise<string> {
  if (runtime.captureWhenReady) return runtime.captureWhenReady(timeoutMs);
  return runtime.capture();
}

/**
 * Deterministically sample a fixed-step PIE sequence, including both ends.
 * Live React capture state is deliberately not involved: tool execution must
 * not depend on whether a render committed between two simulation frames.
 */
export async function captureMotionSequence(
  runtime: MotionCaptureRuntime,
  frameCount: number,
  maxCaptures: number,
): Promise<CapturedFrame[]> {
  const total = Math.max(6, Math.min(600, Math.floor(frameCount)));
  const count = Math.max(2, Math.min(64, Math.min(total, Math.floor(maxCaptures))));
  const captureSteps = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    captureSteps.add(1 + Math.round((index * (total - 1)) / (count - 1)));
  }

  runtime.pause();
  const captures: CapturedFrame[] = [];
  for (let step = 1; step <= total; step += 1) {
    await runtime.stepOnce();
    if (!captureSteps.has(step)) continue;
    const dataUrl = await captureFrameWhenReady(runtime);
    if (!dataUrl.startsWith("data:image/")) throw new Error(`PIE frame ${runtime.frames} could not be captured`);
    captures.push({ frame: runtime.frames, timeMs: runtime.timeMs, dataUrl });
  }
  return captures;
}

/**
 * The editor's tool surface. Every entry is registered with the Rust core so
 * the agent drives the real editor rather than a mirrored copy of its state.
 */
export function useBrowserTools({
  project,
  setProject,
  adoptSaved,
  runtimeRef,
  setTestResults,
  setSelectedEntityId,
  pushLog,
  getLogs,
  builderAssetId,
  setBuilderAssetId,
  focusBuilderTab,
  applyBuilderOps,
  replaceBuilderSpec,
  saveBuilderAsset,
}: BrowserToolDeps): BrowserTool[] {
  const liveProjectRef = useRef(project);
  liveProjectRef.current = project;

  const adoptProject = useCallback(
    (loaded: Project): Project => {
      const saved = adoptSaved ? adoptSaved(loaded) : loaded;
      // Force one render when the saved snapshot is the same object already
      // held by React. That cleanup cancels any older autosave timer before
      // core appends the generated asset to the on-disk project.
      const adopted = saved === liveProjectRef.current ? { ...saved } : saved;
      try {
        runtimeRef.current?.setProject(adopted);
      } catch (error) {
        const message = `runtime sync failed: ${error instanceof Error ? error.message : String(error)}`;
        pushLog(message, "error");
        throw new Error(message);
      }
      liveProjectRef.current = adopted;
      setProject(adopted);
      return adopted;
    },
    [adoptSaved, runtimeRef, setProject, pushLog],
  );

  /**
   * React may batch several tool calls into one render. Keep a synchronous
   * mirror so each call validates against the result of the preceding call,
   * then publish one concrete next state to React.
   */
  const mutateProject = useCallback(
    <T,>(updater: (current: Project) => ProjectMutation<T>): T => {
      const current = liveProjectRef.current;
      const mutation = updater(current);
      if (mutation.project !== current) {
        try {
          runtimeRef.current?.setProject(mutation.project);
        } catch (error) {
          const message = `runtime sync failed: ${error instanceof Error ? error.message : String(error)}`;
          pushLog(message, "error");
          throw new Error(message);
        }
        liveProjectRef.current = mutation.project;
        setProject(mutation.project);
      }
      return mutation.result;
    },
    [runtimeRef, setProject, pushLog],
  );

  return useMemo<BrowserTool[]>(
    () => [
      {
        name: "editor_scene_inspect",
        description:
          "Inspect the complete live project: entity transforms/materials/script assignments, script source, assets, and test source.",
        parameters: { type: "object", properties: {} },
        handler: async () => describeEditorProject(liveProjectRef.current),
      },
      {
        name: "editor_camera_frame",
        description:
          "Author the persistent evidence camera before PIE or screenshots. Pass the gameplay foreground entityIds (hero, opponent, goals, arena) so large sky/backdrop geometry stays drawable without controlling or occluding the composition. viewDirection points from the target toward the camera. The exact pose persists across run, capture, motion analysis, autosave, and reload. Pass reset:true alone to clear it.",
        parameters: {
          type: "object",
          properties: {
            entityIds: {
              type: "array",
              items: { type: "string" },
              description: "exact inspected gameplay entity ids to fit",
            },
            excludeEntityIds: {
              type: "array",
              items: { type: "string" },
              description: "alternative to entityIds; decorative entities excluded only from composition",
            },
            viewDirection: {
              ...VEC3,
              description: "finite non-zero target-to-camera direction; choose the side opposite the backdrop",
            },
            padding: { type: "number", minimum: 1.05, maximum: 3 },
            reset: { type: "boolean" },
          },
        },
        handler: async (args) => {
          const target = runtimeRef.current;
          if (!target) return { error: "runtime not ready" };
          const hasFramingArgs = ["entityIds", "excludeEntityIds", "viewDirection", "padding"].some(
            (key) => args[key] !== undefined,
          );
          if (args.reset === true) {
            if (hasFramingArgs) return { error: "reset must be passed alone" };
            mutateProject((current) => {
              const currentPie = isRecord(current.settings.pie) ? current.settings.pie : {};
              const { camera: _camera, ...pie } = currentPie;
              return {
                project: { ...current, settings: { ...current.settings, pie } },
                result: null,
              };
            });
            const framed = await target.frameProject({});
            if (isCameraFrameFailure(framed)) return { error: framed.reason, reset: true };
            return { ...framed, reset: true, persisted: false };
          }
          const entityIds = parseStringArray(args.entityIds, "entityIds");
          if ("error" in entityIds) return entityIds;
          const excludeEntityIds = parseStringArray(args.excludeEntityIds, "excludeEntityIds");
          if ("error" in excludeEntityIds) return excludeEntityIds;
          if (entityIds.value && excludeEntityIds.value) {
            return { error: "pass either entityIds or excludeEntityIds, not both" };
          }
          const direction = parseVec3(args.viewDirection, [1, 0.7, 1], "viewDirection");
          if ("error" in direction) return direction;
          if (direction.value.every((component) => component === 0)) {
            return { error: "viewDirection must be non-zero" };
          }
          if (args.padding !== undefined && (typeof args.padding !== "number" || !Number.isFinite(args.padding))) {
            return { error: "padding must be a finite number" };
          }
          const options: CameraFrameOptions = {
            ...(entityIds.value ? { entityIds: entityIds.value } : {}),
            ...(excludeEntityIds.value ? { excludeEntityIds: excludeEntityIds.value } : {}),
            ...(args.viewDirection !== undefined ? { viewDirection: direction.value } : {}),
            ...(args.padding !== undefined ? { padding: args.padding } : {}),
          };
          target.setProject(liveProjectRef.current);
          const framed = await target.frameProject(options);
          if (isCameraFrameFailure(framed)) return { error: framed.reason };
          if (!isCameraFrameSuccess(framed)) return { error: "runtime returned no camera pose" };
          mutateProject((current) => {
            const currentPie = isRecord(current.settings.pie) ? current.settings.pie : {};
            return {
              project: {
                ...current,
                settings: {
                  ...current.settings,
                  pie: { ...currentPie, camera: framed.camera },
                },
              },
              result: null,
            };
          });
          // `setProject` rebuilt the runtime with the newly persisted pose.
          // Apply it once more so OrbitControls and the visible editor agree
          // before the model asks for its first capture.
          const applied = await target.frameProject();
          if (isCameraFrameFailure(applied)) return { error: applied.reason };
          return { ...framed, persisted: true };
        },
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
          const kind = args.kind === undefined ? "box" : parseEntityKind(args.kind);
          if (typeof kind !== "string") return kind;
          const position = parseVec3(args.position, [0, 0.5, 0], "position");
          if ("error" in position) return position;
          const entity: Entity = {
            id: uid("entity"),
            name: String(args.name ?? "New Entity"),
            kind,
            transform: {
              position: position.value,
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
            },
            material: { color: args.color ?? "#6b7280", metalness: 0.1, roughness: 0.7 },
            light: kind === "light" ? { type: "directional", intensity: 2, color: args.color ?? "#ffffff" } : {},
            scriptIds: [],
            assetId: null,
          };
          return mutateProject((current) => ({
            project: { ...current, entities: [...current.entities, entity] },
            result: entity,
          }));
        },
      },
      {
        name: "editor_object_remove",
        description: "Remove an entity from the scene by id.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        handler: async (args) => {
          const id = String(args.id);
          return mutateProject<{ removed: string } | ToolError>((current) => {
            const removed = current.entities.find((entity) => entity.id === id);
            if (!removed) return { project: current, result: { error: `entity ${id} not found` } };
            return {
              project: {
                ...current,
                entities: current.entities.filter((entity) => entity.id !== id),
                assets: removed.assetId
                  ? current.assets.map((asset) =>
                      asset.id === removed.assetId
                        ? { ...asset, usage: asset.usage.filter((usageId) => usageId !== id) }
                        : asset,
                    )
                  : current.assets,
              },
              result: { removed: id },
            };
          });
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
          return mutateProject<EntityToolResult>((current) => {
            const mutation = patchEditorEntity(current, args);
            return mutation;
          });
        },
      },
      {
        name: "editor_object_update",
        description:
          "Update an existing entity's name, kind, transform, material, light, script assignments, or asset reference.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            kind: { type: "string", enum: [...GEOMETRY_KINDS, "light"] },
            position: VEC3,
            rotation: VEC3,
            scale: VEC3,
            material: { type: "object" },
            light: { type: "object" },
            scriptIds: { type: "array", items: { type: "string" } },
            assetId: { type: ["string", "null"] },
          },
          required: ["id"],
        },
        handler: async (args) => {
          return mutateProject((current) => patchEditorEntity(current, args));
        },
      },
      {
        name: "editor_script_write",
        description:
          "Create or update a game script. Define update(entity, state, delta); time and delta are seconds. Patch only entity transforms. Read frozen state.scene snapshots or state.find(nameOrId), persist private JSON-safe state in state.self, and coordinate scripts through state.world. There are no global scene/input/DOM/network APIs. Pass id to create or update that stable id; omit id to upsert by name.",
        parameters: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" }, code: { type: "string" } },
          required: ["name", "code"],
        },
        handler: async (args) => {
          return mutateProject((current) =>
            upsertEditorScript(current, { id: args.id, name: args.name, code: args.code }),
          );
        },
      },
      {
        name: "editor_run_pie",
        description: "Start PIE so scripts and game logic run.",
        parameters: { type: "object", properties: { frames: { type: "number" } } },
        handler: async (args) => {
          const target = runtimeRef.current;
          if (!target) return { error: "runtime not ready" };
          target.setProject(liveProjectRef.current);
          await target.frameProject();
          const startFrame = target.frames;
          target.start();
          await target.waitFrames(Number(args.frames ?? 12));
          target.pause();
          return {
            frames: target.frames,
            advancedFrames: target.frames - startFrame,
          };
        },
      },
      {
        name: "editor_capture_frame",
        description: "Capture the current frame as a screenshot.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
          const target = runtimeRef.current;
          if (!target) return { error: "runtime not ready" };
          target.setProject(liveProjectRef.current);
          await target.frameProject();
          return { dataUrl: await captureFrameWhenReady(target) };
        },
      },
      {
        name: "editor_persist_capture",
        description:
          "Capture the current PIE frame and persist it atomically to a project-relative PNG/JPEG path. Pass only path for the reliable capture-and-save flow; dataUrl is an optional compatibility input. Returns the verified persisted path, byte count, MIME, SHA-256, frame, and simulation time so reports never need to copy a multi-megabyte screenshot through the model context.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "project-relative target; must end in .png, .jpg, or .jpeg",
            },
            dataUrl: {
              type: "string",
              description: "optional data:image/png or data:image/jpeg;base64,... payload; omit to capture live PIE",
            },
          },
          required: ["path"],
        },
        handler: async (args) => {
          const path = String(args.path ?? "").trim();
          if (!path) return { error: "path is required" };
          const target = runtimeRef.current;
          const supplied = String(args.dataUrl ?? "");
          if (!supplied && !target) return { error: "runtime not ready" };
          if (!supplied && target) {
            target.setProject(liveProjectRef.current);
            await target.frameProject();
          }
          const dataUrl = supplied || (target ? await captureFrameWhenReady(target) : "");
          const persisted = await rpc<{ path: string; bytes: number; mime: string; sha256: string }>(
            "capture_persist",
            {
              slug: liveProjectRef.current.slug,
              path,
              dataUrl,
            },
          );
          return {
            ...persisted,
            frame: target?.frames ?? null,
            timeMs: target?.timeMs ?? null,
          };
        },
      },
      {
        name: "editor_analyze_motion",
        description:
          "Review movement over time: run PIE, gather chronological captures, and persist a labelled contact sheet with frame timestamps plus motion metrics for the visual judge.",
        parameters: {
          type: "object",
          properties: {
            frames: { type: "integer", minimum: 6, maximum: 600 },
            label: { type: "string", description: "letters, digits, underscore, or hyphen" },
            maxCaptures: { type: "integer", minimum: 2, maximum: 64 },
          },
        },
        handler: async (args) => {
          const target = runtimeRef.current;
          if (!target) return { error: "runtime not ready" };
          target.setProject(liveProjectRef.current);
          await target.frameProject();
          const requestedFrames = Math.max(6, Math.min(600, Number(args.frames ?? 60)));
          const maxCaptures = Math.max(2, Math.min(64, Number(args.maxCaptures ?? 16)));
          const selected = await captureMotionSequence(target, requestedFrames, maxCaptures);
          return rpc("video_contact_sheet", {
            slug: liveProjectRef.current.slug,
            label: String(args.label ?? `motion-${Date.now()}`),
            frames: selected.map((frame) => ({
              image: frame.dataUrl,
              timestampSeconds: frame.timeMs / 1000,
              frameNumber: frame.frame,
            })),
          });
        },
      },
      {
        name: "editor_run_tests",
        description: "Run the project test suite and return pass/fail results.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
          const target = runtimeRef.current;
          if (!target) return { error: "runtime not ready" };
          const current = liveProjectRef.current;
          const results = await runTests(current, target, current.tests, pushLog);
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
          return mutateProject((current) => ({
            project: addAsset(current, asset),
            result: asset,
          }));
        },
      },
      {
        name: "editor_image3d_mesh",
        description:
          "Build a real image-to-3D mesh through core while preserving the current live project. Saves first, reopens/adopts the generated asset, and returns only after editor_promote_asset can see it. Use this live path instead of calling image3d_mesh directly before promoting the result.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            image: { type: "string", description: "base64 or data URI image; omit when assetId is given" },
            assetId: { type: "string", description: "existing image asset to use as source" },
            mode: { type: "string", enum: ["extrude", "heightfield", "lathe"] },
            depth: { type: "number" },
            resolution: { type: "integer", minimum: 8, maximum: 192 },
            targetSize: { type: "number" },
            threshold: { type: "integer", minimum: 0, maximum: 255 },
          },
          required: ["name"],
        },
        handler: async (args) =>
          orchestrateLiveImage3dMesh(args, {
            currentProject: () => liveProjectRef.current,
            saveProject: (current) => rpc("project_save", { project: current }),
            generateMesh: (params) => rpc<Record<string, unknown>>("image3d_mesh", params),
            openProject: (slug) => rpc<Project>("project_open", { slug }),
            adoptProject,
          }),
      },
      {
        name: "editor_asset_preview",
        description: "Render an asset thumbnail.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        handler: async (args) => {
          const assetId = String(args.id);
          const asset = liveProjectRef.current.assets.find((item) => item.id === assetId);
          if (!asset) return { error: "asset not found" };
          const thumbnail = renderThumbnail(assetObject(asset));
          return mutateProject((current) => ({
            project: updateAsset(current, asset.id, { thumbnail }),
            result: { thumbnail },
          }));
        },
      },
      {
        name: "editor_promote_asset",
        description: "Add an asset to the scene as a new entity.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        handler: async (args) => {
          const assetId = String(args.id);
          const asset = liveProjectRef.current.assets.find((item) => item.id === assetId);
          if (!asset) return { error: `asset ${assetId} not found` };
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
          return mutateProject<Entity | ToolError>((current) => {
            const currentAsset = current.assets.find((item) => item.id === asset.id);
            if (!currentAsset) return { project: current, result: { error: `asset ${asset.id} not found` } };
            return {
              project: {
                ...current,
                entities: [...current.entities, entity],
                assets: current.assets.map((item) =>
                  item.id === asset.id && !item.usage.includes(entity.id)
                    ? { ...item, usage: [...item.usage, entity.id] }
                    : item,
                ),
              },
              result: entity,
            };
          });
        },
      },
      {
        name: "editor_project_save",
        description: "Persist the current scene, assets, scripts, and tests to the CaliCode project store.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
          const current = liveProjectRef.current;
          await rpc("project_save", { project: current });
          return { saved: true, slug: current.slug };
        },
      },
      {
        name: "editor_project_checkpoint",
        description: "Create a revertible checkpoint of the current project.",
        parameters: { type: "object", properties: {} },
        handler: async () => rpc<{ id: string }>("project_checkpoint", { slug: liveProjectRef.current.slug }),
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
        name: "editor_console_history",
        description:
          "Read the editor console log buffer (the same entries shown in the CONSOLE tab) so an agent can verify what scripts and tests actually emitted, not just the summary the user typed back.",
        parameters: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 2000,
              description: "max entries to return, newest-last; defaults to 200",
            },
            level: { type: "string", enum: ["info", "error", "all"], default: "all" },
          },
        },
        handler: async (args) => {
          const limit = Math.max(1, Math.min(2000, Number(args.limit ?? 200)));
          const level = String(args.level ?? "all");
          if (!getLogs) {
            return {
              logs: [],
              count: 0,
              available: false,
              notice: "console log read not exposed by the host; wire getLogs into useBrowserTools to enable this tool",
            };
          }
          const entries = getLogs();
          const filtered = level === "all" ? entries : entries.filter((entry) => entry.level === level);
          const sliced = filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;
          return {
            logs: sliced.map((entry) => ({
              id: entry.id,
              level: entry.level,
              time: entry.time,
              message: entry.message,
            })),
            count: sliced.length,
            available: true,
          };
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
        description:
          "Create or update a scripted game test. Pass its id to replace an inspected test. Test globals are scene, entityFor(name), state.world, step(frames), baseline(...), log(...), and async assert(...); always `await assert(...)`. state.world is a read-only snapshot refreshed after each awaited step.",
        parameters: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" }, script: { type: "string" } },
          required: ["name", "script"],
        },
        handler: async (args) => {
          return mutateProject((current) =>
            upsertEditorTest(current, { id: args.id, name: args.name, script: args.script }),
          );
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
            slug: liveProjectRef.current.slug,
            name: String(args.name),
            data: String(args.data),
            mime: String(args.mime),
            tags: Array.isArray(args.tags) ? args.tags : [],
          });
          const loaded = await rpc<Project>("project_open", { slug: liveProjectRef.current.slug });
          adoptProject(loaded);
          return result;
        },
      },
      {
        name: "editor_asset_builder_open",
        description:
          "Open an asset in the 3D asset builder (BUILD tab). Creates a new empty cali asset when assetId is omitted (returns its id). Converts a procedural asset to a cali spec on open.",
        parameters: {
          type: "object",
          properties: {
            assetId: { type: "string" },
            name: { type: "string", description: "name for a newly created asset" },
          },
        },
        handler: async (args) => {
          if (!args.assetId) {
            const name = String(args.name ?? "New Asset");
            const id = uid("asset");
            const spec = emptySpec(name);
            mutateProject((current) => ({
              project: addAsset(current, {
                id,
                name,
                type: "cali",
                source: `${id}.cali.json`,
                tags: ["builder"],
                metadata: { cali: spec },
              }),
              result: null,
            }));
            setBuilderAssetId(id);
            focusBuilderTab();
            return { assetId: id, spec: describeSpec(spec) };
          }
          const asset = liveProjectRef.current.assets.find((item) => item.id === String(args.assetId));
          if (!asset) return { error: `asset ${String(args.assetId)} not found` };
          let spec = (asset.metadata?.cali as CaliSpec | undefined) ?? null;
          if (!spec) {
            spec = asset.type === "procedural" ? specFromProcedural(asset) : emptySpec(asset.name);
            const convertedSpec = spec;
            mutateProject((current) => {
              const target = current.assets.find((item) => item.id === asset.id);
              if (!target) return { project: current, result: null };
              return {
                project: updateAsset(current, asset.id, {
                  type: "cali",
                  source: `${asset.id}.cali.json`,
                  metadata: { ...(target.metadata ?? {}), cali: convertedSpec },
                }),
                result: null,
              };
            });
          }
          setBuilderAssetId(asset.id);
          focusBuilderTab();
          return { assetId: asset.id, spec: describeSpec(spec) };
        },
      },
      {
        name: "editor_asset_builder_apply",
        description:
          "Apply a batch of build ops to the asset open in the builder (or given assetId). Returns {applied, created, errors, spec: compact description}. Ops: add_component, remove_component, update_component, set_transform, set_parent, group, add_material, update_material, remove_material, assign_material, set_pivot, set_collider, rename_asset.",
        parameters: {
          type: "object",
          properties: { assetId: { type: "string" }, ops: BUILDER_OPS_SCHEMA },
          required: ["ops"],
        },
        handler: async (args) => {
          const assetId = args.assetId ? String(args.assetId) : builderAssetId;
          if (!assetId) {
            return { error: "no asset open in the builder — pass assetId or call editor_asset_builder_open first" };
          }
          if (!liveProjectRef.current.assets.some((item) => item.id === assetId)) {
            return { error: `asset ${assetId} not found` };
          }
          if (!Array.isArray(args.ops)) {
            return { error: "ops must be an array of build op objects" };
          }
          const result = applyBuilderOps(assetId, args.ops as BuilderOp[]);
          return {
            applied: result.applied,
            created: result.created,
            errors: result.errors,
            spec: describeSpec(result.spec),
          };
        },
      },
      {
        name: "editor_asset_builder_state",
        description:
          "Describe the asset currently open in the builder (or given assetId): component tree, materials, runtime. Pass verbose:true for full transforms.",
        parameters: {
          type: "object",
          properties: { assetId: { type: "string" }, verbose: { type: "boolean" } },
        },
        handler: async (args) => {
          const assetId = args.assetId ? String(args.assetId) : builderAssetId;
          const asset = assetId ? liveProjectRef.current.assets.find((item) => item.id === assetId) : undefined;
          if (!asset) return { error: "no asset open in the builder — pass assetId" };
          const spec = (asset.metadata?.cali as CaliSpec | undefined) ?? emptySpec(asset.name);
          return { assetId: asset.id, ...describeSpec(spec, Boolean(args.verbose)) };
        },
      },
      {
        name: "editor_asset_builder_save",
        description:
          "Persist the built asset: saves the project and writes the .cali.json file so disk and project state agree. To review the result visually, use editor_promote_asset + editor_capture_frame (the screenshot loop).",
        parameters: { type: "object", properties: { assetId: { type: "string" } } },
        handler: async (args) => {
          const assetId = args.assetId ? String(args.assetId) : builderAssetId;
          const asset = assetId ? liveProjectRef.current.assets.find((item) => item.id === assetId) : undefined;
          if (!asset || !assetId) return { error: "no asset open in the builder — pass assetId" };
          if (saveBuilderAsset) {
            await saveBuilderAsset(assetId);
          } else {
            const spec = (asset.metadata?.cali as CaliSpec | undefined) ?? emptySpec(asset.name);
            await rpc("project_save", { project: liveProjectRef.current });
            await rpc("project_asset_write", {
              slug: liveProjectRef.current.slug,
              assetId,
              content: JSON.stringify(spec, null, 2),
            });
          }
          return { saved: true, assetId };
        },
      },
    ],
    [
      applyBuilderOps,
      builderAssetId,
      adoptProject,
      focusBuilderTab,
      getLogs,
      mutateProject,
      pushLog,
      runtimeRef,
      saveBuilderAsset,
      setBuilderAssetId,
      setProject,
      setSelectedEntityId,
      setTestResults,
    ],
  );
}
