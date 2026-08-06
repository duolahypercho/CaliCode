import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Viewport } from "./components/editor/Viewport";
import { SceneGraph } from "./components/editor/SceneGraph";
import { Inspector } from "./components/editor/Inspector";
import { ScriptEditor } from "./components/editor/ScriptEditor";
import type { LogEntry } from "./components/editor/ConsolePanel";
import { Filmstrip } from "./components/editor/Filmstrip";
import { TestResults } from "./components/editor/TestResults";
import { AssetWorkbench } from "./components/editor/AssetWorkbench";
import { AssetLibrary } from "./components/editor/AssetLibrary";
import { AgentPanel } from "./components/editor/AgentPanel";
import { TitleBar } from "./components/workspace/TitleBar";
import { GamesSidebar, type GameSession } from "./components/workspace/GamesSidebar";
import { WorkspaceTabs, type WorkspaceTab } from "./components/workspace/WorkspaceTabs";
import { PlayOverlay, type TweakPin } from "./components/workspace/PlayOverlay";
import { TweakPanel, entityTweakControls, type TweakControl } from "./components/workspace/TweakPanel";
import { LiveBar, type LiveStats } from "./components/workspace/LiveBar";
import { Button } from "./components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { rpc } from "./lib/rpc";
import { addAsset, removeEntity, slugify, starterProject, uid, updateEntity, updateScript } from "./lib/store";
import { runTests } from "./lib/testRunner";
import { useBrowserTools } from "./lib/useBrowserTools";
import { useFrameStats } from "./lib/useFrameStats";
import type { PieRuntime, PieState } from "./lib/pie";
import type { Asset, CapturedFrame, Entity, ModelList, Project, TestResult } from "./lib/types";

const SESSIONS_KEY = "calicode-sessions";
const PREVIEW_ORIGIN = "http://127.0.0.1:5199";

