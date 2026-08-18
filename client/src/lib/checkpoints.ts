// Restore-point presentation and confirmation for unattended `/loop` runs.
// Core owns creation, inventory, pruning, and restoration; keeping inventory
// server-side means a loop remains recoverable after a reload or in another
// window.

export interface ListedCheckpoint {
  id: string;
  kind: "git" | "project";
  createdAtMs: number;
}

/**
 * When a checkpoint was taken, read from its own id.
 *
 * Core mints ids as `cp-<epoch millis>` with a `-<n>` suffix on collision, so
 * an id the user pasted from somewhere else — an agent-made checkpoint, say —
 * still carries an age even though this panel never recorded it.
 */
export function checkpointTakenAtMs(id: string): number | null {
  const match = /^(?:cp|git)-(\d+)(?:-\d+)?$/.exec(id);
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

export function formatCheckpointList(entries: readonly ListedCheckpoint[], nowMs: number): string {
  if (entries.length === 0) {
    return [
      "No restore points exist yet.",
      "A /loop takes one before its first iteration, then at most one every 15 minutes.",
    ].join("\n");
  }
  const lines = entries.map((entry) => {
    const age = formatCheckpointAge(Math.max(0, nowMs - entry.createdAtMs));
    const kind = entry.kind === "git" ? "git snapshot" : "project snapshot";
    return `• ${entry.id} — ${age}, ${kind}`;
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
