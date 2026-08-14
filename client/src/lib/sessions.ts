// Client wrappers for the persistent session RPCs (see core/src/sessions.rs).
// Transcripts are stored under ~/.cali/sessions so they survive restarts and
// can be listed, resumed, forked, and deleted.

import { rpc } from "./rpc";
import type { AgentMessage } from "./types";

export interface SessionSummary {
  id: string;
  title: string;
  projectSlug: string | null;
  provider: string | null;
  model: string | null;
  workspaceRoot?: string | null;
  worktreeId?: string | null;
  branch?: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * When the chat was moved to the archive, in UNIX seconds. Null for a live
   * chat. Archived chats leave the sidebar and are listed in Settings →
   * Archive, which is the only place they can be restored or really deleted.
   */
  archivedAt?: number | null;
  messageCount: number;
}

export interface SessionRecord extends SessionSummary {
  messages: AgentMessage[];
  /**
   * Raw provider-shaped turns core's compaction soft-archived out of the live
   * transcript (sessions.rs `archive_turns`). Absent until a compaction runs.
   */
  archived?: unknown[];
}

export interface SaveSessionInput {
  id: string;
  messages: AgentMessage[];
  projectSlug?: string | null;
  provider?: string | null;
  model?: string | null;
  workspaceRoot?: string | null;
  worktreeId?: string | null;
  branch?: string | null;
  title?: string;
}

export const saveSession = (input: SaveSessionInput): Promise<SessionSummary> =>
  rpc<SessionSummary>("session_save", { ...input });

export const createSession = (projectSlug: string): Promise<SessionSummary> =>
  rpc<SessionSummary>("session_create", { projectSlug });

/**
 * Saved transcripts, newest first.
 *
 * Entries without an id are dropped rather than shown. Every session RPC —
 * open, rename, delete — is keyed by id, so an id-less row is a chat nothing
 * can act on: it rendered as a blank, untouchable line in the sidebar when
 * core listed a non-session file (see sessions.rs `list`). Filtering here as
 * well keeps an older core from putting one back.
 */
export const listSessions = async (options: { archived?: boolean } = {}): Promise<SessionSummary[]> => {
  const listed = await rpc<SessionSummary[]>("session_list", { archived: options.archived ?? false });
  return (listed ?? []).filter((session) => typeof session?.id === "string" && session.id.trim() !== "");
};

/** The archive Settings shows: chats hidden from the sidebar but kept whole. */
export const listArchivedSessions = (): Promise<SessionSummary[]> => listSessions({ archived: true });

/**
 * Move a chat out of the sidebar without discarding anything — the transcript,
 * the worktree and any running agent survive, so a restore is exact.
 */
export const archiveSession = (id: string): Promise<SessionSummary> =>
  rpc<SessionSummary>("session_archive", { id });

export const restoreSession = (id: string): Promise<SessionSummary> =>
  rpc<SessionSummary>("session_restore", { id });

export const loadSession = (id: string): Promise<SessionRecord> => rpc<SessionRecord>("session_load", { id });

/** Title-only save; core keeps the stored transcript when messages are absent. */
export const renameSession = (id: string, title: string): Promise<SessionSummary> =>
  rpc<SessionSummary>("session_save", { id, title });

export const deleteSession = (id: string): Promise<{ id: string; deleted: boolean }> =>
  rpc<{ id: string; deleted: boolean }>("session_delete", { id });

export const forkSession = (id: string, newId?: string): Promise<SessionRecord> =>
  rpc<SessionRecord>("session_fork", { id, newId });

/** Compact "3m ago" / "2h ago" label from a UNIX-seconds timestamp. */
export function relativeTime(epochSecs: number): string {
  const deltaSecs = Math.max(0, Math.floor(Date.now() / 1000) - epochSecs);
  if (deltaSecs < 60) return "just now";
  const minutes = Math.floor(deltaSecs / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