export default function App() {
  const [project, setProject] = useState<Project>(starterProject);
  const [projects, setProjects] = useState<Project[]>([]);
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
  const [tab, setTab] = useState<WorkspaceTab>("play");
  const [activePin, setActivePin] = useState<string | null>(null);
  const [buildMs, setBuildMs] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [sessions, setSessions] = useState<Record<string, GameSession[]>>(readSessions);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const runtimeRef = useRef<PieRuntime | null>(null);
  runtimeRef.current = runtime;

  const pushLog = useCallback((text: string, level: "info" | "error" = "info") => {
    setLogs((current) => [
      ...current.slice(-199),
      { id: uid("log"), level, message: text, time: new Date().toLocaleTimeString() },
    ]);
  }, []);

  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  useEffect(() => {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    const started = performance.now();
    void (async () => {
      try {
        const loaded = await rpc<Project>("project_open", { slug: "starter" });
        setProject(loaded);
        setCaptureEvery((loaded.settings.pie as { captureEvery?: number })?.captureEvery ?? 3);
        setProjects(await rpc<Project[]>("project_list", {}));
        setBuildMs(performance.now() - started);
      } catch {
        pushLog("core unavailable; using local starter project", "error");
      }
      try {
        setModelList(await rpc("model_list", {}));
      } catch (error) {
        pushLog(`model list failed: ${reason(error)}`);
      }
    })();
  }, [pushLog]);

  const browserTools = useBrowserTools({
    project,
    setProject,
    runtimeRef,
    setModelList,
    setTestResults,
    setSelectedEntityId,
    pushLog,
  });

  useEffect(() => {
    void rpc("tool_register", {
      tools: browserTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    }).catch((error) => pushLog(`tool registration failed: ${reason(error)}`));
  }, [browserTools, pushLog]);

  const saveProject = useCallback(async () => {
    setExporting(true);
    try {
      await rpc("project_save", { project });
      pushLog(`saved ${project.slug}`);
    } catch (error) {
      pushLog(`save failed: ${reason(error)}`, "error");
    } finally {
      setExporting(false);
    }
  }, [project, pushLog]);

  const openProject = useCallback(
    async (slug: string) => {
      try {
        const loaded = await rpc<Project>("project_open", { slug });
        setProject(loaded);
        setSelectedEntityId(null);
        setSelectedScriptId(loaded.scripts[0]?.id ?? null);
        setFrames([]);
        setTestResults([]);
        setCaptureEvery((loaded.settings.pie as { captureEvery?: number })?.captureEvery ?? 3);
        pushLog(`opened ${loaded.title}`);
      } catch (error) {
        pushLog(`open failed: ${reason(error)}`, "error");
      }
    },
    [pushLog],
  );

  const createProject = async () => {
    const title = newProjectName.trim();
    if (!title || newProjectBusy) return;
    const slug = slugify(title);
    if (projects.some((item) => item.slug === slug)) {
      pushLog(`project ${slug} already exists`, "error");
      return;
    }
    setNewProjectBusy(true);
    try {
      const created = await rpc<Project>("project_create", { slug, title });
      setProjects((current) => [...current.filter((item) => item.slug !== slug), created]);
      setProject(created);
      setSelectedEntityId(null);
      setSelectedScriptId(created.scripts[0]?.id ?? null);
      setFrames([]);
      setTestResults([]);
      setNewProjectName("");
      setNewProjectOpen(false);
      pushLog(`created ${title}`);
    } catch (error) {
      pushLog(`create failed: ${reason(error)}`, "error");
    } finally {
      setNewProjectBusy(false);
    }
  };

  const runTestSuite = useCallback(async () => {
    if (!runtime) return;
    const results = await runTests(project, runtime, project.tests, pushLog, async (name, dataUrl, threshold = 8) => {
      try {
        return await rpc<{ pass: boolean; distance: number; threshold: number }>("test_baseline_compare", {
          slug: project.slug,
          name,
          image: dataUrl.split(",")[1] ?? "",
          threshold,
        });
      } catch (error) {
        pushLog(`baseline compare failed: ${reason(error)}`);
        return { pass: false, distance: 64, threshold };
      }
    });
    setTestResults(results);
    pushLog(`${results.filter((result) => result.pass).length}/${results.length} tests passed`);
  }, [project, pushLog, runtime]);

  const handleAddEntity = useCallback(() => {
    const entity: Entity = {
      id: uid("entity"),
      name: "New Entity",
      kind: "box",
      transform: { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      material: { color: "#6b7280", metalness: 0.1, roughness: 0.7 },
      light: {},
      scriptIds: [],
      assetId: null,
    };
    setProject((current) => ({ ...current, entities: [...current.entities, entity] }));
    setSelectedEntityId(entity.id);
  }, []);

  const handleImportImage = async (file: File) => {
    const data = await readFileBase64(file);
    const mime = file.type || "application/octet-stream";
    try {
      await rpc("asset_import_file", { slug: project.slug, name: file.name, data, mime, tags: ["imported"] });
      if (!mime.startsWith("image/")) {
        setProject(await rpc<Project>("project_open", { slug: project.slug }));
        pushLog(`imported ${file.name}`);
        return;
      }
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
      const loaded = await rpc<Project>("project_open", { slug: project.slug });
      const withCali: Project = {
        ...loaded,
        assets: loaded.assets.map((asset) =>
          asset.id === generated.assetId
            ? { ...asset, metadata: { ...(asset.metadata ?? {}), cali: JSON.parse(caliFile.content) } }
            : asset,
        ),
      };
      await rpc("project_save", { project: withCali });
      setProject(withCali);
      pushLog(`imported ${file.name} and generated image-to-3D spec`);
    } catch (error) {
      pushLog(`import failed: ${reason(error)}`, "error");
    }
  };

  const selectedEntity = project.entities.find((entity) => entity.id === selectedEntityId) ?? null;

  const promoteAsset = (assetId: string) => {
    void browserTools.find((tool) => tool.name === "editor_promote_asset")?.handler({ id: assetId });
  };

  const pins = useMemo<TweakPin[]>(
    () => [
      ...project.entities.slice(0, 3).map((entity) => ({ id: entity.id, label: entity.name.toUpperCase() })),
      { id: "__runtime", label: "RUNTIME" },
    ],
    [project.entities],
  );

  const tweak = useMemo<{ title: string; controls: TweakControl[] } | null>(() => {
    if (!activePin) return null;
    if (activePin === "__runtime") {
      return {
        title: "RUNTIME",
        controls: [
          {
            key: "capture",
            label: "Capture every",
            min: 1,
            max: 30,
            step: 1,
            value: captureEvery,
            display: `${captureEvery}f`,
            onChange: (value) => {
              setCaptureEvery(value);
              runtime?.setCaptureEvery(value);
            },
          },
        ],
      };
    }
    const entity = project.entities.find((item) => item.id === activePin);
    if (!entity) return null;
    return {
      title: entity.name.toUpperCase(),
      controls: entityTweakControls(entity, (patch) => setProject((current) => updateEntity(current, entity.id, patch))),
    };
  }, [activePin, captureEvery, project.entities, runtime]);

  const frameStats = useFrameStats(runtime, pieState === "running");
  const stats: LiveStats = {
    fps: frameStats.fps,
    frameMs: frameStats.frameMs,
    draws: project.entities.length,
    entities: project.entities.length,
    buildMs,
  };

  const failing = testResults.filter((result) => !result.pass).length;

  return (
    <div className="flex h-dvh flex-col">
      <TitleBar projectTitle={project.title} modelList={modelList} />

      <div className="flex min-h-0 flex-1">
        <GamesSidebar
          projects={projects.length > 0 ? projects : [project]}
          activeSlug={project.slug}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onOpenProject={(slug) => void openProject(slug)}
          onSelectSession={(slug, sessionId) => {
            setActiveSessionId(sessionId);
            if (slug !== project.slug) void openProject(slug);
          }}
          onNewSession={(slug) => {
            const session: GameSession = { id: uid("session"), name: `Session ${(sessions[slug]?.length ?? 0) + 1}` };
            setSessions((current) => ({ ...current, [slug]: [...(current[slug] ?? []), session] }));
            setActiveSessionId(session.id);
          }}
          onNewGame={() => setNewProjectOpen(true)}
        />

        <aside className="hidden w-[384px] shrink-0 border-r border-white/[0.06] bg-[#0a0a0a] lg:block">
          <AgentPanel
            projectSlug={project.slug}
            modelList={modelList}
            browserTools={browserTools}
            onModelChange={() =>
              void rpc<ModelList>("model_list", {})
                .then(setModelList)
                .catch(() => undefined)
            }
            onLog={pushLog}
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-[#080808]">
          <WorkspaceTabs
            active={tab}
            onChange={setTab}
            badges={{ test: failing || undefined }}
            previewUrl={`${PREVIEW_ORIGIN}/play/${project.slug}`}
            onNewGame={() => setNewProjectOpen(true)}
            onExport={() => void saveProject()}
            exporting={exporting}
          />

          <div className="relative min-h-0 flex-1">
            {/* The viewport stays mounted across tabs so PIE never loses its WebGL context. */}
            <div
              className={tab === "play" ? "absolute inset-0" : "pointer-events-none absolute inset-0 opacity-0"}
              aria-hidden={tab !== "play"}
            >
              <Viewport
                project={project}
                selectedEntityId={selectedEntityId}
                onSelect={setSelectedEntityId}
                onRuntimeReady={(next) => {
                  setRuntime(next);
                  next?.setCaptureEvery(captureEvery);
                }}
                onCapture={(frame) => setFrames((current) => [...current.slice(-59), frame])}
                onLog={pushLog}
                onStateChange={setPieState}
              />
              {tab === "play" ? (
                <>
                  <PlayOverlay
                    pieState={pieState}
                    hint="CLICK TO SELECT"
                    pins={pins}
                    activePin={activePin}
                    onTogglePin={(id) => setActivePin((current) => (current === id ? null : id))}
                    onTogglePlay={() => (pieState === "running" ? runtime?.pause() : runtime?.start())}
                    onReset={() => {
                      runtime?.stop();
                      setFrames([]);
                    }}
                  />
                  {tweak ? (
                    <TweakPanel title={tweak.title} controls={tweak.controls} onClose={() => setActivePin(null)} />
                  ) : null}
                </>
              ) : null}
            </div>

            {tab === "code" ? (
              <div className="absolute inset-0">
                <ScriptEditor
                  scripts={project.scripts}
                  selectedId={selectedScriptId}
                  onSelect={setSelectedScriptId}
                  onChange={(script) => {
                    setProject((current) => updateScript(current, script.id, script));
                    pushLog(`saved script ${script.name}`);
                  }}
                  onAdd={() => {
                    const script = {
                      id: uid("script"),
                      name: "script",
                      code: "function update(entity, state, delta) {\n  return state;\n}",
                    };
                    setProject((current) => ({ ...current, scripts: [...current.scripts, script] }));
                    setSelectedScriptId(script.id);
                  }}
                />
              </div>
            ) : null}

            {tab === "art" ? (
              <div className="absolute inset-0 flex min-h-0">
                <div className="min-h-0 w-[420px] shrink-0 overflow-y-auto border-r border-white/[0.06]">
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
                    onPromote={promoteAsset}
                    onImportImage={(file) => void handleImportImage(file)}
                  />
                </div>
                <div className="min-h-0 flex-1">
                  <AssetLibrary
                    assets={project.assets}
                    entities={project.entities}
                    search={assetSearch}
                    onSearch={setAssetSearch}
                    onPromote={(asset) => promoteAsset(asset.id)}
                    onRemove={(assetId) =>
                      setProject((current) => ({
                        ...current,
                        assets: current.assets.filter((asset) => asset.id !== assetId),
                      }))
                    }
                    onDedupe={() =>
                      void rpc<{ sha256: string; files: string[] }[]>("asset_hash_dedupe", { slug: project.slug })
                        .then((result) =>
                          pushLog(result.length === 0 ? "no duplicate assets" : `found ${result.length} duplicate groups`),
                        )
                        .catch((error) => pushLog(`dedupe failed: ${reason(error)}`, "error"))
                    }
                  />
                </div>
              </div>
            ) : null}

            {tab === "scene" ? (
              <div className="absolute inset-0 flex min-h-0">
                <div className="min-h-0 w-[280px] shrink-0 border-r border-white/[0.06]">
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
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <Inspector
                    entity={selectedEntity}
                    onSave={(entity) => {
                      setProject((current) => updateEntity(current, entity.id, entity));
                      pushLog(`updated ${entity.name}`);
                    }}
                  />
                </div>
              </div>
            ) : null}

            {tab === "test" ? (
              <div className="absolute inset-0 flex min-h-0 flex-col">
                <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-5 py-3">
                  <div>
                    <div className="calicode-label">CaliCode Playtest</div>
                    <p className="mt-1 text-[13px] text-[#c8c8c8]">
                      {testResults.length === 0
                        ? "No runs yet."
                        : `${testResults.length - failing}/${testResults.length} passing · ${frames.length} frames captured.`}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    className="calicode-button ml-auto"
                    disabled={!runtime}
                    onClick={() => void runTestSuite()}
                  >
                    Run playtest
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <TestResults results={testResults} />
                </div>
                <div className="h-32 shrink-0 border-t border-white/[0.06]">
                  <Filmstrip frames={frames} />
                </div>
              </div>
            ) : null}
          </div>

          <LiveBar stats={stats} pieState={pieState} logs={logs} />
        </main>
      </div>

      <Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}>
        <DialogContent className="max-w-sm">
          <DialogTitle>New game</DialogTitle>
          <DialogDescription>Create a CaliCode project in core and open it in the editor.</DialogDescription>
          <form
            className="mt-3"
            onSubmit={(event) => {
              event.preventDefault();
              void createProject();
            }}
          >
            <Label htmlFor="new-project-name">Name</Label>
            <Input
              id="new-project-name"
              className="mt-1"
              value={newProjectName}
              onChange={(event) => setNewProjectName(event.target.value)}
              autoFocus
              placeholder="My Game"
            />
            <div className="mt-3 flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" size="sm" disabled={newProjectBusy || !newProjectName.trim()}>
                {newProjectBusy ? "Creating..." : "Create & open"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSessions(): Record<string, GameSession[]> {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, GameSession[]>) : {};
  } catch {
    return {};
  }
}

async function readFileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
