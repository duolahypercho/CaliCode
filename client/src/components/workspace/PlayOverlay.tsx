import type { PieState } from "../../lib/pie";

export interface TweakPin {
  id: string;
  label: string;
}

interface PlayOverlayProps {
  pieState: PieState;
  hint: string;
  pins: TweakPin[];
  activePin: string | null;
  onTogglePin: (id: string) => void;
  onTogglePlay: () => void;
  onReset: () => void;
}

/**
 * Non-interactive-by-default chrome layered over the PIE viewport:
 * run indicator, transport controls, and the live-tweak pin row.
 */
export function PlayOverlay({
  pieState,
  hint,
  pins,
  activePin,
  onTogglePin,
  onTogglePlay,
  onReset,
}: PlayOverlayProps) {
  const running = pieState === "running";

  return (
    <>
      <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_160px_40px_rgba(0,0,0,0.85)]" />

      <div className="absolute left-3.5 top-3.5 inline-flex items-center gap-2.5 rounded-md border border-white/10 bg-black/50 px-3 py-1.5 text-[10.5px] tracking-[0.14em] text-[#c0c0c0] backdrop-blur">
        <span
          className={`h-1.5 w-1.5 ${running ? "animate-pulse bg-[#bdbdbd]" : "bg-[#8a8a8a]"}`}
          aria-hidden
        />
        {pieState.toUpperCase()}
        <span className="text-[#8a8a8a]">·</span>
        <span className="text-[#828282]">{hint}</span>
      </div>

      <div className="absolute right-3 top-3 flex gap-1.5">
        <button
          type="button"
          onClick={onTogglePlay}
          className="h-8 min-w-[44px] rounded-md border border-white/[0.12] bg-black/50 px-3 text-[10px] tracking-[0.12em] text-[#d4d4d4] backdrop-blur transition-colors active:border-white/50 focus-visible:outline-none"
        >
          {running ? "PAUSE" : "PLAY"}
        </button>
        <button
          type="button"
          onClick={onReset}
          className="h-8 min-w-[44px] rounded-md border border-white/[0.12] bg-black/50 px-3 text-[10px] tracking-[0.12em] text-[#d4d4d4] backdrop-blur transition-colors active:border-white/50 focus-visible:outline-none"
        >
          RESET
        </button>
      </div>

      <div className="absolute bottom-3.5 left-3.5 flex max-w-[70%] flex-wrap items-center gap-2">
        <span className="text-[10px] tracking-[0.12em] text-[#8a8a8a]">TWEAK LIVE</span>
        {pins.map((pin) => {
          const active = pin.id === activePin;
          return (
            <button
              key={pin.id}
              type="button"
              onClick={() => onTogglePin(pin.id)}
              aria-pressed={active}
              className={`inline-flex min-h-[28px] items-center rounded border border-white/[0.14] px-2.5 py-[5px] text-[10px] font-bold tracking-[0.1em] backdrop-blur transition-colors focus-visible:outline-none ${
                active
                  ? "bg-[#c6c6c6] text-[#0a0a0a] active:bg-[#b4b4b4]"
                  : "bg-black/50 text-[#c6c6c6] active:border-white/50"
              }`}
            >
              {pin.label}
            </button>
          );
        })}
      </div>
    </>
  );
}
