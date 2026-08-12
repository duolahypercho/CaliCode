import { Film } from "lucide-react";
import type { CapturedFrame } from "../../lib/types";

export function Filmstrip({ frames }: { frames: CapturedFrame[] }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Film className="h-4 w-4 text-muted-foreground" />
        <span className="text-[11px] font-bold tracking-[0.16em] text-ink-strong">Filmstrip</span>
        <span className="text-xs text-ink-subtle">{frames.length} frames</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {frames.length === 0 ? (
          <p className="text-xs text-muted-foreground">No frames captured yet. Run PIE to capture every 3rd or 4th frame.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {frames.map((frame) => (
              <figure key={frame.frame} className="overflow-hidden rounded-md border border-border">
                <img src={frame.dataUrl} alt={`Frame ${frame.frame}`} className="aspect-square w-full object-cover" />
                <figcaption className="border-t border-border bg-muted px-1.5 py-1 text-xs text-muted-foreground">
                  Frame {frame.frame} · {Math.round(frame.timeMs)} ms
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
