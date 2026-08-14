// Restore points for unattended runs.
//
// Core gives us exactly two primitives: `project_checkpoint` copies the project
// directory and returns `{ id }`, and `project_revert` copies one back. There
// is no RPC that lists checkpoints and none that deletes one, so the ids this
// panel creates are remembered here — a restore point nobody can name is not a
// restore point. The same gap means retention below can only bound the *list*;
// bounding the bytes on disk needs a core method that does not exist yet.

export type AutoCheckpointReason = "loop" | "goal";

export interface AutoCheckpoint {
  /** Core's checkpoint id, e.g. `cp-1723600000000`. */
  id: string;
  takenAtMs: number;
  reason: AutoCheckpointReason;
  /** The loop/goal objective this checkpoint was taken in front of. */
  objective: string;
}

/**
 * How long an automatic checkpoint stays fresh enough to skip taking another.
 *
 * Each one is a full copy of the project directory, and a three-day `/loop`
 * would otherwise take hundreds. Fifteen minutes bounds the work a single
 * destructive turn can cost to roughly one iteration while keeping a 72-hour
 * run near 288 copies — already more than anyone wants, which is why the
 * interval sits here rather than at one or five minutes.
 */
export const AUTO_CHECKPOINT_INTERVAL_MS = 15 * 60_000;

/** Automatic restore points remembered per game. Older ids are forgotten. */
export const AUTO_CHECKPOINT_KEEP = 10;

/** Objective text kept beside an id, so the list stays one line per entry. */
const OBJECTIVE_CHARS = 60;

const STORAGE_KEY = "calicode-auto-checkpoints";

type Registry = Record<string, AutoCheckpoint[]>;

function isReason(value: unknown): value is AutoCheckpointReason {
  return value === "loop" || value === "goal";
}

function toEntry(value: unknown): AutoCheckpoint | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.takenAtMs !== "number" || !Number.isFinite(record.takenAtMs)) return null;
  if (!isReason(record.reason)) return null;
  return {
    id: record.id,
    takenAtMs: record.takenAtMs,
    reason: record.reason,
    objective: typeof record.objective === "string" ? record.objective : "",
  };
}

function readRegistry(): Registry {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const registry: Registry = {};
    for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      registry[slug] = value.flatMap((item) => {
        const entry = toEntry(item);
        return entry ? [entry] : [];
      });
    }
    return registry;
  } catch {
    return {};
  }
}

function writeRegistry(registry: Registry): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
  } catch {
    // A full or disabled localStorage must not break a run: the checkpoint
    // itself already exists on disk, only the name for it is lost.
  }
}

/** Newest first, capped at `AUTO_CHECKPOINT_KEEP`. */
export function pruneAutoCheckpoints(entries: readonly AutoCheckpoint[]): AutoCheckpoint[] {
  return [...entries].sort((left, right) => right.takenAtMs - left.takenAtMs).slice(0, AUTO_CHECKPOINT_KEEP);
}

export function readAutoCheckpoints(slug: string): AutoCheckpoint[] {
  return pruneAutoCheckpoints(readRegistry()[slug] ?? []);
}

export function recordAutoCheckpoint(slug: string, entry: AutoCheckpoint): AutoCheckpoint[] {
  const registry = readRegistry();
  const kept = pruneAutoCheckpoints([entry, ...(registry[slug] ?? []).filter((item) => item.id !== entry.id)]);
  registry[slug] = kept;
  writeRegistry(registry);
  return kept;
}

/** Test seam: drops every remembered id for every game. */
export function clearAutoCheckpoints(): void {
  writeRegistry({});
}

/** True when no checkpoint has been taken inside the throttle window. */
export function dueForCheckpoint(lastAtMs: number | null, nowMs: number): boolean {
  if (lastAtMs === null) return true;
  return nowMs - lastAtMs >= AUTO_CHECKPOINT_INTERVAL_MS;
}

