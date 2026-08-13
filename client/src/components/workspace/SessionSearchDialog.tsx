import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Folder, MessageSquare, Search } from "lucide-react";
import type { Project } from "../../lib/types";
import { relativeTime, type SessionSummary } from "../../lib/sessions";

interface SessionSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  /** Saved transcripts per game, keyed by project slug. */
  sessions: Record<string, SessionSummary[]>;
  onOpenProject: (slug: string) => void;
  onSelectSession: (slug: string, sessionId: string) => void;
}

interface SessionHit {
  session: SessionSummary;
  projectSlug: string;
  projectTitle: string;
}

/**
 * Spotlight-style command palette over the studio's games and saved agent
 * sessions. Opens from the sidebar's search icon; a single query matches both
 * game titles and session titles, live as you type.
 */
export function SessionSearchDialog({
  open,
  onOpenChange,
  projects,
  sessions,
  onOpenProject,
  onSelectSession,
}: SessionSearchDialogProps) {
  const [query, setQuery] = useState("");

  const trimmed = query.trim().toLowerCase();

  const gameHits = useMemo(() => {
    if (!trimmed) return projects;
    return projects.filter(
      (project) => project.title.toLowerCase().includes(trimmed) || project.slug.toLowerCase().includes(trimmed),
    );
  }, [projects, trimmed]);

  const sessionHits = useMemo<SessionHit[]>(() => {
    if (!trimmed) return [];
    const titleBySlug = new Map(projects.map((project) => [project.slug, project.title]));
    const hits: SessionHit[] = [];
    for (const [slug, list] of Object.entries(sessions)) {
      for (const session of list) {
        if (session.title.toLowerCase().includes(trimmed)) {
          hits.push({ session, projectSlug: slug, projectTitle: titleBySlug.get(slug) ?? slug });
        }
      }
    }
    hits.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
    return hits;
  }, [projects, sessions, trimmed]);

  const close = () => onOpenChange(false);
  const empty = gameHits.length === 0 && sessionHits.length === 0;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[18%] z-50 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-popover text-popover-foreground shadow-[0_24px_60px_rgba(0,0,0,0.35)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <Dialog.Title className="sr-only">Search games and chats</Dialog.Title>
          <label className="flex min-h-11 items-center gap-2.5 border-b border-line px-3.5">
            <Search aria-hidden size={15} strokeWidth={1.7} className="shrink-0 text-ink-faint" />
            <input
              autoFocus
              data-no-focus-ring
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search games and chats…"
              aria-label="Search games"
              className="min-w-0 flex-1 bg-transparent py-3 text-[13px] text-ink-strong placeholder:text-ink-faint"
            />
            <kbd className="hidden shrink-0 rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-faint sm:inline-block">
              esc
            </kbd>
          </label>

          <div className="max-h-[min(50vh,380px)] overflow-y-auto p-1.5 [scrollbar-width:thin]">
            {empty ? (
              <p className="px-2.5 py-6 text-center text-[12px] text-ink-subtle">No matches.</p>
            ) : (
              <>
                {gameHits.length > 0 && (
                  <section aria-label="Games">
                    <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                      Games
                    </div>
                    {gameHits.map((project) => (
                      <button
                        key={project.slug}
                        type="button"
                        onClick={() => {
                          onOpenProject(project.slug);
                          close();
                        }}
                        className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-surface-2 hover:text-ink-strong"
                      >
                        <Folder aria-hidden size={15} strokeWidth={1.7} className="shrink-0 text-ink-subtle" />
                        <span className="min-w-0 flex-1 truncate" title={project.title}>
                          {project.title}
                        </span>
                      </button>
                    ))}
                  </section>
                )}

                {sessionHits.length > 0 && (
                  <section aria-label="Chats">
                    <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                      Chats
                    </div>
                    {sessionHits.map(({ session, projectSlug, projectTitle }) => (
                      <button
                        key={`${projectSlug}:${session.id}`}
                        type="button"
                        onClick={() => {
                          onSelectSession(projectSlug, session.id);
                          close();
                        }}
                        className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-surface-2 hover:text-ink-strong"
                      >
                        <MessageSquare aria-hidden size={14} strokeWidth={1.7} className="shrink-0 text-ink-subtle" />
                        <span className="min-w-0 flex-1 truncate" title={session.title}>
                          {session.title}
                        </span>
                        <span className="shrink-0 truncate text-[10.5px] text-ink-faint">{projectTitle}</span>
                        <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
                          {relativeTime(session.updatedAt)}
                        </span>
                      </button>
                    ))}
                  </section>
                )}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
