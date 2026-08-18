import { useEffect, useState } from "react";
import { Repeat, Square } from "lucide-react";
import { formatDuration } from "../../lib/activity";

/** The `/loop` run in flight, as much of it as the composer needs to show. */
export interface ActiveLoopRun {
  objective: string;
  startedAtMs: number;
  /** Set by `/loop <interval> <goal>`: the wait between checks, e.g. `15m`. */
  every?: string | null;
}

function RunStatusPillBody({ loop, onStop }: { loop: ActiveLoopRun; onStop: () => void }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The ticker lives here, not in the panel: a state update one level up would
  // re-render the whole transcript once a second for a label this small.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = formatDuration(Math.max(0, nowMs - loop.startedAtMs), "clock");
  return (
    <div
      data-run-status-pill
      data-run-mode="loop"
      className="mb-2 flex min-w-0 items-center gap-2 rounded-full border border-line bg-surface-1 py-1 pl-2.5 pr-1 text-[11px] text-ink-subtle"
    >
      <Repeat aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" strokeWidth={1.7} />
      <span className="shrink-0 font-medium text-ink">Loop</span>
      {/* A watch is a different thing from a run-to-done loop; the pill has to
          say which one is up there. */}
      {loop.every ? <span className="shrink-0 tabular-nums text-ink-faint">every {loop.every}</span> : null}
      <span className="min-w-0 flex-1 truncate">{loop.objective}</span>
      <span className="shrink-0 tabular-nums text-ink-faint">{elapsed}</span>
      <button
        type="button"
        aria-label="Stop loop"
        onClick={onStop}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink active:bg-surface-3"
      >
        <Square aria-hidden className="h-3 w-3" strokeWidth={1.7} />
      </button>
    </div>
  );
}

/**
 * What is running right now, above the composer: objective, live elapsed time,
 * and the way to stop it after its start line scrolls away.
 */
export function RunStatusPill({
  loop,
  onStop,
}: {
  loop: ActiveLoopRun | null;
  onStop: () => void;
}) {
  // Unmounting rather than hiding is what stops the interval when idle.
  if (!loop) return null;
  return <RunStatusPillBody loop={loop} onStop={onStop} />;
}
