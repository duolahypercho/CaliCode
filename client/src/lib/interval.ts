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

/**
 * How much process a loop imposes on its goal.
 *
 * `standard` replays the goal verbatim and takes the agent's DONE at its word,
 * which is what every other harness's loop does and what most goals want.
 * `aaa` is CaliCode's own thing: a mandated task graph — three dependency-free
 * specialist build roots, an integration build, a terminal judge — plus PIE
 * captures, persisted frames, and a durable report that must clear a score
 * threshold before DONE is believed.
 *
 * The pipeline is the stronger machine, and it used to be the *only* one, which
 * is the problem it caused: "fix the typo in the README" was answered with a
 * three-specialist graph and a demand for three screenshots. A quality bar that
 * cannot be declined is not a quality bar, it is a tax.
 */
export type LoopProfile = "standard" | "aaa";

export const DEFAULT_LOOP_PROFILE: LoopProfile = "standard";

/** `--aaa` / `--standard`, accepted only in leading position. */
const PROFILE_FLAGS: Record<string, LoopProfile> = {
  "--aaa": "aaa",
  "--standard": "standard",
};

export interface LoopArgs {
  /** Milliseconds between iterations, or null to let the loop run flat out. */
  intervalMs: number | null;
  profile: LoopProfile;
  goal: string;
}

/**
 * Split `/loop` arguments into optional leading flags and the goal.
 *
 * Both the profile flag and the interval only count in leading position, in
 * either order, so a goal that happens to contain `30s` or the word `--aaa`
 * keeps them.
 */
export function parseLoopArgs(args: string): LoopArgs {
  let rest = args.trim();
  let intervalMs: number | null = null;
  let profile: LoopProfile = DEFAULT_LOOP_PROFILE;
  // Loop rather than a fixed order: `--aaa 15m goal` and `15m --aaa goal` are
  // the same request, and making one of them silently park the loop on the
  // goal "--aaa" would be a nasty way to learn the order.
  for (;;) {
    const match = /^(\S+)\s+([\s\S]+)$/.exec(rest);
    if (!match) break;
    const [, head, tail] = match;
    const flagged = PROFILE_FLAGS[head.toLowerCase()];
    if (flagged) {
      profile = flagged;
      rest = tail.trim();
      continue;
    }
    if (intervalMs === null) {
      const parsed = parseInterval(head);
      if (parsed !== null) {
        intervalMs = parsed;
        rest = tail.trim();
        continue;
      }
    }
    break;
  }
  return { intervalMs, profile, goal: rest };
}
