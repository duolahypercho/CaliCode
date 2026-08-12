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

export const listSessions = (): Promise<SessionSummary[]> => rpc<SessionSummary[]>("session_list", {});

export const loadSession = (id: string): Promise<SessionRecord> => rpc<SessionRecord>("session_load", { id });

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
