import { rpc } from "./rpc";

export type LoopStatus = "running" | "completed" | "blocked" | "cancelled";
export type IterationOutcome = "passed" | "needs-work" | "failed" | "cancelled";
export type AgentOutcome = "passed" | "failed" | "cancelled";
export type CheckKind = "build" | "test" | "lint" | "play" | "performance" | "other";
export type CheckStatus = "passed" | "failed" | "skipped";
export type EvidenceKind = "screenshot" | "video" | "contact-sheet" | "trace" | "log" | "other";
export type PunchPriority = "critical" | "high" | "medium" | "low";

export interface LoopTotals {
  iterations: number;
  workedDurationMs: number;
  elapsedDurationMs: number;
  agents: number;
  checksPassed: number;
  checksFailed: number;
  checksSkipped: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  latestScorePercent?: number | null;
}

export interface LoopReportSummary {
  loopId: string;
  objective: string;
  status: LoopStatus;
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number | null;
  totals: LoopTotals;
}

export interface AgentRun {
  role: string;
  agentId?: string | null;
  task: string;
  outcome: AgentOutcome;
  summary: string;
  durationMs: number;
}

export interface CheckResult {
  kind: CheckKind;
  name: string;
  command?: string | null;
  status: CheckStatus;
  durationMs: number;
  details: string;
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface LoopEvidence {
  kind: EvidenceKind;
  path: string;
  caption: string;
  capturedAtMs?: number | null;
}

export interface ObjectiveScore {
  criterion: string;
  score: number;
  maximum: number;
  passThreshold?: number | null;
  rationale: string;
}

export interface PunchItem {
  priority: PunchPriority;
  item: string;
  source?: string | null;
  resolved: boolean;
}

export interface NextIterationMemory {
  observations: string[];
  decisions: string[];
  risks: string[];
  nextActions: string[];
}

export interface LoopIteration {
  iteration: number;
  startedAtMs: number;
  completedAtMs: number;
  durationMs: number;
  outcome: IterationOutcome;
  summary: string;
  agents: AgentRun[];
  checks: CheckResult[];
  changedFiles: ChangedFile[];
  evidence: LoopEvidence[];
  scores: ObjectiveScore[];
  punchList: PunchItem[];
  nextIterationMemory: NextIterationMemory;
}

export interface LoopReport {
  schemaVersion: number;
  projectSlug: string;
  loopId: string;
  objective: string;
  reference?: string | null;
  status: LoopStatus;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs: number;
  completedAtMs?: number | null;
  summary: string;
  punchList: PunchItem[];
  nextIterationMemory: NextIterationMemory;
  iterations: LoopIteration[];
  totals: LoopTotals;
}

export interface OpenLoopReport {
  report: LoopReport;
  projectRoot: string;
  jsonPath: string;
  markdownPath: string;
  htmlPath: string;
}

export const listLoopReports = (slug: string) =>
  rpc<{ reports: LoopReportSummary[] }>("loop_report_list", { slug });

export const openLoopReport = (slug: string, loopId: string) =>
  rpc<OpenLoopReport>("loop_report_open", { slug, loopId });

/** Prefer the active run, otherwise the list contract's newest report. */
export function preferredLoopReport(reports: LoopReportSummary[]): LoopReportSummary | undefined {
  return reports.find((report) => report.status === "running") ?? reports[0];
}

export function isSafeReportPath(path: string): boolean {
  if (!path || path.length > 512 || path.includes("\\") || path.includes(":")) return false;
  if (path.startsWith("/") || path.includes("?") || path.includes("#") || /[\u0000-\u001f]/.test(path)) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
