import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Viewport } from "./components/editor/Viewport";
import type { LogEntry } from "./components/editor/ConsolePanel";
import { AgentPanel } from "./components/editor/AgentPanel";
import { TitleBar } from "./components/workspace/TitleBar";
import {
  GamesSidebar,
  type GameSession,
  type ProjectMenuAction,
} from "./components/workspace/GamesSidebar";
import { WORKSPACE_TABS, WorkspaceTabs, type WorkspaceTab } from "./components/workspace/WorkspaceTabs";
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
import { CodeTab } from "./components/workspace/CodeTab";
import { ArtTab } from "./components/workspace/ArtTab";
import { SceneGraphCanvas } from "./components/workspace/SceneGraphCanvas";
import { TestTab, toIssues } from "./components/workspace/TestTab";
import { FileTree } from "./components/workspace/FileTree";
import { FileEditor } from "./components/workspace/FileEditor";
import { LivePreview } from "./components/workspace/LivePreview";
import { NewProjectDialog } from "./components/workspace/NewProjectDialog";
import { openWorkspace, setProjectWorkspace, type WorkspaceInfo } from "./lib/workspace";
import {
  useResizablePanels,
  type ResizablePanel,
  type ResizablePanelOptions,
} from "./hooks/useResizablePanels";
import type { PieRuntime, PieState } from "./lib/pie";
import type { Asset, CapturedFrame, Entity, ModelList, Project, TestResult } from "./lib/types";
import type { ProjectTemplate } from "./lib/projectTemplates";

const snapshotScripts = (p: Project): Record<string, string> => Object.fromEntries(p.scripts.map((x) => [x.id, x.code]));

const SESSIONS_KEY = "calicode-sessions";
const VIEW_KEY = "calicode-view";
const PINNED_PROJECTS_KEY = "calicode-pinned-projects";

type DialogProjectAction = Exclude<ProjectMenuAction, "pin" | "reveal">;

interface PendingProjectAction {
  action: DialogProjectAction;
  project: Project;
}

/** Panel bounds are shared by the hook and the handle's aria value range. */
const GAMES_SIDEBAR: ResizablePanelOptions = {
  storageKey: "calicode-games-sidebar-width",
  defaultWidth: 240,
  minWidth: 180,
  maxWidth: 420,
};

const AGENT_PANEL: ResizablePanelOptions = {
  storageKey: "calicode-agent-width",
  defaultWidth: 384,
  minWidth: 280,
  maxWidth: 720,
};

const FILE_TREE_PANEL: ResizablePanelOptions = {
  storageKey: "calicode-filetree-width",
  defaultWidth: 260,
  minWidth: 180,
  maxWidth: 560,
};

/**
 * The tab and open file, remembered across reloads.
 *
 * Core restarts are routine — the client reconnects fine, but the editor used
 * to snap back to PLAY and drop whatever file you had open, which reads as
 * lost work even though nothing was lost.
 */
interface ViewState {
  tab: WorkspaceTab;
  workspaceFile: string | null;
}

