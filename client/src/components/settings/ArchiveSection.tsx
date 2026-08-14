import { useCallback, useEffect, useState } from "react";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import {
  deleteSession,
  listArchivedSessions,
  relativeTime,
  restoreSession,
  type SessionSummary,
} from "../../lib/sessions";

interface ArchiveSectionProps {
  /**
   * Lets the shell refresh its sidebar list after a restore — a restored chat
   * belongs back under its game immediately, not after the next reload.
   */
  onSessionsChanged?: () => void | Promise<void>;
}

const chatLabel = (session: SessionSummary): string => session.title?.trim() || "Untitled session";

/**
 * The archive: chats the sidebar hid, kept whole.
 *
 * Archiving is the sidebar's only way to clear a chat, so this is the one
 * place a transcript is really destroyed — and the only place it can come
 * back. Both actions live on the row so neither is a hunt.
 */
export function ArchiveSection({ onSessionsChanged }: ArchiveSectionProps) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * Deleting confirms in the row rather than in a dialog: the settings page is
   * a fixed z-[60] overlay and the shared dialog portals in at z-50, so a
   * modal opened from here renders underneath it.
   */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSessions(await listArchivedSessions());
      setError("");
    } catch (cause) {
      // Left null, not empty: a failed read must not claim the archive is
      // empty — that reads as "your chats are gone".
      setSessions(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (session: SessionSummary, action: "restore" | "delete") => {
    setBusyId(session.id);
    setConfirmingId(null);
    setError("");
    try {
      if (action === "restore") {
        await restoreSession(session.id);
      } else {
        await deleteSession(session.id);
      }
      setSessions((current) => (current ?? []).filter((item) => item.id !== session.id));
      if (action === "restore") await onSessionsChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <section aria-labelledby="settings-archive-heading">
        <h2 id="settings-archive-heading" className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-subtle">
          Archived chats
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-faint">
          Archiving a chat only hides it from the sidebar — its transcript, working directory, and history are kept.
          Restore it to put it back under its game, or delete it here to discard the transcript and clean up the
          worktree it generated. Deleting cannot be undone.
        </p>

        {error ? (
          <p role="alert" className="mt-3 rounded-md border border-danger-soft/40 bg-danger-soft/10 px-3 py-2 text-xs text-danger-soft">
            {error}
          </p>
        ) : null}

        {sessions === null ? (
          error ? null : <p className="mt-3 text-[13px] text-ink-subtle">Loading archive…</p>
        ) : sessions.length === 0 ? (
          <div data-archive-empty className="mt-3 flex items-start gap-3 rounded-lg border border-line bg-surface-1 px-3.5 py-3.5">
            <Archive aria-hidden size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-faint" />
            <div>
              <p className="text-[13px] text-ink-strong">Nothing archived</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
                Archive a chat from its row in the games sidebar and it will wait here.
              </p>
            </div>
          </div>
        ) : (
          <ul data-archive-list className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface-1">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-center gap-3 px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-ink-strong" title={chatLabel(session)}>
                    {chatLabel(session)}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-ink-subtle">
                    {session.projectSlug ?? "no game"} · {session.messageCount} message
                    {session.messageCount === 1 ? "" : "s"} · archived{" "}
                    {relativeTime(session.archivedAt ?? session.updatedAt)}
                  </p>
                </div>
                {confirmingId === session.id ? (
                  <>
                    <span className="shrink-0 text-[11px] text-ink-subtle">Delete for good?</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmingId(null)}
                      aria-label={`Keep ${chatLabel(session)} archived`}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busyId === session.id}
                      onClick={() => void run(session, "delete")}
                      aria-label={`Delete ${chatLabel(session)} permanently`}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Delete
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busyId === session.id}
                      onClick={() => void run(session, "restore")}
                      aria-label={`Restore ${chatLabel(session)}`}
                    >
                      <RotateCcw aria-hidden size={14} strokeWidth={1.7} className="mr-1.5 shrink-0" />
                      Restore
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busyId === session.id}
                      onClick={() => setConfirmingId(session.id)}
                      aria-label={`Delete ${chatLabel(session)}`}
                      className="text-danger-soft hover:text-destructive"
                    >
                      <Trash2 aria-hidden size={14} strokeWidth={1.7} className="mr-1.5 shrink-0" />
                      Delete
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
