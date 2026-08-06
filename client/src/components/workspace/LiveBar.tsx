import { useState } from "react";
import type { LogEntry } from "../editor/ConsolePanel";
import type { PieState } from "../../lib/pie";

export interface LiveStats {
  fps: number;
  frameMs: number;
  /** three.js render.info.render.calls, or null when the renderer is idle. */
  drawCalls: number | null;
  entities: number;
  buildMs: number | null;
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

  const chips = [
    { k: "BUILD", v: stats.buildMs === null ? "pending" : `ok · ${(stats.buildMs / 1000).toFixed(1)}s` },
    { k: "FPS", v: String(stats.fps) },
    { k: "SIG", v: pieState.toUpperCase() },
  ];

  const statCells = [
    { k: "FPS", v: String(stats.fps) },
    { k: "FRAME", v: `${stats.frameMs.toFixed(1)}ms` },
    { k: "DRAW", v: stats.drawCalls === null ? "—" : String(stats.drawCalls) },
    { k: "ENTITIES", v: String(stats.entities) },
  ];

  return (
    <div className="shrink-0 border-t border-white/[0.06] bg-[#0a0a0a]">
      <div className="flex h-10 items-center gap-2.5 px-3.5">
        <span className="calicode-label shrink-0">Live</span>
        <div className="flex min-w-0 gap-2 overflow-x-auto">
          {chips.map((chip) => (
            <span
              key={chip.k}
              className="shrink-0 rounded border border-white/[0.07] px-2.5 py-[3px] text-[10.5px] text-[#7a7a7a]"
            >
              <span className="font-bold text-[#a6a6a6]">{chip.k}</span> {chip.v}
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="ml-auto shrink-0 rounded-md border border-white/10 px-2.5 py-[5px] text-[10px] tracking-[0.14em] text-[#8f8f8f] hover:border-white/25 hover:text-[#c0c0c0]"
        >
          CONSOLE {open ? "▾" : "▸"}
        </button>
      </div>
      {open ? (
        <div className="flex h-[88px] gap-6 overflow-hidden border-t border-white/[0.06] px-3.5 py-2.5">
          <div className="flex shrink-0 flex-wrap gap-5">
            {statCells.map((cell) => (
              <span key={cell.k} className="inline-flex flex-col gap-[3px]">
                <span className="text-[9px] tracking-[0.16em] text-[#8a8a8a]">{cell.k}</span>
                <span className="text-sm text-[#c0c0c0]">{cell.v}</span>
              </span>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto border-l border-white/[0.06] pl-5 text-[11px] leading-[1.7]">
            {logs.length === 0 ? (
              <p className="text-[#8a8a8a]">No output yet.</p>
            ) : (
              logs.slice(-40).reverse().map((log) => (
                <div key={log.id} className={log.level === "error" ? "text-[#c98b8b]" : "text-[#949494]"}>
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
