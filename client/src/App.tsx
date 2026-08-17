import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Viewport } from "./components/editor/Viewport";
import { ConsolePanel, type LogEntry } from "./components/editor/ConsolePanel";
import { AgentPanel } from "./components/editor/AgentPanel";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  PanelBottom,
  PanelLeft,
  PanelRight,
} from "lucide-react";
import blenderLogo from "./assets/blender-logo.svg";
import { hasOverlayWindowControls } from "./lib/desktop";
import {
  GamesSidebar,
  type ProjectMenuAction,
  type SessionMenuAction,
} from "./components/workspace/GamesSidebar";
import { AssetsLibraryPage } from "./components/library/AssetsLibraryPage";
import { SettingsPage } from "./components/settings/SettingsPage";
import {
  archiveSession,
  createSession,
  forkSession,
  listSessions,
  renameSession,
  type SessionSummary,
} from "./lib/sessions";
import {
  MULTI_INSTANCE_TABS,
  WORKSPACE_TABS,
  WorkspaceTabs,
  nextTabId,
  tabKind,
  type WorkspaceTab,
  type WorkspaceTabId,
} from "./components/workspace/WorkspaceTabs";
import { PlayOverlay, type TweakPin } from "./components/workspace/PlayOverlay";
import { TweakPanel, entityTweakControls, type TweakControl } from "./components/workspace/TweakPanel";
import { LiveBar, type LiveStats } from "./components/workspace/LiveBar";
import { Button } from "./components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { currentCoreStatus, rpc, subscribeCoreStatus, type CoreConnectionState } from "./lib/rpc";
import { withIntroducedTabs } from "./lib/viewState";
import {
  attachRepo,
  attachedRepos,
  catalogSnapshot,
  detachRepo,
  getRepo,
  setRepoSetting,
  type RepoSettingValue,
} from "./lib/assetLibrary";
import { addAsset, removeAsset, removeEntity, slugify, starterProject, uid, updateAsset, updateEntity, updateScript } from "./lib/store";
import { applyOps, emptySpec, specFromProcedural, type ApplyResult, type BuilderOp } from "./lib/assetBuilderOps";
import { AssetBuilder, projectAssetWrite } from "./components/editor/AssetBuilder";
import type { CaliSpec } from "./lib/assetPipeline";
import { runTests } from "./lib/testRunner";
import { useBrowserTools } from "./lib/useBrowserTools";
import { useFrameStats } from "./lib/useFrameStats";
import { CodeTab } from "./components/workspace/CodeTab";
import { ArtTab } from "./components/workspace/ArtTab";
import { SceneGraphCanvas } from "./components/workspace/SceneGraphCanvas";
import { TestTab, toIssues } from "./components/workspace/TestTab";
import { BrowserTab } from "./components/workspace/BrowserTab";
import { TerminalTab } from "./components/workspace/TerminalTab";
import { BottomPanel } from "./components/workspace/BottomPanel";
import { SideChat, type SideChatDraft, type SideMessage } from "./components/editor/SideChat";
import { ReportsTab } from "./components/workspace/ReportsTab";
import { FileTree } from "./components/workspace/FileTree";
import { FileEditor } from "./components/workspace/FileEditor";
import { LivePreview } from "./components/workspace/LivePreview";
import { NewProjectDialog } from "./components/workspace/NewProjectDialog";
import { FolderPicker } from "./components/workspace/FolderPicker";
import { StarterPicker } from "./components/workspace/StarterPicker";
import { createWorkspaceFromStarter, defaultStarterPath } from "./lib/starters";
import {
  chooseNativeWorkspace,
  openWorkspace,
  readWorkspaceFile,
  setProjectWorkspace,
  type WorkspaceInfo,
} from "./lib/workspace";
import { isSafeActivityPath, type ActivityFileChange } from "./lib/activity";
import {
  useResizablePanels,
  type ResizablePanel,
  type ResizablePanelOptions,
} from "./hooks/useResizablePanels";
import type { PieRuntime, PieState } from "./lib/pie";
import type { AgentMessage, Asset, CapturedFrame, Entity, ModelList, Project, TestResult } from "./lib/types";
import type { ProjectTemplate } from "./lib/projectTemplates";
import { importMime, isBlenderAsset } from "./lib/blender";

const snapshotScripts = (p: Project): Record<string, string> => Object.fromEntries(p.scripts.map((x) => [x.id, x.code]));

const VIEW_KEY = "calicode-view";
/** The dock's console tab is fixed, so its id is a constant rather than a uuid. */
const CONSOLE_TAB_ID = "console";

/** Small icon button used in the collapsed-sidebar chrome strip. */
const CHROME_ICON_BUTTON =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors enabled:hover:bg-surface-2 enabled:hover:text-ink-strong disabled:opacity-35";
const PINNED_PROJECTS_KEY = "calicode-pinned-projects";
const PINNED_SESSIONS_KEY = "calicode-pinned-sessions";
const THEME_KEY = "calicode-theme";

type Theme = "dark" | "light";

/** Autosave, as the header reports it. There is no SAVE button to fall back on. */
type SaveState = { status: "saved" | "saving" } | { status: "error"; message: string };

/**
 * An unsaved workspace-file buffer. `verified` is true when the file's on-disk
 * contents were read and the text is known to differ from them; false when the
 * read failed, which keeps the text but withholds the claim that it modifies
 * anything, since nobody knows what it would be modifying.
 */
type DraftBuffer = { text: string; verified: boolean };

function readTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

type DialogProjectAction = Exclude<ProjectMenuAction, "pin" | "reveal" | "attach">;

interface PendingProjectAction {
  action: DialogProjectAction;
  project: Project;
}

/** Only renaming stops for a dialog; the rest act on the spot — archiving
 *  included, since Settings → Archive can undo it. */
type DialogSessionAction = Extract<SessionMenuAction, "rename">;

interface PendingSessionAction {
  action: DialogSessionAction;
  session: SessionSummary;
}

/**
 * The chat column (transcript + composer) never yields more than this to the
 * side panels: wide enough for the composer's permission/model row and the
 * empty-state wordmark. The static maxWidths below are ceilings for a roomy
 * window; the App body lowers them per-render so sidebar + chat + tools always
 * fit the actual viewport instead of the dragged panel overflowing the chat.
 */
const MIN_CHAT_WIDTH = 360;
/** Matches ResizeHandle's w-[5px]. */
const RESIZE_HANDLE_WIDTH = 5;
/** Tailwind lg — below this the tools dock leaves the row and overlays. */
const TOOLS_DOCK_BREAKPOINT = 1024;

/** Panel bounds are shared by the hook and the handle's aria value range. */
const GAMES_SIDEBAR: ResizablePanelOptions = {
  storageKey: "calicode-games-sidebar-width",
  defaultWidth: 240,
  minWidth: 180,
  maxWidth: 420,
};

const TOOLS_PANEL: ResizablePanelOptions = {
  storageKey: "calicode-tools-width",
  defaultWidth: 560,
  minWidth: 360,
  maxWidth: 960,
  invert: true,
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
  tab: WorkspaceTabId;
  /** Views open as dock tabs. Order is the strip order. */
  openTabs: WorkspaceTabId[];
  /**
   * Views this editor has already offered.
   *
   * Without it, adding a view to `WORKSPACE_TABS` shipped it to nobody: the
   * stored strip is filtered against the catalogue, so an editor that had ever
   * saved one simply never grew the new tab, and BROWSER was invisible to
   * every existing install. Recording what has been offered is what separates
   * "new, show it once" from "the user closed it", which openTabs alone cannot
   * express.
   */
  seenTabs?: WorkspaceTab[];
  workspaceFile: string | null;
}

function readView(): ViewState {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ViewState>) : {};
    const tab = WORKSPACE_TABS.includes(parsed.tab as WorkspaceTab) ? (parsed.tab as WorkspaceTab) : "play";
    // A stored strip is filtered against the current view list, so a released
    // or renamed view cannot restore a tab that no longer has a panel. An
    // empty result falls back to every view rather than none — a dock with no
    // tabs has nothing to show and no way back.
    // Bare ids only: a second side chat is a memory-only thread, so restoring
    // its tab would reopen an empty panel the user never asked for again.
    const stored = Array.isArray(parsed.openTabs)
      ? parsed.openTabs.filter((entry): entry is WorkspaceTab => WORKSPACE_TABS.includes(entry as WorkspaceTab))
      : [];
    // An editor that predates `seenTabs` is treated as having been offered
    // exactly what it has open, so only genuinely new views appear.
    const seen = Array.isArray(parsed.seenTabs)
      ? parsed.seenTabs.filter((entry): entry is WorkspaceTab => WORKSPACE_TABS.includes(entry as WorkspaceTab))
      : stored;
    const openTabs = withIntroducedTabs(stored, seen, WORKSPACE_TABS);
    if (!openTabs.includes(tab)) openTabs.unshift(tab);
    return {
      tab,
      openTabs,
      seenTabs: [...WORKSPACE_TABS],
      workspaceFile: typeof parsed.workspaceFile === "string" ? parsed.workspaceFile : null,
    };
  } catch {
    return { tab: "play", openTabs: [...WORKSPACE_TABS], seenTabs: [...WORKSPACE_TABS], workspaceFile: null };
  }
}

function sameWorkspaceRoot(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return left === right;
  const normalize = (value: string) => value.trim().replace(/[\\/]+$/, "");
  return normalize(left) === normalize(right);
}

/** Stable identity for a game with no side thread yet. */
const EMPTY_SIDE_THREAD: SideMessage[] = [];

