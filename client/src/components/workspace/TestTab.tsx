import { useMemo } from "react";
import { Filmstrip } from "../editor/Filmstrip";
import type { CapturedFrame, TestResult } from "../../lib/types";

interface TestTabProps {
  results: TestResult[];
  frames: CapturedFrame[];
  running: boolean;
  canRun: boolean;
  onRun: () => void;
  onFixAll: (issues: Issue[]) => void;
}

export interface Issue {
  id: string;
  severity: "HIGH" | "MED" | "LOW";
  title: string;
  description: string;
  repro: string;
}

/** Severity reads off the theme tokens so the tint tracks light and dark, and so HIGH outranks MED. */
const SEVERITY_TINT: Record<Issue["severity"], string> = {
  HIGH: "var(--danger-soft)",
  MED: "var(--ink)",
  LOW: "var(--ink-subtle)",
};

/**
 * Playtest surface plus the issues panel from the design.
 *
 * Issues are derived from real test results, never mocked. Severity follows
 * what actually failed: a thrown error outranks a visual-baseline drift,
 * which outranks a test that merely failed its assertions.
 */
export function TestTab({ results, frames, running, canRun, onRun, onFixAll }: TestTabProps) {
  const issues = useMemo(() => toIssues(results), [results]);
  const passed = results.length - results.filter((result) => !result.pass).length;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-5">
        <div className="mb-3">
          <div className="calicode-label mb-1.5">CaliCode Playtest</div>
          <p className="text-[13px] text-ink">
            {results.length === 0
              ? "No runs yet — run the suite to collect frames and issues."
              : `${passed}/${results.length} passing · ${frames.length} frames captured.`}
          </p>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-[repeating-linear-gradient(115deg,var(--surface-1),var(--surface-1)_12px,var(--surface-2)_12px,var(--surface-2)_24px)]">
          {frames.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
              <button
                type="button"
                onClick={onRun}
                disabled={!canRun || running}
                className="flex h-[52px] w-[52px] items-center justify-center rounded-full border border-line-strong text-lg text-ink transition-colors active:border-ink-subtle disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Run playtest"
              >
                ▶
              </button>
              <span className="text-[11px] tracking-[0.06em] text-ink-subtle">
                {running ? "RUNNING PLAYTEST…" : canRun ? "RUN A PLAYTEST" : "RUNTIME NOT READY"}
              </span>
            </div>
          ) : (
            <div className="min-h-0 flex-1">
              <Filmstrip frames={frames} />
            </div>
          )}
          <div className="h-1 shrink-0 bg-surface-3">
            <div
              className="h-full w-full origin-left bg-ink-subtle transition-transform duration-300"
              style={{ transform: `scaleX(${results.length === 0 ? 0 : passed / results.length})` }}
            />
          </div>
        </div>
      </div>

      <div className="flex min-h-0 w-[388px] shrink-0 flex-col border-l border-line bg-surface-0">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-[18px] py-[15px]">
          <span className="text-[11px] font-bold tracking-[0.16em] text-ink-strong">ISSUES FOUND</span>
          <button
            type="button"
            onClick={() => onFixAll(issues)}
            disabled={issues.length === 0}
            className="ml-auto inline-flex min-h-[28px] items-center rounded-md border border-line-strong bg-secondary px-3 py-1.5 text-[11px] font-bold tracking-[0.1em] text-ink-strong transition-colors enabled:hover:bg-secondary/80 active:bg-secondary/70 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {issues.length === 0 ? "NOTHING TO FIX" : `FIX ALL ${issues.length}`}
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3.5">
          {issues.length === 0 ? (
            <p className="text-xs text-ink-subtle">
              {results.length === 0 ? "Run a playtest to surface issues." : "All tests passed."}
            </p>
          ) : (
            issues.map((issue) => (
              <div
                key={issue.id}
                style={{ borderLeftColor: SEVERITY_TINT[issue.severity] }}
                className="rounded-lg border border-l-2 border-line bg-surface-1 px-3.5 py-3"
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <span
                    style={{ color: SEVERITY_TINT[issue.severity], borderColor: SEVERITY_TINT[issue.severity] }}
                    className="rounded border px-1.5 py-px text-[9.5px] font-bold tracking-[0.1em]"
                  >
                    {issue.severity}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-ink-strong">{issue.title}</span>
                </div>
                <p className="mb-2 whitespace-pre-wrap text-xs leading-[1.55] text-ink-subtle">{issue.description}</p>
                <p className="rounded-[5px] border border-line px-2.5 py-1.5 text-[11px] text-ink-subtle">
                  {issue.repro}
                </p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** Maps failed tests onto the issue shape the panel renders. */
export function toIssues(results: TestResult[]): Issue[] {
  return results
    .filter((result) => !result.pass)
    .map((result) => {
      const drifted = result.baselineDistance !== undefined && result.baselineDistance > 0;
      const severity: Issue["severity"] = result.error ? "HIGH" : drifted ? "MED" : "LOW";
      return {
        id: result.id,
        severity,
        title: result.name,
        description:
          result.error ??
          (drifted
            ? `Visual baseline drifted by ${result.baselineDistance}.`
            : "Assertions did not pass; no error was thrown."),
        repro: result.logs.length > 0 ? result.logs[result.logs.length - 1] : `test ${result.id}`,
      };
    })
    .sort((a, b) => rank(a.severity) - rank(b.severity));
}

function rank(severity: Issue["severity"]): number {
  return severity === "HIGH" ? 0 : severity === "MED" ? 1 : 2;
}
