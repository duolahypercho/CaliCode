import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  CircleSlash2,
  Clock3,
  FileCode2,
  FileText,
  Gauge,
  Image as ImageIcon,
  ListChecks,
  RefreshCw,
  RotateCw,
  X,
} from "lucide-react";
import type { CoreConnectionState } from "../../lib/rpc";
import {
  isSafeReportPath,
  listLoopReports,
  openLoopReport,
  preferredLoopReport,
  type LoopEvidence,
  type LoopIteration,
  type LoopReport,
  type LoopReportSummary,
  type LoopStatus,
  type NextIterationMemory,
  type OpenLoopReport,
  type PunchItem,
} from "../../lib/loopReports";

const POLL_MS = 2_000;

interface ReportsTabProps {
  projectSlug: string;
  coreStatus: CoreConnectionState;
  canOpenFiles: boolean;
  workspaceRoot?: string | null;
  onOpenFile: (path: string) => void;
}

type LoadState = "loading" | "ready" | "error";

export function ReportsTab({ projectSlug, coreStatus, canOpenFiles, workspaceRoot, onOpenFile }: ReportsTabProps) {
  const [summaries, setSummaries] = useState<LoopReportSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenLoopReport | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const refresh = useCallback(
    async (showLoading = false) => {
      if (coreStatus === "offline") {
        setLoadState("error");
        setError("CaliCode core is offline. Reports will be available after it reconnects.");
        return;
      }
      if (showLoading) setLoadState("loading");
      try {
        const listed = await listLoopReports(projectSlug);
        const current = selectedIdRef.current;
        const selected = listed.reports.find((report) => report.loopId === current) ?? preferredLoopReport(listed.reports);
        setSummaries(listed.reports);
        setSelectedId(selected?.loopId ?? null);
        if (!selected) {
          setOpened(null);
          setError("");
          setLoadState("ready");
          return;
        }
        const next = await openLoopReport(projectSlug, selected.loopId);
        setOpened(next);
        setError("");
        setLoadState("ready");
      } catch (loadError) {
        setError(describe(loadError));
        setLoadState("error");
      }
    },
    [coreStatus, projectSlug],
  );

  useEffect(() => {
    setSummaries([]);
    setSelectedId(null);
    setOpened(null);
    void refresh(true);
  }, [projectSlug, refresh]);

  const running = opened?.report.status === "running";
  useEffect(() => {
    if (!running || coreStatus === "offline") return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [coreStatus, refresh, running]);

  const chooseReport = async (loopId: string) => {
    if (loopId === selectedId || coreStatus === "offline") return;
    setSelectedId(loopId);
    selectedIdRef.current = loopId;
    setLoadState("loading");
    try {
      const next = await openLoopReport(projectSlug, loopId);
      setOpened(next);
      setError("");
      setLoadState("ready");
    } catch (loadError) {
      setError(describe(loadError));
      setLoadState("error");
    }
  };

  if (loadState === "loading" && !opened) return <ReportSkeleton />;

  if (loadState === "error" && !opened) {
    return (
      <StateMessage
        icon={coreStatus === "offline" ? CircleSlash2 : AlertTriangle}
        title={coreStatus === "offline" ? "Reports are offline" : "Could not load reports"}
        detail={error}
        action={
          coreStatus !== "offline" ? (
            <button type="button" onClick={() => void refresh(true)} className={SECONDARY_BUTTON}>
              <RotateCw aria-hidden className="h-3.5 w-3.5" strokeWidth={1.7} />
              Retry
            </button>
          ) : undefined
        }
      />
    );
  }

  if (!opened) {
    return (
      <StateMessage
        icon={FileText}
        title="No loop reports yet"
        detail="Run /loop in the agent panel. Each build, play, and judge pass will appear here."
      />
    );
  }

  const { report } = opened;
  const canOpenProjectFiles = canOpenFiles && samePath(opened.projectRoot, workspaceRoot);
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-0">
      <header className="shrink-0 border-b border-line bg-surface-0 px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusLabel status={report.status} />
              <span className="font-mono text-[10px] text-ink-faint">{report.loopId}</span>
              {report.status === "running" ? (
                <span className="inline-flex items-center gap-1 text-[10px] text-ink-subtle" aria-label="Updates automatically">
                  <RefreshCw aria-hidden className="h-3 w-3 animate-spin" strokeWidth={1.7} />
                  Live
                </span>
              ) : null}
            </div>
            <h2 className="mt-1.5 text-[15px] font-semibold leading-[1.35] text-ink-strong">{report.objective}</h2>
            <p className="mt-1 text-[11px] text-ink-subtle">
              Started {formatDate(report.startedAtMs)}
              {report.completedAtMs ? `, finished ${formatDate(report.completedAtMs)}` : `, updated ${formatRelative(report.updatedAtMs)}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {summaries.length > 1 ? (
              <label className="relative">
                <span className="sr-only">Open report</span>
                <select
                  aria-label="Open report"
                  value={selectedId ?? report.loopId}
                  onChange={(event) => void chooseReport(event.target.value)}
                  className="h-7 max-w-[180px] appearance-none rounded-md border border-line bg-surface-1 py-1 pl-2.5 pr-7 text-[11px] text-ink"
                >
                  {summaries.map((summary) => (
                    <option key={summary.loopId} value={summary.loopId}>
                      {summaryLabel(summary)}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden className="pointer-events-none absolute right-2 top-2 h-3 w-3 text-ink-faint" strokeWidth={1.7} />
              </label>
            ) : null}
            <button
              type="button"
              onClick={() => void refresh()}
              aria-label="Refresh loop report"
              title="Refresh report"
              className={ICON_BUTTON}
            >
              <RefreshCw aria-hidden className="h-3.5 w-3.5" strokeWidth={1.7} />
            </button>
          </div>
        </div>
        {loadState === "error" ? (
          <p role="alert" className="mt-2 text-[11px] text-danger-soft">
            Could not refresh. Showing the last loaded report. {error}
          </p>
        ) : null}
        <Totals report={report} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        <div className="mx-auto max-w-[760px] space-y-4">
          {report.summary || report.reference ? (
            <section aria-labelledby="report-overview">
              <SectionTitle id="report-overview">Overview</SectionTitle>
              {report.summary ? <p className="whitespace-pre-wrap text-xs leading-[1.6] text-ink">{report.summary}</p> : null}
              {report.reference ? (
                <p className="mt-2 border-l-2 border-line-strong pl-3 text-xs leading-[1.55] text-ink-subtle">
                  Reference: {report.reference}
                </p>
              ) : null}
            </section>
          ) : null}

          {report.punchList.length > 0 || hasMemory(report.nextIterationMemory) ? (
            <section aria-labelledby="report-next-pass" className="rounded-lg border border-line bg-surface-1 p-3.5">
              <SectionTitle id="report-next-pass">Current handoff</SectionTitle>
              <PunchList items={report.punchList} />
              <Memory memory={report.nextIterationMemory} />
            </section>
          ) : null}

          <section aria-labelledby="report-iterations">
            <div className="flex items-center gap-2">
              <SectionTitle id="report-iterations" className="mb-0">Iterations</SectionTitle>
              <span className="font-mono text-[10px] text-ink-faint">{report.iterations.length}</span>
            </div>
            {report.iterations.length === 0 ? (
              <div className="mt-2 rounded-lg border border-line bg-surface-1 px-3.5 py-4 text-xs text-ink-subtle">
                The loop is running. Its first completed pass will appear here.
              </div>
            ) : (
              <div className="mt-2 space-y-2.5">
                {[...report.iterations].reverse().map((iteration, index) => (
                  <IterationDetails
                    key={iteration.iteration}
                    iteration={iteration}
                    projectSlug={projectSlug}
                    openByDefault={index === 0}
                    canOpenFiles={canOpenFiles}
                    onOpenFile={onOpenFile}
                  />
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="report-files">
            <SectionTitle id="report-files">Durable report files</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              {[opened.jsonPath, opened.markdownPath, opened.htmlPath].map((path) => (
                <FileAction key={path} path={path} canOpen={canOpenProjectFiles} onOpen={onOpenFile} />
              ))}
            </div>
            {!canOpenProjectFiles ? (
              <p className="mt-2 text-[11px] text-ink-faint">
                Report files live in CaliCode's project store. They remain available here as structured data.
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

function Totals({ report }: { report: LoopReport }) {
  const { totals } = report;
  return (
    <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2 border-t border-line pt-3 @[540px]:grid-cols-6">
      <Metric label="Iterations" value={String(totals.iterations)} />
      <Metric label="Score" value={totals.latestScorePercent == null ? "-" : `${totals.latestScorePercent}%`} />
      <Metric label="Checks" value={`${totals.checksPassed}/${totals.checksPassed + totals.checksFailed + totals.checksSkipped}`} />
      <Metric label="Agents" value={String(totals.agents)} />
      <Metric label="Files" value={String(totals.filesChanged)} />
      <Metric label="Worked" value={formatDuration(totals.workedDurationMs)} />
    </dl>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[9.5px] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 font-mono text-[11px] font-bold text-ink-strong">{value}</dd>
    </div>
  );
}

interface IterationDetailsProps {
  iteration: LoopIteration;
  projectSlug: string;
  openByDefault: boolean;
  canOpenFiles: boolean;
  onOpenFile: (path: string) => void;
}

function IterationDetails({ iteration, projectSlug, openByDefault, canOpenFiles, onOpenFile }: IterationDetailsProps) {
  const passedChecks = iteration.checks.filter((check) => check.status === "passed").length;
  return (
    <details open={openByDefault} className="group rounded-lg border border-line bg-surface-1">
      <summary className="flex cursor-pointer list-none items-start gap-3 px-3.5 py-3 marker:hidden hover:bg-surface-2">
        <OutcomeIcon outcome={iteration.outcome} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-semibold text-ink-strong">Iteration {iteration.iteration}</span>
            <span className="text-[10px] text-ink-subtle">{iteration.outcome === "needs-work" ? "Needs work" : titleCase(iteration.outcome)}</span>
            <span className="font-mono text-[9.5px] text-ink-faint">{formatDuration(iteration.durationMs)}</span>
          </div>
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[11px] leading-[1.5] text-ink-subtle">{iteration.summary}</p>
        </div>
        <div className="hidden shrink-0 items-center gap-3 text-[9.5px] text-ink-faint @[480px]:flex">
          {iteration.scores.length > 0 ? <span>{scorePercent(iteration)}% score</span> : null}
          {iteration.checks.length > 0 ? <span>{passedChecks}/{iteration.checks.length} checks</span> : null}
          {iteration.agents.length > 0 ? <span>{iteration.agents.length} agents</span> : null}
        </div>
        <ChevronDown aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform group-open:rotate-180" strokeWidth={1.7} />
      </summary>
      <div className="space-y-4 border-t border-line px-3.5 py-3.5">
        <p className="whitespace-pre-wrap text-xs leading-[1.6] text-ink">{iteration.summary}</p>

        {iteration.scores.length > 0 ? (
          <IterationSection icon={Gauge} title="Scores">
            <div className="grid gap-2 @[560px]:grid-cols-2">
              {iteration.scores.map((score) => {
                const passed = score.passThreshold == null || score.score >= score.passThreshold;
                return (
                  <div key={score.criterion} className="rounded-md border border-line bg-surface-0 px-3 py-2.5">
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 text-[11px] font-medium text-ink-strong">{score.criterion}</span>
                      <span className={`font-mono text-xs font-bold ${passed ? "text-ink-strong" : "text-danger-soft"}`}>
                        {score.score}/{score.maximum}
                      </span>
                    </div>
                    {score.passThreshold != null ? (
                      <p className="mt-1 text-[9.5px] text-ink-faint">Pass threshold {score.passThreshold}</p>
                    ) : null}
                    {score.rationale ? <p className="mt-1.5 text-[11px] leading-[1.5] text-ink-subtle">{score.rationale}</p> : null}
                  </div>
                );
              })}
            </div>
          </IterationSection>
        ) : null}

        {iteration.checks.length > 0 ? (
          <IterationSection icon={ListChecks} title="Checks">
            <div className="space-y-1.5">
              {iteration.checks.map((check, index) => (
                <div key={`${check.kind}-${check.name}-${index}`} className="rounded-md border border-line bg-surface-0 px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <ResultIcon result={check.status} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-[11px] font-medium text-ink-strong">{check.name}</span>
                        <span className="text-[9.5px] text-ink-faint">{titleCase(check.kind)}</span>
                        {check.durationMs > 0 ? <span className="font-mono text-[9px] text-ink-faint">{formatDuration(check.durationMs)}</span> : null}
                      </div>
                      {check.command ? <code className="mt-1 block break-all font-mono text-[9.5px] text-ink-subtle">{check.command}</code> : null}
                      {check.details ? <p className="mt-1 text-[11px] leading-[1.5] text-ink-subtle">{check.details}</p> : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </IterationSection>
        ) : null}

        {iteration.agents.length > 0 ? (
          <IterationSection icon={Bot} title="Agent fanout">
            <div className="space-y-1.5">
              {iteration.agents.map((agent, index) => (
                <div key={`${agent.role}-${agent.agentId ?? index}`} className="rounded-md border border-line bg-surface-0 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] font-bold text-ink-strong">{agent.role}</span>
                    {agent.agentId ? <span className="font-mono text-[9px] text-ink-faint">{agent.agentId}</span> : null}
                    <span className="ml-auto text-[9.5px] text-ink-subtle">{titleCase(agent.outcome)}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-ink">{agent.task}</p>
                  {agent.summary ? <p className="mt-1 text-[11px] leading-[1.5] text-ink-subtle">{agent.summary}</p> : null}
                </div>
              ))}
            </div>
          </IterationSection>
        ) : null}

        {iteration.changedFiles.length > 0 ? (
          <IterationSection icon={FileCode2} title="Changed files">
            <div className="flex flex-wrap gap-1.5">
              {iteration.changedFiles.map((file) => (
                <FileAction
                  key={file.path}
                  path={file.path}
                  canOpen={canOpenFiles}
                  onOpen={onOpenFile}
                  additions={file.additions}
                  deletions={file.deletions}
                />
              ))}
            </div>
          </IterationSection>
        ) : null}

        {iteration.evidence.length > 0 ? (
          <IterationSection icon={ImageIcon} title="Evidence">
            <EvidenceGrid
              evidence={iteration.evidence}
              projectSlug={projectSlug}
              canOpenFiles={canOpenFiles}
              onOpenFile={onOpenFile}
            />
          </IterationSection>
        ) : null}

        {iteration.punchList.length > 0 || hasMemory(iteration.nextIterationMemory) ? (
          <IterationSection icon={AlertTriangle} title="Next pass">
            <PunchList items={iteration.punchList} />
            <Memory memory={iteration.nextIterationMemory} />
          </IterationSection>
        ) : null}
      </div>
    </details>
  );
}

/**
 * One line per past loop, so a soak spanning days reads as a trajectory
 * rather than a list of identical objectives: when it ran, how it ended, and
 * how much it moved. `<option>` renders plain text only, so this is a string.
 */
export function summaryLabel(summary: LoopReportSummary): string {
  const when = new Date(summary.startedAtMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const totals = summary.totals;
  const parts = [when, statusText(summary.status), `${totals.iterations} iter`];
  // The score is the trajectory: across a multi-day soak it is the one number
  // that says whether yesterday's work moved the judge.
  if (totals.latestScorePercent != null) parts.push(`${Math.round(totals.latestScorePercent)}%`);
  if (totals.filesChanged > 0) parts.push(`${totals.filesChanged} files`);
  return `${parts.join(" · ")} — ${summary.objective}`;
}

function IterationSection({ icon: Icon, title, children }: { icon: typeof Gauge; title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold text-ink-subtle">
        <Icon aria-hidden className="h-3 w-3" strokeWidth={1.7} />
        {title}
      </h4>
      {children}
    </section>
  );
}

/** Project files are served by core at `/projects/<slug>/<path>`. */
function evidenceImageSrc(projectSlug: string, path: string): string | null {
  if (!isSafeReportPath(path) || !/\.(png|jpe?g|webp|gif)$/i.test(path)) return null;
  return `/projects/${encodeURIComponent(projectSlug)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function EvidenceGrid({
  evidence,
  projectSlug,
  canOpenFiles,
  onOpenFile,
}: {
  evidence: LoopEvidence[];
  projectSlug: string;
  canOpenFiles: boolean;
  onOpenFile: (path: string) => void;
}) {
  return (
    <div className="grid gap-2 @[560px]:grid-cols-2">
      {evidence.map((item, index) => (
        <div key={`${item.kind}-${item.path}-${index}`} className="min-w-0 rounded-md border border-line bg-surface-0 p-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[9.5px] font-semibold text-ink-subtle">{titleCase(item.kind)}</span>
            {item.capturedAtMs ? <span className="ml-auto text-[9px] text-ink-faint">{formatDate(item.capturedAtMs)}</span> : null}
          </div>
          <p className="mt-1 text-[11px] leading-[1.45] text-ink">{item.caption || titleCase(item.kind)}</p>
          <EvidenceThumbnail
            src={evidenceImageSrc(projectSlug, item.path)}
            alt={item.caption || titleCase(item.kind)}
          />
          <FileAction path={item.path} canOpen={canOpenFiles} onOpen={onOpenFile} compact />
        </div>
      ))}
    </div>
  );
}

/**
 * A frame the loop cited is worth more than its filename: the standalone
 * report.html already embeds it, and the whole point of reports living in the
 * editor is seeing the evidence without leaving. A file that no longer exists
 * hides itself rather than leaving a broken tile.
 */
function EvidenceThumbnail({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="mt-2 max-h-40 w-full rounded border border-line bg-surface-1 object-contain"
    />
  );
}

function FileAction({
  path,
  canOpen,
  onOpen,
  suffix,
  additions,
  deletions,
  compact = false,
}: {
  path: string;
  canOpen: boolean;
  onOpen: (path: string) => void;
  suffix?: string;
  additions?: number;
  deletions?: number;
  compact?: boolean;
}) {
  const safe = isSafeReportPath(path);
  const label = path.split("/").at(-1) ?? path;
  return (
    <button
      type="button"
      disabled={!canOpen || !safe}
      onClick={() => onOpen(path)}
      title={canOpen && safe ? `Open ${path} in Code` : path}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-surface-0 text-left text-ink-subtle transition-colors enabled:hover:bg-surface-2 enabled:hover:text-ink-strong disabled:cursor-default disabled:opacity-60 ${
        compact ? "mt-2 px-2 py-1 text-[9.5px]" : "px-2.5 py-1.5 text-[10.5px]"
      }`}
    >
      <FileText aria-hidden className="h-3 w-3 shrink-0" strokeWidth={1.7} />
      <span className="truncate font-mono">{label}</span>
      {additions != null && deletions != null ? (
        <span className="inline-flex shrink-0 gap-1 font-mono text-[9px] tabular-nums">
          <span className="text-success-soft">+{additions}</span>
          <span className="text-danger-soft">-{deletions}</span>
        </span>
      ) : suffix ? (
        <span className="shrink-0 font-mono text-[9px] text-ink-faint">{suffix}</span>
      ) : null}
    </button>
  );
}

function PunchList({ items }: { items: PunchItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {items.map((item, index) => (
        <li key={`${item.priority}-${item.item}-${index}`} className="flex items-start gap-2 text-[11px] leading-[1.5]">
          {item.resolved ? (
            <Check aria-hidden className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" strokeWidth={1.7} />
          ) : (
            <AlertTriangle
              aria-hidden
              className={`mt-0.5 h-3 w-3 shrink-0 ${item.priority === "critical" || item.priority === "high" ? "text-danger-soft" : "text-ink-subtle"}`}
              strokeWidth={1.7}
            />
          )}
          <span className={item.resolved ? "text-ink-faint line-through" : "text-ink"}>
            {item.item}
            {item.source ? <span className="ml-1 text-ink-faint">({item.source})</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Memory({ memory }: { memory: NextIterationMemory }) {
  const groups: [string, string[]][] = [
    ["Observations", memory.observations],
    ["Decisions", memory.decisions],
    ["Risks", memory.risks],
    ["Next actions", memory.nextActions],
  ];
  const visible = groups.filter(([, values]) => values.length > 0);
  if (visible.length === 0) return null;
  return (
    <div className={`${visible.length > 0 ? "mt-3" : ""} grid gap-2 @[560px]:grid-cols-2`}>
      {visible.map(([label, values]) => (
        <div key={label} className="rounded-md border border-line bg-surface-0 px-3 py-2.5">
          <h5 className="text-[9.5px] font-semibold text-ink-subtle">{label}</h5>
          <ul className="mt-1.5 space-y-1 text-[11px] leading-[1.45] text-ink">
            {values.map((value, index) => (
              <li key={`${value}-${index}`}>{value}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function StatusLabel({ status }: { status: LoopStatus }) {
  const classes: Record<LoopStatus, string> = {
    running: "border-line-strong bg-surface-2 text-ink-strong",
    completed: "border-line bg-surface-1 text-ink-strong",
    blocked: "border-danger-soft bg-surface-1 text-danger-soft",
    cancelled: "border-line bg-surface-1 text-ink-faint",
  };
  return <span className={`rounded border px-1.5 py-0.5 text-[9.5px] font-semibold ${classes[status]}`}>{statusText(status)}</span>;
}

function OutcomeIcon({ outcome }: { outcome: LoopIteration["outcome"] }) {
  if (outcome === "passed") return <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ink-strong" strokeWidth={1.7} />;
  if (outcome === "failed") return <X aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-danger-soft" strokeWidth={1.7} />;
  if (outcome === "cancelled") return <CircleSlash2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" strokeWidth={1.7} />;
  return <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.7} />;
}

function ResultIcon({ result }: { result: "passed" | "failed" | "skipped" }) {
  if (result === "passed") return <Check aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-strong" strokeWidth={1.7} />;
  if (result === "failed") return <X aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-soft" strokeWidth={1.7} />;
  return <CircleSlash2 aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" strokeWidth={1.7} />;
}

function SectionTitle({ id, children, className = "" }: { id: string; children: ReactNode; className?: string }) {
  return (
    <h3 id={id} className={`mb-2 text-[11px] font-semibold text-ink-strong ${className}`}>
      {children}
    </h3>
  );
}

function StateMessage({
  icon: Icon,
  title,
  detail,
  action,
}: {
  icon: typeof FileText;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center bg-surface-0 px-6">
      <div className="max-w-sm text-center">
        <Icon aria-hidden className="mx-auto h-7 w-7 text-ink-faint" strokeWidth={1.5} />
        <h2 className="mt-3 text-[14px] font-semibold text-ink-strong">{title}</h2>
        <p className="mt-1.5 text-xs leading-[1.55] text-ink-subtle">{detail}</p>
        {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div aria-label="Loading loop reports" className="h-full animate-pulse bg-surface-0 px-4 py-4">
      <div className="h-3 w-20 rounded bg-surface-2" />
      <div className="mt-3 h-4 w-3/4 rounded bg-surface-2" />
      <div className="mt-2 h-3 w-1/2 rounded bg-surface-2" />
      <div className="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-3 @[540px]:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="h-8 rounded bg-surface-1" />
        ))}
      </div>
      <div className="mt-6 space-y-3">
        <div className="h-24 rounded-lg border border-line bg-surface-1" />
        <div className="h-20 rounded-lg border border-line bg-surface-1" />
      </div>
    </div>
  );
}

const SECONDARY_BUTTON =
  "inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-surface-1 px-3 py-1.5 text-[11px] font-medium text-ink-strong transition-colors hover:bg-surface-2 active:bg-surface-3";
const ICON_BUTTON =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink-strong active:bg-surface-3";

function hasMemory(memory: NextIterationMemory): boolean {
  return memory.observations.length + memory.decisions.length + memory.risks.length + memory.nextActions.length > 0;
}

function scorePercent(iteration: LoopIteration): number {
  const scored = iteration.scores.reduce((sum, score) => sum + score.score, 0);
  const maximum = iteration.scores.reduce((sum, score) => sum + score.maximum, 0);
  return maximum > 0 ? Math.round((scored / maximum) * 100) : 0;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(
    new Date(timestamp),
  );
}

function formatRelative(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return formatDate(timestamp);
}

function statusText(status: LoopStatus): string {
  return status === "running" ? "Running" : titleCase(status);
}

function titleCase(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePath(left?: string | null, right?: string | null): boolean {
  if (!left || !right) return false;
  return left.trim().replace(/[\\/]+$/, "") === right.trim().replace(/[\\/]+$/, "");
}
