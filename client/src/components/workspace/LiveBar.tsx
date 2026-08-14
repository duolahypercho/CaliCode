import { useEffect, useState } from "react";
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
}

/**
 * Bottom status strip plus a collapsible console, matching the design's
 * LIVE row (build/fps/signal chips) over a stats + log split panel.
 */
export function LiveBar({ stats, pieState }: LiveBarProps) {
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
      </div>
    </div>
  );
}
