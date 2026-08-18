import { ArrowRight, Check, Folder, FolderOpen, MessageSquare, Plus } from "lucide-react";
import type { CoreConnectionState } from "../../lib/rpc";
import type { SessionSummary } from "../../lib/sessions";
import type { Project } from "../../lib/types";
import { Button } from "../ui/button";

interface ProjectHubProps {
  projects: Project[];
  sessions: Record<string, SessionSummary[]>;
  activeSlug: string;
  coreStatus?: CoreConnectionState;
  onOpenProject: (slug: string) => void;
  onNewProject: () => void;
}

/**
 * The project-first entry point. It stays inside the editor shell rather than
 * opening a second window, so choosing a game feels like changing context —
 * not leaving CaliCode — and the agent never appears detached from its files.
 */
export function ProjectHub({
  projects,
  sessions,
  activeSlug,
  coreStatus = "unknown",
  onOpenProject,
  onNewProject,
}: ProjectHubProps) {
  const hasProjects = projects.length > 0;
  const activeProject = projects.find((project) => project.slug === activeSlug);

  return (
    <main data-project-hub className="min-h-0 flex-1 overflow-y-auto bg-surface-0">
      <div className="mx-auto flex min-h-full w-full max-w-[1080px] flex-col px-5 py-8 sm:px-8 sm:py-10 lg:px-12">
        <header className="flex flex-col gap-6 border-b border-line pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-[620px]">
            <div className="calicode-label">Workspace / projects</div>
            <h1 className="mt-2 font-display text-[30px] font-semibold tracking-[-0.035em] text-ink-strong sm:text-[36px]">
              Choose a game to work on.
            </h1>
            <p className="mt-2 max-w-[56ch] text-[13px] leading-relaxed text-ink-subtle">
              Each project keeps its own scene, files, chats, and tools. Pick a game first, then tell the agent what to build.
            </p>
          </div>
          <Button type="button" onClick={onNewProject} className="shrink-0 self-start sm:self-auto">
            <Plus aria-hidden className="h-4 w-4" strokeWidth={1.9} />
            New game
          </Button>
        </header>

        {activeProject ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-3 text-[11px] text-ink-subtle">
            <span className="inline-flex items-center gap-1.5 text-ink-strong">
              <Check aria-hidden className="h-3.5 w-3.5 text-success-soft" strokeWidth={2.2} />
              Currently open: {activeProject.title}
            </span>
            <span className="hidden text-ink-faint sm:inline">Select another project below to switch context.</span>
          </div>
        ) : null}

        {!hasProjects ? (
          <EmptyProjectState coreStatus={coreStatus} onNewProject={onNewProject} />
        ) : (
          <section className="flex-1 pt-7" aria-labelledby="project-hub-list-title">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 id="project-hub-list-title" className="text-[13px] font-medium text-ink-strong">
                  Your games
                </h2>
                <p className="mt-1 text-[11px] text-ink-faint">Open a project to continue with its chats and workspace.</p>
              </div>
              <span className="font-mono text-[10px] text-ink-faint">
                {projects.length} {projects.length === 1 ? "project" : "projects"}
              </span>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {projects.map((project) => {
                const projectSessions = sessions[project.slug] ?? [];
                const active = project.slug === activeSlug;
                return (
                  <button
                    key={project.slug}
                    type="button"
                    aria-label={`Open ${project.title}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => onOpenProject(project.slug)}
                    className={`group flex min-h-[164px] flex-col rounded-xl border p-4 text-left transition-colors active:bg-surface-3 ${
                      active
                        ? "border-line-strong bg-surface-2"
                        : "border-line bg-raised hover:bg-surface-1"
                    }`}
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span
                        className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border ${
                          active ? "border-line-strong bg-surface-3" : "border-line bg-surface-1"
                        }`}
                      >
                        {project.workspaceRoot ? (
                          <FolderOpen aria-hidden className="h-4 w-4 text-ink" strokeWidth={1.7} />
                        ) : (
                          <Folder aria-hidden className="h-4 w-4 text-ink-subtle" strokeWidth={1.7} />
                        )}
                      </span>
                      <ArrowRight
                        aria-hidden
                        className="h-4 w-4 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink"
                        strokeWidth={1.8}
                      />
                    </span>

                    <span className="mt-5 min-w-0 truncate text-[14px] font-medium text-ink-strong" title={project.title}>
                      {project.title}
                    </span>
                    <span className="mt-1 min-w-0 truncate text-[11px] text-ink-subtle">
                      {project.workspaceRoot ? workspaceLabel(project.workspaceRoot) : "No folder attached yet"}
                    </span>

                    <span className="mt-auto flex items-center gap-1.5 border-t border-line pt-3 text-[10px] text-ink-faint">
                      <MessageSquare aria-hidden className="h-3 w-3" strokeWidth={1.8} />
                      {projectSessions.length === 0
                        ? "No chats yet"
                        : `${projectSessions.length} ${projectSessions.length === 1 ? "chat" : "chats"}`}
                      {active ? <span className="ml-auto text-ink-subtle">Open</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <footer className="mt-8 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-4 text-[11px] text-ink-faint">
          <span className="font-mono text-ink-subtle">cali</span>
          <span>Projects are the boundary for agent context and file changes.</span>
        </footer>
      </div>
    </main>
  );
}

function EmptyProjectState({
  coreStatus,
  onNewProject,
}: {
  coreStatus: CoreConnectionState;
  onNewProject: () => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <div className="w-full max-w-[430px] rounded-xl border border-line bg-raised p-6 text-center">
        <span className="mx-auto inline-flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface-1">
          <Folder aria-hidden className="h-4 w-4 text-ink-subtle" strokeWidth={1.7} />
        </span>
        <h2 className="mt-4 text-[15px] font-medium text-ink-strong">Start with a game</h2>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-subtle">
          Create a new scene or open a folder you already have. Your prompt will stay scoped to that project.
        </p>
        {coreStatus === "offline" ? (
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">Core is offline. Reconnect to load saved projects.</p>
        ) : null}
        <Button type="button" onClick={onNewProject} className="mt-5">
          <Plus aria-hidden className="h-4 w-4" strokeWidth={1.9} />
          Create or open a game
        </Button>
      </div>
    </div>
  );
}

function workspaceLabel(root: string): string {
  const normalized = root.trim().replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? root;
}

