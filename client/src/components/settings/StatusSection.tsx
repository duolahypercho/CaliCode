import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "../ui/button";
import { currentCoreStatus, rpc } from "../../lib/rpc";
import type { ModelUsageRow, UsageStats } from "../../lib/types";
import { ActivityGrid, CacheHitTrend, CompositionBar, compactNumber } from "./UsageCharts";

/**
 * Settings → Status: what each model has actually cost, and how much of its
 * prompt came back as a cache read.
 *
 * The numbers are core's, not this component's. Totals and hit rates are
 * computed in the ledger and rendered verbatim so the page can never disagree
 * with core's own arithmetic — this file only formats.
 *
 * Composition is a spec sheet rather than a dashboard: numbered sections, one
 * headline figure per section, dotted leaders instead of boxed stat tiles. The
 * intent is that this page not read as a generic usage dashboard, while the
 * tokens, radii and type scale stay inside the design system.
 */

/** Thousands separators, because six-digit token counts are unreadable raw. */
const NUMBER = new Intl.NumberFormat();

function formatTokens(value: number): string {
  return NUMBER.format(value);
}

/**
 * Hit rate as a whole percent. `null` means the model has never been sent a
 * prompt — rendered as a dash rather than 0%, which would read as a cache
 * that is failing rather than one that has not been asked yet.
 */
function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function formatSince(since: number): string {
  if (!since) return "—";
  return new Date(since * 1000).toLocaleString();
}

/**
 * Every rate renders at full strength; only an absent one recedes.
 *
 * A brightness gradient was tried and is wrong here: it dimmed the low rates,
 * so the one model whose cache was failing became the faintest text on a page
 * whose entire purpose is spotting exactly that.
 */
function rateTone(rate: number | null): string {
  return rate === null ? "text-ink-faint" : "text-ink-strong";
}

/**
 * `rpc` rejects for two different reasons, and they need different words.
 *
 * A transport failure means core is not answering at all. A JSON-RPC error
 * means core answered and refused — an older core without `usage_stats`, or a
 * ledger it could not read — and blaming the network there hides the one
 * message that says why. `rpc.ts` already draws that line and publishes it, so
 * read it rather than inferring an outage from any rejection.
 */
