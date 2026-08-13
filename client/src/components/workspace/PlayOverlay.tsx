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
      {/* Vignette mixed from --surface-0 so it fades the viewport edges into the
          page in either theme, instead of laying a black frame over light. */}
      <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_160px_40px_color-mix(in_srgb,var(--surface-0)_85%,transparent)]" />

      <div className="absolute left-3.5 top-3.5 inline-flex items-center gap-2.5 rounded-md border border-line bg-surface-0/80 px-3 py-1.5 text-[10.5px] tracking-[0.14em] text-ink backdrop-blur">
        <span
          className={`h-1.5 w-1.5 ${running ? "animate-pulse bg-ink" : "bg-ink-subtle"}`}
          aria-hidden
        />
        {pieState.toUpperCase()}
        <span className="text-ink-subtle">·</span>
        <span className="text-ink-subtle">{hint}</span>
      </div>

      <div className="absolute right-3 top-3 flex gap-1.5">
        <button
          type="button"
          onClick={onTogglePlay}
          className="h-8 min-w-[44px] rounded-md border border-line-strong bg-surface-0/80 px-3 text-[10px] tracking-[0.12em] text-ink-strong backdrop-blur transition-colors active:border-ink-faint"
        >
          {running ? "PAUSE" : "PLAY"}
        </button>
        <button
          type="button"
          onClick={onReset}
          className="h-8 min-w-[44px] rounded-md border border-line-strong bg-surface-0/80 px-3 text-[10px] tracking-[0.12em] text-ink-strong backdrop-blur transition-colors active:border-ink-faint"
        >
          RESET
        </button>
      </div>

      <div className="absolute bottom-3.5 left-3.5 flex max-w-[70%] flex-wrap items-center gap-2">
        <span className="text-[10px] tracking-[0.12em] text-ink-subtle">TWEAK LIVE</span>
        {pins.map((pin) => {
          const active = pin.id === activePin;
          return (
            <button
              key={pin.id}
              type="button"
              onClick={() => onTogglePin(pin.id)}
              aria-pressed={active}
              className={`inline-flex min-h-[28px] items-center rounded border border-line-strong px-2.5 py-[5px] text-[10px] font-bold tracking-[0.1em] backdrop-blur transition-colors ${
                active
                  ? "bg-ink-strong text-surface-0 active:bg-ink"
                  : "bg-surface-0/80 text-ink active:border-ink-faint"
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
