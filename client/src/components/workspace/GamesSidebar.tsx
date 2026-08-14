import { useMemo, useState, type CSSProperties } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  CircleHelp,
  Copy,
  Folder,
  FolderOpen,
  GitBranch,
  GitFork,
  Library,
  Loader2,
  Moon,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  SquarePen,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react";
import { hasOverlayWindowControls } from "../../lib/desktop";
import type { CoreConnectionState } from "../../lib/rpc";
import type { Project } from "../../lib/types";
import { relativeTime, type SessionSummary } from "../../lib/sessions";
import { SessionSearchDialog } from "./SessionSearchDialog";
import caliberIcon from "../../assets/caliber-icon.png";

export type ProjectMenuAction = "pin" | "reveal" | "attach" | "worktree" | "edit" | "archive" | "remove";

/** No delete here on purpose: a chat leaves the sidebar by being archived, and
 *  Settings → Archive is the one place it can be deleted for good. */
export type SessionMenuAction = "pin" | "rename" | "continue" | "copy-id" | "copy-path" | "archive";

/** What a chat row shows. Core titles every session, but a stored title can
 *  still be empty, and an unlabelled row is indistinguishable from a bug. */
const sessionLabel = (session: SessionSummary): string => session.title?.trim() || "Untitled session";

interface GamesSidebarProps {
  projects: Project[];
  activeSlug: string;
  /** Saved transcripts per game — the recents under each game row. */
  sessions: Record<string, SessionSummary[]>;
  activeSessionId: string | null;
  /**
   * Session ids whose agent is currently running. The matching sidebar row
   * shows a quiet spinner so the user can tell which chat is live, even if
   * a different chat is selected in the editor. Kept as a readonly set so
   * the parent can hand a stable reference for the same membership.
   */
  runningSessionIds?: ReadonlySet<string>;
  onOpenProject: (slug: string) => void;
  onSelectSession: (slug: string, sessionId: string) => void;
  onNewSession: (slug: string) => void;
  onNewGame: () => void;
  /** Opens a folder on disk as a game in this list. */
  pinnedProjectSlugs?: string[];
  onProjectAction?: (project: Project, action: ProjectMenuAction) => void;
  /** Per-chat menu, from the row's ellipsis or a right-click on the row. */
  onSessionAction?: (session: SessionSummary, action: SessionMenuAction) => void;
  /** Chat ids the user pinned; they sort to the top of their game. */
  pinnedSessionIds?: string[];
  /**
   * Connection state of the core. An empty game list is usually an offline
   * core rather than an empty disk, so the empty state says which it is.
   */
  coreStatus?: CoreConnectionState;
  /** Opens the assets library view. */
  onOpenAssetsLibrary: () => void;
  /** True while the assets library view is the active view. */
  assetsLibraryActive?: boolean;
  /** Open as an overlay when the rail is below its md breakpoint. */
  overlay?: boolean;
  /** Width of the persistent rail at md and above. */
  width?: number;
  /** Whether the persistent rail is present at md and above. */
  desktopVisible?: boolean;
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
  /** Opens the app-wide settings page. */
  onOpenSettings?: () => void;
  /** Collapses the rail (or closes the drawer below md). */
  onToggleSidebar?: () => void;
  canBack?: boolean;
  canForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  /** True during a toggle, enabling the slide transition. Off while resizing. */
  animating?: boolean;
}

/** Small icon button used in the window-controls and wordmark rows. */
function HeaderIcon({
  icon: Icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors enabled:hover:bg-surface-2 enabled:hover:text-ink-strong disabled:opacity-35"
    >
      <Icon aria-hidden size={15} strokeWidth={1.7} />
    </button>
  );
}

