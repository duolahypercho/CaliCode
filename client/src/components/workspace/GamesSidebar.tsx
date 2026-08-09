import { useMemo, useState, type CSSProperties } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Folder,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Pin,
  Plus,
  Search,
  Settings,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Project } from "../../lib/types";

export interface GameSession {
  id: string;
  name: string;
}

export type ProjectMenuAction = "pin" | "reveal" | "worktree" | "edit" | "archive" | "remove";

interface GamesSidebarProps {
  projects: Project[];
  activeSlug: string;
  sessions: Record<string, GameSession[]>;
  activeSessionId: string | null;
  onOpenProject: (slug: string) => void;
  onSelectSession: (slug: string, sessionId: string) => void;
  onNewSession: (slug: string) => void;
  onNewGame: () => void;
  pinnedProjectSlugs?: string[];
  onProjectAction?: (project: Project, action: ProjectMenuAction) => void;
  workspace: { name: string; root: string } | null;
  onOpenFolder: () => void;
  /** Open as an overlay when the rail is below its md breakpoint. */
  overlay?: boolean;
  /** Width of the persistent rail at md and above. */
  width?: number;
  /** Whether the persistent rail is present at md and above. */
  desktopVisible?: boolean;
}

/**
 * Left rail: new-game action, searchable game list, and each game's
 * agent sessions nested underneath. The desktop rail is user-resizable.
 */
