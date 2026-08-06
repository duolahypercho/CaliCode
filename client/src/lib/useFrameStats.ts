import { useEffect, useState } from "react";
import type { PieRuntime } from "./pie";

export interface FrameStats {
  fps: number;
  frameMs: number;
}

const SAMPLE_MS = 500;

/**
 * Samples the runtime's own frame counter on a wall-clock interval.
 * Reporting a measured rate matters more than reporting a pretty one — a
 * hardcoded 60 would hide exactly the stalls this readout exists to surface.
 */
export function useFrameStats(runtime: PieRuntime | null, running: boolean): FrameStats {
  const [stats, setStats] = useState<FrameStats>({ fps: 0, frameMs: 0 });

  useEffect(() => {
    if (!runtime || !running) {
      setStats({ fps: 0, frameMs: 0 });
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
      setStats({ fps: Math.round(fps), frameMs: drawn > 0 ? elapsed / drawn : 0 });
    }, SAMPLE_MS);

    return () => window.clearInterval(timer);
  }, [runtime, running]);

  return stats;
}
