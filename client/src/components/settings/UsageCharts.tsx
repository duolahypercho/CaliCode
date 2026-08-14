import { useMemo } from "react";
import type { UsageDay, UsageStats } from "../../lib/types";

/**
 * The three instruments on Settings → Status: a composition bar for the
 * lifetime totals, a year-long day grid, and a cache-hit trend line.
 *
 * All plain DOM and inline SVG. No chart library: the shapes are simple, and a
 * dependency that ships its own colour scale would have to be fought back into
 * the monochrome palette anyway.
 *
 * Weight is opacity over `bg-ink-strong`, never a colour ramp. The palette is
 * deliberately monochrome (`index.css` has no accent token), and opacity reads
 * correctly in both themes: ink is near-black on light and near-white on dark,
 * so heavier means more of whatever is being measured either way.
 */

const DAY_MS = 86_400_000;
const WEEKS = 53;

/** `YYYY-MM-DD` → days since epoch. Parsed as UTC so the arithmetic cannot
 *  drift across a DST boundary; the keys are already core-local dates. */
function toDayNumber(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(utc) ? null : Math.round(utc / DAY_MS);
}

function toDate(day: number): Date {
  return new Date(day * DAY_MS);
}

function formatDay(day: number): string {
  return toDate(day).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const COMPACT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const PLAIN = new Intl.NumberFormat();

/**
 * Quartile thresholds over the active days only.
 *
 * Scaling to the maximum instead would let one outlier day flatten a year of
 * real work into the lowest bucket — the failure mode that makes a heatmap
 * look empty on exactly the accounts that used it most.
 */
function thresholds(values: number[]): number[] {
  const sorted = [...values].filter((value) => value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return [0, 0, 0, 0];
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return [at(0.25), at(0.5), at(0.75), at(0.95)];
}

function levelFor(value: number, steps: number[]): number {
  if (value <= 0) return 0;
  if (value <= steps[0]) return 1;
  if (value <= steps[1]) return 2;
  if (value <= steps[2]) return 3;
  return 4;
}

/** Level 0 is a drawn empty cell, not a hole — the grid must stay legible. */
function cellClass(level: number): string {
  return level === 0 ? "bg-surface-2" : "bg-ink-strong";
}

/**
 * Level 1 starts well clear of zero. At 0.22 it sat close enough to the empty
 * cell's `surface-2` that a light day and an idle day were hard to tell apart
 * on the dark theme, which is most of the grid's information.
 */
const LEVEL_OPACITY = [1, 0.34, 0.55, 0.78, 1];

/**
 * How a lifetime prompt divides up, cheapest slice first.
 *
 * The order is the point: cache reads on the left at the lightest weight,
 * full-price prompt and output on the right at full weight, so the bar is read
 * left-to-right as increasing cost rather than as four unrelated categories.
 */
const COMPOSITION = [
  { key: "read", label: "Cache reads", opacity: 0.24, of: (t: Totals) => t.cacheReadTokens },
  { key: "write", label: "Cache writes", opacity: 0.5, of: (t: Totals) => t.cacheWriteTokens },
  { key: "prompt", label: "Billed prompt", opacity: 0.76, of: (t: Totals) => t.promptTokens },
  { key: "output", label: "Output", opacity: 1, of: (t: Totals) => t.completionTokens },
] as const;

type Totals = UsageStats["totals"];

export function CompositionBar({ totals }: { totals: Totals | undefined }) {
  const parts = COMPOSITION.map((part) => ({
    ...part,
    value: totals ? part.of(totals) : 0,
  }));
  const sum = parts.reduce((carry, part) => carry + part.value, 0);

  return (
    <div>
      <div className="flex h-2 gap-px overflow-hidden rounded-[2px] bg-surface-2">
        {sum > 0
          ? parts
              .filter((part) => part.value > 0)
              .map((part) => (
                <span
                  key={part.key}
                  className="bg-ink-strong"
                  // Floored so a slice worth a fraction of a percent still draws
                  // a mark instead of collapsing into the neighbouring segment.
                  style={{ width: `${(part.value / sum) * 100}%`, minWidth: 2, opacity: part.opacity }}
                  title={`${part.label} — ${PLAIN.format(part.value)} tokens`}
                />
              ))
          : null}
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5">
        {parts.map((part) => (
          <li key={part.key} className="flex items-center gap-1.5 text-[11px] text-ink-subtle">
            <span aria-hidden className="h-2 w-2 rounded-[1px] bg-ink-strong" style={{ opacity: part.opacity }} />
            {part.label}
            <span className="font-mono text-[11px] tabular-nums text-ink">{COMPACT.format(part.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A year of days as a seven-row grid, one cell per day, weight by tokens.
 *
 * A continuous tape was tried here and is wrong: filling the panel width put
 * every day under 2px, so a cell could be seen but not pointed at, and the
 * whole point of a per-day view is reading one specific day. A 9px cell is a
 * hover target; a 1.8px column is not.
 */
export function ActivityGrid({ days, today }: { days: UsageDay[]; today: string }) {
  const model = useMemo(() => {
    const end = toDayNumber(today);
    if (end === null) return null;

    const totals = new Map<number, UsageDay>();
    for (const day of days) {
      const number = toDayNumber(day.date);
      if (number !== null) totals.set(number, day);
    }

    // End on the Saturday of the current week so the final column is whole,
    // then walk back a fixed number of weeks. Columns are Sun–Sat.
    const endOfWeek = end + (6 - toDate(end).getUTCDay());
    const start = endOfWeek - WEEKS * 7 + 1;
    const steps = thresholds([...totals.values()].map((day) => day.totalTokens));

    const columns: { day: number; usage: UsageDay | undefined; future: boolean }[][] = [];
    for (let week = 0; week < WEEKS; week += 1) {
      const column = [];
      for (let weekday = 0; weekday < 7; weekday += 1) {
        const day = start + week * 7 + weekday;
        column.push({ day, usage: totals.get(day), future: day > end });
      }
      columns.push(column);
    }

    // A label sits on the first column whose month differs from the previous
    // column's, which is how the months line up with where they actually start.
    const labels = columns.map((column, index) => {
      const month = toDate(column[0].day).getUTCMonth();
      const previous = index === 0 ? null : toDate(columns[index - 1][0].day).getUTCMonth();
      if (month === previous) return null;
      return toDate(column[0].day).toLocaleDateString(undefined, { timeZone: "UTC", month: "short" });
    });

    return { columns, labels, steps, busiest: steps[3], active: totals.size };
  }, [days, today]);

  if (!model) return null;

  // Under two weeks the quartiles collapse onto one or two samples, so
  // "darkest from N" would quote a threshold that is really just the only day
  // recorded. Say how full the grid is instead — which is also what explains
  // the empty year the user is looking at.
  const scale =
    model.active === 0
      ? null
      : model.active < 14
        ? `${model.active} active ${model.active === 1 ? "day" : "days"} so far`
        : `darkest from ${COMPACT.format(model.busiest)} tokens/day`;

  return (
    <>
      <div className="mt-3 overflow-x-auto rounded-[5px] border border-line bg-surface-1 px-3 py-3">
        <div className="min-w-[640px]">
          <div className="flex gap-[3px]">
            {model.columns.map((column, index) => (
              <div key={index} className="flex flex-col gap-[3px]">
                {column.map(({ day, usage, future }) => {
                  const level = levelFor(usage?.totalTokens ?? 0, model.steps);
                  return (
                    <span
                      key={day}
                      className={`h-[9px] w-[9px] rounded-[2px] ${future ? "bg-transparent" : cellClass(level)}`}
                      style={future ? undefined : { opacity: LEVEL_OPACITY[level] }}
                      title={
                        future ? undefined : `${formatDay(day)} — ${PLAIN.format(usage?.totalTokens ?? 0)} tokens`
                      }
                    />
                  );
                })}
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-[3px]">
            {model.labels.map((label, index) => (
              <span key={index} className="w-[9px] shrink-0 text-[10px] text-ink-faint">
                {/* Absolutely positioned so a 3-letter month can overhang its
                    9px column without pushing the grid out of alignment. */}
                {label ? <span className="relative whitespace-nowrap">{label}</span> : null}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[10px] text-ink-faint">
        <span>
          One cell per day, {WEEKS} weeks
          {scale ? ` · ${scale}` : ""}
        </span>
        <span className="flex items-center gap-1.5">
          <span>Less</span>
          {LEVEL_OPACITY.map((opacity, level) => (
            <span
              key={level}
              className={`h-[9px] w-[9px] rounded-[2px] ${cellClass(level)}`}
              style={{ opacity: level === 0 ? 1 : opacity }}
            />
          ))}
          <span>More</span>
        </span>
      </div>
    </>
  );
}

/** 100% sits at 6 and 0% at 94, so a flat line at either extreme keeps its
 *  full stroke inside the plot instead of being sliced by the edge. */
function plotY(rate: number): number {
  return 6 + (1 - rate) * 88;
}

/**
 * Cache hit rate over the trailing window, one vertex per active day.
 *
 * Idle days are dropped rather than plotted as 0%: a day with no model calls
 * has no hit rate, and drawing it as zero would invent a cache collapse that
 * never happened.
 */
export function CacheHitTrend({ days, limit = 30 }: { days: UsageDay[]; limit?: number }) {
  const points = useMemo(
    () => days.filter((day) => day.cacheHitRate !== null && day.promptTotal > 0).slice(-limit),
    [days, limit],
  );

  if (points.length < 2) {
    return (
      <p className="mt-3 text-[13px] text-ink-subtle">
        A trend appears once at least two days have model calls.
      </p>
    );
  }

  const last = points.length - 1;
  const average = points.reduce((sum, day) => sum + (day.cacheHitRate ?? 0), 0) / points.length;
  const line = points.map((day, index) => `${index},${plotY(day.cacheHitRate ?? 0)}`).join(" ");

  return (
    <div className="mt-3 rounded-[5px] border border-line bg-surface-1 px-3 pb-2.5 pt-3">
      <div className="flex gap-2">
        <div className="relative h-[88px] w-6 shrink-0">
          {[1, 0.5, 0].map((rate) => (
            <span
              key={rate}
              aria-hidden
              className="absolute right-0 -translate-y-1/2 font-mono text-[9.5px] leading-none tabular-nums text-ink-faint"
              style={{ top: `${plotY(rate)}%` }}
            >
              {rate * 100}
            </span>
          ))}
        </div>
        <div className="relative h-[88px] min-w-0 flex-1">
          {[1, 0.5].map((rate) => (
            <span
              key={rate}
              aria-hidden
              className="absolute inset-x-0 border-t border-dashed border-line-strong"
              style={{ top: `${plotY(rate)}%` }}
            />
          ))}
          <span aria-hidden className="absolute inset-x-0 border-t border-line-strong" style={{ top: `${plotY(0)}%` }} />
          {/* `preserveAspectRatio="none"` stretches one vertex-per-day into the
              panel width; the stroke opts out of that scaling so the line stays
              hairline-thin however many days are plotted. */}
          <svg
            aria-hidden
            viewBox={`0 0 ${last} 100`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible text-ink-strong"
          >
            <polygon points={`0,${plotY(0)} ${line} ${last},${plotY(0)}`} fill="currentColor" opacity="0.1" />
            <polyline
              points={line}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              opacity="0.9"
            />
            <line
              x1="0"
              y1={plotY(average)}
              x2={last}
              y2={plotY(average)}
              stroke="currentColor"
              strokeWidth="1"
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
              opacity="0.4"
            />
          </svg>
          {points.map((day, index) => (
            <span
              key={day.date}
              className="absolute top-0 h-full -translate-x-1/2"
              style={{ left: `${(index / last) * 100}%`, width: `${100 / last}%` }}
              title={`${day.date} — ${Math.round((day.cacheHitRate ?? 0) * 100)}% of ${PLAIN.format(
                day.promptTotal,
              )} prompt tokens`}
            />
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 pl-8 text-[10px] text-ink-faint">
        <span className="font-mono">{points[0].date}</span>
        <span className="text-ink-subtle">
          {Math.round(average * 100)}% average over {points.length} active days
        </span>
        <span className="font-mono">{points[last].date}</span>
      </div>
    </div>
  );
}

export { COMPACT as compactNumber };
