import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Moon, Sun, Gamepad2 } from "lucide-react";
import { Toolbar } from "./components/editor/Toolbar";
import { Viewport } from "./components/editor/Viewport";
import { SceneGraph } from "./components/editor/SceneGraph";
import { Inspector } from "./components/editor/Inspector";
import { ScriptEditor } from "./components/editor/ScriptEditor";
import { ConsolePanel, type LogEntry } from "./components/editor/ConsolePanel";
import { Filmstrip } from "./components/editor/Filmstrip";
import { TestResults } from "./components/editor/TestResults";
import { AssetWorkbench } from "./components/editor/AssetWorkbench";
import { AssetLibrary } from "./components/editor/AssetLibrary";
import { AgentPanel } from "./components/editor/AgentPanel";
import { Button } from "./components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { rpc } from "./lib/rpc";
import { addAsset, addEntity, addScript, addTest, removeEntity, starterProject, uid, updateAsset, updateEntity, updateScript } from "./lib/store";
import { assetObject, renderThumbnail } from "./lib/procedural";
import { runTests } from "./lib/testRunner";
import type { PieState } from "./lib/pie";
import type { PieRuntime } from "./lib/pie";
import type { Asset, BrowserTool, CapturedFrame, Entity, ModelList, Project, TestResult } from "./lib/types";

