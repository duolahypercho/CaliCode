import { useMemo, useState } from "react";
import type { Project } from "../../lib/types";

export interface GameSession {
  id: string;
  name: string;
}

interface GamesSidebarProps {
  projects: Project[];
  activeSlug: string;
  sessions: Record<string, GameSession[]>;
  activeSessionId: string | null;
  onOpenProject: (slug: string) => void;
  onSelectSession: (slug: string, sessionId: string) => void;
  onNewSession: (slug: string) => void;
  onNewGame: () => void;
  workspace: { name: string; root: string } | null;
  onOpenFolder: () => void;
}

/**
 * Left rail: new-game action, searchable game list, and each game's
 * agent sessions nested underneath. Matches the 208px sidebar in the design.
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
  workspace,
  onOpenFolder,
}: GamesSidebarProps) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(activeSlug);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter(
      (project) => project.title.toLowerCase().includes(query) || project.slug.toLowerCase().includes(query),
    );
  }, [projects, search]);

  return (
    <aside className="hidden w-52 shrink-0 flex-col border-r border-white/[0.06] bg-[#0b0b0b] p-3 md:flex">
      <button
        type="button"
        onClick={onNewGame}
        className="w-full rounded-md border border-white/10 bg-[#242424] py-2.5 text-[11px] font-bold tracking-[0.16em] text-[#dcdcdc] hover:bg-[#2c2c2c]"
      >
        NEW GAME
      </button>

      <div className="calicode-label mx-1 mb-2 mt-5">Games</div>
      <div className="mb-2.5 flex items-center gap-2 rounded-md border border-white/[0.07] bg-[#101010] px-2.5 py-[7px]">
        <span aria-hidden className="text-[#454545]">
          /
        </span>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="search"
          aria-label="Search games"
          className="min-w-0 flex-1 bg-transparent text-xs text-[#c6c6c6] outline-none placeholder:text-[#565656]"
        />
      </div>

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {visible.length === 0 ? (
          <p className="px-2 py-1 text-xs text-[#565656]">{projects.length === 0 ? "No games yet." : "No matches."}</p>
        ) : (
          visible.map((project) => {
            const open = expanded === project.slug;
            const list = sessions[project.slug] ?? [];
            return (
              <div key={project.slug} className="mb-1">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => {
                    setExpanded(open ? null : project.slug);
                    if (project.slug !== activeSlug) onOpenProject(project.slug);
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12.5px] ${
                    project.slug === activeSlug ? "text-[#e0e0e0]" : "text-[#a0a0a0] hover:text-[#d0d0d0]"
                  }`}
                >
                  <span
                    aria-hidden
                    className="inline-block text-[9px] text-[#767676] transition-transform"
                    style={{ transform: `rotate(${open ? 90 : 0}deg)` }}
                  >
                    ▸
                  </span>
                  <span className="min-w-0 flex-1 truncate">{project.title}</span>
                  <span className="text-[10px] text-[#565656]">{list.length}</span>
                </button>
                {open ? (
                  <div className="mb-1.5 ml-2 mt-[3px] flex flex-col gap-[2px] border-l border-white/[0.08] pl-2">
                    {list.map((session) => {
                      const active = session.id === activeSessionId;
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => onSelectSession(project.slug, session.id)}
                          className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12.5px] ${
                            active ? "bg-[#171717] text-[#dcdcdc]" : "text-[#8f8f8f] hover:text-[#c0c0c0]"
                          }`}
                        >
                          <span aria-hidden className={`h-3.5 w-[2px] ${active ? "bg-[#c0c0c0]" : "bg-transparent"}`} />
                          <span className="min-w-0 flex-1 truncate">{session.name}</span>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => onNewSession(project.slug)}
                      className="px-2 py-1.5 text-left text-[11px] text-[#616161] hover:text-[#9a9a9a]"
                    >
                      + new session
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {/* A workspace is a real folder on disk that CaliCode edits in place,
          as opposed to a project it owns end to end. */}
      <div className="mt-3 border-t border-white/5 pt-3">
        <div className="calicode-label mx-1 mb-2">Workspace</div>
        {workspace ? (
          <div className="rounded-md border border-white/[0.07] bg-[#101010] px-2.5 py-2">
            <div className="truncate text-[12px] text-[#dcdcdc]">{workspace.name}</div>
            <div className="mt-0.5 truncate text-[10px] text-[#565656]" title={workspace.root}>
              {workspace.root}
            </div>
          </div>
        ) : null}
        <button
          type="button"
          onClick={onOpenFolder}
          className="mt-1.5 w-full rounded-md border border-white/10 py-2 text-[11px] tracking-[0.14em] text-[#a0a0a0] hover:border-white/25 hover:text-[#d0d0d0]"
        >
          {workspace ? "CHANGE FOLDER" : "OPEN FOLDER"}
        </button>
      </div>

      <div className="mt-auto flex flex-col gap-[2px] border-t border-white/5 pt-3.5">
        <a
          href="https://github.com/duolahypercho/CaliCode#readme"
          target="_blank"
          rel="noreferrer"
          className="px-1 py-[7px] text-xs tracking-[0.08em] text-[#828282] hover:text-[#c0c0c0]"
        >
          HELP
        </a>
      </div>
    </aside>
  );
}