function readView(): ViewState {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ViewState>) : {};
    const tab = WORKSPACE_TABS.includes(parsed.tab as WorkspaceTab) ? (parsed.tab as WorkspaceTab) : "play";
    return { tab, workspaceFile: typeof parsed.workspaceFile === "string" ? parsed.workspaceFile : null };
  } catch {
    return { tab: "play", workspaceFile: null };
  }
}

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
  const [tab, setTab] = useState<WorkspaceTab>(() => readView().tab);
  const [activePin, setActivePin] = useState<string | null>(null);
  const [loadMs, setLoadMs] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [newProjectError, setNewProjectError] = useState("");
  const [sessions, setSessions] = useState<Record<string, GameSession[]>>(readSessions);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [pinnedProjectSlugs, setPinnedProjectSlugs] = useState<string[]>(readPinnedProjects);
  const [pendingProjectAction, setPendingProjectAction] = useState<PendingProjectAction | null>(null);
  const [projectActionTitle, setProjectActionTitle] = useState("");
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  const [projectActionError, setProjectActionError] = useState("");
  const [sessionRevision, setSessionRevision] = useState(0);
  // Scripts as of the last load or save, so CODE can show a real diff.
  const [scriptBaseline, setScriptBaseline] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workspaceFile, setWorkspaceFile] = useState<string | null>(() => readView().workspaceFile);
  // Below lg/md these panes leave the layout entirely; the toggles open them
  // as overlays so the agent and the games list stay reachable on a narrow
  // window rather than simply disappearing.
  const [agentOpen, setAgentOpen] = useState(false);
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const gamesSidebar = useResizablePanels(GAMES_SIDEBAR);
  const agentPanel = useResizablePanels(AGENT_PANEL);
  const fileTreePanel = useResizablePanels(FILE_TREE_PANEL);
  const [openFolderOpen, setOpenFolderOpen] = useState(false);
  const [folderPath, setFolderPath] = useState("");

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
    localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify(pinnedProjectSlugs));
  }, [pinnedProjectSlugs]);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ tab, workspaceFile } satisfies ViewState));
  }, [tab, workspaceFile]);

  useEffect(() => {
    const started = performance.now();
    void (async () => {
      try {
        const loaded = await rpc<Project>("project_open", { slug: "starter" });
        setProject(loaded);
        setScriptBaseline(snapshotScripts(loaded));
        setCaptureEvery((loaded.settings.pie as { captureEvery?: number })?.captureEvery ?? 3);
        setProjects(await rpc<Project[]>("project_list", {}));
        setLoadMs(performance.now() - started);
      } catch {
        pushLog("core unavailable; using local starter project", "error");
      }
      try {
        setModelList(await rpc("model_list", {}));
      } catch (error) {
        pushLog(`model list failed: ${reason(error)}`);
      }
      // The attached folder now comes from the selected game's workspaceRoot
      // (see the effect below), not from whatever core happened to have open —
      // with several games that global pick was arbitrary.
    })();
  }, [pushLog]);

  const attachFolder = async () => {
    const path = folderPath.trim();
    if (!path) return;
    try {
      const info = await openWorkspace(path);
      setWorkspace(info);
      setWorkspaceFile(null);
      setOpenFolderOpen(false);
      setFolderPath("");
      // The folder belongs to this game, not to the app — so a second game can
      // point at a different repo and switching games switches folders.
      if (project) {
        await setProjectWorkspace(project.slug, info.root);
        setProject((current) => (current ? { ...current, workspaceRoot: info.root } : current));
      }
      pushLog(`attached ${info.name} to ${project?.title ?? "this game"} (${info.root})`);
    } catch (error) {
      pushLog(`open folder failed: ${reason(error)}`, "error");
    }
  };

  // Each game owns its folder, so switching games switches the attached
  // workspace. A game with no folder shows none rather than inheriting the
  // previous game's — that inheritance is what made the old single global
  // workspace confusing once more than one game existed.
  const projectSlug = project?.slug ?? null;
  const projectWorkspaceRoot = project?.workspaceRoot ?? null;
  useEffect(() => {
    if (!projectSlug) return;
    let cancelled = false;
    void (async () => {
      if (!projectWorkspaceRoot) {
        if (!cancelled) {
          setWorkspace(null);
          setWorkspaceFile(null);
        }
        return;
      }
      try {
        const info = await openWorkspace(projectWorkspaceRoot);
        if (cancelled) return;
        setWorkspace(info);
        setWorkspaceFile(null);
      } catch (error) {
        if (cancelled) return;
        setWorkspace(null);
        pushLog(`could not open ${projectWorkspaceRoot}: ${reason(error)}`, "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectSlug, projectWorkspaceRoot, pushLog]);

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
      setScriptBaseline(snapshotScripts(project));
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
        setScriptBaseline(snapshotScripts(loaded));
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

  const createProject = async (projectName: string, templateId: ProjectTemplate["id"]) => {
    const title = projectName.trim();
    if (!title || newProjectBusy) return;
    const slug = slugify(title);
    if (projects.some((item) => item.slug === slug)) {
      setNewProjectError("A project with this name already exists. Choose another name.");
      return;
    }
    setNewProjectBusy(true);
    setNewProjectError("");
    try {
      const created = await rpc<Project>("project_create", { slug, title, template: templateId });
      setProjects((current) => [...current.filter((item) => item.slug !== slug), created]);
      setProject(created);
      setScriptBaseline(snapshotScripts(created));
      setSelectedEntityId(null);
      setSelectedScriptId(created.scripts[0]?.id ?? null);
      setFrames([]);
      setTestResults([]);
      setNewProjectOpen(false);
      pushLog(`created ${title}`);
    } catch (error) {
      const message = `Couldn't create the project. ${reason(error)}`;
      setNewProjectError(message);
      pushLog(`create failed: ${reason(error)}`, "error");
    } finally {
      setNewProjectBusy(false);
    }
  };

  const displayedProjects = useMemo(() => {
    const source = projects.length > 0 ? projects : [project];
    const pinned = new Set(pinnedProjectSlugs);
    return [...source].sort((left, right) => Number(pinned.has(right.slug)) - Number(pinned.has(left.slug)));
  }, [pinnedProjectSlugs, project, projects]);

  const handleProjectAction = useCallback(
    (target: Project, action: ProjectMenuAction) => {
      if (action === "pin") {
        setPinnedProjectSlugs((current) =>
          current.includes(target.slug)
            ? current.filter((slug) => slug !== target.slug)
            : [...current, target.slug],
        );
        return;
      }
      if (action === "reveal") {
        void rpc<{ path: string }>("project_reveal", { slug: target.slug })
          .then((result) => pushLog(`revealed ${result.path}`))
          .catch((error) => pushLog(`reveal failed: ${reason(error)}`, "error"));
        return;
      }
      setProjectActionError("");
      setProjectActionTitle(target.title);
      setPendingProjectAction({ action, project: target });
    },
    [pushLog],
  );

  const runPendingProjectAction = async () => {
    const pending = pendingProjectAction;
    if (!pending || projectActionBusy) return;
    const target = pending.project;
    setProjectActionBusy(true);
    setProjectActionError("");
    try {
      if (pending.action === "edit") {
        const renamed = await rpc<Project>("project_rename", {
          slug: target.slug,
          title: projectActionTitle.trim(),
        });
        setProjects((current) => current.map((item) => (item.slug === target.slug ? renamed : item)));
        if (project.slug === target.slug) setProject(renamed);
        pushLog(`renamed ${target.title} to ${renamed.title}`);
      } else if (pending.action === "worktree") {
        const result = await rpc<{ project: Project; path: string; branch: string; created: boolean }>(
          "project_create_worktree",
          { slug: target.slug },
        );
        setProjects((current) => current.map((item) => (item.slug === target.slug ? result.project : item)));
        if (project.slug === target.slug) setProject(result.project);
        pushLog(`${result.created ? "created" : "reused"} ${result.branch} at ${result.path}`);
      } else if (pending.action === "archive") {
        const result = await rpc<{ deleted: number }>("session_archive_project", { slug: target.slug });
        setSessions((current) => ({ ...current, [target.slug]: [] }));
        if (project.slug === target.slug) {
          setActiveSessionId(null);
          setSessionRevision((current) => current + 1);
        }
        pushLog(`archived ${result.deleted} chat${result.deleted === 1 ? "" : "s"} for ${target.title}`);
      } else if (pending.action === "remove") {
        await rpc("project_delete", { slug: target.slug });
        try {
          await rpc("session_archive_project", { slug: target.slug });
        } catch (error) {
          pushLog(`project removed, but its chat cleanup failed: ${reason(error)}`, "error");
        }
        const remaining = projects.filter((item) => item.slug !== target.slug);
        setProjects(remaining);
        setPinnedProjectSlugs((current) => current.filter((slug) => slug !== target.slug));
        setSessions((current) => {
          const next = { ...current };
          delete next[target.slug];
          return next;
        });
        if (project.slug === target.slug && remaining[0]) {
          setActiveSessionId(null);
          await openProject(remaining[0].slug);
        }
        pushLog(`removed ${target.title}`);
      }
      setPendingProjectAction(null);
    } catch (error) {
      const message = reason(error);
      setProjectActionError(message);
      pushLog(`${pending.action} failed: ${message}`, "error");
    } finally {
      setProjectActionBusy(false);
    }
  };

  const runTestSuite = useCallback(async () => {
    if (!runtime) return;
    setTesting(true);
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
    setTesting(false);
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
    drawCalls: frameStats.drawCalls,
    entities: project.entities.length,
    loadMs,
  };

  const failing = testResults.filter((result) => !result.pass).length;

  return (
    <div className="flex h-dvh flex-col">
      <TitleBar
        projectTitle={project.title}
        modelList={modelList}
        onToggleSidebar={() => {
          if (window.matchMedia("(min-width: 768px)").matches) {
            setSidebarVisible((visible) => !visible);
          } else {
            setSidebarDrawerOpen((open) => !open);
          }
        }}
        onToggleAgent={() => setAgentOpen((open) => !open)}
      />

      <div className="flex min-h-0 flex-1">
        <GamesSidebar
          projects={displayedProjects}
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
          pinnedProjectSlugs={pinnedProjectSlugs}
          onProjectAction={handleProjectAction}
          overlay={sidebarDrawerOpen}
          width={gamesSidebar.width}
          desktopVisible={sidebarVisible}
          workspace={workspace ? { name: workspace.name, root: workspace.root } : null}
          onOpenFolder={() => setOpenFolderOpen(true)}
        />

        {sidebarVisible ? (
          <ResizeHandle
            panel={gamesSidebar}
            bounds={GAMES_SIDEBAR}
            label="Resize games sidebar"
            className="hidden md:block"
          />
        ) : null}

        {/* Overlay backdrop for the narrow-window drawers. */}
        {(agentOpen || sidebarDrawerOpen) && (
          <button
            type="button"
            aria-label="Close panel"
            onClick={() => {
              setAgentOpen(false);
              setSidebarDrawerOpen(false);
            }}
            className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          />
        )}

        {/* The drag width applies only from lg up, where the panel is a real
            column; below that it is an overlay drawer with its own sizing. */}
        <aside
          style={{ "--agent-width": `${agentPanel.width}px` } as CSSProperties}
          className={`${
            agentOpen ? "fixed inset-y-0 right-0 z-40 block w-[min(384px,92vw)] shadow-2xl" : "hidden"
          } shrink-0 border-l border-white/[0.06] bg-[#0a0a0a] lg:static lg:block lg:w-[var(--agent-width)] lg:border-l-0 lg:border-r lg:shadow-none`}
        >
          <AgentPanel
            key={`${project.slug}:${sessionRevision}`}
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

        <ResizeHandle panel={agentPanel} bounds={AGENT_PANEL} label="Resize agent panel" className="hidden lg:block" />

        <main className="flex min-w-0 flex-1 flex-col bg-[#080808]">
          <WorkspaceTabs
            active={tab}
            onChange={setTab}
            badges={{ test: failing || undefined }}
            // Without a workspace there is no preview server; core serves no
            // /play route, and the old label hardcoded port 5199.
            previewUrl={workspace ? workspace.root : `project · ${project.slug}`}
            onNewGame={() => setNewProjectOpen(true)}
            onExport={() => void saveProject()}
            exporting={exporting}
          />

          <div className="relative min-h-0 flex-1">
            {/* A live workspace owns PLAY: its own dev server renders the real
                game, rather than the scene document the editor manages. */}
            {tab === "play" && workspace ? (
              <div role="tabpanel" id="workspace-panel-play" aria-labelledby="workspace-tab-play" className="absolute inset-0">
                <LivePreview
                  workspaceId={workspace.id}
                  workspaceName={workspace.name}
                  script={workspace.scripts.dev ? "dev" : Object.keys(workspace.scripts)[0] ?? "dev"}
                  onError={(text) => pushLog(text, "error")}
                />
              </div>
            ) : null}

            {/* The viewport stays mounted across tabs so PIE never loses its WebGL context. */}
            <div
              className={
                tab === "play" && !workspace
                  ? "absolute inset-0"
                  : "pointer-events-none absolute inset-0 opacity-0"
              }
              aria-hidden={tab !== "play" || Boolean(workspace)}
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
              {tab === "play" && !workspace ? (
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

            {tab === "code" && workspace ? (
              <div role="tabpanel" id="workspace-panel-code" aria-labelledby="workspace-tab-code" className="absolute inset-0 flex min-h-0">
                <div className="min-h-0 shrink-0 border-r border-white/[0.06]" style={{ width: fileTreePanel.width }}>
                  <FileTree
                    workspaceId={workspace.id}
                    activePath={workspaceFile}
                    onOpenFile={setWorkspaceFile}
                    onError={(text) => pushLog(text, "error")}
                  />
                </div>
                <ResizeHandle panel={fileTreePanel} bounds={FILE_TREE_PANEL} label="Resize file tree" />
                <div className="min-h-0 flex-1">
                  <FileEditor
                    workspaceId={workspace.id}
                    path={workspaceFile}
                    onSaved={(path) => pushLog(`saved ${path}`)}
                    onError={(text) => pushLog(text, "error")}
                  />
                </div>
              </div>
            ) : null}

            {tab === "code" && !workspace ? (
              <div role="tabpanel" id="workspace-panel-code" aria-labelledby="workspace-tab-code" className="absolute inset-0">
                <CodeTab
                  scripts={project.scripts}
                  baseline={scriptBaseline}
                  selectedId={selectedScriptId}
                  onSelect={setSelectedScriptId}
                  onChange={(script) => setProject((current) => updateScript(current, script.id, script))}
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
              <div role="tabpanel" id="workspace-panel-art" aria-labelledby="workspace-tab-art" className="absolute inset-0">
                <ArtTab
                  assets={project.assets}
                  entities={project.entities}
                  onGenerate={(created) =>
                    setProject((current) => created.reduce((next, asset) => addAsset(next, asset), current))
                  }
                  onPromote={promoteAsset}
                  onRemove={(assetId) =>
                    setProject((current) => ({
                      ...current,
                      assets: current.assets.filter((asset) => asset.id !== assetId),
                    }))
                  }
                  onImportImage={(file) => void handleImportImage(file)}
                  onLog={pushLog}
                />
              </div>
            ) : null}

            {tab === "scene" ? (
              <div role="tabpanel" id="workspace-panel-scene" aria-labelledby="workspace-tab-scene" className="absolute inset-0">
                <SceneGraphCanvas
                  project={project}
                  selectedEntityId={selectedEntityId}
                  onSelect={setSelectedEntityId}
                  onAddEntity={handleAddEntity}
                  onPatchEntity={(id, patch) => setProject((current) => updateEntity(current, id, patch))}
                  onRemoveEntity={(id) => {
                    setProject((current) => removeEntity(current, id));
                    if (selectedEntityId === id) setSelectedEntityId(null);
                  }}
                />
              </div>
            ) : null}

            {tab === "test" ? (
              <div role="tabpanel" id="workspace-panel-test" aria-labelledby="workspace-tab-test" className="absolute inset-0">
                <TestTab
                  results={testResults}
                  frames={frames}
                  running={testing}
                  canRun={Boolean(runtime)}
                  onRun={() => void runTestSuite()}
                  onFixAll={(issues) => {
                    setTab("play");
                    pushLog(`asked the agent to fix ${issues.length} issue${issues.length === 1 ? "" : "s"}`);
                    void rpc("agent_chat", {
                      projectSlug: project.slug,
                      permissionMode: "auto-accept-edits",
                      maxTurns: 12,
                      messages: [
                        {
                          role: "user",
                          content: `The playtest found these issues. Fix them in the project:\n${issues
                            .map((issue) => `- [${issue.severity}] ${issue.title}: ${issue.description}`)
                            .join("\n")}`,
                        },
                      ],
                    }).catch((error) => pushLog(`fix-all failed: ${reason(error)}`, "error"));
                  }}
                />
              </div>
            ) : null}
          </div>

          <LiveBar stats={stats} pieState={pieState} logs={logs} />
        </main>
      </div>

      <Dialog open={openFolderOpen} onOpenChange={setOpenFolderOpen}>
        <DialogContent className="max-w-lg">
          <DialogTitle>Open folder as a live project</DialogTitle>
          <DialogDescription>
            CaliCode edits this folder in place and runs its own dev server. It must contain a package.json or a
            .git directory.
          </DialogDescription>
          <form
            className="mt-3"
            onSubmit={(event) => {
              event.preventDefault();
              void attachFolder();
            }}
          >
            <Label htmlFor="workspace-path">Absolute path</Label>
            <Input
              id="workspace-path"
              className="mt-1"
              value={folderPath}
              onChange={(event) => setFolderPath(event.target.value)}
              autoFocus
              placeholder="/Users/you/code/my-game"
            />
            <div className="mt-3 flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" size="sm" disabled={!folderPath.trim()}>
                Open
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <NewProjectDialog
        open={newProjectOpen}
        busy={newProjectBusy}
        error={newProjectError}
        onOpenChange={(open) => {
          setNewProjectOpen(open);
          if (open) setNewProjectError("");
        }}
        onCreate={createProject}
      />

      <Dialog
        open={pendingProjectAction !== null}
        onOpenChange={(open) => {
          if (!open && !projectActionBusy) {
            setPendingProjectAction(null);
            setProjectActionError("");
          }
        }}
      >
        <DialogContent className="max-w-sm border-white/[0.1] bg-[#1d1d1c] text-[#eceae7] shadow-[0_24px_80px_rgba(0,0,0,0.6)]">
          {pendingProjectAction ? (
            <>
              <DialogTitle>{projectActionDialogTitle(pendingProjectAction.action)}</DialogTitle>
              <DialogDescription className="mt-1 leading-relaxed text-[#aaa7a1]">
                {projectActionDialogDescription(pendingProjectAction)}
              </DialogDescription>

              {pendingProjectAction.action === "edit" ? (
                <form
                  className="mt-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runPendingProjectAction();
                  }}
                >
                  <Label htmlFor="edit-project-title">Project name</Label>
                  <Input
                    id="edit-project-title"
                    className="mt-1 border-white/[0.12] bg-[#111110]"
                    value={projectActionTitle}
                    onChange={(event) => setProjectActionTitle(event.target.value)}
                    autoFocus
                  />
                  {projectActionError ? <p className="mt-2 text-xs text-[#f0a29b]">{projectActionError}</p> : null}
                  <ProjectActionButtons
                    busy={projectActionBusy}
                    disabled={!projectActionTitle.trim()}
                    confirmLabel="Save changes"
                  />
                </form>
              ) : (
                <div className="mt-4">
                  {pendingProjectAction.action === "worktree" && !pendingProjectAction.project.workspaceRoot ? (
                    <p className="rounded-md border border-[#b6803c]/30 bg-[#8b5e25]/10 px-3 py-2 text-xs leading-relaxed text-[#d8b47f]">
                      Attach a Git project folder first, then run this action again.
                    </p>
                  ) : null}
                  {projectActionError ? <p className="mt-2 text-xs text-[#f0a29b]">{projectActionError}</p> : null}
                  <ProjectActionButtons
                    busy={projectActionBusy}
                    disabled={pendingProjectAction.action === "worktree" && !pendingProjectAction.project.workspaceRoot}
                    confirmLabel={projectActionConfirmLabel(pendingProjectAction.action)}
                    destructive={pendingProjectAction.action === "archive" || pendingProjectAction.action === "remove"}
                    onConfirm={() => void runPendingProjectAction()}
                  />
                </div>
              )}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProjectActionButtons({
  busy,
  disabled,
  confirmLabel,
  destructive = false,
  onConfirm,
}: {
  busy: boolean;
  disabled: boolean;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm?: () => void;
}) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <DialogClose asChild>
        <Button type="button" variant="ghost" size="sm" disabled={busy}>
          Cancel
        </Button>
      </DialogClose>
      <Button
        type={onConfirm ? "button" : "submit"}
        size="sm"
        disabled={busy || disabled}
        onClick={onConfirm}
        className={destructive ? "bg-[#a83d35] text-white hover:bg-[#bd4b42]" : ""}
      >
        {busy ? "Working..." : confirmLabel}
      </Button>
    </div>
  );
}

function projectActionDialogTitle(action: DialogProjectAction): string {
  return {
    edit: "Edit project",
    worktree: "Create permanent worktree",
    archive: "Archive chats",
    remove: "Remove project",
  }[action];
}

function projectActionDialogDescription({ action, project }: PendingProjectAction): string {
  if (action === "edit") return `Rename ${project.title}. Its slug and files will stay unchanged.`;
  if (action === "worktree") {
    return `Create calicode/${project.slug} under ~/.cali/worktrees and attach ${project.title} to it.`;
  }
  if (action === "archive") return `Permanently delete every saved chat for ${project.title}. The project files stay intact.`;
  return `Permanently remove ${project.title} and its saved chats. This cannot be undone.`;
}

function projectActionConfirmLabel(action: DialogProjectAction): string {
  return {
    edit: "Save changes",
    worktree: "Create worktree",
    archive: "Archive chats",
    remove: "Remove project",
  }[action];
}

interface ResizeHandleProps {
  panel: ResizablePanel;
  bounds: ResizablePanelOptions;
  label: string;
  className?: string;
}

/**
 * The grab strip between two panels.
 *
 * A focusable separator so the layout is reachable without a pointer: arrows
 * nudge it, double-click snaps back to the default width.
 */
function ResizeHandle({ panel, bounds, label, className = "" }: ResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={panel.width}
      aria-valuemin={bounds.minWidth}
      aria-valuemax={bounds.maxWidth}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={panel.onDragStart}
      onKeyDown={panel.onKeyDown}
      onDoubleClick={panel.reset}
      className={`w-[5px] shrink-0 cursor-col-resize transition-colors hover:bg-white/15 active:bg-white/25 focus-visible:bg-white/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/40 ${
        panel.isDragging ? "bg-white/25" : "bg-transparent"
      } ${className}`}
    />
  );
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sessions, validated on read.
 *
 * This used to JSON.parse without checking the shape, so a corrupted value —
 * `"null"`, or any slug mapped to a non-array — threw inside GamesSidebar and
 * white-screened the editor with no error boundary. The bad value persisted,
 * so every reload crashed again and only clearing localStorage recovered.
 * readView already validated; this now matches it.
 */
function readSessions(): Record<string, GameSession[]> {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

    const clean: Record<string, GameSession[]> = {};
    for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      clean[slug] = value.filter(
        (item): item is GameSession =>
          typeof item === "object" && item !== null && typeof (item as GameSession).id === "string",
      );
    }
    return clean;
  } catch {
    return {};
  }
}

function readPinnedProjects(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_PROJECTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((slug): slug is string => typeof slug === "string"))]
      : [];
  } catch {
    return [];
  }
}

async function readFileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
