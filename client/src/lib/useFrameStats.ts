import { useEffect, useState } from "react";
import type { PieRuntime } from "./pie";

export interface FrameStats {
  fps: number;
  frameMs: number;
  /** Real WebGL draw calls for the last frame; null when idle. */
  drawCalls: number | null;
}

const SAMPLE_MS = 500;

/**
 * Samples the runtime's own frame counter on a wall-clock interval.
 * Reporting a measured rate matters more than reporting a pretty one — a
 * hardcoded 60 would hide exactly the stalls this readout exists to surface.
 */
export function useFrameStats(runtime: PieRuntime | null, running: boolean): FrameStats {
  const [stats, setStats] = useState<FrameStats>({ fps: 0, frameMs: 0, drawCalls: null });

  useEffect(() => {
    if (!runtime || !running) {
      setStats({ fps: 0, frameMs: 0, drawCalls: null });
      return;
    }

    let lastFrames = runtime.frames;
    let lastAt = performance.now();

    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - lastAt;
      const drawn = runtime.frames - lastFrames;
      lastFrames = runtime.frames;
      lastAt = now;

      if (elapsed <= 0) return;
      const fps = (drawn * 1000) / elapsed;
      setStats({
        fps: Math.round(fps),
        frameMs: drawn > 0 ? elapsed / drawn : 0,
        // The DRAW readout used to be entities.length, which is not a draw
        // call count and duplicated the ENTITIES cell beside it.
        drawCalls: runtime.drawCalls,
      });
    }, SAMPLE_MS);

    return () => window.clearInterval(timer);
  }, [runtime, running]);

  return stats;
}