export default function App() {
  const [project, setProject] = useState<Project>(starterProject);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>("spin");
  const [runtime, setRuntime] = useState<PieRuntime | null>(null);
  const [pieState, setPieState] = useState<PieState>("idle");
  const [frames, setFrames] = useState<CapturedFrame[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [modelList, setModelList] = useState<ModelList | null>(null);
  const [captureEvery, setCaptureEvery] = useState(3);
  const [assetSearch, setAssetSearch] = useState("");
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("cali-theme");
    return saved ? saved === "dark" : true;
  });
  const runtimeRef = useRef<PieRuntime | null>(null);
  runtimeRef.current = runtime;

  const pushLog = useCallback((message: string, level: "info" | "error" = "info") => {
    setLogs((current) => [
      ...current.slice(-199),
      {
        id: uid("log"),
        level,
        message,
        time: new Date().toLocaleTimeString(),
      },
    ]);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("cali-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = (await rpc("project_open", { slug: "starter" })) as Project;
        setProject(loaded);
        setCaptureEvery((loaded.settings.pie as { captureEvery?: number })?.captureEvery ?? 3);
      } catch {
        pushLog("core unavailable; using local starter project", "error");
      }
      try {
        setModelList(await rpc("model_list", {}));
      } catch (error) {
        pushLog(`model list failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, [pushLog]);

  const browserTools = useMemo<BrowserTool[]>(
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
            kind: { type: "string", enum: ["box", "sphere", "cylinder", "cone", "torus", "terrain", "plane", "light"] },
            position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
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
          properties: {
            id: { type: "string" },
            position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
            rotation: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
            scale: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          },
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
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            code: { type: "string" },
          },
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
          const frames = Number(args.frames ?? 12);
          await target.waitFrames(frames);
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
            kind: { type: "string", enum: ["box", "sphere", "cylinder", "cone", "torus", "terrain", "plane"] },
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
            assets: current.assets.map((item) => (item.id === asset.id ? { ...item, usage: [...item.usage, entity.id] } : item)),
          }));
          return entity;
        },
      },
      {
        name: "editor_project_save",
        description: "Persist the current scene, assets, scripts, and tests to the Caliber project store.",
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
        handler: async () => {
          const result = await rpc<{ id: string }>("project_checkpoint", { slug: project.slug });
          return result;
        },
      },
      {
        name: "editor_model_switch",
        description: "Switch the Caliber harness provider and model.",
        parameters: {
          type: "object",
          properties: {
            provider: { type: "string" },
            model: { type: "string" },
          },
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
          properties: {
            message: { type: "string" },
            level: { type: "string", enum: ["info", "error"] },
          },
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
          properties: {
            name: { type: "string" },
            script: { type: "string" },
          },
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
          const loaded = await rpc<Project>("project_open", { slug: project.slug });
          setProject(loaded);
          return result;
        },
      },
    ],
    [project, pushLog],
  );

  useEffect(() => {
    void rpc("tool_register", {
      tools: browserTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    }).catch((error) => pushLog(`tool registration failed: ${error instanceof Error ? error.message : String(error)}`));
  }, [browserTools, pushLog]);

  const saveProject = async () => {
    try {
      await rpc("project_save", { project });
      pushLog(`saved ${project.slug}`);
    } catch (error) {
      pushLog(`save failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const checkpointProject = async () => {
    try {
      const result = await rpc<{ id: string }>("project_checkpoint", { slug: project.slug });
      pushLog(`checkpoint ${result.id}`);
    } catch (error) {
      pushLog(`checkpoint failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const runTestSuite = async () => {
    if (!runtime) return;
    const results = await runTests(project, runtime, project.tests, pushLog, async (name, dataUrl, threshold = 8) => {
      try {
        const result = await rpc<{ pass: boolean; distance: number; threshold: number }>("test_baseline_compare", {
          slug: project.slug,
          name,
          image: dataUrl.split(",")[1] ?? "",
          threshold,
        });
        return result;
      } catch (error) {
        pushLog(`baseline compare failed: ${error instanceof Error ? error.message : String(error)}`);
        return { pass: false, distance: 64, threshold };
      }
    });
    setTestResults(results);
    pushLog(`${results.filter((result) => result.pass).length}/${results.length} tests passed`);
  };

  const handleAddEntity = () => {
    const entity = {
      id: uid("entity"),
      name: "New Entity",
      kind: "box",
      transform: { position: [0, 0.5, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] },
      material: { color: "#6b7280", metalness: 0.1, roughness: 0.7 },
      light: {},
      scriptIds: [] as string[],
      assetId: null,
    };
    setProject((current) => ({ ...current, entities: [...current.entities, entity] }));
    setSelectedEntityId(entity.id);
  };

  const handleImportImage = async (file: File) => {
    const data = await readFileBase64(file);
    const mime = file.type || "application/octet-stream";
    try {
      await rpc("asset_import_file", { slug: project.slug, name: file.name, data, mime, tags: ["imported"] });
      if (mime.startsWith("image/")) {
        const ingest = await rpc<{ sourceHash: string; width: number; height: number }>("image3d_ingest", {
          slug: project.slug,
          name: file.name,
          image: data,
        });
        const spec = await rpc("image3d_spec", {
          name: file.name,
          sourceHash: ingest.sourceHash,
          width: ingest.width,
          height: ingest.height,
        });
        const generated = await rpc<{ assetId: string }>("image3d_generate", { slug: project.slug, spec });
        const caliFile = await rpc<{ content: string }>("file_read", {
          slug: project.slug,
          path: `assets/${generated.assetId}.cali.json`,
        });
        const loadedWithCali = await rpc<Project>("project_open", { slug: project.slug });
        const withCali: Project = {
          ...loadedWithCali,
          assets: loadedWithCali.assets.map((asset) =>
            asset.id === generated.assetId
              ? { ...asset, metadata: { ...(asset.metadata ?? {}), cali: JSON.parse(caliFile.content) } }
              : asset,
          ),
        };
        await rpc("project_save", { project: withCali });
        setProject(withCali);
        pushLog(`imported ${file.name} and generated image-to-3D spec`);
        return;
      }
      const loaded = await rpc<Project>("project_open", { slug: project.slug });
      setProject(loaded);
      pushLog(`imported ${file.name}`);
    } catch (error) {
      pushLog(`import failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const handleDedupe = async () => {
    try {
      const result = await rpc<{ sha256: string; files: string[] }[]>("asset_hash_dedupe", { slug: project.slug });
      pushLog(result.length === 0 ? "no duplicate assets" : `found ${result.length} duplicate groups`);
    } catch (error) {
      pushLog(`dedupe failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const selectedEntity = project.entities.find((entity) => entity.id === selectedEntityId) ?? null;
  const selectedAsset = useMemo(() => project.assets.find((asset) => asset.id === selectedEntity?.assetId) ?? null, [project.assets, selectedEntity?.assetId]);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-[#0c0c0c] px-4">
        <div className="flex items-center gap-3">
          <Gamepad2 className="h-4 w-4 text-[#828282]" />
          <h1 className="font-display text-sm font-extrabold tracking-[0.32em] text-[#d6d6d6]">Caliber</h1>
        </div>
        <span className="hidden min-w-0 items-center gap-3 sm:flex">
          <span className="text-[#3a3a3a]">/</span>
          <span className="truncate text-xs tracking-[0.12em] text-[#828282]">{project.title}</span>
        </span>
        <span className="ml-2 hidden rounded border border-white/10 px-2 py-0.5 text-[10px] tracking-[0.14em] text-[#616161] md:inline">
          {modelList?.active.provider ?? "OFFLINE"} · {modelList?.active.model ?? "NO MODEL"}
        </span>
        <div className="flex-1" />
        <span className="hidden text-[10px] tracking-[0.14em] text-[#4f4f4f] md:inline">
          PIE · 60 HZ · CAPTURE {captureEvery}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          onClick={() => setDark((current) => !current)}
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-52 shrink-0 border-r border-border bg-[#0b0b0b] md:flex md:flex-col">
          <div className="px-3 pb-2 pt-3">
            <Button variant="secondary" size="sm" className="caliber-button w-full justify-center" onClick={handleAddEntity}>
              New Entity
            </Button>
          </div>
          <div className="caliber-label px-3 pb-2">Games</div>
          <Tabs defaultValue="scene" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="border-b border-white/5 px-2">
              <TabsTrigger value="scene">Scene</TabsTrigger>
              <TabsTrigger value="assets">Assets</TabsTrigger>
            </TabsList>
            <TabsContent value="scene" className="min-h-0 flex-1 pt-0">
              <SceneGraph
                entities={project.entities}
                selectedId={selectedEntityId}
                onSelect={setSelectedEntityId}
                onAdd={handleAddEntity}
                onRemove={(id) => {
                  setProject((current) => removeEntity(current, id));
                  if (selectedEntityId === id) setSelectedEntityId(null);
                }}
              />
            </TabsContent>
            <TabsContent value="assets" className="min-h-0 flex-1 pt-0">
              <AssetLibrary
                assets={project.assets}
                entities={project.entities}
                search={assetSearch}
                onSearch={setAssetSearch}
                onPromote={(asset) => {
                  const tool = browserTools.find((item) => item.name === "editor_promote_asset");
                  void tool?.handler({ id: asset.id });
                }}
                onRemove={(assetId) => {
                  setProject((current) => ({ ...current, assets: current.assets.filter((asset) => asset.id !== assetId) }));
                }}
                onDedupe={() => void handleDedupe()}
              />
            </TabsContent>
          </Tabs>
        </aside>
        <aside className="hidden w-[380px] shrink-0 border-r border-border bg-[#0a0a0a] lg:block">
          <Tabs defaultValue="agent" className="flex h-full flex-col">
            <TabsList className="border-b border-white/5 px-2">
              <TabsTrigger value="agent">Agent</TabsTrigger>
              <TabsTrigger value="workbench">Workbench</TabsTrigger>
            </TabsList>
            <TabsContent value="agent" className="min-h-0 flex-1 pt-0">
              <AgentPanel
                projectSlug={project.slug}
                modelList={modelList}
                browserTools={browserTools}
                onModelChange={() =>
                  void rpc<ModelList>("model_list", {}).then((list) => setModelList(list)).catch(() => undefined)
                }
                onLog={pushLog}
              />
            </TabsContent>
            <TabsContent value="workbench" className="min-h-0 flex-1 pt-0">
              <AssetWorkbench
                onAddAsset={(asset) => {
                  const next: Asset = {
                    id: uid("asset"),
                    name: asset.name ?? "Asset",
                    type: asset.type ?? "procedural",
                    source: asset.source ?? "procedural:box",
                    tags: asset.tags ?? [],
                    usage: [],
                    thumbnail: asset.thumbnail ?? null,
                    metadata: asset.metadata ?? {},
                  };
                  setProject((current) => addAsset(current, next));
                  pushLog(`generated ${next.name}`);
                  return next;
                }}
                onPromote={(assetId) => {
                  const tool = browserTools.find((item) => item.name === "editor_promote_asset");
                  void tool?.handler({ id: assetId });
                }}
                onImportImage={(file) => void handleImportImage(file)}
              />
            </TabsContent>
          </Tabs>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <Toolbar
            runtime={runtime}
            pieState={pieState}
            captureEvery={captureEvery}
            onCaptureEveryChange={(value) => {
              setCaptureEvery(value);
              runtime?.setCaptureEvery(value);
            }}
            onRunTests={() => void runTestSuite()}
            onSave={() => void saveProject()}
            onCheckpoint={() => void checkpointProject()}
            onAddEntity={handleAddEntity}
          />
          <div className="relative min-h-0 flex-1">
            <Viewport
              project={project}
              selectedEntityId={selectedEntityId}
              onSelect={setSelectedEntityId}
              onRuntimeReady={(next) => {
                setRuntime(next);
                if (next) next.setCaptureEvery(captureEvery);
              }}
              onCapture={(frame) => setFrames((current) => [...current.slice(-59), frame])}
              onLog={pushLog}
              onStateChange={setPieState}
            />
          </div>
          <section className="h-56 shrink-0 border-t border-border bg-[#0a0a0a]">
            <Tabs defaultValue="inspector" className="flex h-full flex-col">
              <TabsList className="max-w-full border-b border-white/5 px-2">
                <TabsTrigger value="inspector">Inspector</TabsTrigger>
                <TabsTrigger value="scripts">Scripts</TabsTrigger>
                <TabsTrigger value="console">Console</TabsTrigger>
                <TabsTrigger value="filmstrip">Filmstrip</TabsTrigger>
                <TabsTrigger value="tests">Tests</TabsTrigger>
              </TabsList>
              <TabsContent value="inspector" className="min-h-0 flex-1 overflow-y-auto pt-0">
                <Inspector
                  entity={selectedEntity}
                  onSave={(entity) => {
                    setProject((current) => updateEntity(current, entity.id, entity));
                    pushLog(`updated ${entity.name}`);
                  }}
                />
              </TabsContent>
              <TabsContent value="scripts" className="min-h-0 flex-1 pt-0">
                <ScriptEditor
                  scripts={project.scripts}
                  selectedId={selectedScriptId}
                  onSelect={setSelectedScriptId}
                  onChange={(script) => {
                    setProject((current) => updateScript(current, script.id, script));
                    pushLog(`saved script ${script.name}`);
                  }}
                  onAdd={() => {
                    const script = { id: uid("script"), name: "script", code: "function update(entity, state, delta) {\n  return state;\n}" };
                    setProject((current) => ({ ...current, scripts: [...current.scripts, script] }));
                    setSelectedScriptId(script.id);
                  }}
                />
              </TabsContent>
              <TabsContent value="console" className="min-h-0 flex-1 pt-0">
                <ConsolePanel logs={logs} />
              </TabsContent>
              <TabsContent value="filmstrip" className="min-h-0 flex-1 pt-0">
                <Filmstrip frames={frames} />
              </TabsContent>
              <TabsContent value="tests" className="min-h-0 flex-1 pt-0">
                <TestResults results={testResults} />
              </TabsContent>
            </Tabs>
          </section>
        </main>
      </div>
    </div>
  );
}

async function readFileBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