/** Quiet icon+label row used for the nav block under the wordmark. */
function NavRow({
  icon: Icon,
  label,
  onClick,
  active = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-8 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${
        active
          ? "bg-surface-3 text-ink-strong"
          : "text-ink hover:bg-surface-2 hover:text-ink-strong active:bg-surface-3"
      }`}
    >
      <Icon aria-hidden size={15} strokeWidth={1.7} className="shrink-0 text-ink-subtle" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * Left rail, structured like a chat-first studio app: static wordmark header,
 * a nav block (new chat / new game / assets library / folder), a searchable
 * games tree with each game's agent sessions nested underneath, and a footer
 * identity row. The desktop rail is user-resizable.
 */
export function GamesSidebar({
  projects,
  activeSlug,
  sessions,
  activeSessionId,
  runningSessionIds,
  onOpenProject,
  onSelectSession,
  onNewSession,
  onNewGame,
  pinnedProjectSlugs = [],
  onProjectAction = () => undefined,
  onSessionAction = () => undefined,
  pinnedSessionIds = [],
  coreStatus = "unknown",
  onOpenAssetsLibrary,
  assetsLibraryActive = false,
  overlay = false,
  width = 240,
  desktopVisible = true,
  theme = "dark",
  onToggleTheme = () => undefined,
  onOpenSettings = () => undefined,
  onToggleSidebar = () => undefined,
  canBack = false,
  canForward = false,
  onBack = () => undefined,
  onForward = () => undefined,
  animating = false,
}: GamesSidebarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(activeSlug);
  const [actionMenuSlug, setActionMenuSlug] = useState<string | null>(null);
  const [actionMenuSessionId, setActionMenuSessionId] = useState<string | null>(null);

  // Platform is fixed for the lifetime of the document.
  const overlayControls = useMemo(hasOverlayWindowControls, []);

  // The parent keeps this value within the resize bounds, but clamping here
  // keeps the rail safe when it is rendered in isolation (or with persisted
  // settings from an older build).
  const railWidth = Number.isFinite(width) ? Math.min(420, Math.max(180, width)) : 240;

  return (
    <aside
      aria-label="Games sidebar"
      data-games-sidebar
      style={{ "--games-sidebar-width": `${railWidth}px` } as CSSProperties}
      className={`${
        overlay
          ? "fixed inset-y-0 left-0 z-40 flex w-[min(var(--games-sidebar-width),92vw)] shadow-2xl"
          : "hidden"
      } ${
        /* From md up the rail stays in the layout and slides: its width
           animates to zero and visibility flips only when the transition
           ends, so the collapsed rail also leaves the accessibility tree. */
        desktopVisible
          ? "md:visible md:w-[var(--games-sidebar-width)] md:min-w-[180px] md:px-2.5"
          : "md:invisible md:w-0 md:min-w-0 md:px-0"
      } max-md:min-w-[180px] max-w-[420px] shrink-0 flex-col overflow-hidden border-r border-line bg-surface-1 pb-2.5 text-ink max-md:px-2.5 md:static md:flex md:shadow-none ${
        /* min-width must ride along: it snaps to 180px otherwise, clamping
           the animating width and killing the slide-in. */
        animating
          ? "md:[transition:width_300ms_ease,min-width_300ms_ease,padding_300ms_ease,visibility_300ms]"
          : ""
      }`}
    >
      {/* Window-controls row: traffic lights (native in the desktop shell,
          decorative in the browser), panel toggle, history back/forward.
          The whole header doubles as the window drag region. */}
      <header data-tauri-drag-region="deep" className="select-none">
        {/* In the desktop shell the native traffic lights are lowered to
            center at ~20pt (tauri.conf trafficLightPosition) — an h-10 row
            with no top padding centers our icons on that same line. */}
        {/* The controls swap instantly (no fade) when the rail collapses, so
            exactly one "Toggle games sidebar" button exists at any moment —
            the chrome strip's copy takes over the same spot. */}
        <div
          className={`flex h-10 items-center gap-0.5 ${overlayControls ? "pl-[72px]" : "px-1"} ${
            desktopVisible ? "" : "md:invisible md:transition-none"
          }`}
        >
          {!overlayControls && (
            <div aria-hidden className="mr-1.5 flex gap-2 px-1.5">
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]" />
            </div>
          )}
          <HeaderIcon icon={PanelLeft} label="Toggle games sidebar" onClick={onToggleSidebar} />
          <HeaderIcon icon={ArrowLeft} label="Back" onClick={onBack} disabled={!canBack} />
          <HeaderIcon icon={ArrowRight} label="Forward" onClick={onForward} disabled={!canForward} />
        </div>

        <div className="flex h-10 items-center justify-between px-2">
          {/* Static logo lockup — the brand is a label, not a menu. All the
              old menu items live in the nav rows and the Studio footer menu. */}
          <div className="flex min-w-0 items-center gap-2 py-1">
            <img
              src={caliberIcon}
              alt=""
              aria-hidden
              className="h-[18px] w-[18px] shrink-0 rounded-[5px]"
            />
            <span className="font-mono truncate text-[14.5px] font-bold leading-none tracking-[-0.04em]">
              <span className="text-ink-faint">cali</span>
              <span className="text-ink-strong">code</span>
            </span>
          </div>

          <HeaderIcon icon={Search} label="Toggle search" onClick={() => setSearchOpen((open) => !open)} />
        </div>
      </header>

      {/* Spotlight-style palette over games and saved chats. */}
      <SessionSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        projects={projects}
        sessions={sessions}
        onOpenProject={onOpenProject}
        onSelectSession={onSelectSession}
      />

      {/* Nav block: the studio's primary actions, as quiet rows. */}
      <nav className="mt-1 flex flex-col gap-0.5">
        <NavRow icon={SquarePen} label="New chat" onClick={() => onNewSession(activeSlug)} />
        <NavRow icon={Plus} label="New game" onClick={onNewGame} />
        <NavRow icon={Library} label="Assets Library" onClick={onOpenAssetsLibrary} active={assetsLibraryActive} />
      </nav>

      <div className="mt-4 flex items-center justify-between px-2">
        <div className="calicode-label">Games</div>
      </div>

      {/* data-games-list: masked in visual snapshots. Other e2e specs create
          projects with timestamped names, so the contents are not stable
          between runs — the layout around it still is. */}
      <div data-games-list className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1 pt-1 [scrollbar-width:thin]">
        {projects.length === 0 ? (
          /* Reachable state: with the core offline there is nothing to list,
             so this has to explain the list and offer the one way to fill it. */
          <div data-games-empty className="px-2 py-2">
            <p className="text-xs leading-relaxed text-ink-subtle">
              No games yet. A game holds its chats, scene, and assets — and the folder you attach to it.
            </p>
            {coreStatus === "offline" ? (
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-subtle">
                Core is offline; your saved games will appear when it reconnects.
              </p>
            ) : null}
            <button
              type="button"
              onClick={onNewGame}
              className="mt-2.5 inline-flex min-h-8 w-full items-center justify-center gap-1.5 rounded-md border border-line-strong bg-surface-2 px-2 py-1.5 text-[12px] text-ink-strong transition-colors hover:bg-surface-3"
            >
              <Plus aria-hidden size={14} strokeWidth={1.8} className="shrink-0" />
              Create your first game
            </button>
          </div>
        ) : (
          projects.map((project) => {
            const open = expanded === project.slug;
            const list = sessions[project.slug] ?? [];
            return (
              <div key={project.slug} className="mb-1">
                <div
                  className="group relative"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setActionMenuSlug(project.slug);
                  }}
                >
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => {
                      setExpanded(open ? null : project.slug);
                      if (project.slug !== activeSlug) onOpenProject(project.slug);
                    }}
                    className={`flex min-h-9 w-full items-center gap-1.5 rounded-md px-2 py-1.5 pr-16 text-left text-[12px] transition-colors ${
                      /* The game row only carries the selected gray while the
                         game itself is the view — once a chat session is
                         selected, its row is the single highlight. */
                      project.slug === activeSlug && activeSessionId === null
                        ? "bg-surface-3 text-ink-strong"
                        : "text-ink-subtle hover:bg-surface-2 hover:text-ink-strong active:bg-surface-3"
                    }`}
                  >
                    {open ? (
                      <FolderOpen aria-hidden size={15} strokeWidth={1.7} className="shrink-0 text-ink" />
                    ) : (
                      <Folder aria-hidden size={15} strokeWidth={1.7} className="shrink-0 text-ink-subtle" />
                    )}
                    <span className="min-w-0 flex-1 truncate" title={project.title}>
                      {project.title}
                    </span>
                  </button>

                  {/* Starts an empty chat in this game; the empty state names
                      the game so it is clear where the chat will live. */}
                  <button
                    type="button"
                    aria-label={`New chat in ${project.title}`}
                    onClick={() => onNewSession(project.slug)}
                    className="pointer-events-none absolute right-8 top-1 inline-flex h-7 w-7 items-center justify-center rounded text-ink-subtle opacity-0 transition-[color,background-color,opacity] duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:bg-surface-3 hover:text-ink-strong focus-visible:pointer-events-auto focus-visible:opacity-100"
                  >
                    <Plus aria-hidden size={15} strokeWidth={1.8} />
                  </button>
                  <ProjectActions
                    title={project.title}
                    hasFolder={Boolean(project.workspaceRoot)}
                    pinned={pinnedProjectSlugs.includes(project.slug)}
                    open={actionMenuSlug === project.slug}
                    onOpenChange={(nextOpen) => setActionMenuSlug(nextOpen ? project.slug : null)}
                    onAction={(action) => onProjectAction(project, action)}
                  />
                </div>
                {open ? (
                  <div className="mb-1.5 ml-[13px] mt-1 flex flex-col gap-0.5 border-l border-line pl-2.5">
                    {/* Without this the disclosure opens onto a bare 1px rule
                        beside nothing. It sits where the first chat will. */}
                    {list.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => onNewSession(project.slug)}
                        className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11.5px] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink active:bg-surface-3"
                      >
                        <Plus aria-hidden size={13} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
                        <span className="min-w-0 flex-1 truncate">Start a chat in {project.title}</span>
                      </button>
                    ) : null}
                    {list.map((session) => {
                      const active = session.id === activeSessionId;
                      const running = runningSessionIds?.has(session.id) ?? false;
                      const pinned = pinnedSessionIds.includes(session.id);
                      return (
                        <div
                          key={session.id}
                          className="group relative"
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setActionMenuSessionId(session.id);
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => onSelectSession(project.slug, session.id)}
                            aria-label={running ? `${session.title} (agent running)` : undefined}
                            className={`flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11.5px] transition-colors ${
                              active
                                ? "bg-surface-3 text-ink-strong"
                                : "text-ink-subtle hover:bg-surface-2 hover:text-ink active:bg-surface-3"
                            }`}
                          >
                            <span
                              aria-hidden
                              className={`h-3.5 w-[2px] shrink-0 rounded-full ${active ? "bg-ink-strong" : "bg-transparent group-hover:bg-ink-faint"}`}
                            />
                            {running ? (
                              <Loader2
                                aria-hidden
                                data-session-running
                                data-testid="session-running-spinner"
                                className="h-3 w-3 shrink-0 animate-spin text-ink-subtle"
                                strokeWidth={1.8}
                              />
                            ) : null}
                            {/* A titleless chat still has to be a visible,
                                clickable row — a blank label reads as a
                                broken line the user cannot select. */}
                            <span className="min-w-0 flex-1 truncate" title={sessionLabel(session)}>
                              {sessionLabel(session)}
                            </span>
                            {pinned ? (
                              <Pin
                                aria-hidden
                                data-session-pinned
                                size={11}
                                strokeWidth={1.8}
                                className="shrink-0 text-ink-faint"
                              />
                            ) : null}
                            {/* The timestamp, the archive action and the
                                ellipsis share this spot; the two buttons take
                                it while the row is hovered, and the ellipsis
                                keeps it while its menu is open and the pointer
                                has moved away. The min-width is what the two
                                buttons need: without it a long title truncates
                                under them instead of before them. */}
                            <span className="min-w-[52px] shrink-0 text-right text-[9.5px] tabular-nums text-ink-faint transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 group-has-[[data-state=open]]:opacity-0">
                              {relativeTime(session.updatedAt)}
                            </span>
                            {running ? (
                              <span className="sr-only" data-session-running-text>
                                Agent is running on this chat
                              </span>
                            ) : null}
                          </button>

                          {/* Archiving is the one thing a chat row is cleared
                              with, so it sits on the row itself rather than one
                              menu deep. Safe as a single click: Settings >
                              Archive puts it back. */}
                          <button
                            type="button"
                            aria-label={`Archive ${sessionLabel(session)}`}
                            onClick={() => onSessionAction(session, "archive")}
                            className="pointer-events-none absolute right-8 top-0.5 inline-flex h-7 w-7 items-center justify-center rounded text-ink-subtle opacity-0 transition-[color,background-color,opacity] duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:bg-surface-3 hover:text-ink-strong focus-visible:pointer-events-auto focus-visible:opacity-100"
                          >
                            <Archive aria-hidden size={14} strokeWidth={1.8} />
                          </button>
                          <SessionActions
                            title={sessionLabel(session)}
                            pinned={pinned}
                            hasFolder={Boolean(session.workspaceRoot)}
                            open={actionMenuSessionId === session.id}
                            onOpenChange={(nextOpen) => setActionMenuSessionId(nextOpen ? session.id : null)}
                            onAction={(action) => onSessionAction(session, action)}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <footer className="mt-3 border-t border-line px-1 pt-2.5">
        {/* The identity row is the account/app menu, like a workspace switcher:
            settings, theme, and help live one click from the avatar. */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="Studio menu"
              className="flex min-h-8 w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-surface-2 data-[state=open]:bg-surface-2"
            >
              <span
                aria-hidden
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[10px] font-bold text-ink-strong"
              >
                C
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink-subtle">Studio</span>
              <ChevronDown aria-hidden size={13} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              side="top"
              sideOffset={6}
              collisionPadding={8}
              className="z-50 min-w-[216px] rounded-[14px] border border-line bg-popover p-1.5 text-[13px] text-popover-foreground shadow-[0_18px_45px_rgba(0,0,0,0.28)] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
            >
              <ProjectAction icon={Settings} label="Settings" onSelect={onOpenSettings} />
              <ProjectAction
                icon={theme === "dark" ? Sun : Moon}
                label={theme === "dark" ? "Light mode" : "Dark mode"}
                onSelect={onToggleTheme}
              />
              <DropdownMenu.Separator className="my-1.5 h-px bg-line" />
              <DropdownMenu.Item asChild>
                <a
                  href="https://github.com/duolahypercho/CaliCode#readme"
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-h-7 cursor-default select-none items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none transition-colors data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink-strong"
                >
                  <CircleHelp aria-hidden size={14} strokeWidth={1.8} className="shrink-0 text-ink-subtle" />
                  <span>Help</span>
                </a>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </footer>
    </aside>
  );
}

/** Hover-revealed project menu; the parent also opens it from a row right-click. */
function ProjectActions({
  title,
  hasFolder,
  pinned,
  open,
  onOpenChange,
  onAction,
}: {
  title: string;
  hasFolder: boolean;
  pinned: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (action: ProjectMenuAction) => void;
}) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Open actions for ${title}`}
          className="pointer-events-none absolute right-1 top-1 inline-flex h-7 w-7 items-center justify-center rounded text-ink-subtle opacity-0 transition-[color,background-color,opacity] duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:bg-surface-3 hover:text-ink-strong focus-visible:pointer-events-auto focus-visible:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:bg-surface-3 data-[state=open]:text-ink-strong data-[state=open]:opacity-100"
        >
          <MoreHorizontal aria-hidden size={15} strokeWidth={1.8} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={5}
          collisionPadding={8}
          className="z-50 min-w-[216px] rounded-[14px] border border-line bg-popover p-1.5 text-[13px] text-popover-foreground shadow-[0_18px_45px_rgba(0,0,0,0.28)] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <ProjectAction icon={Pin} label={pinned ? "Unpin project" : "Pin project"} onSelect={() => onAction("pin")} />
          <ProjectAction icon={Folder} label="Reveal in Finder" onSelect={() => onAction("reveal")} />
          <ProjectAction
            icon={FolderOpen}
            label={hasFolder ? "Change folder" : "Attach folder"}
            onSelect={() => onAction("attach")}
          />
          <ProjectAction icon={GitBranch} label="Create permanent worktree" onSelect={() => onAction("worktree")} />
          <ProjectAction icon={Settings} label="Edit project" onSelect={() => onAction("edit")} />
          <ProjectAction icon={Archive} label="Archive chats" onSelect={() => onAction("archive")} />
          <ProjectAction icon={X} label="Remove" onSelect={() => onAction("remove")} destructive />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Hover-revealed chat menu; the row's right-click opens the same menu. */
