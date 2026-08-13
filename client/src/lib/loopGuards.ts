// Runaway detection for `/loop`. An iteration counter alone cannot separate a
// loop that is working from one retrying the same failing call, so the count is
// paired with two cheap signals — identical repeated actions and repeated
// failures — and the cap ends in a handoff rather than a hard stop.

export interface LoopAction {
  /** Tool name, or a stable label for the step. */
  tool: string;
  /** Stable signature of the arguments — the caller stringifies. */
  signature: string;
  /** Did the step fail? */
  failed?: boolean;
}

export interface StallVerdict {
  /** "ok" | "warn" | "block" */
  level: "ok" | "warn" | "block";
  /** Human sentence naming what is repeating; empty when level is "ok". */
  reason: string;
}

const DEFAULT_WARN_AFTER = 2;
const DEFAULT_BLOCK_AFTER = 5;

const OK: StallVerdict = { level: "ok", reason: "" };

function severity(level: StallVerdict["level"]): number {
  return level === "block" ? 2 : level === "warn" ? 1 : 0;
}

function levelForRun(run: number, warnAfter: number, blockAfter: number): StallVerdict["level"] {
  if (run >= blockAfter) return "block";
  if (run >= warnAfter) return "warn";
  return "ok";
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * Repeated identical actions and repeated failures across recent iterations.
 *
 * Only the run at the tail counts: a false positive kills a healthy loop, which
 * is far worse than letting one extra repeat through, so anything varied —
 * including a repeat that has since been broken by a different action — stays
 * "ok".
 */
export function detectStall(
  actions: LoopAction[],
  options?: { warnAfter?: number; blockAfter?: number },
): StallVerdict {
  // A run of one is just an action, so thresholds below 2 are meaningless and
  // would flag every loop on its first step.
  const warnAfter = Math.max(2, Math.floor(options?.warnAfter ?? DEFAULT_WARN_AFTER));
  const blockAfter = Math.max(warnAfter, Math.floor(options?.blockAfter ?? DEFAULT_BLOCK_AFTER));
  if (!actions.length) return OK;

  const last = actions[actions.length - 1];
  let repeats = 1;
  for (let index = actions.length - 2; index >= 0; index -= 1) {
    const action = actions[index];
    if (action.tool !== last.tool || action.signature !== last.signature) break;
    repeats += 1;
  }

  let failures = 0;
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    if (!actions[index].failed) break;
    failures += 1;
  }

  const repeatLevel = levelForRun(repeats, warnAfter, blockAfter);
  const failureLevel = levelForRun(failures, warnAfter, blockAfter);
  if (severity(repeatLevel) >= severity(failureLevel)) {
    if (repeatLevel === "ok") return OK;
    return {
      level: repeatLevel,
      reason: `Ran the same \`${last.tool}\` call with identical arguments ${plural(repeats, "time")} in a row.`,
    };
  }
  return {
    level: failureLevel,
    reason: `The last ${plural(failures, "step")} all failed, most recently \`${last.tool}\`.`,
  };
}

/** Remaining-budget line so the model can pace itself and wrap up deliberately. */
export function budgetNotice(iteration: number, cap: number): string {
  const total = Math.max(0, Math.floor(cap));
  const used = Math.min(total, Math.max(0, Math.floor(iteration)));
  const remaining = total - used;
  if (remaining <= 0) {
    return `Budget: iteration ${used} of ${total} — none remaining. Finish and summarise now.`;
  }
  return `Budget: iteration ${used} of ${total} — ${plural(remaining, "iteration")} remaining. Pace the work so it lands inside that budget.`;
}

/** The final, tools-stripped instruction when a loop runs out of budget. */
export function exhaustionPrompt(goal: string, iterations: number): string {
  const used = Math.max(0, Math.floor(iterations));
  return [
    `The iteration budget is spent after ${plural(used, "iteration")} and the goal is not confirmed done.`,
    `Goal: ${goal.trim()}`,
    "Stop calling tools. Reply with a handoff: what you accomplished, what still remains, and the exact next step to take.",
  ].join("\n");
}
