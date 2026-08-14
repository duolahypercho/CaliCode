// Interval arguments for `/loop`, spelled the way every other harness spells
// them: `/loop <interval> <prompt>`, the interval first and a unit always
// attached (`30s`, `15m`, `2h`). Claude Code's `/loop 15m run the test suite`
// is the shape people already have in their fingers, so this parses that.
//
// A bare number is deliberately NOT an interval: `/loop 3 failing tests to
// fix` is a goal, and guessing minutes there would silently park the loop.

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/** `15m` → 900000. Null when the token is not an interval. */
export function parseInterval(token: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)$/i.exec(token.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * UNIT_MS[match[2].toLowerCase()]);
}

/** `900000` → `15m`. Used in the transcript lines the loop prints. */
export function formatInterval(ms: number): string {
  if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h}h`;
  if (ms % UNIT_MS.m === 0) return `${ms / UNIT_MS.m}m`;
  return `${Math.round(ms / UNIT_MS.s)}s`;
}

export interface LoopArgs {
  /** Milliseconds between iterations, or null to let the loop run flat out. */
  intervalMs: number | null;
  goal: string;
}

/**
 * Split `/loop` arguments into an optional leading interval and the goal.
 *
 * The interval only counts in first position, so a goal that happens to
 * contain `30s` keeps it.
 */
export function parseLoopArgs(args: string): LoopArgs {
  const trimmed = args.trim();
  const match = /^(\S+)\s+([\s\S]+)$/.exec(trimmed);
  if (!match) return { intervalMs: null, goal: trimmed };
  const intervalMs = parseInterval(match[1]);
  return intervalMs === null ? { intervalMs: null, goal: trimmed } : { intervalMs, goal: match[2].trim() };
}
