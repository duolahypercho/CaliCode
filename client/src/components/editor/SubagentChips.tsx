import { Loader2 } from "lucide-react";

/** One spawned worker: a graph node or a directly spawned subagent. */
export interface SubagentChipItem {
  /** Stable key — the graph node id or the tool call id. */
  id: string;
  title: string;
  status: "pending" | "running" | "done" | "failed";
}

interface SubagentChipsProps {
  items: SubagentChipItem[];
  /** Trailing plain-text status, e.g. "started working". */
  note?: string;
}

/**
 * Chips are keyed by identity, not by position, so a worker keeps its colour
 * as siblings come and go. Hue only — saturation and lightness stay fixed so
 * every chip reads as the same weight of accent in both themes.
 */
function hueFor(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) % 360;
  return hash;
}

const STATUS_LABEL: Record<SubagentChipItem["status"], string> = {
  pending: "queued",
  running: "started working",
  done: "updated",
  failed: "failed",
};

/**
 * Spawned workers as a row of pills above a turn's actions, so a fan-out is
 * visible as it happens rather than only in the graph panel. Failed workers
 * keep their chip — a run that died is the thing you most need to see.
 */
export function SubagentChips({ items, note }: SubagentChipsProps) {
  if (items.length === 0) return null;
  const trailing = note ?? STATUS_LABEL[items.at(-1)?.status ?? "running"];
  return (
    <div data-subagent-chips className="flex w-full max-w-[94%] flex-wrap items-center gap-2 self-start">
      {items.map((item) => (
        <span
          key={item.id}
          data-subagent-chip={item.id}
          title={item.title}
          className={`inline-flex min-w-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[12.5px] ${
            item.status === "failed" ? "border-danger-soft/40 text-danger-soft" : "border-line text-ink-subtle"
          }`}
        >
          {item.status === "running" ? (
            <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin" strokeWidth={2} />
          ) : (
            <span
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 rounded-full"
              style={{
                background: `conic-gradient(from 0deg, hsl(${hueFor(item.id)} 70% 62%), hsl(${
                  (hueFor(item.id) + 60) % 360
                } 70% 62%), hsl(${hueFor(item.id)} 70% 62%))`,
                opacity: item.status === "pending" ? 0.45 : 1,
              }}
            />
          )}
          <span className="min-w-0 max-w-[180px] truncate">{item.title}</span>
        </span>
      ))}
      <span className="text-[12.5px] text-ink-faint">{trailing}</span>
    </div>
  );
}
