import { useEffect, useState } from "react";
import { Repeat, Square, Target } from "lucide-react";
import { formatDuration } from "../../lib/activity";
import type { GoalState } from "../../lib/goal";

/** The `/loop` run in flight, as much of it as the composer needs to show. */
export interface ActiveLoopRun {
  objective: string;
  startedAtMs: number;
  /** Set by `/loop <interval> <goal>`: the wait between checks, e.g. `15m`. */
  every?: string | null;
}

export type RunMode = "goal" | "loop";

interface ActiveRun {
  mode: RunMode;
  objective: string;
  startedAtMs: number;
  /** A paced loop's interval label; null for everything else. */
  every?: string | null;
  /** Evaluator passes so far; a loop has no equivalent, hence null. */
  checks: number | null;
}

/**
 * A `/goal` cannot be set while a loop runs, so at most one of these is real.
 * The loop still wins if both are somehow present: it is the run that owns the
 * Stop button, and offering to clear a goal would not halt it.
 */
function activeRun(goal: GoalState | null, loop: ActiveLoopRun | null): ActiveRun | null {
  if (loop)
    return {
      mode: "loop",
      objective: loop.objective,
      startedAtMs: loop.startedAtMs,
      every: loop.every ?? null,
      checks: null,
    };
  if (goal) {
    return {
      mode: "goal",
      objective: goal.goal,
      startedAtMs: goal.startedAtMs,
      checks: Math.max(0, Math.floor(goal.evaluations)),
    };
  }
  return null;
}

function RunStatusPillBody({ run, onStop }: { run: ActiveRun; onStop: (mode: RunMode) => void }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The ticker lives here, not in the panel: a state update one level up would
  // re-render the whole transcript once a second for a label this small.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = formatDuration(Math.max(0, nowMs - run.startedAtMs), "clock");
  const Icon = run.mode === "loop" ? Repeat : Target;
  return (
    <div
      data-run-status-pill
      data-run-mode={run.mode}
      className="mb-2 flex min-w-0 items-center gap-2 rounded-full border border-line bg-surface-1 py-1 pl-2.5 pr-1 text-[11px] text-ink-subtle"
    >
      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" strokeWidth={1.7} />
      <span className="shrink-0 font-medium text-ink">{run.mode === "loop" ? "Loop" : "Goal"}</span>
      {/* A watch is a different thing from a run-to-done loop; the pill has to
          say which one is up there. */}
      {run.every ? <span className="shrink-0 tabular-nums text-ink-faint">every {run.every}</span> : null}
      <span className="min-w-0 flex-1 truncate">{run.objective}</span>
      {run.checks != null ? (
        <span className="shrink-0 tabular-nums text-ink-faint">
          {run.checks} {run.checks === 1 ? "check" : "checks"}
        </span>
      ) : null}
      <span className="shrink-0 tabular-nums text-ink-faint">{elapsed}</span>
      <button
        type="button"
        aria-label={run.mode === "loop" ? "Stop loop" : "Clear goal"}
        onClick={() => onStop(run.mode)}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink active:bg-surface-3"
      >
        <Square aria-hidden className="h-3 w-3" strokeWidth={1.7} />
      </button>
    </div>
  );
}

/**
 * What is running right now, above the composer: mode, objective, live
 * elapsed time, and the way to stop it. Without this a `/goal` or `/loop`
 * disappears the moment its start line scrolls out of the transcript.
 */
export function RunStatusPill({
  goal,
  loop,
  onStop,
}: {
  goal: GoalState | null;
  loop: ActiveLoopRun | null;
  onStop: (mode: RunMode) => void;
}) {
  const run = activeRun(goal, loop);
  // Unmounting rather than hiding is what stops the interval when idle.
  if (!run) return null;
  return <RunStatusPillBody run={run} onStop={onStop} />;
}
