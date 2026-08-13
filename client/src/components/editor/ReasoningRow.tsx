import { useEffect, useId, useRef, useState } from "react";
import { Brain, ChevronRight } from "lucide-react";

/** How long a finished block stays open before folding itself away. */
const AUTO_COLLAPSE_MS = 1000;

export interface ReasoningRowProps {
  /** Reasoning text streamed so far. May be empty while the first chunk is pending. */
  text: string;
  /** True while the model is still streaming reasoning for this block. */
  streaming: boolean;
  /** Milliseconds the block took (or has taken so far). */
  durationMs?: number;
  /** Start collapsed regardless of streaming state (used when replaying a saved transcript). */
  defaultCollapsed?: boolean;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * A turn's reasoning as a collapsible block — shimmering while it streams,
 * then labelled with how long it took, with the text under a left rule (the
 * opencode idiom). Opens and closes itself around the stream, but a manual
 * toggle wins from then on: the panel must never fight the reader.
 */
export function ReasoningRow({ text, streaming, durationMs, defaultCollapsed = false }: ReasoningRowProps) {
  const [open, setOpen] = useState(!defaultCollapsed);
  const toggled = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodyId = useId();

  useEffect(() => {
    if (streaming && !defaultCollapsed && !toggled.current) setOpen(true);
  }, [streaming, defaultCollapsed]);

  useEffect(() => {
    if (streaming || toggled.current) return;
    const timer = window.setTimeout(() => {
      if (!toggled.current) setOpen(false);
    }, AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [streaming]);

  // Newest thought first is what a reader wants mid-stream, so pin to the bottom.
  useEffect(() => {
    if (!streaming || !open) return;
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [text, streaming, open]);

  if (!text && !streaming) return null;

  const label = streaming
    ? "Thinking…"
    : durationMs === undefined
      ? "Thought"
      : `Thought for ${formatDuration(durationMs)}`;

  return (
    <section aria-label="Model reasoning" data-role="reasoning" className="w-full max-w-[94%] self-start">
      <button
        type="button"
        onClick={() => {
          toggled.current = true;
          setOpen((current) => !current);
        }}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs transition-colors hover:bg-surface-2 active:bg-surface-3"
      >
        <Brain aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" strokeWidth={1.7} />
        <span
          className={`shrink-0 text-[12px] font-medium ${streaming ? "cb-shimmer" : "text-ink"}`}
        >
          {label}
        </span>
        <ChevronRight
          aria-hidden
          className={`ml-auto h-3 w-3 shrink-0 text-ink-faint transition-transform ${open ? "rotate-90" : ""}`}
          strokeWidth={1.7}
        />
      </button>
      {open && text ? (
        <div
          id={bodyId}
          ref={bodyRef}
          className="ml-[5px] mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap border-l border-line pl-3 text-[12px] leading-[1.65] text-ink-subtle"
        >
          {text}
        </div>
      ) : null}
    </section>
  );
}
