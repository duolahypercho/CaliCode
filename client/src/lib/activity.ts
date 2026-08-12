import { collapseContext, diffLines, type DiffRow } from "./diff";

/**
 * File activity passed between the agent transcript and the workspace editor.
 *
 * The object intentionally contains the bounded, collapsed diff only. The
 * potentially large before/after snapshots from an SSE event are consumed
 * while constructing this value and are never persisted in the transcript.
 */
export interface ActivityFileChange {
  path: string;
  workspaceRoot?: string | null;
  projectSlug?: string | null;
  operation: ActivityOperation;
  additions: number;
  deletions: number;
  diff: DiffRow[];
  truncated?: boolean;
  turnId?: string;
  toolCallId?: string;
}

export type ActivityOperation = "read" | "search" | "edit" | "write" | "command" | "tool";

export interface ActivityTextPayload {
  operation?: string;
  path?: string;
  before?: string;
  after?: string;
  beforeSnippet?: string;
  afterSnippet?: string;
  truncated?: boolean;
  replacements?: number;
}

export interface ActivityAction {
  id: string;
  turnId: string;
  tool: string;
  toolCallId?: string;
  status: "running" | "done" | "error";
  startedAtMs?: number;
  finishedAtMs?: number;
  content: string;
  detail?: string;
  file?: ActivityFileChange;
  projectSlug?: string | null;
  workspaceRoot?: string | null;
}

const MAX_DIFF_ROWS = 120;
const MAX_DETAIL_CHARS = 12_000;

/** A small, deterministic turn marker for persistence and resume. */
export function createTurnMarker(turnId: string, startedAtMs = Date.now()): {
  role: "tool";
  tool: "turn";
  content: string;
  status: "running";
  turnId: string;
  startedAtMs: number;
} {
  return {
    role: "tool",
    tool: "turn",
    content: "",
    status: "running",
    turnId,
    startedAtMs,
  };
}

export function isTurnMarker(message: {
  role: string;
  tool?: string;
  turnId?: string;
}): boolean {
  return message.role === "tool" && message.tool === "turn" && Boolean(message.turnId);
}

/**
 * Activity paths are workspace-relative. Rejecting traversal and absolute
 * paths keeps a transcript click from becoming an arbitrary file opener.
 */