function SessionActions({
  title,
  pinned,
  hasFolder,
  open,
  onOpenChange,
  onAction,
}: {
  title: string;
  pinned: boolean;
  hasFolder: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (action: SessionMenuAction) => void;
}) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Open actions for chat ${title}`}
          className="pointer-events-none absolute right-1 top-0.5 inline-flex h-7 w-7 items-center justify-center rounded text-ink-subtle opacity-0 transition-[color,background-color,opacity] duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:bg-surface-3 hover:text-ink-strong focus-visible:pointer-events-auto focus-visible:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:bg-surface-3 data-[state=open]:text-ink-strong data-[state=open]:opacity-100"
        >
          <MoreHorizontal aria-hidden size={14} strokeWidth={1.8} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={5}
          collisionPadding={8}
          className="z-50 min-w-[196px] rounded-[14px] border border-line bg-popover p-1.5 text-[13px] text-popover-foreground shadow-[0_18px_45px_rgba(0,0,0,0.28)] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <ProjectAction icon={Pin} label={pinned ? "Unpin chat" : "Pin chat"} onSelect={() => onAction("pin")} />
          <ProjectAction icon={Pencil} label="Rename chat" onSelect={() => onAction("rename")} />
          <ProjectAction icon={GitFork} label="Continue in new chat" onSelect={() => onAction("continue")} />
          <DropdownMenu.Separator className="my-1.5 h-px bg-line" />
          <ProjectAction icon={Copy} label="Copy chat ID" onSelect={() => onAction("copy-id")} />
          {/* Chats started before a folder was attached have no path to copy. */}
          {hasFolder ? (
            <ProjectAction icon={Folder} label="Copy working directory" onSelect={() => onAction("copy-path")} />
          ) : null}
          <DropdownMenu.Separator className="my-1.5 h-px bg-line" />
          {/* Reversible, so it is not styled as a destructive item — the
              transcript is kept and Settings → Archive can put it back. */}
          <ProjectAction icon={Archive} label="Archive chat" onSelect={() => onAction("archive")} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ProjectAction({
  icon: Icon,
  label,
  onSelect,
  destructive = false,
}: {
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={`flex min-h-7 cursor-default select-none items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none transition-colors data-[highlighted]:bg-surface-2 ${
        destructive ? "text-danger-soft data-[highlighted]:text-destructive" : "data-[highlighted]:text-ink-strong"
      }`}
    >
      <Icon aria-hidden size={14} strokeWidth={1.8} className={`shrink-0 ${destructive ? "text-danger-soft" : "text-ink-subtle"}`} />
      <span>{label}</span>
    </DropdownMenu.Item>
  );
}