/**
 * When a checkpoint was taken, read from its own id.
 *
 * Core mints ids as `cp-<epoch millis>` with a `-<n>` suffix on collision, so
 * an id the user pasted from somewhere else — an agent-made checkpoint, say —
 * still carries an age even though this panel never recorded it.
 */
export function checkpointTakenAtMs(id: string): number | null {
  const match = /^cp-(\d+)(?:-\d+)?$/.exec(id);
  if (!match) return null;
  const millis = Number(match[1]);
  return Number.isFinite(millis) && millis > 0 ? millis : null;
}

export function formatCheckpointAge(ageMs: number): string {
  if (ageMs < 60_000) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function objectiveOf(entry: AutoCheckpoint): string {
  const trimmed = entry.objective.trim();
  if (!trimmed) return "";
  return trimmed.length > OBJECTIVE_CHARS ? `${trimmed.slice(0, OBJECTIVE_CHARS)}…` : trimmed;
}

export function formatCheckpointList(entries: readonly AutoCheckpoint[], nowMs: number): string {
  if (entries.length === 0) {
    return [
      "No restore points recorded yet.",
      "One is taken automatically before the first /loop iteration and the first /goal round, then at most one every 15 minutes.",
    ].join("\n");
  }
  const lines = entries.map((entry) => {
    const age = formatCheckpointAge(Math.max(0, nowMs - entry.takenAtMs));
    const objective = objectiveOf(entry);
    return `• ${entry.id} — ${age}, before a /${entry.reason} turn${objective ? ` (${objective})` : ""}`;
  });
  return [
    "Restore points, newest first:",
    ...lines,
    "/restore <id> shows what it would overwrite; /restore <id> confirm applies it.",
  ].join("\n");
}

export interface RestoreRequest {
  id: string;
  confirmed: boolean;
}

/** `/restore <id>` and `/restore <id> confirm`; anything else is a usage error. */
export function parseRestoreArgs(args: string): RestoreRequest | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  const [id, keyword] = parts;
  if (parts.length === 2 && keyword.toLowerCase() !== "confirm") return null;
  return { id, confirmed: parts.length === 2 };
}

/** Which mechanism took a restore point, as core reports it on `kind`. */
export type CheckpointKind = "git" | "project";

/**
 * What `/restore` actually replaces, named in full.
 *
 * The two mechanisms cover opposite halves, so the confirmation has to say
 * which one this id is. A `project` checkpoint re-copies `project.json`,
 * `scripts`, `assets`, `tests`, `baselines` and `thumbnails` under the project
 * directory and never touches an attached workspace — which is where
 * `file_write` and `file_edit` land whenever a game has one. A `git` restore
 * point is the mirror image: it returns the attached repository's *tracked*
 * files to the snapshot without moving HEAD or the branch, and says nothing
 * about the CaliCode project document or anything untracked.
 *
 * Either way the user is told what survives, rather than being left to assume
 * a restore point covers everything.
 */
export function restoreWarning(
  id: string,
  age: string | null,
  hasWorkspace: boolean,
  kind: CheckpointKind = "project",
): string {
  const when = age ? ` saved ${age}` : "";
  if (kind === "git") {
    return [
      `/restore ${id} will return the attached folder's tracked files to the snapshot${when}.`,
      "Everything changed in them since then is deleted, and this cannot be undone from here.",
      "HEAD and your branch do not move, so commits made since the restore point stay in the history.",
      "It does NOT restore untracked files, and it does NOT restore this game's project.json, scripts/, assets/, tests/, baselines/ or thumbnails/.",
      `Send /restore ${id} confirm to go ahead.`,
    ].join("\n");
  }
  const lines = [
    `/restore ${id} will overwrite this game's project.json, scripts/, assets/, tests/, baselines/ and thumbnails/ with the copies${when}.`,
    "Everything changed in those since then is deleted, and this cannot be undone from here.",
  ];
  if (hasWorkspace) {
    lines.push(
      "It does NOT restore the attached workspace folder, which is where the agent's file edits go — those files stay exactly as they are.",
    );
  }
  lines.push(`Send /restore ${id} confirm to go ahead.`);
  return lines.join("\n");
}