export function isSafeActivityPath(path: string, workspaceRoot?: string | null): boolean {
  void workspaceRoot;
  if (typeof path !== "string") return false;
  const value = path.trim();
  if (!value || value.length > 4096 || value.includes("\0")) return false;
  const normalised = value.replaceAll("\\", "/");
  if (normalised.startsWith("/") || /^[A-Za-z]:\//.test(normalised) || normalised.startsWith("//")) return false;
  const segments = normalised.split("/");
  return !segments.some((segment) => segment === "..");
}

export function classifyActivityOperation(tool: string, explicit?: string): ActivityOperation {
  const operation = explicit?.toLowerCase();
  if (operation === "read") return "read";
  if (operation === "search") return "search";
  if (operation === "edit") return "edit";
  if (operation === "write") return "write";
  if (operation === "command") return "command";
  const name = tool.toLowerCase();
  if (name.includes("read") || name === "file_list") return "read";
  if (name.includes("grep") || name.includes("glob") || name.includes("search") || name.includes("find")) return "search";
  if (name.includes("edit") || name.includes("patch") || name.includes("update")) return "edit";
  if (name.includes("write") || name.includes("create") || name.includes("save")) return "write";
  if (
    name.includes("command") ||
    name.includes("shell") ||
    name.includes("exec") ||
    name.includes("run") ||
    name.includes("build") ||
    name.includes("test")
  ) {
    return "command";
  }
  return "tool";
}

function boundedText(value: unknown, max = MAX_DETAIL_CHARS): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

function basename(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/");
  return segments.at(-1) || path;
}

function boundedDiff(before: string, after: string): { diff: DiffRow[]; additions: number; deletions: number } {
  const result = diffLines(before, after);
  const rows = collapseContext(result.rows, 3).slice(0, MAX_DIFF_ROWS);
  return { diff: rows, additions: result.added, deletions: result.removed };
}

/**
 * Consume the raw activity payload from core and retain only the compact
 * change representation used by the client. Callers should pass snippets for
 * truncated writes; the `truncated` bit keeps the UI from presenting those
 * counts as a complete-file guarantee.
 */
export function buildActivityFileChange(
  payload: ActivityTextPayload,
  context: {
    tool: string;
    turnId: string;
    toolCallId?: string;
    projectSlug?: string | null;
    workspaceRoot?: string | null;
    fallbackPath?: string;
  },
): ActivityFileChange | undefined {
  const path = payload.path ?? context.fallbackPath;
  if (!path) return undefined;
  const before = payload.before ?? payload.beforeSnippet;
  const after = payload.after ?? payload.afterSnippet;
  const operation = classifyActivityOperation(context.tool, payload.operation);
  const counts =
    before !== undefined || after !== undefined
      ? boundedDiff(before ?? "", after ?? "")
      : { diff: [], additions: 0, deletions: 0 };
  return {
    path,
    workspaceRoot: context.workspaceRoot,
    projectSlug: context.projectSlug,
    operation,
    additions: counts.additions,
    deletions: counts.deletions,
    diff: counts.diff,
    truncated: payload.truncated,
    turnId: context.turnId,
    toolCallId: context.toolCallId,
  };
}

export function activityDetail(result: unknown): string | undefined {
  if (result == null) return undefined;
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return boundedText(text);
}

export function activitySummary(
  tool: string,
  operation: ActivityOperation,
  args?: unknown,
  file?: ActivityFileChange,
): string {
  const params = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const path = file?.path ?? (typeof params.path === "string" ? params.path : undefined);
  const name = path ? basename(path) : undefined;
  if (operation === "read") return name ? `Read ${name}` : "Read files";
  if (operation === "search") {
    const pattern = typeof params.pattern === "string" ? params.pattern : typeof params.query === "string" ? params.query : "";
    return pattern ? `Searched for ${pattern}${name ? ` in ${name}` : ""}` : name ? `Listed ${name}` : "Searched files";
  }
  if (operation === "edit" || operation === "write") {
    if (file && (file.additions > 0 || file.deletions > 0)) {
      const counts = `+${file.additions} -${file.deletions}`;
      return `${operation === "edit" ? "Edited" : "Wrote"} ${name ?? "file"} ${file.truncated ? `${counts} (partial)` : counts}`;
    }
    return `${operation === "edit" ? "Edited" : "Wrote"} ${name ?? "file"}`;
  }
  if (operation === "command") {
    const command =
      (typeof params.command === "string" && params.command) ||
      (typeof params.cmd === "string" && params.cmd) ||
      (typeof params.script === "string" && params.script);
    return command ? `Ran ${command}` : `Ran ${tool}`;
  }
  return tool || "Used tool";
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function durationForTurn(startedAtMs?: number, completedAtMs?: number, nowMs = Date.now()): number {
  if (startedAtMs == null || !Number.isFinite(startedAtMs)) return 0;
  const end = completedAtMs != null && Number.isFinite(completedAtMs) ? completedAtMs : nowMs;
  return Math.max(0, end - startedAtMs);
}

export function sessionWorkedMs(
  messages: Array<{ role: string; tool?: string; turnId?: string; startedAtMs?: number; completedAtMs?: number }>,
  nowMs = Date.now(),
): number {
  const turns = new Map<string, { startedAtMs?: number; completedAtMs?: number }>();
  for (const message of messages) {
    if (!isTurnMarker(message) || !message.turnId) continue;
    const current = turns.get(message.turnId);
    turns.set(message.turnId, {
      startedAtMs:
        current?.startedAtMs == null
          ? message.startedAtMs
          : message.startedAtMs == null
            ? current.startedAtMs
            : Math.min(current.startedAtMs, message.startedAtMs),
      completedAtMs:
        current?.completedAtMs == null
          ? message.completedAtMs
          : message.completedAtMs == null
            ? current.completedAtMs
            : Math.max(current.completedAtMs, message.completedAtMs),
    });
  }
  let total = 0;
  for (const turn of turns.values()) total += durationForTurn(turn.startedAtMs, turn.completedAtMs, nowMs);
  return total;
}