function describeFailure(error: unknown): string {
  if (currentCoreStatus() === "offline") {
    return "Core is unavailable, so usage cannot be read right now.";
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Core answered, but the usage ledger could not be read. ${detail}`;
}

/**
 * Section headers are a numeral, a title, and a rule that runs out to the
 * section's own controls — a drawing sheet's caption rather than the uppercase
 * micro-label every settings dashboard uses. The numeral is decorative: it is
 * outside the `<h2>` so the accessible name stays the bare title, which is what
 * the specs address these regions by.
 */
function PanelHeader({
  index,
  id,
  title,
  aside,
}: {
  index: string;
  id: string;
  title: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden className="font-mono text-[10px] leading-none tabular-nums text-ink-faint">
        {index}
      </span>
      <h2 id={id} className="shrink-0 text-[12.5px] font-medium text-ink-strong">
        {title}
      </h2>
      <span aria-hidden className="h-px min-w-3 flex-1 bg-line" />
      {aside}
    </div>
  );
}

/** A label, a dotted leader, a figure. */
function LedgerRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="shrink-0 text-[12px] text-ink-subtle">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-baseline gap-2">
        <span aria-hidden className="min-w-2 flex-1 border-b border-dotted border-line-strong" />
        <span className={`shrink-0 font-mono text-[12.5px] tabular-nums ${tone ?? "text-ink-strong"}`}>{value}</span>
      </dd>
    </div>
  );
}

function UsageRow({ row, rank }: { row: ModelUsageRow; rank: number }) {
  const rate = row.cacheHitRate;
  return (
    <tr className="border-t border-line">
      <th scope="row" className="max-w-[210px] px-3.5 py-2.5 text-left font-normal">
        <span className="flex items-baseline gap-2">
          <span aria-hidden className="font-mono text-[10px] tabular-nums text-ink-faint">
            {String(rank).padStart(2, "0")}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] text-ink-strong" title={row.model}>
              {row.model}
            </span>
            <span className="block truncate font-mono text-[10px] text-ink-faint" title={row.provider}>
              {row.provider}
            </span>
          </span>
        </span>
      </th>
      <td className="px-3 py-2.5">
        <span className="flex items-center justify-end gap-2">
          {/* The bar is a second reading of the same number, not new data: a
              column of percentages does not show which cache is failing until
              you compare them, and a track does that at a glance.

              A never-called model gets no track at all. An empty one is
              pixel-identical to a failing cache, which is the single
              distinction this column exists to make. */}
          {rate === null ? null : (
            <span aria-hidden className="hidden h-1 w-9 shrink-0 overflow-hidden rounded-[1px] bg-surface-3 sm:block">
              <span className="block h-full bg-ink-strong" style={{ width: `${Math.max(2, rate * 100)}%` }} />
            </span>
          )}
          <span className={`font-mono text-[12px] tabular-nums ${rateTone(rate)}`}>{formatRate(rate)}</span>
        </span>
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
        {formatTokens(row.cacheReadTokens)}
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
        {formatTokens(row.promptTokens)}
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
        {formatTokens(row.completionTokens)}
      </td>
      <td className="px-3.5 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-subtle">
        {formatTokens(row.requests)}
      </td>
    </tr>
  );
}

export function StatusSection() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "offline">("loading");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStats(await rpc<UsageStats>("usage_stats"));
      setState("ready");
      setFailure("");
    } catch (error) {
      setStats(null);
      setState("offline");
      setFailure(describeFailure(error));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void rpc<UsageStats>("usage_stats")
      .then((result) => {
        if (cancelled) return;
        setStats(result);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStats(null);
        setState("offline");
        setFailure(describeFailure(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reset = useCallback(async () => {
    setBusy(true);
    try {
      setStats(await rpc<UsageStats>("usage_reset"));
      setState("ready");
      setFailure("");
    } catch (error) {
      setState("offline");
      setFailure(describeFailure(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  // Busiest model first: the one dominating spend is the one worth reading.
  const rows = useMemo(
    () => [...(stats?.models ?? [])].sort((a, b) => b.totalTokens - a.totalTokens),
    [stats],
  );
  const totals = stats?.totals;
  const activity = stats?.activity;
  // Nothing has been read yet, so every figure is a dash. Zeros here would be a
  // claim — "you have spent nothing" — that the page cannot yet make.
  const lifetime = stats ? compactNumber.format(totals?.totalTokens ?? 0) : "—";

  return (
    <div className="space-y-7">
      <section aria-labelledby="settings-usage-heading">
        <PanelHeader
          index="01"
          id="settings-usage-heading"
          title="Token usage"
          aside={
            <div className="flex shrink-0 items-center gap-1.5">
              <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} disabled={busy}>
                <RefreshCw aria-hidden size={13} strokeWidth={1.7} />
                Refresh
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => void reset()} disabled={busy}>
                <RotateCcw aria-hidden size={13} strokeWidth={1.7} />
                Reset
              </Button>
            </div>
          }
        />

        {state === "offline" ? (
          <p role="status" className="mt-3 text-[13px] leading-relaxed text-ink-subtle">
            {failure}
          </p>
        ) : (
          <>
            <div className="mt-3 overflow-hidden rounded-[5px] border border-line bg-surface-1">
              <div className="grid sm:grid-cols-[1fr_minmax(0,15rem)]">
                <div className="px-4 py-4">
                  <p className="flex items-baseline gap-2">
                    <span className="font-display text-[38px] font-bold leading-none tabular-nums text-ink-strong">
                      {lifetime}
                    </span>
                    <span className="font-mono text-[11px] text-ink-faint">tokens</span>
                  </p>
                  <p className="mt-2.5 max-w-sm text-[12px] leading-relaxed text-ink-subtle">
                    Counted across every session since {formatSince(stats?.since ?? 0)}, and kept across restarts. Only
                    tokens the provider reported are counted.
                  </p>
                </div>
                <dl className="space-y-2 border-t border-line px-4 py-4 sm:border-l sm:border-t-0">
                  <LedgerRow
                    label="Cache hit"
                    value={formatRate(totals?.cacheHitRate ?? null)}
                    tone={rateTone(totals?.cacheHitRate ?? null)}
                  />
                  <LedgerRow label="Model calls" value={stats ? formatTokens(totals?.requests ?? 0) : "—"} />
                  <LedgerRow label="Active days" value={stats ? formatTokens(activity?.activeDays ?? 0) : "—"} />
                  <LedgerRow
                    label="Streak"
                    value={activity?.currentStreak ? `${activity.currentStreak}d` : "—"}
                    tone={activity?.currentStreak ? undefined : "text-ink-faint"}
                  />
                </dl>
              </div>
              <div className="border-t border-line px-4 py-3.5">
                <CompositionBar totals={totals} />
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-subtle">
              &ldquo;Billed prompt&rdquo; counts only tokens billed at full price; cache reads and writes are separate,
              so the three sum to the real prompt size. A cache write counts against the hit rate — it is the miss that
              paid to populate the cache.
            </p>
          </>
        )}
      </section>

      {state !== "offline" && (
        <section aria-labelledby="settings-activity-heading">
          <PanelHeader
            index="02"
            id="settings-activity-heading"
            title="Token activity"
            aside={
              activity?.busiestDay ? (
                <p className="shrink-0 text-[11px] text-ink-faint">
                  Busiest {activity.busiestDay.date} · {compactNumber.format(activity.busiestDay.totalTokens)} tokens
                </p>
              ) : undefined
            }
          />
          <ActivityGrid days={stats?.days ?? []} today={stats?.today ?? ""} />
        </section>
      )}

      {state !== "offline" && (
        <section aria-labelledby="settings-trend-heading">
          <PanelHeader index="03" id="settings-trend-heading" title="Cache hit rate over time" />
          <CacheHitTrend days={stats?.days ?? []} />
        </section>
      )}

      {state !== "offline" && (
        <section aria-labelledby="settings-per-model-heading">
          <PanelHeader
            index="04"
            id="settings-per-model-heading"
            title="Per model"
            aside={
              rows.length > 0 ? (
                <p className="shrink-0 text-[11px] text-ink-faint">
                  {rows.length} {rows.length === 1 ? "model" : "models"}
                </p>
              ) : undefined
            }
          />
          {rows.length === 0 ? (
            <div className="mt-3 flex items-start gap-3 rounded-[5px] border border-line bg-surface-1 px-3.5 py-3.5">
              <Activity aria-hidden size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-faint" />
              <div>
                <p className="text-[13px] text-ink-strong">
                  {state === "loading" ? "Reading usage…" : "No model calls recorded yet"}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
                  Totals appear here once an agent turn completes and the provider reports its token usage.
                </p>
              </div>
            </div>
          ) : (
            <div className="mt-3 overflow-x-auto rounded-[5px] border border-line bg-surface-1">
              <table className="w-full min-w-[520px] border-collapse text-left">
                <caption className="sr-only">Token usage and cache hit rate per model</caption>
                <thead>
                  <tr className="border-b border-line-strong text-[10.5px] text-ink-faint">
                    <th scope="col" className="px-3.5 py-2 font-normal">
                      Model
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Cache hit
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Cache reads
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Billed prompt
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-normal">
                      Output
                    </th>
                    <th scope="col" className="px-3.5 py-2 text-right font-normal">
                      Calls
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <UsageRow key={row.key} row={row} rank={index + 1} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
