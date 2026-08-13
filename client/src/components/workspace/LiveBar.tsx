import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { LogEntry } from "../editor/ConsolePanel";
import type { PieState } from "../../lib/pie";

export interface LiveStats {
  fps: number;
  frameMs: number;
  /** three.js render.info.render.calls, or null when the renderer is idle. */
  drawCalls: number | null;
  entities: number;
  /** Wall-clock duration of the initial project load RPC. Not a build. */
  loadMs: number | null;
}

interface LiveBarProps {
  stats: LiveStats;
  pieState: PieState;
  logs: LogEntry[];
}

/**
 * Bottom status strip plus a collapsible console, matching the design's
 * LIVE row (build/fps/signal chips) over a stats + log split panel.
 */
export function LiveBar({ stats, pieState, logs }: LiveBarProps) {
  const [open, setOpen] = useState(false);
  const [backgrounded, setBackgrounded] = useState(() => document.visibilityState === "hidden");

  useEffect(() => {
    const updateVisibility = () => setBackgrounded(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  // This console is the only place a failed autosave is written down, and it
  // ships collapsed. Opening it on the session's first error means a user does
  // not have to already suspect something broke in order to find out that it
  // did; after that it stays under their control.
  const errorCount = logs.reduce((total, log) => total + (log.level === "error" ? 1 : 0), 0);
  const autoOpened = useRef(false);
  useEffect(() => {
    if (errorCount === 0 || autoOpened.current) return;
    autoOpened.current = true;
    setOpen(true);
  }, [errorCount]);

  // Browsers intentionally throttle requestAnimationFrame in background tabs.
  // Calling the resulting zero sample "RUNNING" looked like a game stall even
  // though the runtime resumed normally as soon as the editor was foregrounded.
  const signal = pieState === "running" && backgrounded ? "BACKGROUND" : pieState.toUpperCase();

  const chips = [
    // Labelled LOAD, not BUILD. This is the duration of the initial
    // project_open RPC — there is no build step, and calling it one implied a
    // pipeline that does not exist.
    { k: "LOAD", v: stats.loadMs === null ? "pending" : `${(stats.loadMs / 1000).toFixed(1)}s` },
    { k: "FPS", v: String(stats.fps) },
    { k: "SIG", v: signal },
  ];

  const statCells = [
    { k: "FPS", v: String(stats.fps) },
    { k: "FRAME", v: `${stats.frameMs.toFixed(1)}ms` },
    { k: "DRAW", v: stats.drawCalls === null ? "—" : String(stats.drawCalls) },
    { k: "ENTITIES", v: String(stats.entities) },
  ];

  return (
    <div className="shrink-0 border-t border-line bg-surface-0">
      <div className="flex h-10 items-center gap-2.5 px-3.5">
        <span className="calicode-label shrink-0">Live</span>
        {/* data-live-stats: masked in visual snapshots. fps, frame time and
            load time are measured, so they differ on every run. */}
        <div data-live-stats className="flex min-w-0 gap-2 overflow-x-auto">
          {chips.map((chip) => (
            <span
              key={chip.k}
              className="shrink-0 rounded border border-line px-2.5 py-[3px] text-[10.5px] text-ink-faint"
            >
              <span className="font-bold text-ink-subtle">{chip.k}</span> {chip.v}
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          // Only labelled when there is a count to announce; otherwise the
          // button's own text is the name.
          aria-label={errorCount > 0 ? `CONSOLE, ${errorCount} error${errorCount === 1 ? "" : "s"}` : undefined}
          className="ml-auto inline-flex min-h-[28px] shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 py-[5px] text-[10px] tracking-[0.14em] text-ink-subtle transition-colors hover:text-ink active:bg-surface-3"
        >
          <span>CONSOLE</span>
          {errorCount > 0 ? (
            <span
              aria-hidden
              data-console-errors
              className="inline-flex min-w-[15px] items-center justify-center rounded-full border border-danger-soft/40 bg-danger-soft/15 px-1 py-px text-[9px] font-bold tracking-normal tabular-nums text-danger-soft"
            >
              {errorCount}
            </span>
          ) : null}
          {open ? (
            <ChevronDown aria-hidden className="h-3 w-3" strokeWidth={1.7} />
          ) : (
            <ChevronRight aria-hidden className="h-3 w-3" strokeWidth={1.7} />
          )}
        </button>
      </div>
      {open ? (
        <div className="flex h-[88px] gap-6 overflow-hidden border-t border-line px-3.5 py-2.5">
          <div data-live-stats className="flex shrink-0 flex-wrap gap-5">
            {statCells.map((cell) => (
              <span key={cell.k} className="inline-flex flex-col gap-[3px]">
                <span className="text-[9px] tracking-[0.16em] text-ink-subtle">{cell.k}</span>
                <span className="text-sm text-ink">{cell.v}</span>
              </span>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto border-l border-line pl-5 text-[11px] leading-[1.7]">
            {logs.length === 0 ? (
              <p className="text-ink-subtle">No output yet.</p>
            ) : (
              logs.slice(-40).reverse().map((log) => (
                <div key={log.id} className={log.level === "error" ? "text-danger-soft" : "text-ink-subtle"}>
                  ▸ {log.message}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