export function GamesSidebar({
  projects,
  activeSlug,
  sessions,
  activeSessionId,
  onOpenProject,
  onSelectSession,
  onNewSession,
  onNewGame,
  pinnedProjectSlugs = [],
  onProjectAction = () => undefined,
  workspace,
  onOpenFolder,
  overlay = false,
  width = 240,
  desktopVisible = true,
}: GamesSidebarProps) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(activeSlug);
  const [actionMenuSlug, setActionMenuSlug] = useState<string | null>(null);

  // The parent keeps this value within the resize bounds, but clamping here
  // keeps the rail safe when it is rendered in isolation (or with persisted
  // settings from an older build).
  const railWidth = Number.isFinite(width) ? Math.min(420, Math.max(180, width)) : 240;

  // The folder section belongs to the selected game, so it is labelled with
  // that game's title rather than a generic "Workspace".
  const activeTitle = projects.find((candidate) => candidate.slug === activeSlug)?.title ?? null;

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter(
      (project) => project.title.toLowerCase().includes(query) || project.slug.toLowerCase().includes(query),
    );
  }, [projects, search]);

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
        desktopVisible ? "md:static md:flex md:w-[var(--games-sidebar-width)] md:shadow-none" : "md:hidden"
      } min-w-[180px] max-w-[420px] shrink-0 flex-col border-r border-[#2b2a28] bg-[#181817] p-2.5 text-[#d7d5d2]`}
    >
      <header className="flex h-9 items-center justify-between px-2">
        <div className="inline-flex min-w-0 items-center gap-1.5">
          <span className="font-display truncate text-[15px] font-extrabold tracking-[-0.02em] text-[#e8e6e3]">
            CaliCode
          </span>
          <ChevronDown aria-hidden size={13} strokeWidth={1.8} className="shrink-0 text-[#8e8b87]" />
        </div>
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#72706d]" />
      </header>

      <button
        type="button"
        onClick={onNewGame}
        className="group inline-flex min-h-9 w-full items-center gap-2 rounded-md border border-white/[0.11] bg-[#292826] px-2.5 py-2 text-left text-xs font-medium text-[#e3e1de] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] transition-colors hover:border-white/[0.18] hover:bg-[#32312f] active:bg-[#3a3937] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
      >
        <Plus aria-hidden size={15} strokeWidth={1.8} className="text-[#bdbab5] transition-colors group-hover:text-[#efedea]" />
        <span className="truncate">NEW GAME</span>
      </button>

      <label className="mt-3 flex min-h-8 items-center gap-2 rounded-md border border-white/[0.07] bg-[#111110] px-2.5 py-1.5 transition-colors focus-within:border-white/[0.16] focus-within:bg-[#141413]">
        <Search aria-hidden size={14} strokeWidth={1.7} className="shrink-0 text-[#8b8985]" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="search"
          aria-label="Search games"
          className="min-w-0 flex-1 rounded-sm bg-transparent text-[11px] text-[#d2d0cd] transition-colors outline-none placeholder:text-[#85827e] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
        />
      </label>

      <div className="mt-4 flex items-center justify-between px-2">
        <div className="calicode-label">Projects</div>
        <span className="text-[10px] tabular-nums text-[#77746f]">{visible.length}</span>
      </div>

      {/* data-games-list: masked in visual snapshots. Other e2e specs create
          projects with timestamped names, so the contents are not stable
          between runs — the layout around it still is. */}
      <div data-games-list className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1 pt-1 [scrollbar-color:#3a3937_transparent] [scrollbar-width:thin]">
        {visible.length === 0 ? (
          <p className="px-2 py-2 text-xs text-[#8e8b86]">{projects.length === 0 ? "No games yet." : "No matches."}</p>
        ) : (
          visible.map((project) => {
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
                    className={`flex min-h-9 w-full items-center gap-1.5 rounded-md px-2 py-1.5 pr-9 text-left text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/40 ${
                      project.slug === activeSlug
                        ? "bg-[#3b3a38] text-[#f0eeeb] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]"
                        : "text-[#b0ada8] hover:bg-white/[0.055] hover:text-[#e0dedb] active:bg-white/[0.08]"
                    }`}
                  >
                    <ChevronRight
                      aria-hidden
                      size={13}
                      strokeWidth={1.8}
                      className={`shrink-0 text-[#85827e] transition-transform ${open ? "rotate-90" : ""}`}
                    />
                    {open ? (
                      <FolderOpen aria-hidden size={15} strokeWidth={1.7} className="shrink-0 text-[#c3c0bb]" />
                    ) : (
                      <Folder aria-hidden size={15} strokeWidth={1.7} className="shrink-0 text-[#aaa7a1]" />
                    )}
                    <span className="min-w-0 flex-1 truncate" title={project.title}>
                      {project.title}
                    </span>
                    <span className="min-w-3 text-right text-[10px] tabular-nums text-[#85827e] transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                      {list.length}
                    </span>
                  </button>

                  <ProjectActions
                    title={project.title}
                    pinned={pinnedProjectSlugs.includes(project.slug)}
                    open={actionMenuSlug === project.slug}
                    onOpenChange={(nextOpen) => setActionMenuSlug(nextOpen ? project.slug : null)}
                    onAction={(action) => onProjectAction(project, action)}
                  />
                </div>
                {open ? (
                  <div className="mb-1.5 ml-[13px] mt-1 flex flex-col gap-0.5 border-l border-[#393835] pl-2.5">
                    {list.map((session) => {
                      const active = session.id === activeSessionId;
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => onSelectSession(project.slug, session.id)}
                          className={`group flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/40 ${
                            active
                              ? "bg-white/[0.09] text-[#e4e1dd]"
                              : "text-[#999691] hover:bg-white/[0.05] hover:text-[#c8c5c0] active:bg-white/[0.08]"
                          }`}
                        >
                          <span
                            aria-hidden
                            className={`h-3.5 w-[2px] shrink-0 rounded-full ${active ? "bg-[#d8d5d0]" : "bg-transparent group-hover:bg-[#6d6a66]"}`}
                          />
                          <span className="min-w-0 flex-1 truncate" title={session.name}>
                            {session.name}
                          </span>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      aria-label="+ new session"
                      onClick={() => onNewSession(project.slug)}
                      className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] text-[#96928c] transition-colors hover:bg-white/[0.04] hover:text-[#d0cdc8] active:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/40"
                    >
                      <Plus aria-hidden size={13} strokeWidth={1.8} />
                      <span>new session</span>
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {/* Each game owns one folder on disk, so this section describes the
          SELECTED game's workspace — switching games switches the folder. */}
      <section className="mt-2 border-t border-white/[0.08] pt-3">
        <div className="mb-2 flex items-center gap-2 px-1">
          <FolderOpen aria-hidden size={14} strokeWidth={1.7} className="text-[#8e8b86]" />
          <div className="calicode-label truncate">{activeTitle ? `${activeTitle} folder` : "Game folder"}</div>
        </div>
        {workspace ? (
          <div className="rounded-md border border-white/[0.08] bg-[#111110] px-2.5 py-2">
            <div className="truncate text-[11.5px] text-[#ddd9d4]">{workspace.name}</div>
            <div className="mt-1 truncate text-[10px] text-[#898680]" title={workspace.root}>
              {workspace.root}
            </div>
          </div>
        ) : (
          <p className="px-1 text-[11px] leading-relaxed text-[#85817b]">
            No folder attached to this game yet.
          </p>
        )}
        <button
          type="button"
          onClick={onOpenFolder}
          className="mt-2 inline-flex min-h-8 w-full items-center justify-center rounded-md border border-white/[0.11] py-1.5 text-[10px] font-medium tracking-[0.14em] text-[#aaa7a1] transition-colors hover:border-white/[0.24] hover:bg-white/[0.04] hover:text-[#e0ddd8] active:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
        >
          {workspace ? "CHANGE FOLDER" : "ATTACH FOLDER"}
        </button>
      </section>

      <footer className="mt-3 flex items-center justify-between border-t border-white/[0.08] px-1 pt-2.5">
        <div className="min-w-0 truncate text-[10px] tracking-[0.1em] text-[#77746f]">CALICODE WORKSPACE</div>
        <a
          href="https://github.com/duolahypercho/CaliCode#readme"
          target="_blank"
          rel="noreferrer"
          aria-label="Help and documentation"
          className="inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded px-1 py-1.5 text-[10px] tracking-[0.08em] text-[#85817b] transition-colors hover:bg-white/[0.04] hover:text-[#d1cec9] active:text-[#e5e2dd] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
        >
          <CircleHelp aria-hidden size={14} strokeWidth={1.7} />
          HELP
        </a>
      </footer>
    </aside>
  );
}

/** Hover-revealed project menu; the parent also opens it from a row right-click. */
function ProjectActions({
  title,
  pinned,
  open,
  onOpenChange,
  onAction,
}: {
  title: string;
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
          className="pointer-events-none absolute right-1 top-1 inline-flex h-7 w-7 items-center justify-center rounded text-[#aaa7a1] opacity-0 transition-[color,background-color,opacity] duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:bg-white/[0.08] hover:text-[#efedea] focus-visible:pointer-events-auto focus-visible:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:bg-white/[0.1] data-[state=open]:text-[#f0eeeb] data-[state=open]:opacity-100"
        >
          <MoreHorizontal aria-hidden size={15} strokeWidth={1.8} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={5}
          collisionPadding={8}
          className="z-50 min-w-[216px] rounded-[14px] border border-white/[0.09] bg-[#2c2c2c] p-1.5 text-[13px] text-[#efefef] shadow-[0_18px_45px_rgba(0,0,0,0.48),0_1px_0_rgba(255,255,255,0.06)_inset] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <ProjectAction icon={Pin} label={pinned ? "Unpin project" : "Pin project"} onSelect={() => onAction("pin")} />
          <ProjectAction icon={Folder} label="Reveal in Finder" onSelect={() => onAction("reveal")} />
          <ProjectAction icon={GitBranch} label="Create permanent worktree" onSelect={() => onAction("worktree")} />
          <ProjectAction icon={Settings} label="Edit project" onSelect={() => onAction("edit")} />
          <ProjectAction icon={Archive} label="Archive chats" onSelect={() => onAction("archive")} />
          <ProjectAction icon={X} label="Remove" onSelect={() => onAction("remove")} destructive />
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
      className={`flex min-h-7 cursor-default select-none items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none transition-colors data-[highlighted]:bg-white/[0.09] ${
        destructive ? "text-[#f0a29b] data-[highlighted]:text-[#ffc1bb]" : "data-[highlighted]:text-white"
      }`}
    >
      <Icon aria-hidden size={14} strokeWidth={1.8} className={`shrink-0 ${destructive ? "text-[#e7867d]" : "text-[#c8c8c8]"}`} />
      <span>{label}</span>
    </DropdownMenu.Item>
  );
}