export default function App() {
  const [project, setProject] = useState<Project>(starterProject);
  const [coreStatus, setCoreStatus] = useState<CoreConnectionState>(currentCoreStatus);
  const [coreRetry, setCoreRetry] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>("spin");
  const [runtime, setRuntime] = useState<PieRuntime | null>(null);
  const [pieState, setPieState] = useState<PieState>("idle");
  const [frames, setFrames] = useState<CapturedFrame[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsRef = useRef<LogEntry[]>(logs);
  logsRef.current = logs;
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [modelList, setModelList] = useState<ModelList | null>(null);
  const [captureEvery, setCaptureEvery] = useState(3);
  const [assetSearch, setAssetSearch] = useState("");
  const [tab, setTab] = useState<WorkspaceTabId>(() => readView().tab);
  const [openTabs, setOpenTabs] = useState<WorkspaceTabId[]>(() => readView().openTabs);
  // Render mirror of the strip, so an opener can allocate against the current
  // set without waiting for a re-render.
  const openTabsRef = useRef<WorkspaceTabId[]>(openTabs);
  openTabsRef.current = openTabs;
  /**
   * What the agent browser currently has open, so the BROWSER tab can show the
   * page's own title and favicon the way a browser tab does.
   *
   * Polled here rather than inside the panel because the panel unmounts when
   * you switch to another view — which is exactly when the strip is the only
   * thing still telling you what is open.
   */
  const [browserPage, setBrowserPage] = useState<{ title?: string; icon?: string }>({});
  // Dock fills the window, hiding the sidebar and chat. Not persisted: full
  // screen is a momentary mode, and restoring into it on launch would hide
  // the conversation with no obvious way back.
  const [toolsExpanded, setToolsExpanded] = useState(false);
  // The bottom dock and its terminal sessions. Sessions outlive a dismissal so
  // reopening the panel returns to the shells you left running.
  // Side chat: an observer conversation about the run. It holds a copy of the
  // transcript and talks to a tool-less endpoint, so asking about a run can
  // never alter it.
  const [mainTranscript, setMainTranscript] = useState<AgentMessage[]>([]);
  // Text `/side <question>` puts in the side chat's composer, unsent. The
  // nonce is what makes a repeat of the same question reach the panel again.
  // Drafts and threads are per side chat, not per project: `/side` twice
  // opens two threads, and a question typed into one must not appear in the
  // other.
  const [sideChatDrafts, setSideChatDrafts] = useState<Record<string, SideChatDraft>>({});
  // Side threads per game, held here so closing the tab does not discard the
  // conversation. Memory only: a side chat is never written to disk, and
  // quitting the app still ends it.
  const [sideChatThreads, setSideChatThreads] = useState<Record<string, SideMessage[]>>({});
  const [bottomOpen, setBottomOpen] = useState(false);
  const [bottomAnimating, setBottomAnimating] = useState(false);
  const [terminalTabs, setTerminalTabs] = useState<Array<{ id: string; title: string }>>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(CONSOLE_TAB_ID);
  // Asset open in the 3D builder (BUILD tab); null shows the picker.
  const [builderAssetId, setBuilderAssetId] = useState<string | null>(null);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [activePin, setActivePin] = useState<string | null>(null);
  const [loadMs, setLoadMs] = useState<number | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectBusy, setNewProjectBusy] = useState(false);
  const [newProjectError, setNewProjectError] = useState("");
  // The saved transcripts core keeps under ~/.cali/sessions — the sidebar's
  // recents. AgentPanel refreshes this list whenever it saves or deletes one.
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // Per-session "is the agent running" flag. The panel remounts on selection
  // change, so its internal busy state dies with it — but a turn that is in
  // flight in another browser window, or a panel we just navigated away
  // from, still needs a spinner on its sidebar row. AgentPanel reports each
  // transition (start/stop, plus a null on unmount) into this set.
  const [runningSessionIds, setRunningSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pinnedProjectSlugs, setPinnedProjectSlugs] = useState<string[]>(() => readPinnedIds(PINNED_PROJECTS_KEY));
  const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>(() => readPinnedIds(PINNED_SESSIONS_KEY));
  const [pendingProjectAction, setPendingProjectAction] = useState<PendingProjectAction | null>(null);
  const [projectActionTitle, setProjectActionTitle] = useState("");
  const [projectActionBusy, setProjectActionBusy] = useState(false);
  const [projectActionError, setProjectActionError] = useState("");
  const [pendingSessionAction, setPendingSessionAction] = useState<PendingSessionAction | null>(null);
  const [sessionActionTitle, setSessionActionTitle] = useState("");
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [sessionActionError, setSessionActionError] = useState("");
  const [sessionRevision, setSessionRevision] = useState(0);
  // Scripts as of the last load or save, so CODE can show a real diff.
  const [scriptBaseline, setScriptBaseline] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workspaceFile, setWorkspaceFile] = useState<string | null>(() => readView().workspaceFile);
  const [workspaceOpenError, setWorkspaceOpenError] = useState<string | null>(null);
  // Agent activity can arrive while the selected session's workspace is still
  // opening. Keep only a validated, project-scoped selection until the
  // matching root is loaded; never let a stale/foreign path jump the editor.
  const [activityFile, setActivityFile] = useState<ActivityFileChange | null>(null);
  const [pendingActivityFile, setPendingActivityFile] = useState<ActivityFileChange | null>(null);
  // Unsaved workspace-file buffers, keyed by path. FileEditor unmounts on
  // every tab change and used to reset its draft whenever the path changed,
  // so typed work only survives if it is held above both of those events.
  // `verified` is false while the file's read failed: the text is kept exactly
  // like any other buffer, but its disk state is unknown, so it is not a known
  // modification and must not be advertised as one.
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, DraftBuffer>>({});
  const [saveState, setSaveState] = useState<SaveState>({ status: "saved" });
  // The most recent error log, raised where the user is actually looking.
  const [errorToast, setErrorToast] = useState<{ id: string; message: string } | null>(null);
  // Below lg/md these panes leave the layout entirely; the toggles open them
  // as overlays so the agent and the games list stay reachable on a narrow
  // window rather than simply disappearing.
  const [toolsOpen, setToolsOpen] = useState(false);
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  // From lg up the dock is a real column; the chat header's panel button
  // hides/shows it there, and below lg the same button drives the overlay.
  // What the main column shows: the agent chat, or the Assets Library page.
  const [mainView, setMainView] = useState<"chat" | "library">("chat");
  const [toolsVisible, setToolsVisible] = useState<boolean>(
    () => localStorage.getItem("calicode-tools-visible") !== "0",
  );
  const [toolsAnimating, setToolsAnimating] = useState(false);
  const toolsAnimTimer = useRef<number | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarAnimating, setSidebarAnimating] = useState(false);
  const sidebarAnimTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (toolsAnimTimer.current) window.clearTimeout(toolsAnimTimer.current);
      if (sidebarAnimTimer.current) window.clearTimeout(sidebarAnimTimer.current);
    },
    [],
  );
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Only while the BROWSER tab is in the strip: this asks core, which asks the
  // page, and there is no reason to do that for a view nobody has open. Core
  // caches the favicon per origin, so the repeat cost is a lookup.
  const browserTabOpen = openTabs.includes("browser");
  // Side chats are numbered by strip position rather than by id: closing the
  // first should renumber the rest, not leave a gap where it was.
  const sideChatIds = useMemo(() => openTabs.filter((id) => tabKind(id) === "sidechat"), [openTabs]);
  const sideChatNames = useMemo(
    () =>
      Object.fromEntries(
        sideChatIds.map((id, index) => [id, index === 0 ? "Side chat" : `Side chat ${index + 1}`]),
      ),
    [sideChatIds],
  );
  /**
   * Where the next `/side` goes. Each run gets its own thread, except that an
   * untouched panel — nothing asked, nothing typed — is used before a new one
   * is opened beside it. Without that, the side chat the dock ships with would
   * sit empty forever while every question opened another tab next to it.
   */
  const openFreshSideChat = (): WorkspaceTabId => {
    const pristine = sideChatIds.find(
      (id) => !sideChatDrafts[id] && (sideChatThreads[`${project.slug}::${id}`]?.length ?? 0) === 0,
    );
    if (!pristine) return addWorkspaceTab("sidechat");
    setTab(pristine);
    return pristine;
  };

  /** Strip labels. The first side chat keeps the plain view label. */
  const sideChatTitles = useMemo(
    () => Object.fromEntries(sideChatIds.slice(1).map((id, index) => [id, `Side chat ${index + 2}`])),
    [sideChatIds],
  );
  useEffect(() => {
    if (!browserTabOpen) {
      setBrowserPage({});
      return;
    }
    let cancelled = false;
    const poll = () => {
      rpc<{ running?: boolean; title?: string | null; icon?: string | null }>("browser_status")
        .then((status) => {
          if (cancelled) return;
          setBrowserPage(
            status?.running
              ? { title: status.title ?? undefined, icon: status.icon ?? undefined }
              : {},
          );
        })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [browserTabOpen]);
  // From lg up the tools dock occupies the row, so the sidebar must also leave
  // room for it at its narrowest; below lg the dock is an overlay drawer.
  const toolsDocked = mainView === "chat" && toolsVisible && viewportWidth >= TOOLS_DOCK_BREAKPOINT;
  const sidebarBounds: ResizablePanelOptions = {
    ...GAMES_SIDEBAR,
    maxWidth: Math.min(
      GAMES_SIDEBAR.maxWidth,
      viewportWidth -
        MIN_CHAT_WIDTH -
        RESIZE_HANDLE_WIDTH -
        (toolsDocked ? TOOLS_PANEL.minWidth + RESIZE_HANDLE_WIDTH : 0),
    ),
  };
  const gamesSidebar = useResizablePanels(sidebarBounds);
  // Clamp against at least the lg width: below the breakpoint the dock is an
  // overlay whose width var is unused, and clamping to a phone-sized viewport
  // would needlessly throw away the docked width.
  const toolsBounds: ResizablePanelOptions = {
    ...TOOLS_PANEL,
    maxWidth: Math.min(
      TOOLS_PANEL.maxWidth,
      Math.max(viewportWidth, TOOLS_DOCK_BREAKPOINT) -
        MIN_CHAT_WIDTH -
        RESIZE_HANDLE_WIDTH -
        (sidebarVisible ? gamesSidebar.width + RESIZE_HANDLE_WIDTH : 0),
    ),
  };
  const toolsPanel = useResizablePanels(toolsBounds);
  const fileTreePanel = useResizablePanels(FILE_TREE_PANEL);
  // Which game the attach-folder dialog binds to; the dialog is open while
  // this is non-null. Opening a folder as a brand-new game lives in the
  // "New game" dialog instead (NewProjectDialog's source-folder path).
  const [folderTarget, setFolderTarget] = useState<Project | null>(null);
  const [attachPath, setAttachPath] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  /** "existing" attaches a folder that is already there; "starter" scaffolds one. */
  const [attachMode, setAttachMode] = useState<"existing" | "starter">("existing");
  const [starterId, setStarterId] = useState<string | null>(null);
  const [starterPath, setStarterPath] = useState("");
  const [folderError, setFolderError] = useState("");
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const workbenchRef = useRef<HTMLDivElement>(null);
  // Where you have been: every game/chat selection pushes an entry, and the
  // sidebar's back/forward arrows walk the stack browser-style.
  const [nav, setNav] = useState<{ stack: { slug: string; sessionId: string | null }[]; index: number }>({
    stack: [{ slug: "starter", sessionId: null }],
    index: 0,
  });

  const runtimeRef = useRef<PieRuntime | null>(null);
  runtimeRef.current = runtime;
  // Keep the active slug stable for a recovery load without making the
  // startup effect rerun on every local edit or project switch.
  const projectSlugRef = useRef(project.slug);
  projectSlugRef.current = project.slug;
  const coreHydratedRef = useRef(false);
  const previousCoreStatusRef = useRef<CoreConnectionState>(currentCoreStatus());

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    window.requestAnimationFrame(() => {
      const visibleButton = (selector: string) =>
        Array.from(document.querySelectorAll<HTMLButtonElement>(selector)).find(
          (button) => button.getClientRects().length > 0,
        );
      (visibleButton('button[aria-label="Studio menu"]') ??
        visibleButton('button[aria-label="Toggle games sidebar"]'))?.focus();
    });
  }, []);

  useEffect(() => {
    const workbench = workbenchRef.current;
    if (!workbench) return;
    if (settingsOpen) workbench.setAttribute("inert", "");
    else workbench.removeAttribute("inert");
    return () => workbench.removeAttribute("inert");
  }, [settingsOpen]);

  const pushLog = useCallback((text: string, level: "info" | "error" = "info") => {
    // Browser tool calls can arrive back-to-back before React renders. Build
    // from and update the synchronous mirror before scheduling state so an
    // immediate editor_console_log -> editor_console_history sequence sees
    // the entry that was actually appended, not the preceding render.
    const entry = { id: uid("log"), level, message: text, time: new Date().toLocaleTimeString() };
    const next = [...logsRef.current.slice(-199), entry];
    logsRef.current = next;
    setLogs(next);
    // Failures used to land only in LiveBar's console, which is collapsed by
    // default inside a dock that can be closed or off-screen entirely.
    if (level === "error") setErrorToast({ id: entry.id, message: text });
  }, []);
  const getLogs = useCallback(() => logsRef.current, []);

  // Long enough to read, then gone — the console keeps the permanent copy.
  useEffect(() => {
    if (!errorToast) return;
    const timer = window.setTimeout(() => setErrorToast(null), 8000);
    return () => window.clearTimeout(timer);
  }, [errorToast]);

  // Stable identities for the workspace panes. FileTree and FileEditor read
  // these inside effects; an inline arrow here means a fresh identity every
  // render, which is how a single failed RPC once turned into ~200 requests in
  // ten seconds. They hold the callback in a ref too — this keeps the prop
  // honest so that defence never has to carry it alone.
  const handleWorkspaceError = useCallback((text: string) => pushLog(text, "error"), [pushLog]);
  const dropDirtyFile = useCallback((path: string) => {
    setDirtyFiles((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  }, []);
  const handleWorkspaceSaved = useCallback(
    (path: string) => {
      // The buffer is on disk now. The editor retires its own entry, but only
      // while it is mounted for that path — prune here too so a save followed
      // by a tab or file switch can never leave a buffer behind to be seeded
      // back into the file later.
      dropDirtyFile(path);
      pushLog(`saved ${path}`);
    },
    [dropDirtyFile, pushLog],
  );
  const handleDraftChange = useCallback(
    (path: string, draft: string | null, verified: boolean) => {
      if (draft === null) {
        dropDirtyFile(path);
        return;
      }
      setDirtyFiles((current) => {
        const existing = current[path];
        if (existing && existing.text === draft && existing.verified === verified) return current;
        return { ...current, [path]: { text: draft, verified } };
      });
    },
    [dropDirtyFile],
  );
  // A different folder means different paths; a stale buffer must never be
  // offered as the contents of a same-named file in another workspace.
  const workspaceId = workspace?.id ?? null;
  useEffect(() => {
    setDirtyFiles((current) => (Object.keys(current).length === 0 ? current : {}));
  }, [workspaceId]);
  // The tree's MODIFIED marker is a claim about disk: this file differs from
  // what is stored. A buffer whose file could not be read supports no such
  // claim, so it is held but left out of this set; the editor shows that state
  // in its own words instead.
  const dirtyPaths = useMemo(
    () => new Set(Object.entries(dirtyFiles).filter(([, buffer]) => buffer.verified).map(([path]) => path)),
    [dirtyFiles],
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    void listSessions().then(setSessions).catch(() => {});
  }, []);

  useEffect(() => {
    localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify(pinnedProjectSlugs));
  }, [pinnedProjectSlugs]);

  useEffect(() => {
    localStorage.setItem(PINNED_SESSIONS_KEY, JSON.stringify(pinnedSessionIds));
  }, [pinnedSessionIds]);

  useEffect(() => {
    // `seenTabs` is the whole current catalogue, not the open strip: once a
    // view has been offered it must not be offered again just because it was
    // closed.
    localStorage.setItem(
      VIEW_KEY,
      JSON.stringify({ tab, openTabs, seenTabs: [...WORKSPACE_TABS], workspaceFile } satisfies ViewState),
    );
  }, [tab, openTabs, workspaceFile]);

  useEffect(() => subscribeCoreStatus(setCoreStatus), []);

  // If core is started after the browser, probe it periodically. This only
  // retries hydration when the app never loaded a real project; a hydrated
  // project stays visible across a restart instead of being replaced by
  // Starter or by a partially restored document.
  useEffect(() => {
    if (coreStatus !== "offline") return;
    const timer = window.setInterval(() => {
      void rpc("ping").catch(() => {});
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [coreStatus]);

  useEffect(() => {
    const previous = previousCoreStatusRef.current;
    previousCoreStatusRef.current = coreStatus;
    if (previous !== "offline" || coreStatus !== "ready") return;
    if (!coreHydratedRef.current) {
      setCoreRetry((current) => current + 1);
      return;
    }
    // A restart can restore projects created by another window while this
    // browser stayed open. Refresh the list without reopening the active
    // document, which preserves unsaved local edits across the reconnect.
    void rpc<Project[]>("project_list", {})
      .then(setProjects)
      .catch((error) => pushLog(`project list refresh failed: ${reason(error)}`, "error"));
  }, [coreStatus, pushLog]);

  useEffect(() => {
    const started = performance.now();
    let cancelled = false;
    void (async () => {
      try {
        if (coreRetry > 0) setCoreStatus("unknown");
        const loaded = await rpc<Project>("project_open", { slug: projectSlugRef.current || "starter" });
        if (cancelled) return;
        setProject(adoptSaved(loaded));
        coreHydratedRef.current = true;
        setScriptBaseline(snapshotScripts(loaded));
        setCaptureEvery((loaded.settings.pie as { captureEvery?: number })?.captureEvery ?? 3);
        const listed = await rpc<Project[]>("project_list", {});
        if (cancelled) return;
        setProjects(listed);
        setLoadMs(performance.now() - started);
      } catch {
        if (cancelled) return;
        pushLog(
          coreHydratedRef.current
            ? `core unavailable; keeping ${projectSlugRef.current} visible until it reconnects`
            : "core unavailable; using local starter preview",
          "error",
        );
      }
      try {
        const models = await rpc<ModelList>("model_list", {});
        if (!cancelled) setModelList(models);
      } catch (error) {
        if (!cancelled) pushLog(`model list failed: ${reason(error)}`);
      }
      // The attached folder now comes from the selected game's workspaceRoot
      // (see the effect below), not from whatever core happened to have open —
      // with several games that global pick was arbitrary.
    })();
    return () => {
      cancelled = true;
    };
  }, [coreRetry, pushLog]);

  const closeAttachDialog = () => {
    setFolderTarget(null);
    setAttachPath(null);
    setFolderError("");
    setAttachMode("existing");
    setStarterId(null);
    setStarterPath("");
  };

  /**
   * The folder belongs to this game, not to the app — so a second game can
   * point at a different repo and switching games switches folders. The
   * workspaceRoot effect below opens the folder when the game is the active one.
   */
  const bindWorkspace = async (target: Project, info: WorkspaceInfo) => {
    await setProjectWorkspace(target.slug, info.root);
    setProjects((current) =>
      current.map((item) => (item.slug === target.slug ? { ...item, workspaceRoot: info.root } : item)),
    );
    if (project.slug === target.slug) {
      setProject((current) => ({ ...current, workspaceRoot: info.root }));
    }
  };

  /** Bind the picked folder to the attach dialog's target game. */
  const attachFolder = async () => {
    const path = attachPath?.trim();
    if (!path || !folderTarget || folderBusy) return;
    setFolderBusy(true);
    setFolderError("");
    try {
      const info = await openWorkspace(path);
      await bindWorkspace(folderTarget, info);
      closeAttachDialog();
      pushLog(`attached ${info.name} to ${folderTarget.title} (${info.root})`);
    } catch (error) {
      setFolderError(reason(error));
      pushLog(`attach folder failed: ${reason(error)}`, "error");
    } finally {
      setFolderBusy(false);
    }
  };

  /**
   * Scaffold a starter into a new folder and attach it. Core writes the tree
   * and opens it in one call, so there is no window where the folder exists
   * but nothing points at it.
   */
  const attachFromStarter = async () => {
    const path = starterPath.trim();
    if (!path || !starterId || !folderTarget || folderBusy) return;
    setFolderBusy(true);
    setFolderError("");
    try {
      const created = await createWorkspaceFromStarter(starterId, path, folderTarget.title);
      await bindWorkspace(folderTarget, created.workspace);
      closeAttachDialog();
      pushLog(`created ${created.starter.name} at ${created.workspace.root}`);
      // Core never runs this: installing needs the network, and only a
      // user-initiated terminal may run a command on their machine.
      if (created.install) {
        pushLog(`run \`${created.install}\` in ${created.workspace.root} before PLAY`);
      }
    } catch (error) {
      setFolderError(reason(error));
      pushLog(`create from starter failed: ${reason(error)}`, "error");
    } finally {
      setFolderBusy(false);
    }
  };

  /**
   * The "New game" dialog's source-folder path: the folder becomes a new game
   * (named after itself, or `title` when given) so it shows up as its own row
   * in the sidebar. Picking a folder that is already a game just opens it.
   */
  const openFolderAsGame = async (path: string, title?: string) => {
    if (newProjectBusy) return;
    setNewProjectBusy(true);
    setNewProjectError("");
    try {
      const info = await openWorkspace(path, title);
      const existing = projects.find((item) => item.workspaceRoot === info.root);
      if (existing) {
        setNewProjectOpen(false);
        setActiveSessionId(null);
        setSessionRevision((current) => current + 1);
        await openProject(existing.slug);
        return;
      }
      const slug = slugify(info.name);
      if (projects.some((item) => item.slug === slug)) {
        setNewProjectError(
          `A game called "${info.name}" already exists. Use "Attach folder" in that game's menu instead.`,
        );
        return;
      }
      const created = await rpc<Project>("project_create", { slug, title: info.name, template: "blank" });
      await setProjectWorkspace(slug, info.root);
      const bound = { ...created, workspaceRoot: info.root };
      setProjects((current) => [...current.filter((item) => item.slug !== slug), bound]);
      setProject(adoptSaved(bound));
      setActiveSessionId(null);
      setSessionRevision((current) => current + 1);
      setScriptBaseline(snapshotScripts(bound));
      setSelectedEntityId(null);
      setSelectedScriptId(bound.scripts[0]?.id ?? null);
      setFrames([]);
      setTestResults([]);
      setNewProjectOpen(false);
      pushLog(`opened ${info.root} as ${bound.title}`);
    } catch (error) {
      setNewProjectError(reason(error));
      pushLog(`open folder failed: ${reason(error)}`, "error");
    } finally {
      setNewProjectBusy(false);
    }
  };
  // The panel reports its own session id, then transitions into/out of the
  // running state. We keep both signals at the App level so the sidebar's
  // per-row spinner survives navigating to a different chat (and clears on
  // the original chat once the turn finishes or the panel unmounts).
  const handleActiveSessionChange = useCallback((_next: string | null) => {
    // The id is purely informational here — `activeSessionId` is owned by
    // the sidebar selection flow. The running reporter below already pairs
    // each transition with the session id, so we do not need to mirror it.
  }, []);
  const handleSessionRunningChange = useCallback((running: boolean, sessionId: string | null) => {
    setRunningSessionIds((previous) => {
      if (running) {
        if (!sessionId || previous.has(sessionId)) return previous;
        const next = new Set(previous);
        next.add(sessionId);
        return next;
      }
      if (sessionId) {
        if (!previous.has(sessionId)) return previous;
        const next = new Set(previous);
        next.delete(sessionId);
        return next;
      }
      // A null sessionId on a "stop" signal (the panel never owned a
      // session, or the unmount cleanup arrived after the id was cleared)
      // is a no-op: the per-id transitions above already cover the
      // observable cases, and we deliberately avoid mass-clearing because
      // it would clobber other panels' running rows.
      return previous;
    });
  }, []);
  // The active session owns the editor attachment. Legacy/new unsaved chats
  // fall back to the project's default folder until their durable session is
  // allocated; once allocated, switching chats switches worktrees as well.
  const projectSlug = project?.slug ?? null;
  const activeSession = sessions.find(
    (session) => session.id === activeSessionId && session.projectSlug === projectSlug,
  );
  const editorWorkspaceRoot =
    (activeSession?.worktreeId || project?.workspaceRoot ? activeSession?.workspaceRoot : null) ??
    project?.workspaceRoot ??
    null;

  const revealActivityEditor = useCallback(() => {
    setMainView("chat");
    setTab("code");
    // The dock can be hidden persistently on desktop, or must be opened as an
    // overlay on narrow windows. A file activity click is an explicit request
    // to reveal it in either layout.
    setToolsVisible(true);
    localStorage.setItem("calicode-tools-visible", "1");
    if (window.matchMedia?.("(min-width: 1024px)").matches) setToolsOpen(false);
    else setToolsOpen(true);
  }, []);

  const openActivityFile = useCallback(
    (change: ActivityFileChange) => {
      const expectedRoot = editorWorkspaceRoot;
      if (change.projectSlug && change.projectSlug !== project.slug) {
        pushLog(`ignored activity for another game: ${change.path}`, "error");
        return;
      }
      if (!expectedRoot) {
        pushLog(`cannot open ${change.path}: the active game has no workspace`, "error");
        return;
      }
      const validationRoot = change.workspaceRoot ?? expectedRoot;
      if (!isSafeActivityPath(change.path, validationRoot)) {
        pushLog(`ignored unsafe activity path: ${change.path}`, "error");
        return;
      }

      // A root mismatch is only queueable while the active session's expected
      // workspace is still opening. Once another root is fully loaded, this is
      // a foreign/stale event and must not leak into the editor.
      const expectedRootLoaded = Boolean(workspace && sameWorkspaceRoot(workspace.root, expectedRoot));
      if (change.workspaceRoot && !sameWorkspaceRoot(change.workspaceRoot, expectedRoot)) {
        if (!expectedRootLoaded) {
          setPendingActivityFile(change);
          revealActivityEditor();
        } else {
          pushLog(`ignored activity from another workspace: ${change.path}`, "error");
        }
        return;
      }
      if (!expectedRootLoaded) {
        setPendingActivityFile(change);
        revealActivityEditor();
        if (workspaceOpenError) {
          void (async () => {
            try {
              const selected = await chooseNativeWorkspace(expectedRoot);
              if (!selected) return;
              if (!sameWorkspaceRoot(selected, expectedRoot)) {
                pushLog(`choose ${expectedRoot} to open ${change.path}`, "error");
                return;
              }
              const info = await openWorkspace(selected);
              setWorkspace(info);
              setWorkspaceOpenError(null);
              setPendingActivityFile(null);
              setActivityFile(change);
              setWorkspaceFile(change.path);
            } catch (error) {
              pushLog(`could not grant access to ${expectedRoot}: ${reason(error)}`, "error");
            }
          })();
        }
        return;
      }

      setPendingActivityFile(null);
      setActivityFile(change);
      setWorkspaceFile(change.path);
      revealActivityEditor();
    },
    [editorWorkspaceRoot, project.slug, pushLog, revealActivityEditor, workspace, workspaceOpenError],
  );

  const activityContextRef = useRef<{ slug: string; root: string | null }>({
    slug: project.slug,
    root: editorWorkspaceRoot,
  });
  useEffect(() => {
    const previous = activityContextRef.current;
    if (previous.slug !== project.slug || !sameWorkspaceRoot(previous.root, editorWorkspaceRoot)) {
      setActivityFile(null);
      setPendingActivityFile(null);
    }
    activityContextRef.current = { slug: project.slug, root: editorWorkspaceRoot };
  }, [editorWorkspaceRoot, project.slug]);

  useEffect(() => {
    if (!projectSlug) return;
    let cancelled = false;
    void (async () => {
      if (!editorWorkspaceRoot) {
        if (!cancelled) {
          setWorkspace(null);
          setWorkspaceFile(null);
        }
        return;
      }
      try {
        setWorkspaceOpenError(null);
        const info = await openWorkspace(editorWorkspaceRoot);
        if (cancelled) return;
        setWorkspace(info);
        setWorkspaceFile(null);
      } catch (error) {
        if (cancelled) return;
        setWorkspace(null);
        setWorkspaceOpenError(reason(error));
        pushLog(`could not open ${editorWorkspaceRoot}: ${reason(error)}`, "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectSlug, editorWorkspaceRoot, pushLog]);

  // Finish a validated click once the matching active-session workspace has
  // completed its async `workspace_open`. The pending selection is dropped if
  // the user has switched projects or roots before that response arrives.
  useEffect(() => {
    if (!pendingActivityFile || !editorWorkspaceRoot || !workspace) return;
    if (pendingActivityFile.projectSlug && pendingActivityFile.projectSlug !== project.slug) {
      setPendingActivityFile(null);
      return;
    }
    if (!sameWorkspaceRoot(workspace.root, editorWorkspaceRoot)) return;
    if (
      pendingActivityFile.workspaceRoot &&
      !sameWorkspaceRoot(pendingActivityFile.workspaceRoot, editorWorkspaceRoot)
    ) {
      setPendingActivityFile(null);
      pushLog(`ignored stale activity from another workspace: ${pendingActivityFile.path}`, "error");
      return;
    }
    setActivityFile(pendingActivityFile);
    setWorkspaceFile(pendingActivityFile.path);
    setPendingActivityFile(null);
  }, [editorWorkspaceRoot, pendingActivityFile, project.slug, pushLog, workspace]);

  // There is no SAVE button: the project document persists itself. Any edit
  // to `project` is written back ~800ms after the last change. `lastSavedRef`
  // mirrors the serialization core already has, so loading or switching
  // projects never triggers a write — only real edits do — and the initial
  // placeholder (before hydration) is never saved over the stored project.
  const lastSavedRef = useRef<string | null>(null);
  const adoptSaved = useCallback((loaded: Project): Project => {
    lastSavedRef.current = JSON.stringify(loaded);
    return loaded;
  }, []);

  // --- 3D asset builder wiring -------------------------------------------
  // One mutation path shared by the panel's gizmo, the agent's
  // editor_asset_builder_apply, and undo/redo. Computed from the render-time
  // `project` (not inside the setProject updater) because the ApplyResult must
  // be returned synchronously to whichever caller batched the ops.
  const applyBuilderOps = useCallback(
    (assetId: string, ops: BuilderOp[]): ApplyResult => {
      const asset = project.assets.find((item) => item.id === assetId);
      const spec = (asset?.metadata?.cali as CaliSpec | undefined) ?? emptySpec(asset?.name ?? "Asset");
      const result = applyOps(spec, ops);
      setProject((current) => {
        const target = current.assets.find((item) => item.id === assetId);
        if (!target) return current;
        return updateAsset(current, assetId, { metadata: { ...(target.metadata ?? {}), cali: result.spec } });
      });
      return result;
    },
    [project],
  );

  /** Undo/redo and open-time conversion: replace the spec wholesale, no reducer. */
  const replaceBuilderSpec = useCallback((assetId: string, spec: CaliSpec) => {
    setProject((current) => {
      const target = current.assets.find((item) => item.id === assetId);
      if (!target) return current;
      return updateAsset(current, assetId, { metadata: { ...(target.metadata ?? {}), cali: spec } });
    });
  }, []);

  /** Persist the project, then sync the on-disk `.cali.json` with the spec. */
  const saveBuilderAsset = useCallback(
    async (assetId: string) => {
      const asset = project.assets.find((item) => item.id === assetId);
      const spec = asset?.metadata?.cali as CaliSpec | undefined;
      if (!asset || !spec) throw new Error(`asset ${assetId} has no cali spec to save`);
      await rpc("project_save", { project });
      lastSavedRef.current = JSON.stringify(project);
      await projectAssetWrite(project.slug, assetId, JSON.stringify(spec, null, 2));
      pushLog(`saved ${asset.name} (.cali.json synced)`);
    },
    [project, pushLog],
  );

  /** UI entry (ArtTab EDIT, BUILD-tab picker): convert if needed, open, focus. */
  const openInBuilder = useCallback(
    (assetId: string) => {
      const asset = project.assets.find((item) => item.id === assetId);
      if (!asset) return;
      if (!asset.metadata?.cali) {
        const spec = asset.type === "procedural" ? specFromProcedural(asset) : emptySpec(asset.name);
        setProject((current) => {
          const target = current.assets.find((item) => item.id === assetId);
          if (!target) return current;
          return updateAsset(current, assetId, {
            type: "cali",
            source: `${assetId}.cali.json`,
            metadata: { ...(target.metadata ?? {}), cali: spec },
          });
        });
      }
      setBuilderAssetId(assetId);
      setTab("build");
    },
    [project],
  );

  const focusBuilderTab = useCallback(() => setTab("build"), []);

  const browserTools = useBrowserTools({
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

  // Publish the client-bundled asset-repo registry to core so the agent's
  // asset_search "library" source can see it. The registry glob is build-time,
  // so startup is the only moment the set can change.
  useEffect(() => {
    void rpc("asset_catalog_publish", { entries: catalogSnapshot() }).catch((error) =>
      pushLog(`asset catalog publish failed: ${reason(error)}`),
    );
  }, [pushLog]);

  /**
   * The one write path for the project document, shared by the debounce below
   * and by the header's Retry. It reports into `saveState` because the console
   * line it used to write alone is collapsed by default, inside a dock that is
   * hidden under 1024px — so a failed save looked exactly like a good one.
   */
  const persistProjectNow = useCallback(async () => {
    const serialized = JSON.stringify(project);
    setSaveState({ status: "saving" });
    try {
      await rpc("project_save", { project });
      // Keep the dirty marker when core is unavailable so the same edit
      // retries after recovery instead of being reported as saved.
      lastSavedRef.current = serialized;
      setSaveState({ status: "saved" });
      pushLog(`saved ${project.slug}`);
    } catch (error) {
      const message = reason(error);
      setSaveState({ status: "error", message });
      pushLog(`save failed: ${message}`, "error");
    }
  }, [project, pushLog]);

  useEffect(() => {
    if (lastSavedRef.current === null) return;
    if (JSON.stringify(project) === lastSavedRef.current) return;
    // Announced at the start of the debounce, not when the RPC leaves: the
    // edit is unsaved for those 800ms and the indicator should say so.
    setSaveState((current) => (current.status === "saving" ? current : { status: "saving" }));
    const timer = window.setTimeout(() => void persistProjectNow(), 800);
    return () => window.clearTimeout(timer);
  }, [coreStatus, project, persistProjectNow]);

  /**
   * Open a view as a tab and select it. A repeatable view (the side chat)
   * opens another instance every time rather than focusing the one already
   * there — two asks are two threads.
   */
  const addWorkspaceTab = useCallback((kind: WorkspaceTab): WorkspaceTabId => {
    // Read and write the ref, not just state: `/side` twice in one tick has to
    // allocate two ids, and the second call runs before React has re-rendered
    // with the first.
    const current = openTabsRef.current;
    const opened = MULTI_INSTANCE_TABS.includes(kind) ? nextTabId(kind, current) : kind;
    if (!current.includes(opened)) {
      const next = [...current, opened];
      openTabsRef.current = next;
      setOpenTabs(next);
    }
    setTab(opened);
    return opened;
  }, []);

  /** Select the newest instance of a view, opening one only if none is open. */
  const focusWorkspaceTab = useCallback((kind: WorkspaceTab): WorkspaceTabId => {
    const existing = [...openTabsRef.current].reverse().find((id) => tabKind(id) === kind);
    if (!existing) return addWorkspaceTab(kind);
    setTab(existing);
    return existing;
  }, [addWorkspaceTab]);

  /**
   * Close a tab. Closing the active one selects its neighbour rather than
   * leaving the dock pointed at a view that is no longer in the strip.
   */
  const closeWorkspaceTab = useCallback((target: WorkspaceTabId) => {
    setOpenTabs((current) => {
      if (current.length <= 1) return current;
      const index = current.indexOf(target);
      if (index < 0) return current;
      const next = current.filter((entry) => entry !== target);
      openTabsRef.current = next;
      setTab((active) => (active === target ? next[Math.min(index, next.length - 1)] : active));
      return next;
    });
    // Closing a side chat ends that thread. Ids are reused once freed, so a
    // thread left behind would reappear inside the next chat to take the id.
    if (tabKind(target) === "sidechat") {
      setSideChatDrafts(({ [target]: _closed, ...rest }) => rest);
      setSideChatThreads((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => !key.endsWith(`::${target}`))),
      );
    }
  }, []);

  const addTerminal = useCallback(() => {
    const id = crypto.randomUUID();
    setTerminalTabs((current) => [...current, { id, title: `Terminal ${current.length + 1}` }]);
    setActiveTerminalId(id);
  }, []);

  const closeTerminal = useCallback((id: string) => {
    setTerminalTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      if (index < 0) return current;
      const next = current.filter((tab) => tab.id !== id);
      // The console is always there to fall back to, so closing the last
      // shell leaves the dock open on it rather than dismissing the panel.
      setActiveTerminalId((active) =>
        active === id ? (next[Math.min(index, next.length - 1)]?.id ?? CONSOLE_TAB_ID) : active,
      );
      return next;
    });
  }, []);

  /** Animate only while toggling: a height transition would fight a drag. */
  // The error count follows the log into the dock; without it a failure that
  // scrolls past is invisible while the panel is closed.
  const consoleErrors = logs.reduce((total, log) => total + (log.level === "error" ? 1 : 0), 0);

  const toggleBottom = useCallback(() => {
    setBottomAnimating(true);
    window.setTimeout(() => setBottomAnimating(false), 340);
    setBottomOpen((open) => !open);
  }, []);

  const toggleTools = useCallback(() => {
    if (window.matchMedia("(min-width: 1024px)").matches) {
      setToolsAnimating(true);
      if (toolsAnimTimer.current) window.clearTimeout(toolsAnimTimer.current);
      toolsAnimTimer.current = window.setTimeout(() => setToolsAnimating(false), 360);
      setToolsVisible((current) => {
        localStorage.setItem("calicode-tools-visible", current ? "0" : "1");
        return !current;
      });
    } else {
      setToolsOpen((open) => !open);
    }
  }, []);

  // Repo attach/settings edits go through here; autosave does the writing.
  const persistProject = useCallback((next: Project) => {
    setProject(next);
    setProjects((current) => current.map((item) => (item.slug === next.slug ? next : item)));
  }, []);

  const handleToggleRepo = useCallback(
    (repoId: string, attach: boolean) => {
      const next = attach ? attachRepo(project, repoId) : detachRepo(project, repoId);
      if (next === project) return;
      persistProject(next);
      const name = getRepo(repoId)?.name ?? repoId;
      pushLog(attach ? `added ${name} to ${project.title}` : `removed ${name} from ${project.title}`);
    },
    [project, persistProject, pushLog],
  );

  const handleRepoSetting = useCallback(
    (repoId: string, key: string, value: RepoSettingValue) => {
      const next = setRepoSetting(project, repoId, key, value);
      if (next !== project) persistProject(next);
    },
    [project, persistProject],
  );

  const openProject = useCallback(
    async (slug: string) => {
      try {
        const loaded = await rpc<Project>("project_open", { slug });
        setProject(adoptSaved(loaded));
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
      setProject(adoptSaved(created));
      // A task belongs to exactly one game/worktree. Carrying the previously
      // selected task into a newly created game makes AgentPanel attempt to
      // resume it against the wrong project before the user has done anything.
      setActiveSessionId(null);
      setSessionRevision((current) => current + 1);
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

  // No fallback to `[project]`: with the core offline or nothing on disk, the
  // in-memory starter used to be listed as if it were a saved game — it is
  // expandable, right-clickable and renameable, and none of it persists.
  // Passing the real (possibly empty) list through lets the sidebar show its
  // empty state, which explains the situation instead of faking a game.
  const displayedProjects = useMemo(() => {
    const pinned = new Set(pinnedProjectSlugs);
    return [...projects].sort((left, right) => Number(pinned.has(right.slug)) - Number(pinned.has(left.slug)));
  }, [pinnedProjectSlugs, projects]);

  // Saved transcripts grouped per game for the sidebar, newest first.
  // Sessions with no project slug land under the currently selected game so
  // they stay reachable.
  const sessionsBySlug = useMemo(() => {
    const map: Record<string, SessionSummary[]> = {};
    for (const session of sessions) {
      const slug = session.projectSlug ?? project.slug;
      (map[slug] ??= []).push(session);
    }
    const pinned = new Set(pinnedSessionIds);
    for (const list of Object.values(map)) {
      list.sort(
        (left, right) =>
          Number(pinned.has(right.id)) - Number(pinned.has(left.id)) || right.updatedAt - left.updatedAt,
      );
    }
    return map;
  }, [pinnedSessionIds, project.slug, sessions]);

  // Platform is fixed for the lifetime of the document.
  const overlayControls = useMemo(hasOverlayWindowControls, []);

  const toggleSidebar = () => {
    if (window.matchMedia("(min-width: 768px)").matches) {
      // Animate only the toggle: the same width property is also driven by
      // the resize handle, which must track the pointer with no easing.
      setSidebarAnimating(true);
      if (sidebarAnimTimer.current) window.clearTimeout(sidebarAnimTimer.current);
      sidebarAnimTimer.current = window.setTimeout(() => setSidebarAnimating(false), 360);
      setSidebarVisible((visible) => !visible);
    } else {
      setSidebarDrawerOpen((open) => !open);
    }
  };

  const pushNav = (entry: { slug: string; sessionId: string | null }) => {
    setMainView("chat");
    setNav((current) => {
      const top = current.stack[current.index];
      if (top && top.slug === entry.slug && top.sessionId === entry.sessionId) return current;
      const stack = [...current.stack.slice(0, current.index + 1), entry];
      return { stack, index: stack.length - 1 };
    });
  };

  const startSession = async (slug: string) => {
    try {
      const created = await createSession(slug);
      setSessions((current) => [created, ...current.filter((session) => session.id !== created.id)]);
      pushNav({ slug, sessionId: created.id });
      setActiveSessionId(created.id);
      setSessionRevision((current) => current + 1);
      if (slug !== project.slug) await openProject(slug);
    } catch (error) {
      pushLog(`could not create task: ${reason(error)}`, "error");
    }
  };

  const applyNavEntry = (entry: { slug: string; sessionId: string | null }) => {
    setMainView("chat");
    setActiveSessionId(entry.sessionId);
    setSessionRevision((current) => current + 1);
    if (entry.slug !== project.slug) void openProject(entry.slug);
  };

  const goBack = () => {
    if (nav.index <= 0) return;
    applyNavEntry(nav.stack[nav.index - 1]);
    setNav((current) => ({ ...current, index: current.index - 1 }));
  };

  const goForward = () => {
    if (nav.index >= nav.stack.length - 1) return;
    applyNavEntry(nav.stack[nav.index + 1]);
    setNav((current) => ({ ...current, index: current.index + 1 }));
  };

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
      if (action === "attach") {
        setFolderTarget(target);
        setAttachPath(target.workspaceRoot ?? null);
        setFolderError("");
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
        if (project.slug === target.slug) setProject(adoptSaved(renamed));
        pushLog(`renamed ${target.title} to ${renamed.title}`);
      } else if (pending.action === "worktree") {
        const result = await rpc<{ project: Project; path: string; branch: string; created: boolean }>(
          "project_create_worktree",
          { slug: target.slug },
        );
        setProjects((current) => current.map((item) => (item.slug === target.slug ? result.project : item)));
        if (project.slug === target.slug) setProject(adoptSaved(result.project));
        pushLog(`${result.created ? "created" : "reused"} ${result.branch} at ${result.path}`);
      } else if (pending.action === "archive") {
        const result = await rpc<{ archived: number }>("session_archive_project", { slug: target.slug });
        setSessions((current) => current.filter((session) => session.projectSlug !== target.slug));
        if (project.slug === target.slug) {
          setActiveSessionId(null);
          setSessionRevision((current) => current + 1);
        }
        pushLog(
          `archived ${result.archived} chat${result.archived === 1 ? "" : "s"} for ${target.title} — restore them in Settings > Archive`,
        );
      } else if (pending.action === "remove") {
        // project_delete drops the game's chats, archived ones included: an
        // archive entry whose game is gone cannot be restored into anything.
        await rpc("project_delete", { slug: target.slug });
        const remaining = projects.filter((item) => item.slug !== target.slug);
        setProjects(remaining);
        setPinnedProjectSlugs((current) => current.filter((slug) => slug !== target.slug));
        setSessions((current) => current.filter((session) => session.projectSlug !== target.slug));
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

  const copyToClipboard = (value: string, label: string) => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => pushLog(`copied ${label}`))
      .catch((error: unknown) => pushLog(`copy failed: ${reason(error)}`, "error"));
  };

  const handleSessionAction = (target: SessionSummary, action: SessionMenuAction) => {
    if (action === "pin") {
      setPinnedSessionIds((current) =>
        current.includes(target.id) ? current.filter((id) => id !== target.id) : [...current, target.id],
      );
      return;
    }
    if (action === "copy-id") {
      copyToClipboard(target.id, `chat id ${target.id}`);
      return;
    }
    if (action === "copy-path") {
      if (!target.workspaceRoot) return;
      copyToClipboard(target.workspaceRoot, target.workspaceRoot);
      return;
    }
    if (action === "continue") {
      const slug = target.projectSlug ?? project.slug;
      // Fork rather than resume: the original transcript stays as it was, and
      // the new chat carries its history forward.
      void forkSession(target.id)
        .then((record) => {
          const created: SessionSummary = { ...record, messageCount: record.messages.length };
          setSessions((current) => [created, ...current.filter((session) => session.id !== created.id)]);
          pushNav({ slug, sessionId: created.id });
          setActiveSessionId(created.id);
          setSessionRevision((current) => current + 1);
          if (slug !== project.slug) void openProject(slug);
          pushLog(`continued ${target.title} in a new chat`);
        })
        .catch((error) => pushLog(`continue failed: ${reason(error)}`, "error"));
      return;
    }
    if (action === "archive") {
      // No confirmation: nothing is lost, and the log line says where it went.
      void archiveSession(target.id)
        .then(() => {
          setSessions((current) => current.filter((item) => item.id !== target.id));
          setPinnedSessionIds((current) => current.filter((id) => id !== target.id));
          if (activeSessionId === target.id) {
            // The panel is showing a chat that is no longer in the sidebar;
            // drop back to the game's empty chat rather than a hidden one.
            pushNav({ slug: target.projectSlug ?? project.slug, sessionId: null });
            setActiveSessionId(null);
            setSessionRevision((current) => current + 1);
          }
          pushLog(`archived ${target.title} — restore it in Settings > Archive`);
        })
        .catch((error) => pushLog(`archive failed: ${reason(error)}`, "error"));
      return;
    }
    setSessionActionError("");
    setSessionActionTitle(target.title);
    setPendingSessionAction({ action, session: target });
  };

  const runPendingSessionAction = async () => {
    const pending = pendingSessionAction;
    if (!pending || sessionActionBusy) return;
    const target = pending.session;
    setSessionActionBusy(true);
    setSessionActionError("");
    try {
      const renamed = await renameSession(target.id, sessionActionTitle.trim());
      setSessions((current) => current.map((item) => (item.id === target.id ? { ...item, ...renamed } : item)));
      pushLog(`renamed chat to ${renamed.title}`);
      setPendingSessionAction(null);
    } catch (error) {
      const message = reason(error);
      setSessionActionError(message);
      pushLog(`${pending.action} failed: ${message}`, "error");
    } finally {
      setSessionActionBusy(false);
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

  const handleImportImage = async (file: File): Promise<Asset | null> => {
    const data = await readFileBase64(file);
    const mime = importMime(file);
    try {
      if (file.name.toLowerCase().endsWith(".blend")) {
        const imported = await rpc<Asset>("blender_asset_import", {
          slug: project.slug,
          name: file.name,
          data,
        });
        setProject(adoptSaved(await rpc<Project>("project_open", { slug: project.slug })));
        pushLog(`imported ${file.name}; open it in Blender to start live export`);
        return imported;
      }
      const imported = await rpc<Asset>("asset_import_file", {
        slug: project.slug,
        name: file.name,
        data,
        mime,
        tags: ["imported"],
      });
      if (!mime.startsWith("image/")) {
        setProject(adoptSaved(await rpc<Project>("project_open", { slug: project.slug })));
        pushLog(`imported ${file.name}`);
        return imported;
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
      const loaded = await rpc<Project>("project_open", { slug: project.slug });
      const generatedAsset = loaded.assets.find((asset) => asset.id === generated.assetId);
      if (!generatedAsset?.metadata?.cali) {
        throw new Error(`generated asset ${generated.assetId} reopened without metadata.cali`);
      }
      setProject(adoptSaved(loaded));
      pushLog(`imported ${file.name} and generated image-to-3D spec`);
      return generatedAsset;
    } catch (error) {
      pushLog(`import failed: ${reason(error)}`, "error");
      return null;
    }
  };

  const selectedEntity = project.entities.find((entity) => entity.id === selectedEntityId) ?? null;
  // Derived rather than stored so removing the asset closes the builder.
  const builderAsset = project.assets.find((asset) => asset.id === builderAssetId) ?? null;
  const blenderAsset = project.assets.find((asset) => asset.id === previewAssetId && isBlenderAsset(asset)) ?? null;

  const openInBlender = async () => {
    if (!blenderAsset) return;
    try {
      await rpc("blender_asset_open", { slug: project.slug, assetId: blenderAsset.id });
      pushLog(`opened ${blenderAsset.name} in Blender`);
    } catch (error) {
      pushLog(`Blender launch failed: ${reason(error)}`, "error");
    }
  };

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
      <div
        ref={workbenchRef}
        className="flex min-h-0 flex-1"
        aria-hidden={settingsOpen || undefined}
      >
        <GamesSidebar
          projects={displayedProjects}
          coreStatus={coreStatus}
          activeSlug={project.slug}
          sessions={sessionsBySlug}
          activeSessionId={activeSessionId}
          runningSessionIds={runningSessionIds}
          onOpenProject={(slug) => {
            pushNav({ slug, sessionId: null });
            setActiveSessionId(null);
            setSessionRevision((current) => current + 1);
            void openProject(slug);
          }}
          onSelectSession={(slug, sessionId) => {
            // Already viewing this transcript — reloading it would only
            // remount AgentPanel and drop in-flight UI state. The library is
            // a separate view, so the selected session still needs to take
            // the user back to chat.
            if (slug === project.slug && sessionId === activeSessionId && mainView === "chat") return;
            pushNav({ slug, sessionId });
            setActiveSessionId(sessionId);
            setSidebarDrawerOpen(false);
            // Remount AgentPanel so it resumes the picked transcript.
            setSessionRevision((current) => current + 1);
            if (slug !== project.slug) void openProject(slug);
          }}
          onNewSession={(slug) => {
            void startSession(slug);
          }}
          onNewGame={() => setNewProjectOpen(true)}
          pinnedProjectSlugs={pinnedProjectSlugs}
          onProjectAction={handleProjectAction}
          onSessionAction={handleSessionAction}
          pinnedSessionIds={pinnedSessionIds}
          onOpenAssetsLibrary={() => {
            setMainView("library");
            setToolsOpen(false);
            setSidebarDrawerOpen(false);
          }}
          assetsLibraryActive={mainView === "library"}
          overlay={sidebarDrawerOpen}
          width={gamesSidebar.width}
          desktopVisible={sidebarVisible}
          theme={theme}
          onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
          onOpenSettings={() => {
            setToolsOpen(false);
            setSidebarDrawerOpen(false);
            setSettingsOpen(true);
          }}
          onToggleSidebar={toggleSidebar}
          canBack={nav.index > 0}
          canForward={nav.index < nav.stack.length - 1}
          onBack={goBack}
          onForward={goForward}
          animating={sidebarAnimating}
        />

        {sidebarVisible ? (
          <ResizeHandle
            panel={gamesSidebar}
            bounds={sidebarBounds}
            label="Resize games sidebar"
            className="hidden md:block"
          />
        ) : null}

        {/* Overlay backdrop for the narrow-window drawers. */}
        {(toolsOpen || sidebarDrawerOpen) && (
          <button
            type="button"
            aria-label="Close panel"
            onClick={() => {
              setToolsOpen(false);
              setSidebarDrawerOpen(false);
            }}
            className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          />
        )}

        {/* Everything right of the games rail stacks: the workbench row, then
            the bottom dock. The dock is a sibling rather than an overlay so it
            shortens the chat and the tools column together. */}
        <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
        {/* Center: the agent conversation is the primary column. The hard
            min-width is the CSS backstop for the JS panel clamps: even if a
            stale stored width or a missed clamp over-grows a side panel, the
            chat column (and its composer) refuses to collapse below the floor
            the clamps aim for. */}
        <main className="flex min-w-[360px] flex-1 flex-col bg-surface-0">
          {/* The chat column's single header line: always present because it
              is the window's drag surface, never more than one row tall. The
              sidebar controls inside it only appear while the rail is out of
              the layout (the rail carries its own set otherwise); the title
              and the tools-dock toggle live here in both states. */}
          <div
            data-drag-region="deep"
            className={`${sidebarDrawerOpen ? "hidden" : "flex"} h-10 shrink-0 select-none items-center gap-0.5 border-b border-line ${
              overlayControls && !sidebarVisible ? "pl-[80px]" : "pl-1.5"
            } pr-1.5`}
          >
            <div className={`${sidebarVisible ? "md:hidden" : ""} flex items-center gap-0.5`}>
              <button
                type="button"
                aria-label="Toggle games sidebar"
                onClick={toggleSidebar}
                className={CHROME_ICON_BUTTON}
              >
                <PanelLeft aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.7} />
              </button>
              <button
                type="button"
                aria-label="Back"
                onClick={goBack}
                disabled={nav.index <= 0}
                className={CHROME_ICON_BUTTON}
              >
                <ArrowLeft aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.7} />
              </button>
              <button
                type="button"
                aria-label="Forward"
                onClick={goForward}
                disabled={nav.index >= nav.stack.length - 1}
                className={CHROME_ICON_BUTTON}
              >
                <ArrowRight aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.7} />
              </button>
            </div>
            <span className="ml-2 min-w-0 truncate text-[13px] font-semibold text-ink-strong">
              {mainView === "library"
                ? "Assets Library"
                : sessions.find((session) => session.id === activeSessionId)?.title ?? project.title}
            </span>
            <SaveIndicator state={saveState} onRetry={() => void persistProjectNow()} />
            {mainView === "chat" ? (
              <>
                <button
                  type="button"
                  aria-label="Open in Blender"
                  title={blenderAsset ? `Open ${blenderAsset.name} in Blender` : "Preview an imported .blend asset first"}
                  disabled={!blenderAsset}
                  onClick={() => void openInBlender()}
                  className={`${CHROME_ICON_BUTTON} ml-auto w-auto gap-1.5 rounded-lg border border-line bg-raised pl-1.5 pr-2.5`}
                >
                  <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-primary">
                    <img data-blender-logo aria-hidden alt="" src={blenderLogo} className="h-3.5 w-3.5" />
                  </span>
                  <span className="whitespace-nowrap text-[12px] font-medium text-ink-strong">Open in</span>
                  <ChevronDown aria-hidden className="h-[14px] w-[14px] text-ink-subtle" strokeWidth={1.7} />
                </button>
                <button
                  type="button"
                  aria-label="Toggle terminal panel"
                  aria-pressed={bottomOpen}
                  onClick={toggleBottom}
                  className={`${CHROME_ICON_BUTTON} ${bottomOpen ? "bg-surface-2 text-ink-strong" : ""}`}
                >
                  <PanelBottom aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.7} />
                </button>
                <button
                  type="button"
                  aria-label="Toggle tools panel"
                  aria-pressed={toolsVisible}
                  onClick={toggleTools}
                  className={`${CHROME_ICON_BUTTON} ${toolsVisible ? "bg-surface-2 text-ink-strong" : ""}`}
                >
                  <PanelRight aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.7} />
                </button>
              </>
            ) : null}
          </div>

          {coreStatus !== "ready" ? (
            <div
              data-core-status={coreStatus}
              role={coreStatus === "offline" ? "alert" : "status"}
              className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-surface-1 px-3 py-2 text-xs text-ink-subtle"
            >
              <span>
                {coreStatus === "offline"
                  ? coreHydratedRef.current
                    ? "Core is offline. Your current game remains visible; saves will retry when it reconnects."
                    : "Core is offline. This is a local Starter preview; saved games and edits are not connected."
                  : "Connecting to CaliCode core…"}
              </span>
              {coreStatus === "offline" ? (
                <button
                  type="button"
                  onClick={() => {
                    if (coreHydratedRef.current) {
                      // A hydrated game may contain edits newer than core's
                      // disk copy. Reconnect transport only; the ready
                      // transition retries dirty autosave without reopening
                      // and replacing the active document.
                      void rpc("ping").catch(() => {});
                    } else {
                      setCoreRetry((current) => current + 1);
                    }
                  }}
                  className="shrink-0 rounded px-2 py-1 font-medium text-ink transition-colors hover:bg-surface-2 hover:text-ink-strong"
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}

          {mainView === "library" ? (
            <AssetsLibraryPage
              installedRepoIds={Object.keys(attachedRepos(project))}
              onInstall={(repoId) => handleToggleRepo(repoId, true)}
              onUninstall={(repoId) => handleToggleRepo(repoId, false)}
              projectTitle={project.title}
            />
          ) : (
            <AgentPanel
              key={`${project.slug}:${sessionRevision}`}
              projectSlug={project.slug}
              workspaceRoot={editorWorkspaceRoot}
              modelList={modelList}
              browserTools={browserTools}
              initialSessionId={activeSessionId}
              onSessionsChanged={setSessions}
              onTranscriptChange={setMainTranscript}
              onOpenSideChat={(draft, anchor, options) => {
                const id = options?.fresh ? openFreshSideChat() : focusWorkspaceTab("sidechat");
                if (!toolsVisible) toggleTools();
                // Always bump the draft, even with nothing to put in the
                // composer: it is the signal the panel focuses on, and a side
                // chat you opened but have to click into is half-opened.
                setSideChatDrafts((current) => ({
                  ...current,
                  [id]: { text: draft ?? "", anchor, nonce: (current[id]?.nonce ?? 0) + 1 },
                }));
              }}
              onSessionActivated={(created) => {
                setSessions((current) => [created, ...current.filter((session) => session.id !== created.id)]);
                setActiveSessionId(created.id);
                setNav((current) => {
                  const stack = [...current.stack];
                  stack[current.index] = { slug: created.projectSlug ?? project.slug, sessionId: created.id };
                  return { ...current, stack };
                });
              }}
              onModelChange={() =>
                void rpc<ModelList>("model_list", {})
                  .then(setModelList)
                  .catch(() => undefined)
              }
              onLog={pushLog}
              onOpenActivityFile={openActivityFile}
              onActiveSessionChange={handleActiveSessionChange}
              onSessionRunningChange={handleSessionRunningChange}
            />
          )}
        </main>


        {mainView === "chat" ? (
          <ResizeHandle
            panel={toolsPanel}
            bounds={toolsBounds}
            label="Resize tools panel"
            className={toolsVisible ? "hidden lg:block" : "hidden"}
          />
        ) : null}

        {/* Right: the game tools dock — PLAY/CODE/ART/SCENE/TEST over the
            always-mounted viewport. The drag width applies only from lg up,
            where the dock is a real column; below that it is an overlay
            drawer with its own sizing. */}
        {mainView === "chat" ? (
          <aside
            data-tools-panel
            style={{ "--tools-width": `${toolsPanel.width}px` } as CSSProperties}
            className={
              // Full screen is its own layout, not a wider dock: the drag
              // width, the responsive drawer and the slide transition all stop
              // applying, so it is expressed as a separate class list rather
              // than as overrides fighting the docked one.
              toolsExpanded
                ? "fixed inset-0 z-50 flex w-full max-w-none flex-col overflow-hidden bg-surface-0"
                : `${
                    toolsOpen ? "fixed inset-y-0 right-0 z-40 flex w-[min(720px,94vw)] shadow-2xl" : "hidden"
                  } max-w-[960px] shrink-0 flex-col overflow-hidden bg-surface-0 lg:static lg:flex lg:shadow-none ${
                    toolsVisible
                      ? "lg:visible lg:w-[var(--tools-width)] lg:min-w-[360px] lg:border-l lg:border-line"
                      : "lg:invisible lg:w-0 lg:min-w-0 lg:border-l-0"
                  } ${
                    toolsAnimating
                      ? "lg:[transition:width_300ms_ease,min-width_300ms_ease,border-width_300ms_ease,visibility_300ms]"
                      : ""
                  }`
            }
          >
          <WorkspaceTabs
            openTabs={openTabs}
            active={tab}
            onChange={setTab}
            onAdd={addWorkspaceTab}
            onClose={closeWorkspaceTab}
            expanded={toolsExpanded}
            onToggleExpand={() => setToolsExpanded((current) => !current)}
            onCollapse={() => {
              setToolsExpanded(false);
              toggleTools();
            }}
            badges={{ test: failing || undefined }}
            tabTitles={{ browser: browserPage.title, ...sideChatTitles }}
            tabIcons={{ browser: browserPage.icon }}
            // Without a workspace there is no preview server; core serves no
            // /play route, and the old label hardcoded port 5199.
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
                  onError={handleWorkspaceError}
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
                <div className="min-h-0 shrink-0 border-r border-line" style={{ width: fileTreePanel.width }}>
                  <FileTree
                    workspaceId={workspace.id}
                    activePath={workspaceFile}
                    dirtyPaths={dirtyPaths}
                    onOpenFile={(path) => {
                      // A direct tree click intentionally leaves activity
                      // mode; otherwise an old agent diff would snap back
                      // over the file the user just selected.
                      setActivityFile(null);
                      setPendingActivityFile(null);
                      setWorkspaceFile(path);
                    }}
                    onError={handleWorkspaceError}
                  />
                </div>
                <ResizeHandle panel={fileTreePanel} bounds={FILE_TREE_PANEL} label="Resize file tree" />
                <div className="min-h-0 flex-1">
                  <FileEditor
                    workspaceId={workspace.id}
                    path={workspaceFile}
                    activityFile={activityFile}
                    preservedDraft={workspaceFile ? dirtyFiles[workspaceFile]?.text ?? null : null}
                    onDraftChange={handleDraftChange}
                    onSaved={handleWorkspaceSaved}
                    onError={handleWorkspaceError}
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
                  slug={project.slug}
                  assets={project.assets}
                  entities={project.entities}
                  onGenerate={(created) =>
                    setProject((current) => created.reduce((next, asset) => addAsset(next, asset), current))
                  }
                  onPromote={promoteAsset}
                  onRemove={(assetId) => setProject((current) => removeAsset(current, assetId))}
                  onImportImage={handleImportImage}
                  onLog={pushLog}
                  onPreviewAssetChange={(asset) => setPreviewAssetId(asset?.id ?? null)}
                  onEdit={openInBuilder}
                />
              </div>
            ) : null}

            {tab === "build" ? (
              <div role="tabpanel" id="workspace-panel-build" aria-labelledby="workspace-tab-build" className="absolute inset-0">
                {builderAsset ? (
                  <AssetBuilder
                    asset={builderAsset}
                    entities={project.entities}
                    slug={project.slug}
                    onApply={applyBuilderOps}
                    onReplaceSpec={replaceBuilderSpec}
                    onSave={saveBuilderAsset}
                    onClose={() => setBuilderAssetId(null)}
                  />
                ) : (
                  <div className="flex h-full min-h-0 flex-col overflow-y-auto px-[22px] py-[18px]">
                    <span className="font-display text-[15px] font-bold text-ink-strong">Asset builder</span>
                    <p className="mt-1 text-xs text-ink-subtle">
                      Pick an asset to edit, or ask the agent to open one for you.
                    </p>
                    {project.assets.length === 0 ? (
                      <p className="mt-4 text-xs text-ink-subtle">No assets yet — generate some in ART first.</p>
                    ) : (
                      <ul className="mt-4 space-y-1.5">
                        {project.assets.map((asset) => (
                          <li key={asset.id}>
                            <button
                              type="button"
                              onClick={() => openInBuilder(asset.id)}
                              className="flex w-full items-center gap-2 rounded-md border border-line bg-surface-1 px-3 py-2 text-left text-xs text-ink transition-colors hover:border-ink-faint"
                            >
                              <span className="min-w-0 flex-1 truncate">{asset.name}</span>
                              <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                                {asset.type}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
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

            {/* Kept mounted while the tab is in the strip, unlike the other
                panels: the side thread lives only in this component's state,
                so unmounting it on a tab switch would throw the conversation
                away — which is not what "temporary" promises. */}
            {sideChatIds.map((id) => (
              <div
                key={id}
                role="tabpanel"
                id={`workspace-panel-${id}`}
                aria-labelledby={`workspace-tab-${id}`}
                className={`absolute inset-0 ${tab === id ? "" : "hidden"}`}
              >
                <SideChat
                  projectSlug={project.slug}
                  name={sideChatNames[id]}
                  mainTranscript={mainTranscript}
                  modelList={modelList}
                  draft={sideChatDrafts[id] ?? null}
                  messages={sideChatThreads[`${project.slug}::${id}`] ?? EMPTY_SIDE_THREAD}
                  onMessagesChange={(next) =>
                    setSideChatThreads((current) => ({ ...current, [`${project.slug}::${id}`]: next }))
                  }
                  onClose={() => closeWorkspaceTab(id)}
                />
              </div>
            ))}

            {tab === "browser" ? (
              <div
                role="tabpanel"
                id="workspace-panel-browser"
                aria-labelledby="workspace-tab-browser"
                className="absolute inset-0"
              >
                <BrowserTab />
              </div>
            ) : null}

            {tab === "terminal" ? (
              <div
                role="tabpanel"
                id="workspace-panel-terminal"
                aria-labelledby="workspace-tab-terminal"
                className="absolute inset-0"
              >
                <TerminalTab projectSlug={project.slug} theme={theme} />
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

            {tab === "reports" ? (
              <div
                role="tabpanel"
                id="workspace-panel-reports"
                aria-labelledby="workspace-tab-reports"
                className="@container absolute inset-0"
              >
                <ReportsTab
                  projectSlug={project.slug}
                  coreStatus={coreStatus}
                  canOpenFiles={Boolean(workspace)}
                  workspaceRoot={workspace?.root}
                  onOpenFile={(path) => {
                    if (!workspace || !isSafeActivityPath(path, workspace.root)) return;
                    void readWorkspaceFile(workspace.id, path)
                      .then(() => {
                        setActivityFile(null);
                        setPendingActivityFile(null);
                        setWorkspaceFile(path);
                        setTab("code");
                      })
                      .catch((error) => pushLog(`cannot open ${path}: ${reason(error)}`, "error"));
                  }}
                />
              </div>
            ) : null}
          </div>

          {/* Runtime stats belong to the running game, so they are shown only
              while PLAY is the visible view. Sitting under BROWSER or CODE
              they read as telemetry for whatever is on screen — a paused
              signal and 0 fps over a web page describe nothing. */}
          {tab === "play" ? <LiveBar stats={stats} pieState={pieState} /> : null}
          </aside>
        ) : null}
        </div>

        <div
          data-bottom-dock
          className={`shrink-0 overflow-hidden border-t border-line ${
            bottomOpen ? "h-[var(--bottom-dock-height)]" : "h-0 border-t-0"
          } ${bottomAnimating ? "[transition:height_300ms_ease,border-width_300ms_ease]" : ""}`}
          style={{ "--bottom-dock-height": "260px" } as CSSProperties}
        >
          {bottomOpen ? (
            <BottomPanel
              tabs={[
                { id: CONSOLE_TAB_ID, title: "Console", kind: "console" as const, badge: consoleErrors || undefined },
                ...terminalTabs,
              ]}
              activeId={activeTerminalId}
              onSelect={setActiveTerminalId}
              onAdd={addTerminal}
              onCloseTab={closeTerminal}
              onClose={() => toggleBottom()}
            >
              {/* Every session stays mounted: unmounting would close its shell
                  and lose the scrollback, so only the active one is shown. */}
              <div className={`h-full ${activeTerminalId === CONSOLE_TAB_ID ? "block" : "hidden"}`}>
                <ConsolePanel logs={logs} />
              </div>
              {terminalTabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`h-full ${tab.id === activeTerminalId ? "block" : "hidden"}`}
                >
                  <TerminalTab projectSlug={project.slug} theme={theme} />
                </div>
              ))}
            </BottomPanel>
          ) : null}
        </div>
        </div>
      </div>

      <SettingsPage
        open={settingsOpen}
        onClose={closeSettings}
        modelList={modelList}
        projectSlug={project.slug}
        theme={theme}
        onThemeChange={setTheme}
        onChanged={() =>
          void rpc<ModelList>("model_list", {})
            .then(setModelList)
            .catch(() => undefined)
        }
        onSessionsChanged={() => listSessions().then(setSessions)}
      />

      <Dialog
        open={folderTarget !== null}
        onOpenChange={(open) => {
          if (folderBusy) return;
          if (!open) closeAttachDialog();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogTitle>{folderTarget ? `Attach a folder to ${folderTarget.title}` : ""}</DialogTitle>
          <DialogDescription>
            CaliCode edits this folder in place and runs its own dev server. Attach one you already have, or
            scaffold a new one from a starter.
          </DialogDescription>

          <div role="tablist" aria-label="Folder source" className="mt-3 flex gap-1 rounded-lg bg-surface-1 p-1">
            {(["existing", "starter"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={attachMode === mode}
                disabled={folderBusy}
                onClick={() => {
                  setFolderError("");
                  setAttachMode(mode);
                  // Seed the destination from the game's slug the first time
                  // the starter tab is opened, so the common case is one click.
                  if (mode === "starter" && !starterPath && folderTarget) {
                    setStarterPath(defaultStarterPath(folderTarget.slug));
                  }
                }}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs transition-colors ${
                  attachMode === mode ? "bg-surface-0 text-ink-strong" : "text-ink-subtle hover:bg-surface-2"
                }`}
              >
                {mode === "existing" ? "Existing folder" : "New from starter"}
              </button>
            ))}
          </div>

          <form
            className="mt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (attachMode === "starter") void attachFromStarter();
              else void attachFolder();
            }}
          >
            {attachMode === "existing" ? (
              <FolderPicker
                value={attachPath}
                onChange={(path) => {
                  setFolderError("");
                  setAttachPath(path);
                }}
                disabled={folderBusy}
              />
            ) : (
              <StarterPicker
                value={starterId}
                onChange={(id) => {
                  setFolderError("");
                  setStarterId(id);
                }}
                path={starterPath}
                onPathChange={setStarterPath}
                disabled={folderBusy}
              />
            )}
            {folderError ? (
              <p role="alert" className="mt-2 text-xs text-danger-soft">
                {folderError}
              </p>
            ) : null}
            <div className="mt-3 flex justify-end gap-2">
              <DialogClose asChild>
                <Button type="button" variant="ghost" size="sm" disabled={folderBusy}>
                  Cancel
                </Button>
              </DialogClose>
              {attachMode === "starter" ? (
                <Button type="submit" size="sm" disabled={!starterId || !starterPath.trim() || folderBusy}>
                  {folderBusy ? "Creating..." : "Create and attach"}
                </Button>
              ) : (
                <Button type="submit" size="sm" disabled={!attachPath || folderBusy}>
                  {folderBusy ? "Attaching..." : "Attach"}
                </Button>
              )}
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
        onOpenFolder={openFolderAsGame}
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
        <DialogContent className="max-w-sm border-line bg-popover text-ink-strong shadow-[0_24px_80px_rgba(0,0,0,0.6)]">
          {pendingProjectAction ? (
            <>
              <DialogTitle>{projectActionDialogTitle(pendingProjectAction.action)}</DialogTitle>
              <DialogDescription className="mt-1 leading-relaxed text-ink-subtle">
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
                    className="mt-1 border-line-strong bg-surface-1"
                    value={projectActionTitle}
                    onChange={(event) => setProjectActionTitle(event.target.value)}
                    autoFocus
                  />
                  {projectActionError ? <p className="mt-2 text-xs text-danger-soft">{projectActionError}</p> : null}
                  <ProjectActionButtons
                    busy={projectActionBusy}
                    disabled={!projectActionTitle.trim()}
                    confirmLabel="Save changes"
                  />
                </form>
              ) : (
                <div className="mt-4">
                  {pendingProjectAction.action === "worktree" && !pendingProjectAction.project.workspaceRoot ? (
                    <p className="rounded-md border border-[#b6803c]/40 bg-[#8b5e25]/10 px-3 py-2 text-xs leading-relaxed text-[#8a5c22] dark:text-[#d8b47f]">
                      Attach a Git project folder first, then run this action again.
                    </p>
                  ) : null}
                  {projectActionError ? <p className="mt-2 text-xs text-danger-soft">{projectActionError}</p> : null}
                  <ProjectActionButtons
                    busy={projectActionBusy}
                    disabled={pendingProjectAction.action === "worktree" && !pendingProjectAction.project.workspaceRoot}
                    confirmLabel={projectActionConfirmLabel(pendingProjectAction.action)}
                    destructive={pendingProjectAction.action === "remove"}
                    onConfirm={() => void runPendingProjectAction()}
                  />
                </div>
              )}
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingSessionAction !== null}
        onOpenChange={(open) => {
          if (!open && !sessionActionBusy) {
            setPendingSessionAction(null);
            setSessionActionError("");
          }
        }}
      >
        <DialogContent className="max-w-sm border-line bg-popover text-ink-strong shadow-[0_24px_80px_rgba(0,0,0,0.6)]">
          {pendingSessionAction ? (
            <>
              <DialogTitle>Rename chat</DialogTitle>
              <DialogDescription className="mt-1 leading-relaxed text-ink-subtle">
                Only the sidebar label changes; the transcript stays as it is.
              </DialogDescription>

              <form
                className="mt-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runPendingSessionAction();
                }}
              >
                <Label htmlFor="rename-session-title">Chat name</Label>
                <Input
                  id="rename-session-title"
                  className="mt-1 border-line-strong bg-surface-1"
                  value={sessionActionTitle}
                  onChange={(event) => setSessionActionTitle(event.target.value)}
                  autoFocus
                />
                {sessionActionError ? <p className="mt-2 text-xs text-danger-soft">{sessionActionError}</p> : null}
                <ProjectActionButtons
                  busy={sessionActionBusy}
                  disabled={!sessionActionTitle.trim()}
                  confirmLabel="Save changes"
                />
              </form>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Errors are raised over the whole workbench, not into the dock: the
          dock is closable, hidden under 1024px, and its console ships
          collapsed, so a failed save could pass for a successful one. */}
      {errorToast ? (
        <div
          role="alert"
          data-error-toast
          className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"
        >
          <div className="pointer-events-auto flex max-w-[520px] items-start gap-3 rounded-lg border border-danger-soft/40 bg-raised px-3.5 py-2.5 shadow-lg">
            <p className="min-w-0 text-xs leading-[1.5] text-danger-soft">{errorToast.message}</p>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={() => setErrorToast(null)}
              className="-mr-1 shrink-0 rounded px-1.5 py-0.5 text-xs text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
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
        className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
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
  if (action === "archive") {
    return `Move every saved chat for ${project.title} to the archive. They stay in Settings > Archive until you restore or delete them.`;
  }
  return `Permanently remove ${project.title} and its saved chats, archived ones included. This cannot be undone.`;
}

function projectActionConfirmLabel(action: DialogProjectAction): string {
  return {
    edit: "Save changes",
    worktree: "Create worktree",
    archive: "Archive chats",
    remove: "Remove project",
  }[action];
}

/**
 * Autosave, made observable.
 *
 * WorkspaceTabs tells users "there is no SAVE button — the project document
 * autosaves on edit", so they have been instructed to trust a mechanism whose
 * only failure report used to be one line in a collapsed console. This sits
 * beside the title, where they already are, and offers the retry.
 */
function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  return (
    <span
      role="status"
      aria-live="polite"
      data-save-state={state.status}
      title={state.status === "error" ? state.message : undefined}
      className={`ml-2 inline-flex shrink-0 items-center gap-1 text-[11px] ${
        state.status === "error"
          ? "rounded-md border border-danger-soft/40 bg-danger-soft/10 py-px pl-2 pr-1 text-danger-soft"
          : "text-ink-subtle"
      }`}
    >
      {state.status === "error" ? (
        <>
          Save failed
          <button
            type="button"
            onClick={onRetry}
            className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 transition-colors hover:bg-danger-soft/15"
          >
            Retry
          </button>
        </>
      ) : state.status === "saving" ? (
        "Saving…"
      ) : (
        "Saved"
      )}
    </span>
  );
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
      className={`w-[5px] shrink-0 cursor-col-resize transition-colors hover:bg-surface-3 active:bg-line-strong focus-visible:bg-surface-3 ${
        panel.isDragging ? "bg-line-strong" : "bg-transparent"
      } ${className}`}
    />
  );
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pinned slugs and chat ids, validated on read — a corrupted localStorage
 * value must not white-screen the editor (readView validates for the same
 * reason).
 */
function readPinnedIds(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((id): id is string => typeof id === "string"))]
      : [];
  } catch {
    return [];
  }
}

async function readFileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // Blender sources can be large. Chunking avoids one string append per byte
  // and stays under JavaScript engines' argument-count limit.
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
