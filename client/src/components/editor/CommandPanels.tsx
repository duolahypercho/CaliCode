// Readouts for the commands whose answer is structured data rather than prose:
// `/help` is a reference list, `/usage` is a capacity reading. Both used to
// arrive as a wall of bullet lines in the transcript.
//
// Neither is a chart. `/help` is identity — a list, and a list is the right
// form for it. `/usage` is one magnitude against a capacity, which is a meter
// plus a hero number, not a plot. The only colour carrying meaning is the
// over-threshold state, and it never travels alone: the state is spelled out
// in words beside the bar, so the reading survives greyscale and CVD.

import { Zap } from "lucide-react";
import type { CommandPanel } from "../../lib/types";

const compact = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${Math.round(value / 1_000)}k`
      : String(value);

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-surface-2 px-2.5 py-2">
      <div className="text-[9.5px] uppercase tracking-[0.14em] text-ink-faint">{label}</div>
      <div className="mt-1 truncate font-mono text-[13px] leading-none text-ink-strong">{value}</div>
      {hint ? <div className="mt-1 truncate text-[10.5px] text-ink-subtle">{hint}</div> : null}
    </div>
  );
}

function UsagePanel(panel: Extract<CommandPanel, { kind: "usage" }>) {
  const {
    contextWindow,
    lastPromptTokens,
    lastCacheReadTokens,
    autoCompactAt,
    promptTokens,
    completionTokens,
    cacheReadTokens,
    totalTokens,
  } = panel;
  const ratio = contextWindow > 0 ? lastPromptTokens / contextWindow : 0;
  const percent = Math.round(ratio * 100);
  // The bar is clamped so an over-full context still renders a full bar rather
  // than overflowing its track; the number beside it keeps the real figure.
  const filled = Math.max(ratio > 0 ? 1.5 : 0, Math.min(100, ratio * 100));
  const over = autoCompactAt !== null && ratio >= autoCompactAt;
  const cached = Math.min(lastPromptTokens, lastCacheReadTokens);
  const cachePercent = lastPromptTokens > 0 ? Math.round((cached / lastPromptTokens) * 100) : 0;

  return (
    <div className="max-w-[420px] rounded-lg border border-line bg-raised p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] uppercase tracking-[0.16em] text-ink-subtle">Context</span>
        <span className="text-[10.5px] text-ink-subtle">
          {compact(lastPromptTokens)} / {compact(contextWindow)}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-2.5">
        <span className="font-mono text-[22px] leading-none text-ink-strong">{percent}%</span>
        {/* The track carries the capacity, so it needs its own contrast against
            the card: surface-3 and raised are three shades apart in dark, which
            made the unfilled remainder vanish entirely. */}
        <div
          role="progressbar"
          aria-label="Context used"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${percent}% of the context window`}
          className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-line-strong"
        >
          <div
            className={`h-full rounded-full ${over ? "bg-danger-soft" : "bg-ink-strong"}`}
            style={{ width: `${filled}%` }}
          />
          {autoCompactAt !== null && autoCompactAt < 1 ? (
            // The threshold sits on the track as a notch cut out of the fill,
            // so it reads at a glance whether the bar has passed it.
            <div
              className="absolute inset-y-0 w-[2px] bg-raised"
              style={{ left: `${Math.min(100, autoCompactAt * 100)}%` }}
            />
          ) : null}
        </div>
      </div>

      {/* State in words, never colour alone. */}
      <div className="mt-1.5 text-[10.5px] text-ink-subtle">
        {autoCompactAt === null
          ? "Auto-compaction is off"
          : over
            ? `Over the ${Math.round(autoCompactAt * 100)}% auto-compaction mark — the next turn compacts`
            : `Auto-compacts at ${Math.round(autoCompactAt * 100)}%`}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1.5">
        <StatTile label="Prompt" value={compact(promptTokens)} />
        <StatTile label="Output" value={compact(completionTokens)} />
        <StatTile label="Total" value={compact(totalTokens)} />
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-ink-subtle">
        <Zap size={12} strokeWidth={1.7} aria-hidden />
        <span>
          {compact(cacheReadTokens)} cached this session · {cachePercent}% of the last prompt reused
        </span>
      </div>
    </div>
  );
}

function HelpPanel({ commands }: Extract<CommandPanel, { kind: "help" }>) {
  const builtins = commands.filter((command) => !command.skill);
  const skills = commands.filter((command) => command.skill);
  const groups: { title: string; rows: typeof commands }[] = [
    { title: "Commands", rows: builtins },
    ...(skills.length > 0 ? [{ title: "Skills", rows: skills }] : []),
  ];

  return (
    <div className="max-w-[520px] rounded-lg border border-line bg-raised p-1.5">
      {groups.map((group) => (
        <div key={group.title} className="mb-1 last:mb-0">
          <div className="px-2 py-1.5 text-[9.5px] uppercase tracking-[0.16em] text-ink-faint">
            {group.title}
          </div>
          {group.rows.map((command) => (
            <div
              key={command.name}
              className="flex items-baseline gap-2 rounded-md px-2 py-1 hover:bg-surface-2"
            >
              <span className="shrink-0 font-mono text-[12px] text-ink-strong">/{command.name}</span>
              {command.usage ? (
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">{command.usage}</span>
              ) : null}
              {/* Wraps rather than truncates: this panel exists to say what a
                  command does, so an elided summary is the one thing it must
                  not do. Left-aligned for the same reason — right-aligning tidies
                  the one-line built-ins but gives a skill's paragraph a ragged
                  left edge, and the long descriptions are exactly the ones a
                  reader needs to get through. */}
              <span className="min-w-0 flex-1 text-[11.5px] text-ink-subtle">{command.summary}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Renders a command readout, or null for a kind this client does not know. */
export function CommandPanelView({ panel }: { panel: CommandPanel }) {
  if (panel.kind === "usage") return <UsagePanel {...panel} />;
  if (panel.kind === "help") return <HelpPanel {...panel} />;
  return null;
}
