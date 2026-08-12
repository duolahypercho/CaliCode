import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ChevronRight,
  Clock3,
  FilePenLine,
  Gamepad2,
  Loader2,
  ScanSearch,
  Search,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Square,
  Terminal,
  TestTube2,
  X,
  Zap,
} from "lucide-react";
import { AgentText } from "./AgentText";
import { GraphPanel } from "./GraphPanel";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { connectEvents, rpc, type AgentEvent, type UsageTotals } from "../../lib/rpc";
import { contextWindowOf, formatTokens, readCoreConfig, type CoreConfig } from "../../lib/coreConfig";
import {
  MAX_LOOP_ITERATIONS,
  matchCommands,
  parseSlash,
  type SlashContext,
} from "../../lib/slashCommands";
import {
  createSession,
  forkSession,
  listSessions,
  loadSession,
  relativeTime,
  saveSession,
  type SessionSummary,
} from "../../lib/sessions";
import { defaultEffort, effortLevelsFor, loadModelDev, type EffortIndex } from "../../lib/modelMeta";
import {
  DEFAULT_JUDGE_THRESHOLD,
  cancelGraph,
  graphStatus,
  listGraphs,
  planGraph,
  runGraph,
  type GraphEvent,
  type TaskGraph,
} from "../../lib/graph";
import {
  activityDetail,
  activitySummary,
  buildActivityFileChange,
  classifyActivityOperation,
  createTurnMarker,
  durationForTurn,
  formatDuration,
  isSafeActivityPath,
  isTurnMarker,
  repairLegacyActivitySummary,
  sessionWorkedMs,
  type ActivityAction,
  type ActivityFileChange,
} from "../../lib/activity";
import { openLoopReport, type LoopReport } from "../../lib/loopReports";
import type { AgentMessage, BrowserTool, ModelList, SubagentResult } from "../../lib/types";

interface ApprovalRequest {
  requestId: string;
  tool: string;
  arguments: unknown;
}

type BrowserToolOwnershipEvent = Pick<
  AgentEvent,
  "sessionId" | "targetSessionId" | "targetClientId" | "projectSlug" | "workspaceRoot"
>;

export function fallbackLoopChangedFiles(
  messages: AgentMessage[],
  activityTurnId: string,
): Array<{ path: string; additions: number; deletions: number }> {
  return messages
    .filter((message) => message.turnId === activityTurnId && message.activity)
    .map((message) => ({
      path: message.activity!.path,
      additions: message.activity!.additions,
      deletions: message.activity!.deletions,
    }));
}

export async function reportLoopBestEffort<T>(
  method: "loop_report_start" | "loop_report_iteration" | "loop_report_update",
  params: Record<string, unknown>,
  onFailure?: (error: unknown) => void,
): Promise<T | undefined> {
  try {
    return await rpc<T>(method, params);
  } catch (error) {
    try {
      onFailure?.(error);
    } catch {
      // Reporting is diagnostic-only; an observer must not break the loop.
    }
    return undefined;
  }
}

export function loopIterationPrompt(goal: string, loopId: string, iteration: number): string {
  const topology =
    "Use graph_plan + graph_run with three dependency-free specialist Build roots with distinct roles, " +
    "a separate Integration Build depending on every root, and a terminal Judge depending on Integration. " +
    "Every repair iteration must keep this full topology so its passing graph can prove loop completion.";
  const verification =
    "Before PIE evidence, inspect the scene and call editor_camera_frame with the gameplay foreground " +
    "entity IDs (hero, opponent, goals, arena) and a viewDirection that keeps sky/backdrop geometry behind " +
    "the camera; this authored evidence camera persists across every subsequent capture. Play and verify in PIE. Persist at least three individual screenshots directly with " +
    "editor_persist_capture(path), read editor_console_history for runtime errors, call editor_analyze_motion " +
    "for movement, and append the returned project-relative evidence paths to loop_report_iteration. " +
    "Do not copy screenshot dataUrls through the model or use UTF-8 file_write for PNG bytes.";
  const reporting =
    "Call loop_report_start with a specific named quality reference, then append a fully structured " +
    "loop_report_iteration. Record a structured iteration with build/play/test checks, agent IDs, changed files, durable visual evidence " +
    "paths, objective scores, punch-list items, and nextIterationMemory. The active project and loop ID are " +
    "injected by core; do not spend turns retyping or inventing them.";
  if (iteration === 1) {
    return `${goal}\n\nThis is /loop ${loopId}, iteration ${iteration}. ${topology} ${verification} ${reporting} This is the initial pass: record it and continue to a second verification/repair iteration even if its graph passes. Do not reply DONE yet.`;
  }
  return `Continue /loop ${loopId}, iteration ${iteration}, toward the goal. Read loop_report_open first and use its nextIterationMemory plus punch list. ${topology} ${verification} ${reporting} When a fresh judge crosses threshold, the report has at least two iterations, and every check passes, call loop_report_update and reply with exactly DONE on its own line and nothing else.`;
}

export function isTransientRpcError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (!message) return false;
  // Browser transport failure (proxy down, network reset, Vite dev server
  // bouncing). These are the cases where a short retry should win.
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) return true;
  // The Vite proxy returns plain-text gateway errors when core is down
  // (502/503/504). Match those explicit codes so an application error
  // named "RPC ... failed" never gets retried.
  if (/\b(502|503|504)\b/.test(message)) return true;
  // Provider/auth errors must fail closed. Anything mentioning a key,
  // authorization, usage, or a 4xx is the agent's ledge, not ours.
  return false;
}

export function settleRunningToolRows(messages: AgentMessage[], turnId: string, finishedAtMs: number): AgentMessage[] {
  let mutated = false;
  const next = messages.map((message) => {
    if (
      message.role === "tool" &&
      message.turnId === turnId &&
      message.status === "running" &&
      typeof message.toolCallId === "string"
    ) {
      mutated = true;
      return { ...message, status: "error" as const, completedAtMs: finishedAtMs };
    }
    return message;
  });
  return mutated ? next : messages;
}

export function hasRecordedLoopIteration(
  toolCalls: readonly unknown[],
  projectSlug: string,
  loopId: string,
): boolean {
  return toolCalls.some((call) => {
    if (!call || typeof call !== "object" || Array.isArray(call)) return false;
    const record = call as Record<string, unknown>;
    if (record.name !== "loop_report_iteration" || record.status !== "done") return false;
    const args = record.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) return false;
    const input = args as Record<string, unknown>;
    // During /loop, core binds the active project/loop to every report call.
    // The returned call log intentionally preserves the provider's original
    // arguments, so omitted routing fields are expected; explicit mismatches
    // still fail closed for records made by older/unbound cores.
    const slugMatches = input.slug === undefined || input.slug === projectSlug;
    const loopMatches = input.loopId === undefined || input.loopId === loopId;
    return slugMatches && loopMatches && input.iteration !== undefined;
  });
}

export interface LoopGraphProofContext {
  loopStartedAtMs: number;
  projectSlug: string;
  sessionId: string;
  workspaceRoot: string;
  baselineAvailable?: boolean;
  knownGraphIds?: ReadonlySet<string>;
  observedGraphIds?: ReadonlySet<string>;
}

export interface LoopGraphProof {
  accepted: boolean;
  reason: string;
}

export function graphQualityReference(graph: TaskGraph): string | null {
  for (const node of graph.nodes) {
    if (node.kind !== "judge") continue;
    const reference = node.reference?.trim();
    if (reference) return reference;
  }
  return null;
}

export function validateLoopReportCompletion(
  report: LoopReport,
  projectSlug: string,
  loopId: string,
): LoopGraphProof {
  if (report.projectSlug !== projectSlug || report.loopId !== loopId) {
    return { accepted: false, reason: "progress report belongs to a different loop" };
  }
  if (report.status === "blocked" || report.status === "cancelled") {
    return { accepted: false, reason: `progress report status is ${report.status}` };
  }
  if (!report.reference?.trim()) {
    return { accepted: false, reason: "progress report has no named quality reference" };
  }
  if (report.iterations.length < 2) {
    return { accepted: false, reason: "progress report needs an initial pass and a repair pass" };
  }
  const passed = [...report.iterations].reverse().find((iteration) => iteration.outcome === "passed");
  if (!passed) return { accepted: false, reason: "progress report has no passed iteration" };
  if (passed.agents.length === 0) {
    return { accepted: false, reason: "passed iteration records no specialist agents" };
  }
  const missingChecks = (["build", "play", "test"] as const).filter(
    (kind) => !passed.checks.some((check) => check.kind === kind && check.status === "passed"),
  );
  if (missingChecks.length > 0) {
    return { accepted: false, reason: `passed iteration is missing ${missingChecks.join("/")} checks` };
  }
  if (passed.checks.some((check) => check.status === "failed")) {
    return { accepted: false, reason: "passed iteration still contains a failed check" };
  }
  if (
    !passed.evidence.some(
      (evidence) => evidence.path && ["screenshot", "video", "contact-sheet"].includes(evidence.kind),
    )
  ) {
    return { accepted: false, reason: "passed iteration has no durable visual evidence" };
  }
  if (passed.scores.length === 0) {
    return { accepted: false, reason: "passed iteration has no judge score" };
  }
  const scorePercent = Math.floor(
    passed.scores.reduce((sum, score) => sum + (score.score * 100) / Math.max(1, score.maximum), 0) /
      passed.scores.length,
  );
  if (scorePercent < DEFAULT_JUDGE_THRESHOLD) {
    return { accepted: false, reason: `passed iteration judge score is ${scorePercent}, below ${DEFAULT_JUDGE_THRESHOLD}` };
  }
  const missedThreshold = passed.scores.find(
    (score) => score.passThreshold != null && score.score < score.passThreshold,
  );
  if (missedThreshold) {
    return { accepted: false, reason: `${missedThreshold.criterion} missed its score threshold` };
  }
  if (!report.iterations.some((iteration) => iteration.changedFiles.length > 0)) {
    return { accepted: false, reason: "progress report records no changed files" };
  }
  const hasMemory = report.iterations.some((iteration) => {
    const memory = iteration.nextIterationMemory;
    return memory.observations.length + memory.decisions.length + memory.risks.length + memory.nextActions.length > 0;
  });
  if (!hasMemory) return { accepted: false, reason: "progress report has no carry-forward memory" };
  return { accepted: true, reason: "durable loop report passed" };
}

/**
 * DONE is only authoritative when a graph created by this loop proves the
 * result. The graph snapshot is checked locally after graph_status refreshes
 * it from core, so an old panel event cannot satisfy a new loop.
 */
export function validateLoopGraphCompletion(graph: TaskGraph, context: LoopGraphProofContext): LoopGraphProof {
  const createdAtMs = Date.parse(graph.createdAt);
  const knownGraph = context.knownGraphIds?.has(graph.graphId) ?? false;
  const observedGraph = context.observedGraphIds?.has(graph.graphId) ?? false;
  const baselineAvailable = context.baselineAvailable ?? context.knownGraphIds !== undefined;
  const createdDuringLoop =
    Number.isFinite(createdAtMs) && createdAtMs >= context.loopStartedAtMs - 1_000;
  if (knownGraph || (!observedGraph && (!baselineAvailable || !createdDuringLoop))) {
    return { accepted: false, reason: "no fresh graph was created during this loop" };
  }
  if (graph.ownerSession !== context.sessionId) {
    return { accepted: false, reason: "graph belongs to a different session" };
  }
  if (graph.projectSlug !== context.projectSlug) {
    return { accepted: false, reason: "graph belongs to a different project" };
  }
  if (graph.workspaceRoot !== context.workspaceRoot) {
    return { accepted: false, reason: "graph belongs to a different workspace" };
  }
  if (graph.status !== "complete") {
    return { accepted: false, reason: `graph status is ${graph.status}, not complete` };
  }
  const unfinished = graph.nodes.filter((node) => node.status !== "passed");
  if (unfinished.length > 0) {
    return {
      accepted: false,
      reason: `${unfinished.length} graph node${unfinished.length === 1 ? "" : "s"} still need to pass`,
    };
  }
  const buildNodes = graph.nodes.filter((node) => node.kind === "build");
  const rootBuildNodes = buildNodes.filter((node) => node.deps.length === 0);
  if (rootBuildNodes.length < 3 || new Set(rootBuildNodes.map((node) => node.role)).size < 3) {
    return { accepted: false, reason: "graph needs three independent specialist build roots" };
  }
  const rootIds = new Set(rootBuildNodes.map((node) => node.id));
  const integrationNodes = buildNodes.filter(
    (node) =>
      node.deps.length >= rootBuildNodes.length && [...rootIds].every((rootId) => node.deps.includes(rootId)),
  );
  if (integrationNodes.length === 0) {
    return { accepted: false, reason: "graph needs a separate integration build depending on every root" };
  }
  const judges = graph.nodes.filter((node) => node.kind === "judge");
  if (judges.length === 0) {
    return { accepted: false, reason: "graph has no judge node" };
  }
  if (
    !judges.some(
      (node) =>
        integrationNodes.some((integration) => node.deps.includes(integration.id)) &&
        typeof node.score === "number" &&
        node.score >= (node.threshold ?? DEFAULT_JUDGE_THRESHOLD),
    )
  ) {
    return {
      accepted: false,
      reason: `no terminal judge over integration reached the ${DEFAULT_JUDGE_THRESHOLD}-point threshold`,
    };
  }
  if (
    !buildNodes.some(
      (node) =>
        (node.evidenceCount ?? 0) >= 3 &&
        (node.evidencePaths?.length ?? 0) > 0,
    )
  ) {
    return { accepted: false, reason: "no passed build node has at least three persisted visual frames" };
  }
  return { accepted: true, reason: "fresh graph proof passed" };
}

export function ownsBrowserToolEvent(
  event: BrowserToolOwnershipEvent,
  owner: {
    clientId: string | null;
    projectSlug: string;
    workspaceRoot: string | null;
    sessionId: string | null;
    activeGraph: TaskGraph | null;
  },
): boolean {
  if (event.projectSlug !== owner.projectSlug || event.workspaceRoot !== owner.workspaceRoot) return false;

  // A routed token is authoritative and must never fall through to the
  // legacy session check when it names a different editor.
  if (event.targetClientId !== undefined) {
    return owner.clientId !== null && event.targetClientId === owner.clientId;
  }

  const routedSessionId = event.targetSessionId ?? event.sessionId;
  if (!routedSessionId) return false;
  if (routedSessionId === owner.sessionId || routedSessionId === owner.activeGraph?.ownerSession) return true;
  return Boolean(owner.activeGraph?.nodes.some((node) => node.sessionId === routedSessionId));
}

// Core accepts exactly these permission modes (core/src/agent.rs
// `requires_approval`): "full-access" | "auto" | "auto-accept-edits" |
// "supervised" | "plan". "Sandbox" maps onto core's `auto` (safe tools run
// freely, irreversible writes ask), matching codex-style workspace sandboxes.
// "Plan" is core's real plan mode: dispatch is restricted to the read-only
// whitelist (`plan_mode_allows`), so the agent can inspect and plan but
// nothing is modified.
const PERMISSION_OPTIONS = [
  { value: "full-access", label: "Full access", hint: "Runs every tool without asking" },
  { value: "auto-accept-edits", label: "Accept edits", hint: "Scene edits apply automatically; file writes and commands still ask" },
  { value: "auto", label: "Sandbox", hint: "Safe tools run freely; irreversible writes ask first" },
  { value: "supervised", label: "Manual", hint: "Asks before every tool call" },
  { value: "plan", label: "Plan", hint: "Read-only: inspect and plan; write tools are blocked" },
] as const;

// Which efforts each model accepts comes from the models.dev registry (the
// catalog opencode's picker is built on) — a gpt-4.1-mini has none, an
// o-series has low/medium/high, a deepseek-v4-flash has low/high/max. The
// user's chosen effort is remembered per model.
const EFFORT_STORAGE_KEY = "calicode-model-effort-map";

const GAME_STARTERS = [
  {
    label: "Prototype a mechanic",
    prompt: "Inspect this game, then build the smallest playable version of its core mechanic. Run it and verify the result.",
    icon: Gamepad2,
  },
  {
    label: "Inspect the game",
    prompt: "Inspect the current game and repository. Explain how it works, identify the main gameplay loop, and suggest the best next improvement.",
    icon: ScanSearch,
  },
  {
    label: "Playtest and fix",
    prompt: "Run the game, playtest the current experience, diagnose the most important issue, and fix it. Verify the change in the game.",
    icon: TestTube2,
  },
  {
    label: "Improve game feel",
    prompt: "Inspect the current game and improve the feel of its most important interaction. Keep the scope focused, then run and verify it.",
    icon: Sparkles,
  },
] as const;

const readStoredEfforts = (): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(EFFORT_STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, value]) => typeof value === "string"),
    ) as Record<string, string>;
  } catch {
    return {};
  }
};

interface AgentPanelProps {
  projectSlug: string;
  workspaceRoot: string | null;
  modelList: ModelList | null;
  browserTools: BrowserTool[];
  onModelChange: () => void;
  onLog: (message: string) => void;
  /** Saved transcript to resume on mount — how the sidebar's recents open. */
  initialSessionId?: string | null;
  /** Fired with the fresh list whenever the saved sessions change. */
  onSessionsChanged?: (sessions: SessionSummary[]) => void;
  onSessionActivated?: (session: SessionSummary) => void;
  /** Opens a workspace file when a safe activity path is selected. */
  onOpenActivityFile?: (file: ActivityFileChange) => void;
  /**
   * Reports the session id this panel currently owns — fires when a new
   * session is created, a saved one is resumed, or a fork re-keys the panel.
   * The parent uses this to know which session any subsequent busy signal
   * belongs to.
   */
  onActiveSessionChange?: (sessionId: string | null) => void;
  /**
   * Reports when this panel becomes busy (an agent turn, loop iteration, or
   * compaction is in flight) and when it returns to idle. The session id is
   * the one this panel currently owns, or null if it is no longer tied to a
   * session — the sidebar uses both values to keep a per-session running
   * indicator accurate across selection changes and unmounts.
   */
  onSessionRunningChange?: (running: boolean, sessionId: string | null) => void;
  /** Opens the tools dock as a drawer below lg, where it leaves the layout. */
}

/**
 * One tool execution as a slim status row — spinner while running, a muted
 * check or a red cross when finished — with the full output expandable under
 * a left rule (the opencode/t3code idiom). Tool messages without a `status`
 * are informational lines (slash-command output, session notes).
 */
function ToolRow({ message }: { message: AgentMessage }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(message.detail);
  const heading =
    message.status === "running"
      ? `Running ${message.tool}`
      : message.status
        ? `Ran ${message.tool}`
        : null;
  return (
    <div data-role="tool" className="w-full max-w-[94%] self-start">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={expandable ? open : undefined}
        className={`flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs text-ink-subtle transition-colors ${
          expandable ? "hover:bg-surface-2 active:bg-surface-3" : "cursor-default"
        }`}
      >
        {message.status === "running" ? (
          <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin text-ink-subtle" strokeWidth={2.2} />
        ) : message.status === "error" ? (
          <X aria-hidden className="h-3 w-3 shrink-0 text-danger-soft" strokeWidth={2.4} />
        ) : message.status === "done" ? (
          <Check aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" strokeWidth={2.4} />
        ) : (
          <span aria-hidden className="h-2.5 w-2.5 shrink-0 border border-ink-subtle bg-ink-subtle" />
        )}
        {heading ? (
          <span className={`shrink-0 font-medium ${message.status === "error" ? "text-danger-soft" : "text-ink"}`}>
            {heading}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{message.content}</span>
        {expandable ? (
          <ChevronRight
            aria-hidden
            className={`h-3 w-3 shrink-0 text-ink-faint transition-transform ${open ? "rotate-90" : ""}`}
            strokeWidth={2}
          />
        ) : null}
      </button>
      {open && message.detail ? (
        <pre className="ml-[5px] mt-1 max-h-64 overflow-auto whitespace-pre-wrap border-l border-line pl-3 font-mono text-[11px] leading-[1.6] text-ink-subtle">
          {message.detail}
        </pre>
      ) : null}
    </div>
  );
}

function ActivityIcon({ operation, running }: { operation: string; running?: boolean }) {
  if (running) {
    return <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin text-ink-subtle" strokeWidth={2.2} />;
  }
  if (operation === "edit" || operation === "write") {
    return <FilePenLine aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" strokeWidth={1.8} />;
  }
  if (operation === "command") {
    return <Terminal aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" strokeWidth={1.8} />;
  }
  if (operation === "search") {
    return <Search aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" strokeWidth={1.8} />;
  }
  if (operation === "read") {
    return <BookOpen aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" strokeWidth={1.8} />;
  }
  return <Check aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" strokeWidth={2} />;
}

export function ActivityDetailRow({
  action,
  onOpenFile,
}: {
  action: ActivityAction;
  onOpenFile?: (file: ActivityFileChange) => void;
}) {
  const file = action.file;
  const canOpen = Boolean(file && isSafeActivityPath(file.path, file.workspaceRoot));
  const fileLabel = file ? file.path : null;
  const counts = Boolean(
    file && (file.additions > 0 || file.deletions > 0) && !/[+]\d+\s+[−-]\d+/.test(action.content),
  );
  return (
    <div className="border-l border-line pl-3">
      <div className="flex min-w-0 items-center gap-2 py-1 text-[11px] text-ink-subtle">
        <ActivityIcon operation={file?.operation ?? "tool"} running={action.status === "running"} />
        <span className="min-w-0 flex-1 truncate">{action.content || `Ran ${action.tool}`}</span>
        {counts && file ? (
          <span className="inline-flex shrink-0 gap-1 font-mono text-[10px]">
            <span className="text-success-soft">{file.truncated ? "≈" : ""}+{file.additions}</span>
            <span className="text-danger-soft">-{file.deletions}</span>
          </span>
        ) : null}
        {action.startedAtMs != null && action.finishedAtMs != null ? (
          <span className="shrink-0 text-[10px] text-ink-faint">
            {formatDuration(durationForTurn(action.startedAtMs, action.finishedAtMs))}
          </span>
        ) : null}
      </div>
      {fileLabel ? (
        <button
          type="button"
          disabled={!canOpen || !onOpenFile}
          onClick={() => {
            if (file && canOpen) onOpenFile?.(file);
          }}
          className={`mb-1 max-w-full truncate rounded px-1 text-left font-mono text-[10px] text-ink-faint ${
            canOpen && onOpenFile ? "hover:bg-surface-2 hover:text-ink active:bg-surface-3" : "cursor-default"
          }`}
          aria-label={canOpen ? `Open ${fileLabel}` : fileLabel}
        >
          {fileLabel}
        </button>
      ) : null}
      {action.detail ? (
        <pre className="mb-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-[1.5] text-ink-faint">
          {action.detail}
        </pre>
      ) : null}
      {file && file.diff.length > 0 ? (
        <div className="mb-2 overflow-hidden rounded border border-line bg-surface-1 font-mono text-[10px] leading-[1.5]">
          {file.diff.map((row, index) => (
            <div
              key={`${row.type}-${row.oldLine ?? "x"}-${row.newLine ?? "x"}-${index}`}
                className={
                row.type === "added"
                  ? "bg-success-soft/10 px-2 text-success-soft"
                  : row.type === "removed"
                    ? "bg-danger-soft/5 px-2 text-danger-soft"
                    : "px-2 text-ink-faint"
              }
            >
              <span aria-hidden className="mr-1 inline-block w-3 select-none text-center text-ink-faint">
                {row.type === "added" ? "+" : row.type === "removed" ? "−" : " "}
              </span>
              {row.text || " "}
            </div>
          ))}
          {file.truncated ? <div className="px-2 py-1 text-ink-faint">Diff preview limited to the captured file window.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function ActivityTurnRow({
  turnId,
  messages,
  onOpenFile,
}: {
  turnId: string;
  messages: AgentMessage[];
  onOpenFile?: (file: ActivityFileChange) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const marker = messages.find((message) => isTurnMarker(message));
  const actions = messages.filter((message) => !isTurnMarker(message) && message.toolCallId) as Array<
    AgentMessage & { toolCallId: string }
  >;
  const latest = actions.at(-1);
  const live = marker?.completedAtMs == null || actions.some((action) => action.status === "running");
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  const elapsed = durationForTurn(marker?.startedAtMs, marker?.completedAtMs, nowMs);
  const operation = latest?.activity?.operation ?? classifyActivityOperation(latest?.tool ?? "tool");
  const summary = latest?.content || (live ? "Working…" : "Completed");
  const changedFiles = new Map<string, ActivityFileChange>();
  let additions = 0;
  let deletions = 0;
  for (const action of actions) {
    const file = action.activity;
    if (!file || (file.operation !== "edit" && file.operation !== "write")) continue;
    changedFiles.set(file.path, file);
    additions += file.additions;
    deletions += file.deletions;
  }
  const changed = [...changedFiles.values()];
  return (
    <div data-role="activity-turn" data-turn-id={turnId} className="w-full max-w-[94%] self-start">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} activity for turn ${turnId}`}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs text-ink-subtle transition-colors hover:bg-surface-2 active:bg-surface-3"
      >
        <ActivityIcon operation={operation} running={live} />
        <span className="min-w-0 flex-1 truncate text-ink">{summary}</span>
        {actions.length > 1 ? <span className="shrink-0 text-[10px] text-ink-faint">{actions.length} actions</span> : null}
        <span className="shrink-0 text-[10px] text-ink-faint">{live ? `${formatDuration(elapsed)} · live` : formatDuration(elapsed)}</span>
        <ChevronRight
          aria-hidden
          className={`h-3 w-3 shrink-0 text-ink-faint transition-transform ${expanded ? "rotate-90" : ""}`}
          strokeWidth={2}
        />
      </button>
      {!expanded && changed.length > 0 ? (
        <div className="mt-1 flex justify-end pr-1">
          <span
            data-activity-change-summary
            className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[10px] tabular-nums text-ink-subtle"
          >
            {changed.length} {changed.length === 1 ? "file" : "files"} changed
            <span className="text-success-soft">+{additions}</span>
            <span className="text-danger-soft">-{deletions}</span>
          </span>
        </div>
      ) : null}
      {expanded ? (
        <div className="mt-1 space-y-0.5">
          {actions.length === 0 ? (
            <div className="border-l border-line py-1 pl-3 text-[11px] text-ink-faint">No tool actions recorded yet.</div>
          ) : (
            actions.map((message, index) => (
              <ActivityDetailRow
                key={`${message.toolCallId}-${index}`}
                action={{
                  id: message.toolCallId,
                  turnId,
                  tool: message.tool ?? "tool",
                  toolCallId: message.toolCallId,
                  status: message.status ?? "done",
                  startedAtMs: message.startedAtMs,
                  finishedAtMs: message.completedAtMs,
                  content: message.content,
                  detail: message.detail,
                  file: message.activity,
                }}
                onOpenFile={onOpenFile}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export function activityAnchorIndexes(messages: AgentMessage[]): Map<string, number> {
  const anchors = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!message.turnId) return;
    const current = anchors.get(message.turnId);
    if (current === undefined || message.toolCallId) anchors.set(message.turnId, index);
  });
  return anchors;
}

export function AgentPanel({
  projectSlug,
  workspaceRoot,
  modelList,
  browserTools,
  onModelChange,
  onLog,
  initialSessionId = null,
  onSessionsChanged,
  onSessionActivated,
  onOpenActivityFile,
  onActiveSessionChange,
  onSessionRunningChange,
}: AgentPanelProps) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const messagesRef = useRef<AgentMessage[]>(messages);
  messagesRef.current = messages;
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionWorkspaceRoot, setSessionWorkspaceRoot] = useState<string | null>(workspaceRoot);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [eventSessionId, setEventSessionId] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState("full-access");
  // Reasoning effort is remembered per model and forwarded on every agent
  // turn; graph/subagent workers inherit the coordinator's selected value.
  const [effortByModel, setEffortByModel] = useState<Record<string, string>>(readStoredEfforts);
  const [effortIndex, setEffortIndex] = useState<EffortIndex | null>(null);
  // models.dev per-provider catalogs, used to surface current models the
  // hand-maintained config hasn't caught up to yet.
  const [registryCatalog, setRegistryCatalog] = useState<Record<string, string[]> | null>(null);
  const [providerTarget, setProviderTarget] = useState("openai");
  const [modelInput, setModelInput] = useState("");
  const [looping, setLooping] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  // Latest task graph snapshot from `graph.updated` events, and a per-node
  // live output ticker (last ~200 chars of each subagent's stream).
  const [activeGraph, setActiveGraph] = useState<TaskGraph | null>(null);
  const [graphTickers, setGraphTickers] = useState<Record<string, string>>({});
  // A /loop completion must refer to a graph created after that loop began.
  // These refs let the mount-once SSE handler record creation events without
  // re-subscribing, while the authoritative gate still refreshes graph_status.
  const loopStartedAtRef = useRef<number | null>(null);
  const loopBaselineAvailableRef = useRef(false);
  const loopKnownGraphIdsRef = useRef<Set<string>>(new Set());
  const loopObservedGraphIdsRef = useRef<Set<string>>(new Set());
  // Cumulative session token totals from `agent.usage` events, feeding the
  // context meter beside the composer and the /usage command.
  const [usage, setUsage] = useState<UsageTotals | null>(null);
  // Core config snapshot: the compaction block sizes the context meter, and
  // /usage reports the auto-compaction threshold from it.
  const [coreConfig, setCoreConfig] = useState<CoreConfig | null>(null);
  const cancelLoopRef = useRef(false);
  const saveTimer = useRef<number | null>(null);
  // Each mounted editor panel is an SSE consumer. Core includes this token
  // on editor/browser tool requests so another CaliCode window cannot answer
  // the request first just because it shares the broadcast event stream.
  const editorClientIdRef = useRef<string | null>(null);
  if (!editorClientIdRef.current) editorClientIdRef.current = crypto.randomUUID();
  const onSessionsChangedRef = useRef(onSessionsChanged);
  onSessionsChangedRef.current = onSessionsChanged;
  // Stable handles for the activity/running reporters: they always see the
  // latest callback without re-subscribing the SSE consumer, and they survive
  // component unmounts long enough to deliver a final idle signal.
  const onActiveSessionChangeRef = useRef(onActiveSessionChange);
  onActiveSessionChangeRef.current = onActiveSessionChange;
  const onSessionRunningChangeRef = useRef(onSessionRunningChange);
  onSessionRunningChangeRef.current = onSessionRunningChange;
  // The session id at the time the panel unmounts — emitted alongside the
  // final idle signal so the parent can clear the right row even when
  // `sessionId` has already been reset. Without this, an unmount after the
  // last turn would send a `null` and the spinner would stay stuck on
  // whatever session the parent happened to be tracking.
  const lastOwnedSessionIdRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef(browserTools);
  toolsRef.current = browserTools;
  // Mirrors for the mount-once SSE handler: it must see the live session id
  // and graph snapshot without re-subscribing to /events per render.
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;
  const workspaceRootRef = useRef<string | null>(sessionWorkspaceRoot);
  workspaceRootRef.current = sessionWorkspaceRoot;
  const activeGraphRef = useRef<TaskGraph | null>(activeGraph);
  const applyGraphSnapshot = (graph: TaskGraph) => {
    activeGraphRef.current = graph;
    setActiveGraph(graph);
  };
  const activeTurnRef = useRef<{ turnId: string; startedAtMs: number } | null>(null);

  const targetProvider = modelList?.providers.find((provider) => provider.id === providerTarget);
  const availableModels = [
    ...(modelList?.active.provider === providerTarget && modelList.active.model ? [modelList.active.model] : []),
    ...(targetProvider?.models ?? []),
  ].filter((model, index, models) => model && models.indexOf(model) === index);

  // Keep the active model in the compact composer, where it is visible and
  // switchable without opening the larger session-settings popover.
  const modelChoices = (modelList?.providers ?? []).flatMap((provider) => {
    const configured = [
      ...(modelList?.active.provider === provider.id && modelList.active.model ? [modelList.active.model] : []),
      ...(provider.models ?? []),
    ];
    // Configured models first, then what models.dev says the provider offers
    // today (newest release first) — capped so aggregators with hundreds of
    // models don't swamp the menu.
    const fromRegistry = (registryCatalog?.[provider.id] ?? [])
      .filter((model) => !configured.includes(model))
      .slice(0, 24);
    const models = [...configured, ...fromRegistry].filter(
      (model, index, choices) => model && choices.indexOf(model) === index,
    );
    return models.map((model) => ({
      value: `${provider.id}:${model}`,
      label: model,
      hint: provider.label,
    }));
  });
  const activeModelValue = modelList ? `${modelList.active.provider}:${modelList.active.model}` : "";

  const selectProvider = (provider: string) => {
    setProviderTarget(provider);
    const preset = modelList?.providers.find((candidate) => candidate.id === provider);
    const activeModel = modelList?.active.provider === provider ? modelList.active.model : "";
    setModelInput(activeModel || preset?.models?.[0] || "");
  };

  useEffect(() => {
    setProviderTarget(modelList?.active.provider ?? "openai");
    setModelInput(modelList?.active.model ?? "");
  }, [modelList]);

  useEffect(() => {
    const eventIsLocalActivity = (event: AgentEvent): boolean => {
      const eventSessionId = event.sessionId ?? event.targetSessionId;
      if (!eventSessionId) return Boolean(activeTurnRef.current);
      if (activeGraphRef.current?.nodes.some((node) => node.sessionId === eventSessionId)) return false;
      return !sessionIdRef.current || eventSessionId === sessionIdRef.current;
    };
    const turnForEvent = (event: AgentEvent): string | undefined => {
      if (event.turnId) return event.turnId;
      if (activeTurnRef.current) return activeTurnRef.current.turnId;
      return undefined;
    };
    const disconnect = connectEvents((event: AgentEvent) => {
      if (event.type === "agent.delta") {
        // Demux by sessionId: with a graph fanning out subagents, every
        // stream shares this SSE bus. Deltas whose sessionId matches a graph
        // node feed that node's live ticker; other foreign sessions are
        // dropped; only our own session's deltas reach the transcript.
        const node = event.sessionId
          ? activeGraphRef.current?.nodes.find((candidate) => candidate.sessionId === event.sessionId)
          : undefined;
        if (node) {
          const delta = event.delta ?? "";
          setGraphTickers((current) => ({ ...current, [node.id]: ((current[node.id] ?? "") + delta).slice(-200) }));
          return;
        }
        const foreign = Boolean(event.sessionId && sessionIdRef.current && event.sessionId !== sessionIdRef.current);
        if (foreign) return;
        setMessages((current) => {
          const copy = [...current];
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant") {
            copy[copy.length - 1] = { ...last, content: last.content + (event.delta ?? "") };
          } else {
            copy.push({ role: "assistant", content: event.delta ?? "" });
          }
          return copy;
        });
      }
      if (event.type === "agent.usage" && event.usage) {
        // Same demux as deltas: graph-node sessions and foreign sessions must
        // not drive our meter. With no session yet (first turn still in
        // flight) the event is ours.
        const isGraphNode = Boolean(
          event.sessionId &&
            activeGraphRef.current?.nodes.some((candidate) => candidate.sessionId === event.sessionId),
        );
        const foreign = Boolean(event.sessionId && sessionIdRef.current && event.sessionId !== sessionIdRef.current);
        if (!isGraphNode && !foreign) setUsage(event.usage);
      }
      if (event.type === "agent.compacted") {
        // One path renders both manual /compact and core's auto-trigger: the
        // RPC result itself stays silent on success and this event speaks.
        const foreign = Boolean(event.sessionId && sessionIdRef.current && event.sessionId !== sessionIdRef.current);
        if (!foreign) {
          const parts = [
            `Compacted context: archived ${event.archivedMessages ?? 0} message${(event.archivedMessages ?? 0) === 1 ? "" : "s"}`,
          ];
          if (event.prunedToolResults) parts.push(`pruned ${event.prunedToolResults} old tool result${event.prunedToolResults === 1 ? "" : "s"}`);
          if (event.estimatedTokensBefore != null && event.estimatedTokensAfter != null) {
            parts.push(`~${formatTokens(event.estimatedTokensBefore)} → ~${formatTokens(event.estimatedTokensAfter)} tokens`);
          }
          setMessages((current) => [
            ...current,
            { role: "tool", content: parts.join(", "), tool: "compaction" },
          ]);
          if (event.estimatedTokensAfter != null) {
            const after = event.estimatedTokensAfter;
            setUsage((current) => (current ? { ...current, lastPromptTokens: after } : current));
          }
        }
      }
      if (event.type === "graph.updated") {
        // Events carry the full graph snapshot — no diffing.
        const graphEvent = event as unknown as GraphEvent;
        if (graphEvent.graph) {
          applyGraphSnapshot(graphEvent.graph);
          const loopStartedAtMs = loopStartedAtRef.current;
          const createdAtMs = Date.parse(graphEvent.graph.createdAt);
          if (
            loopStartedAtMs != null &&
            graphEvent.phase === "created" &&
            !loopKnownGraphIdsRef.current.has(graphEvent.graph.graphId) &&
            Number.isFinite(createdAtMs) &&
            createdAtMs >= loopStartedAtMs - 1_000
          ) {
            loopObservedGraphIdsRef.current.add(graphEvent.graph.graphId);
          }
        }
      }
      if (event.type === "agent.tool_request" && event.requestId && event.sessionId && event.tool) {
        const owned = ownsBrowserToolEvent(event, {
          clientId: editorClientIdRef.current,
          projectSlug,
          workspaceRoot: workspaceRootRef.current,
          sessionId: sessionIdRef.current,
          activeGraph: activeGraphRef.current,
        });
        if (!owned) return;
        setEventSessionId(event.sessionId);
        const tool = toolsRef.current.find((candidate) => candidate.name === event.tool);
        void (async () => {
          try {
            const result = tool
                ? await tool.handler((event.arguments as Record<string, unknown>) ?? {})
                : { error: `unknown tool ${event.tool}` };
            await rpc("agent_tool_result", { sessionId: event.sessionId, requestId: event.requestId, result });
          } catch (error) {
            await rpc("agent_tool_result", {
              sessionId: event.sessionId,
              requestId: event.requestId,
              result: { error: error instanceof Error ? error.message : String(error) },
            });
          }
        })();
      }
      if (event.type === "editor.tool_request" && event.requestId && event.tool) {
        const owned = ownsBrowserToolEvent(event, {
          clientId: editorClientIdRef.current,
          projectSlug,
          workspaceRoot: workspaceRootRef.current,
          sessionId: sessionIdRef.current,
          activeGraph: activeGraphRef.current,
        });
        if (!owned) return;
        const tool = toolsRef.current.find((candidate) => candidate.name === event.tool);
        void (async () => {
          try {
            const result = tool
                ? await tool.handler((event.arguments as Record<string, unknown>) ?? {})
                : { error: `unknown tool ${event.tool}` };
            await rpc("editor_tool_result", {
              requestId: event.requestId,
              clientId: editorClientIdRef.current,
              result,
            });
          } catch (error) {
            await rpc("editor_tool_result", {
              requestId: event.requestId,
              clientId: editorClientIdRef.current,
              result: { error: error instanceof Error ? error.message : String(error) },
            });
          }
        })();
      }
      if (event.type === "agent.approval_request" && event.requestId && event.tool) {
        setEventSessionId(event.sessionId ?? null);
        setApproval({ requestId: event.requestId, tool: event.tool, arguments: event.arguments });
      }
      if (event.type === "agent.tool_started" && event.tool && eventIsLocalActivity(event)) {
        const turnId = turnForEvent(event);
        if (!turnId) return;
        const toolCallId = event.toolCallId ?? `${event.tool}-${event.startedAtMs ?? Date.now()}`;
        const operation = classifyActivityOperation(event.tool);
        const content = activitySummary(event.tool, operation, event.arguments);
        const startedAtMs = event.startedAtMs ?? Date.now();
        setMessages((current) => {
          if (current.some((message) => message.role === "tool" && message.toolCallId === toolCallId)) return current;
          const next: AgentMessage[] = [
            ...current,
            {
              role: "tool",
              content,
              tool: event.tool,
              toolCallId,
              turnId,
              status: "running",
              startedAtMs,
            },
          ];
          messagesRef.current = next;
          return next;
        });
      }
      if (event.type === "agent.tool_finished" && event.tool && eventIsLocalActivity(event)) {
        const turnId = turnForEvent(event);
        if (!turnId) return;
        const toolCallId = event.toolCallId;
        const finishedAtMs = event.finishedAtMs ?? Date.now();
        const isError =
          typeof event.result === "object" &&
          event.result !== null &&
          "error" in (event.result as Record<string, unknown>);
        const activity = event.activity
          ? buildActivityFileChange(event.activity, {
              tool: event.tool,
              turnId,
              toolCallId,
              projectSlug: event.projectSlug ?? projectSlug,
              workspaceRoot: event.workspaceRoot ?? workspaceRootRef.current,
            })
          : undefined;
        const operation = activity?.operation ?? classifyActivityOperation(event.tool, event.activity?.operation);
        const detail = activityDetail(event.result);
        const resultSummary = activitySummary(event.tool, operation, undefined, activity);
        // Pair by the provider call id. The tool-name fallback is retained for
        // older cores that predate toolCallId, but it is constrained to this
        // turn and a running row so concurrent same-name calls do not cross.
        setMessages((current) => {
          const copy = [...current];
          let index = toolCallId
            ? copy.findIndex(
                (message) => message.role === "tool" && message.toolCallId === toolCallId && message.turnId === turnId,
              )
            : -1;
          if (index < 0) {
            for (let candidateIndex = copy.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
              const candidate = copy[candidateIndex];
              if (
                candidate.role === "tool" &&
                candidate.turnId === turnId &&
                candidate.tool === event.tool &&
                candidate.status === "running"
              ) {
                index = candidateIndex;
                break;
              }
            }
          }
          const candidate = index >= 0 ? copy[index] : undefined;
          const next: AgentMessage = {
            role: "tool",
            content: activity ? resultSummary : candidate?.content || resultSummary || `Ran ${event.tool}`,
            tool: event.tool,
            toolCallId: toolCallId ?? candidate?.toolCallId,
            turnId,
            status: isError ? "error" : "done",
            startedAtMs: event.startedAtMs ?? candidate?.startedAtMs,
            completedAtMs: finishedAtMs,
            detail,
            activity,
          };
          if (index >= 0) copy[index] = { ...copy[index], ...next };
          else copy.push(next);
          messagesRef.current = copy;
          return copy;
        });
      }
    });
    return disconnect;
  }, []);

  // Stick-to-bottom (Hermes-style): follow the stream only while the reader
  // is already near the end; scrolling up detaches, and the floating arrow
  // (or scrolling back down) re-attaches.
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const [activityClockMs, setActivityClockMs] = useState(() => Date.now());
  useEffect(() => {
    if (!busy) {
      setThinkingSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => setThinkingSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  // Notify the parent whenever the session id this panel owns becomes known,
  // changes (e.g. after a fork or a resumed transcript re-keys us), or
  // clears. A turn that starts before the session is created still reports
  // the id once `ensureEditorSession` allocates it, so the sidebar's running
  // indicator lands on the right row even for a brand-new chat.
  useEffect(() => {
    lastOwnedSessionIdRef.current = sessionId;
    onActiveSessionChangeRef.current?.(sessionId);
  }, [sessionId]);
  // The sidebar's running indicator follows busy/looping state, not the
  // session id directly — a turn can complete and the panel can still be
  // "live" for the brief autosave window. Reporting every transition lets
  // the parent keep a Set<string> of currently running sessions without a
  // race against a late save.
  useEffect(() => {
    onSessionRunningChangeRef.current?.(busy || looping, sessionId);
  }, [busy, looping, sessionId]);
  // On unmount, clear the running flag for the session this panel owned so
  // a pending turn never leaves the sidebar's spinner stuck after the user
  // navigates away. We send the last known id (not the current state) so a
  // panel that cleared its session id just before unmount still tells the
  // parent which row to drop.
  useEffect(() => {
    return () => {
      const finalId = lastOwnedSessionIdRef.current;
      lastOwnedSessionIdRef.current = null;
      onSessionRunningChangeRef.current?.(false, finalId);
    };
  }, []);
  useEffect(() => {
    const hasLiveTurn = messages.some((message) => isTurnMarker(message) && message.completedAtMs == null);
    if (!hasLiveTurn) return;
    const timer = window.setInterval(() => setActivityClockMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [messages]);

  const stickToEndRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const handleTranscriptScroll = () => {
    const el = transcriptRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickToEndRef.current = near;
    setAtBottom(near);
  };
  useEffect(() => {
    if (stickToEndRef.current) transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [messages, approval]);

  const refreshSessions = () => {
    void listSessions()
      .then((list) => {
        setSessions(list);
        onSessionsChangedRef.current?.(list);
      })
      .catch(() => {});
  };

  useEffect(() => {
    refreshSessions();
    // The panel is remounted (keyed) per selection, so this runs once per
    // mount: picking a recent in the sidebar opens that saved transcript.
    if (initialSessionId) void resumeSession(initialSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the transcript shortly after it settles, keyed by the session id
  // core assigned. Debounced so a burst of streamed deltas saves once.
  useEffect(() => {
    if (!sessionId) return;
    const hasConversation = messages.some((message) => message.role === "user" || message.role === "assistant");
    if (!hasConversation) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveSession({
        id: sessionId,
        projectSlug,
        provider: modelList?.active.provider ?? null,
        model: modelList?.active.model ?? null,
        workspaceRoot: sessionWorkspaceRoot,
        messages,
      })
        .then(() => refreshSessions())
        .catch(() => {});
    }, 800);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, sessionId, sessionWorkspaceRoot]);

  // The registry index loads once; until it arrives (or offline) the
  // name-based heuristics in modelMeta answer instead.
  useEffect(() => {
    void loadModelDev().then((data) => {
      setEffortIndex(data.index);
      setRegistryCatalog(data.catalog);
    });
    // Compaction tuning for the context meter; offline core just means the
    // meter measures against the built-in default window.
    void readCoreConfig()
      .then(setCoreConfig)
      .catch(() => {});
  }, []);

  const activeModelId = modelList?.active.model ?? "";
  /** Effort for a model: the user's saved pick, else the model's default; null when the model has no effort control. */
  const effortFor = (modelId: string): string | null => {
    const levels = effortLevelsFor(effortIndex, modelId);
    if (levels.length === 0) return null;
    const chosen = effortByModel[modelId];
    return chosen && levels.includes(chosen) ? chosen : defaultEffort(levels);
  };
  const effort = effortFor(activeModelId) ?? undefined;

  const selectEffort = (modelId: string, value: string) => {
    setEffortByModel((current) => {
      const next = { ...current, [modelId]: value };
      try {
        localStorage.setItem(EFFORT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* best effort */
      }
      return next;
    });
  };

  const appendMessage = (
    message: AgentMessage,
    isDuplicate: (current: AgentMessage[]) => boolean = () => false,
  ): boolean => {
    if (isDuplicate(messagesRef.current)) return false;
    const optimistic = [...messagesRef.current, message];
    // The loop worker reads this ref immediately before its next RPC. State
    // updates may be batched, so waiting for a render would reintroduce a
    // restart window and send stale fallback history after a session loss.
    messagesRef.current = optimistic;
    setMessages((current) => {
      if (isDuplicate(current)) {
        messagesRef.current = current;
        return current;
      }
      const next = [...current, message];
      messagesRef.current = next;
      return next;
    });
    return true;
  };

  const say = (content: string, role: "assistant" | "tool" = "assistant") => {
    appendMessage({ role, content });
  };

  const beginActivityTurn = (turnId = crypto.randomUUID(), startedAtMs = Date.now()): string => {
    activeTurnRef.current = { turnId, startedAtMs };
    setMessages((current) => [...current, createTurnMarker(turnId, startedAtMs)]);
    return turnId;
  };

  const completeActivityTurn = (turnId: string, completedAtMs = Date.now()): void => {
    if (activeTurnRef.current?.turnId === turnId) activeTurnRef.current = null;
    setMessages((current) =>
      current.map((message) =>
        isTurnMarker(message) && message.turnId === turnId
          ? { ...message, status: "done" as const, completedAtMs }
          : message,
      ),
    );
  };

  // One agent_chat call with the session-sync protocol: core's live session
  // is the transcript of record and `chat` APPENDS whatever the client sends,
  // so with a known sessionId only the new user message goes over the wire —
  // resending history would duplicate it in core's context and defeat
  // compaction. Without a session (first turn, /new) the local history seeds
  // a fresh one; if core restarted and lost the session ("session not
  // found"), the call is retried once the same seeding way.
  const agentChat = async (
    history: { role: string; content: string }[],
    userMessage: AgentMessage,
    session: string | null,
    attachedWorkspaceRoot: string | null,
    activeLoopId?: string,
  ): Promise<{ sessionId: string; reply: string; toolCalls: unknown[] }> => {
    const base = {
      projectSlug,
      permissionMode,
      effort,
      // Tool-heavy build turns routinely need more than ten model/tool
      // round-trips. Keep the request bounded, but leave enough headroom for
      // a complete build before the explicit loop/continue controls take over.
      maxTurns: 20,
      workspaceRoot: attachedWorkspaceRoot,
      loopId: activeLoopId,
      finalResponseDrain: Boolean(activeLoopId),
    };
    try {
      return (await rpc("agent_chat", {
        ...base,
        sessionId: session,
        messages: session ? [userMessage] : [...history, userMessage],
      })) as { sessionId: string; reply: string; toolCalls: unknown[] };
    } catch (error) {
      const notFound = session && error instanceof Error && /session .*not found|not found/i.test(error.message);
      if (!notFound) throw error;
      return (await rpc("agent_chat", {
        ...base,
        sessionId: null,
        messages: [...history, userMessage],
      })) as { sessionId: string; reply: string; toolCalls: unknown[] };
    }
  };

  const ensureEditorSession = async (): Promise<{ id: string; workspaceRoot: string }> => {
    let id = sessionIdRef.current;
    let root = workspaceRootRef.current;
    if (!id) {
      const created = await createSession(projectSlug);
      id = created.id;
      root = created.workspaceRoot ?? null;
      sessionIdRef.current = id;
      workspaceRootRef.current = root;
      setSessionId(id);
      setSessionWorkspaceRoot(root);
      onSessionActivated?.(created);
    }
    if (!root) throw new Error("session has no workspace to attach");
    await rpc("editor_attach", {
      sessionId: id,
      clientId: editorClientIdRef.current,
      projectSlug,
      workspaceRoot: root,
    });
    return { id, workspaceRoot: root };
  };

  // A single conversation turn. Only real user/assistant messages are replayed —
  // the synthetic role:"tool" ticker entries would be sent as provider tool
  // messages with no preceding tool_calls, a protocol violation that hard-failed
  // every turn after the first with a 502/422.
  const runTurn = async (text: string): Promise<string> => {
    const turnId = crypto.randomUUID();
    const userMessage: AgentMessage = { role: "user", content: text };
    setMessages((current) => [...current, userMessage]);
    beginActivityTurn(turnId);
    setBusy(true);
    try {
      const attached = await ensureEditorSession();
      const history = messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({ role: message.role, content: message.content }));
      const result = await agentChat(history, userMessage, attached.id, attached.workspaceRoot);
      setSessionId(result.sessionId);
      const reply = result.reply || "Done.";
      setMessages((current) => {
        const last = current[current.length - 1];
        if (last?.role === "assistant" && last.content === reply) return current;
        return [...current, { role: "assistant", content: reply }];
      });
      if (result.toolCalls.length > 0) {
        onLog(`agent completed ${result.toolCalls.length} tool calls`);
      }
      return reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMessages((current) => [...current, { role: "assistant", content: `Error: ${message}` }]);
      onLog(`agent error: ${message}`);
      return "";
    } finally {
      completeActivityTurn(turnId);
      setBusy(false);
    }
  };

  const switchModel = async (raw: string) => {
    const separator = raw.indexOf(":");
    const provider = separator >= 0 ? raw.slice(0, separator) : (modelList?.active.provider ?? "openai");
    const model = separator >= 0 ? raw.slice(separator + 1) : raw;
    try {
      await rpc("model_switch", { provider, model });
      onModelChange();
      say(`Switched to ${provider} / ${model}.`);
    } catch (error) {
      say(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Real core compaction (session_compact RPC): prunes old tool results,
  // summarizes the middle via one model call, soft-archives the replaced
  // turns in the session file, and rewrites core's in-memory transcript in
  // place. The client transcript is untouched — the `agent.compacted` event
  // renders the notice for both this manual path and core's auto-trigger.
  const compact = async () => {
    if (busy || looping) return;
    if (!sessionId) {
      say("Nothing to compact yet. Send a message first.");
      return;
    }
    setBusy(true);
    try {
      const result = await rpc<{ compacted: boolean; reason?: string; estimatedTokens?: number }>(
        "session_compact",
        { sessionId },
      );
      if (!result.compacted) {
        say(`Nothing to compact: ${result.reason ?? "context already fits the budget"}.`, "tool");
      }
    } catch (error) {
      say(`Compact failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  // /usage — session token totals plus context occupancy against the window
  // core's compaction budget uses (config compaction.context_length, else the
  // built-in default).
  const usageCommand = () => {
    if (!usage) {
      say("No token usage yet. Send a message first.");
      return;
    }
    const window = contextWindowOf(coreConfig);
    const percent = Math.min(999, Math.round((usage.lastPromptTokens / window) * 100));
    const compaction = coreConfig?.compaction;
    const autoLine =
      compaction && !compaction.auto
        ? "auto-compaction: off"
        : `auto-compacts at ${Math.round((compaction?.threshold ?? 0.75) * 100)}% of the context window`;
    const latestPrompt = usage.lastPromptTokens;
    const latestCached = Math.min(latestPrompt, usage.lastCacheReadTokens ?? 0);
    const cachePercent = latestPrompt > 0 ? Math.round((latestCached / latestPrompt) * 100) : 0;
    say(
      [
        "Token usage this session:",
        `• prompt tokens: ${usage.promptTokens.toLocaleString()}`,
        `• completion tokens: ${usage.completionTokens.toLocaleString()}`,
        `• cache reads: ${(usage.cacheReadTokens ?? 0).toLocaleString()} tokens`,
        `• total tokens: ${usage.totalTokens.toLocaleString()}`,
        `• latest prompt cache: ${latestCached.toLocaleString()} of ${latestPrompt.toLocaleString()} (${cachePercent}%)`,
        `• context: ${formatTokens(usage.lastPromptTokens)} of ${formatTokens(window)} (${percent}%)`,
        `• ${autoLine}`,
      ].join("\n"),
    );
  };

  const diff = async () => {
    if (busy || looping) return;
    await runTurn(
      "List every file you have changed in this session and summarize what changed in each. If nothing changed, say so.",
    );
  };

  const fetchLoopGraphProof = async (context: LoopGraphProofContext): Promise<LoopGraphProof> => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const addId = (graphId: string | undefined) => {
      if (!graphId || seen.has(graphId)) return;
      seen.add(graphId);
      ids.push(graphId);
    };
    for (const graphId of loopObservedGraphIdsRef.current) addId(graphId);
    addId(activeGraphRef.current?.graphId);
    try {
      // New graphs sort first; cap the status refresh so a project with a
      // long graph history cannot turn a single DONE into an unbounded scan.
      const summaries = await listGraphs(projectSlug);
      for (const summary of summaries.slice(0, 32)) addId(summary.graphId);
    } catch {
      // A missing list is not proof of completion. The observed/active graph
      // candidates above are still refreshed authoritatively below.
    }
    const reasons: string[] = [];
    for (const graphId of ids.slice(0, 32)) {
      try {
        const graph = await graphStatus(graphId);
        const proof = validateLoopGraphCompletion(graph, context);
        if (proof.accepted) return proof;
        reasons.push(proof.reason);
      } catch {
        // Treat status failures as missing proof and let the loop continue.
      }
    }
    return {
      accepted: false,
      reason: reasons[0] ?? "authoritative graph status is unavailable",
    };
  };

  // Autonomous loop: drive the agent toward a goal, feeding a "continue" each
  // turn, until it replies DONE, the cap is reached, or the user hits Stop.
  // History is threaded locally because setState lands after the closure reads it.
  const runLoop = async (goal: string) => {
    if (busy || looping) return;
    setLooping(true);
    setBusy(true);
    cancelLoopRef.current = false;
    const activityTurnId = beginActivityTurn();
    let attached: { id: string; workspaceRoot: string };
    try {
      attached = await ensureEditorSession();
    } catch (error) {
      say(`Loop error: ${error instanceof Error ? error.message : String(error)}`);
      completeActivityTurn(activityTurnId);
      setLooping(false);
      setBusy(false);
      return;
    }
    const loopStartedAtMs = Date.now();
    const loopId = `loop-${loopStartedAtMs.toString(36)}`;
    const fetchLoopReportProof = async (): Promise<LoopGraphProof> => {
      try {
        const opened = await openLoopReport(projectSlug, loopId);
        return validateLoopReportCompletion(opened.report, projectSlug, loopId);
      } catch {
        return { accepted: false, reason: "authoritative progress report is unavailable" };
      }
    };
    loopStartedAtRef.current = loopStartedAtMs;
    loopObservedGraphIdsRef.current = new Set();
    try {
      const summaries = await listGraphs(projectSlug);
      loopKnownGraphIdsRef.current = new Set(summaries.map((summary) => summary.graphId));
      loopBaselineAvailableRef.current = true;
    } catch {
      // An unavailable baseline is safe: fresh graph snapshots still need
      // matching creation time and exact session/project/workspace binding.
      loopKnownGraphIdsRef.current = new Set();
      loopBaselineAvailableRef.current = false;
    }
    let localSession = attached.id;
    const reportFailure = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      say(`Progress report unavailable: ${message}`, "tool");
      onLog(`loop report failed: ${message}`);
    };
    const report = await reportLoopBestEffort<{ htmlPath?: string }>(
      "loop_report_start",
      {
        slug: projectSlug,
        loopId,
        objective: goal,
        startedAtMs: loopStartedAtMs,
      },
      reportFailure,
    );
    if (report?.htmlPath) say(`Progress report: ${report.htmlPath}`, "tool");
    let history = messagesRef.current
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: message.content }));
    say(`▶ loop started: ${goal}`, "tool");
    const persistLoopTranscript = async () => {
      try {
        await saveSession({
          id: localSession,
          projectSlug,
          provider: modelList?.active.provider ?? null,
          model: modelList?.active.model ?? null,
          workspaceRoot: attached.workspaceRoot,
          messages: messagesRef.current,
        });
      } catch (error) {
        onLog(`loop transcript save failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    let completed = false;
    let terminalError: { iteration: number; message: string; transient: boolean } | null = null;
    // Bounded retry around the agent RPC for transient fetch/network loss.
    // Provider errors are never retried — they fail closed in the outer catch.
    const MAX_TRANSIENT_RETRIES = 3;
    const TRANSIENT_BACKOFF_MS = 250;
    const runChatWithTransientRetry = async (
      invocation: () => Promise<{ sessionId: string; reply: string; toolCalls: unknown[] }>,
    ): Promise<{ sessionId: string; reply: string; toolCalls: unknown[] }> => {
      let attempt = 0;
      let lastError: unknown;
      while (attempt <= MAX_TRANSIENT_RETRIES) {
        try {
          return await invocation();
        } catch (error) {
          lastError = error;
          if (!isTransientRpcError(error) || attempt === MAX_TRANSIENT_RETRIES) throw error;
          attempt += 1;
          onLog(`loop retry ${attempt}/${MAX_TRANSIENT_RETRIES} after ${error instanceof Error ? error.message : String(error)}`);
          await new Promise((resolve) => window.setTimeout(resolve, TRANSIENT_BACKOFF_MS * attempt));
        }
      }
      throw lastError;
    };
    for (let iteration = 1; iteration <= MAX_LOOP_ITERATIONS; iteration += 1) {
      if (cancelLoopRef.current) {
        say(`■ loop stopped after ${iteration - 1} iterations`, "tool");
        break;
      }
      const userMessage: AgentMessage = {
        role: "user",
        content: loopIterationPrompt(goal, loopId, iteration),
      };
      say(`loop ${iteration}/${MAX_LOOP_ITERATIONS}`, "tool");
      const iterationStartedAtMs = Date.now();
      try {
        const alreadyPersisted = history.some(
          (message) => message.role === "user" && message.content === userMessage.content,
        );
        const historyBeforeMessage = alreadyPersisted
          ? history.filter((message) => !(message.role === "user" && message.content === userMessage.content))
          : history;
        if (!alreadyPersisted) {
          appendMessage(
            userMessage,
            (current) => current.some((message) => message.role === "user" && message.content === userMessage.content),
          );
        }
        history = [...historyBeforeMessage, userMessage];
        // Save before agent_chat: if the provider or core dies mid-iteration,
        // resuming the session still shows the exact loop prompt and context.
        await persistLoopTranscript();
        // A transient browser/core transport blip should retry, not block the
        // loop. Provider/auth errors fall through to the outer catch so the
        // loop still fails closed on those.
        const result = await runChatWithTransientRetry(
          () => agentChat(historyBeforeMessage, userMessage, localSession, attached.workspaceRoot, loopId),
        );
        localSession = result.sessionId;
        setSessionId(result.sessionId);

        // The report exists before the coordinator chooses a quality bar.
        // Persist the first fresh graph's Judge reference mechanically so a
        // model that plans correctly but forgets to repeat loop_report_start
        // cannot leave the durable report anonymous.
        const latestGraph = activeGraphRef.current;
        const graphReference = latestGraph ? graphQualityReference(latestGraph) : null;
        if (
          latestGraph &&
          graphReference &&
          loopObservedGraphIdsRef.current.has(latestGraph.graphId) &&
          latestGraph.projectSlug === projectSlug &&
          latestGraph.ownerSession === localSession &&
          latestGraph.workspaceRoot === attached.workspaceRoot
        ) {
          await reportLoopBestEffort(
            "loop_report_start",
            {
              slug: projectSlug,
              loopId,
              objective: goal,
              reference: graphReference,
              startedAtMs: loopStartedAtMs,
            },
            reportFailure,
          );
        }

        const reply = result.reply || "Done.";
        history = [...history, { role: "assistant", content: reply }];
        appendMessage(
          { role: "assistant", content: reply },
          (current) => current.at(-1)?.role === "assistant" && current.at(-1)?.content === reply,
        );
        const doneRequested = /(^|\n)\s*DONE\s*($|\n|$)/i.test(reply);
        let proof: LoopGraphProof = { accepted: false, reason: "agent did not return DONE" };
        if (doneRequested) {
          proof = await fetchLoopGraphProof({
            loopStartedAtMs,
            projectSlug,
            sessionId: localSession,
            workspaceRoot: attached.workspaceRoot,
            baselineAvailable: loopBaselineAvailableRef.current,
            knownGraphIds: loopKnownGraphIdsRef.current,
            observedGraphIds: loopObservedGraphIdsRef.current,
          });
          if (proof.accepted) proof = await fetchLoopReportProof();
        }
        if (doneRequested && !proof.accepted) {
          say(
            `DONE ignored: ${proof.reason}. Continue working and provide three independent specialist build roots, a separate integration build, a fresh terminal judge at or above ${DEFAULT_JUDGE_THRESHOLD}, and at least three persisted visual frames.`,
            "tool",
          );
        }
        const alreadyRecorded = hasRecordedLoopIteration(result.toolCalls, projectSlug, loopId);
        if (!alreadyRecorded) {
          const completedAtMs = Date.now();
          const outcome = proof.accepted ? "passed" : "needs-work";
          const changedFiles = fallbackLoopChangedFiles(messagesRef.current, activityTurnId);
          await reportLoopBestEffort(
            "loop_report_iteration",
            {
              slug: projectSlug,
              loopId,
              iteration: {
                startedAtMs: iterationStartedAtMs,
                completedAtMs,
                outcome,
                summary: reply.slice(0, 12_000) || `Iteration ${iteration} returned no summary.`,
                agents: [],
                checks: [],
                changedFiles,
                evidence: [],
                scores: [],
                punchList: [],
                nextIterationMemory: {
                  observations: [],
                  decisions: [],
                  risks: outcome === "passed" ? [] : ["No structured judge evidence was recorded by the agent."],
                  nextActions: outcome === "passed" ? [] : ["Continue from the latest reply and collect primary evidence."],
                },
              },
            },
            reportFailure,
          );
        }
        if (proof.accepted) {
          await reportLoopBestEffort(
            "loop_report_update",
            {
              slug: projectSlug,
              loopId,
              update: {
                status: "completed",
                completedAtMs: Date.now(),
                recordedAtMs: Date.now(),
                summary: reply,
              },
            },
            reportFailure,
          );
          say(`✔ loop complete in ${iteration} iterations`, "tool");
          completed = true;
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Any tool row that started via `agent.tool_started` mid-iteration
        // would otherwise stay `status: "running"` forever once the iteration
        // exits. Mark them errored with a synthetic finish before the
        // terminal report so the transcript reads cleanly on resume.
        terminalError = { iteration, message, transient: isTransientRpcError(error) };
        const announce = terminalError.transient
          ? `Loop blocked at iteration ${iteration}: editor disconnected (${message})`
          : `Loop blocked at iteration ${iteration}: ${message}`;
        say(announce, "tool");
        break;
      }
    }
    if (terminalError) {
      const settled = Date.now();
      const settledMessages = settleRunningToolRows(messagesRef.current, activityTurnId, settled);
      if (settledMessages !== messagesRef.current) {
        messagesRef.current = settledMessages;
        setMessages(settledMessages);
      }
      await persistLoopTranscript();
      await reportLoopBestEffort(
        "loop_report_update",
        {
          slug: projectSlug,
          loopId,
          update: {
            status: "blocked",
            completedAtMs: Date.now(),
            recordedAtMs: Date.now(),
            summary: terminalError.transient
              ? `Loop blocked at iteration ${terminalError.iteration}: editor disconnected (${terminalError.message}) — attempts exhausted`
              : `Loop blocked at iteration ${terminalError.iteration}: ${terminalError.message}`,
          },
        },
        reportFailure,
      );
    } else if (!completed && !cancelLoopRef.current) {
      say(`loop hit the ${MAX_LOOP_ITERATIONS}-iteration cap`, "tool");
      await reportLoopBestEffort(
        "loop_report_update",
        {
          slug: projectSlug,
          loopId,
          update: {
            status: "blocked",
            completedAtMs: Date.now(),
            recordedAtMs: Date.now(),
            summary: `Loop hit the ${MAX_LOOP_ITERATIONS}-iteration cap before passing its judge.`,
          },
        },
        reportFailure,
      );
    } else if (cancelLoopRef.current) {
      await reportLoopBestEffort(
        "loop_report_update",
        {
          slug: projectSlug,
          loopId,
          update: {
            status: "cancelled",
            completedAtMs: Date.now(),
            recordedAtMs: Date.now(),
            summary: "Loop stopped by the user.",
          },
        },
        reportFailure,
      );
    }
    completeActivityTurn(activityTurnId);
    loopStartedAtRef.current = null;
    loopBaselineAvailableRef.current = false;
    loopKnownGraphIdsRef.current = new Set();
    loopObservedGraphIdsRef.current = new Set();
    setLooping(false);
    setBusy(false);
  };

  const stopLoop = () => {
    cancelLoopRef.current = true;
  };

  const resumeSession = async (id: string) => {
    if (looping) return;
    try {
      activeTurnRef.current = null;
      const record = await loadSession(id);
      setSessionId(record.id);
      setSessionWorkspaceRoot(record.workspaceRoot ?? workspaceRoot);
      sessionIdRef.current = record.id;
      workspaceRootRef.current = record.workspaceRoot ?? workspaceRoot;
      if (record.workspaceRoot ?? workspaceRoot) {
        await rpc("editor_attach", {
          sessionId: record.id,
          clientId: editorClientIdRef.current,
          projectSlug,
          workspaceRoot: record.workspaceRoot ?? workspaceRoot,
        });
      }
      setUsage(null);
      // Resume silently — a notice here would be appended to `messages` and
      // then persisted by the autosave, permanently growing the transcript by
      // one line per resume. The filter scrubs lines older builds baked in,
      // plus previously persisted archive rows (re-derived fresh below so the
      // count never duplicates).
      const restored = (record.messages ?? [])
        .filter(
          (message) =>
            !(message.role === "tool" && /^Resumed “.*”\.$/.test(message.content)) &&
            !(message.role === "tool" && message.tool === "compaction" && /^\d+ archived message/.test(message.content)),
        )
        .map((message) =>
          message.role === "tool" && message.toolCallId && !message.activity
            ? { ...message, content: repairLegacyActivitySummary(message.tool, message.content) }
            : message,
        );
      // Turns core's compaction soft-archived render as one collapsed row at
      // the top: the summary line stays cheap, the raw turns sit in `detail`.
      const archived = Array.isArray(record.archived) ? record.archived : [];
      if (archived.length > 0) {
        restored.unshift({
          role: "tool",
          tool: "compaction",
          content: `${archived.length} archived message${archived.length === 1 ? "" : "s"} from earlier compactions`,
          detail: JSON.stringify(archived, null, 2).slice(0, 20_000),
        });
      }
      const resumedAt = Number.isFinite(record.updatedAt) && record.updatedAt > 0 ? record.updatedAt * 1000 : Date.now();
      setMessages(
        restored.map((message) =>
          isTurnMarker(message) && message.completedAtMs == null
            ? { ...message, status: "done" as const, completedAtMs: resumedAt }
            : message,
        ),
      );
    } catch (error) {
      say(`Resume failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const resumeLast = async () => {
    const candidate = sessions.find((session) => session.id !== sessionId) ?? sessions[0];
    if (!candidate) {
      say("No saved sessions yet.");
      return;
    }
    await resumeSession(candidate.id);
  };

  const forkCurrent = async () => {
    if (!sessionId) {
      say("No session to fork yet. Send a message first.");
      return;
    }
    try {
      activeTurnRef.current = null;
      const record = await forkSession(sessionId);
      setSessionId(record.id);
      setSessionWorkspaceRoot(record.workspaceRoot ?? workspaceRoot);
      sessionIdRef.current = record.id;
      workspaceRootRef.current = record.workspaceRoot ?? workspaceRoot;
      onSessionActivated?.({ ...record, messageCount: record.messages.length });
      if (record.workspaceRoot ?? workspaceRoot) {
        await rpc("editor_attach", {
          sessionId: record.id,
          clientId: editorClientIdRef.current,
          projectSlug,
          workspaceRoot: record.workspaceRoot ?? workspaceRoot,
        });
      }
      say(`Forked to a new session “${record.title}”.`, "tool");
      refreshSessions();
    } catch (error) {
      say(`Fork failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const listSessionsCommand = async () => {
    const current = await listSessions().catch(() => [] as SessionSummary[]);
    setSessions(current);
    if (current.length === 0) {
      say("No saved sessions yet.");
      return;
    }
    const lines = current
      .slice(0, 12)
      .map((session) => `• ${session.title}: ${session.messageCount} msgs, ${relativeTime(session.updatedAt)}`);
    say(["Saved sessions (pick one from the sidebar):", ...lines].join("\n"));
  };

  const spawnSubagent = async (role: string, task: string) => {
    if (!task || busy) return;
    setBusy(true);
    try {
      const result = await rpc<SubagentResult>("subagent_spawn", {
        role,
        instructions: task,
        projectSlug,
        maxTurns: 8,
      });
      setMessages((current) => [
        ...current,
        { role: "tool", content: `${result.role} subagent: ${result.reply}`, tool: result.role },
      ]);
      onLog(`${result.role} subagent finished in ${result.turns} turns`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMessages((current) => [...current, { role: "tool", content: `subagent error: ${message}`, tool: role }]);
      onLog(`subagent error: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  // Plan a graph and fire the run without awaiting it — `graph.updated`
  // events drive the panel; the promise resolution appends a summary bubble.
  const runGraphGoal = async (goal: string, template?: string) => {
    try {
      const attached = await ensureEditorSession();
      const graph = await planGraph({
        goal,
        slug: projectSlug,
        ownerSession: attached.id,
        workspaceRoot: attached.workspaceRoot,
        ...(template ? { template } : {}),
      });
      applyGraphSnapshot(graph);
      setGraphTickers({});
      say(`▶ graph ${graph.graphId} planned: ${graph.nodes.length} nodes${template ? ` (template ${template})` : ""}`, "tool");
      void runGraph(graph.graphId)
        .then((rollup) =>
          say(
            `Graph ${rollup.status}: ${rollup.passed} passed, ${rollup.failed} failed, ${rollup.totalAttempts} attempt${
              rollup.totalAttempts === 1 ? "" : "s"
            }.`,
            "tool",
          ),
        )
        .catch((error) => say(`Graph run failed: ${error instanceof Error ? error.message : String(error)}`));
    } catch (error) {
      say(`Graph plan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const stopGraph = () => {
    const graphId = activeGraphRef.current?.graphId;
    if (!graphId) {
      say("No active graph to stop.");
      return;
    }
    void cancelGraph(graphId).catch((error) =>
      say(`Graph cancel failed: ${error instanceof Error ? error.message : String(error)}`),
    );
    say("Requested graph cancel. The current node finishes first.", "tool");
  };

  const slashContext: SlashContext = {
    say,
    clear: () => setMessages([]),
    newSession: () => {
      activeTurnRef.current = null;
      setSessionId(null);
      setUsage(null);
      setMessages([{ role: "tool", content: "Started a new session.", tool: "session" }]);
    },
    switchModel,
    runLoop,
    compact,
    usage: usageCommand,
    diff,
    resumeLast,
    fork: forkCurrent,
    listSessions: listSessionsCommand,
    spawnSubagent,
    runGraphGoal,
    stopGraph,
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy || looping) return;
    setInput("");
    setMenuIndex(0);
    const parsed = parseSlash(text);
    if (parsed) {
      if (!parsed.command) {
        say(`Unknown command /${parsed.name}. Type /help for the list.`);
        return;
      }
      await parsed.command.run(parsed.args, slashContext);
      return;
    }
    await runTurn(text);
  };

  const respondToApproval = async (approved: boolean) => {
    if (!approval) return;
    const targetSession = eventSessionId ?? sessionId;
    if (!targetSession) return;
    try {
      await rpc("agent_approval_response", { sessionId: targetSession, requestId: approval.requestId, approved });
      setMessages((current) => [
        ...current,
        { role: "tool", content: approved ? `Approved ${approval.tool}` : `Denied ${approval.tool}`, tool: approval.tool },
      ]);
    } finally {
      setApproval(null);
    }
  };

  // Context meter: occupancy = the last model call's prompt size against the
  // window core's compaction budget measures (see /usage).
  const contextWindow = contextWindowOf(coreConfig);
  const contextPercent = usage ? Math.min(100, Math.round((usage.lastPromptTokens / contextWindow) * 100)) : 0;

  const commandMenu = matchCommands(input);
  const menuActive = commandMenu.length > 0;
  const activeMenuIndex = Math.min(menuIndex, commandMenu.length - 1);
  const workedMs = sessionWorkedMs(messages, activityClockMs);
  const activityGroups = new Map<string, AgentMessage[]>();
  for (const message of messages) {
    if (!message.turnId) continue;
    const group = activityGroups.get(message.turnId) ?? [];
    group.push(message);
    activityGroups.set(message.turnId, group);
  }
  // A collapsed turn stands in for every tool row in that turn, but belongs
  // at the newest action's timeline position. Anchoring it at the synthetic
  // start marker would place late tool work above narration that happened
  // first, which makes a resumed transcript read out of order.
  const activityAnchors = activityAnchorIndexes(messages);

  const completeCommand = (name: string) => {
    setInput(`/${name} `);
    setMenuIndex(0);
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {activeGraph ? (
        <div className="max-h-[45%] shrink-0 overflow-y-auto">
          <GraphPanel
            graph={activeGraph}
            tickers={graphTickers}
            onCancel={(graphId) => void cancelGraph(graphId).catch(() => {})}
            onRerun={(graphId) => {
              setGraphTickers({});
              void runGraph(graphId).catch((error) =>
                say(`Graph re-run failed: ${error instanceof Error ? error.message : String(error)}`),
              );
            }}
          />
        </div>
      ) : null}

      <div ref={transcriptRef} onScroll={handleTranscriptScroll} className="relative min-h-0 flex-1 overflow-y-auto px-[18px] pb-2 pt-[18px]">
        {messages.length === 0 && (
          <div className="absolute inset-0 flex select-none items-center justify-center px-5">
            <div className="flex w-full max-w-[560px] flex-col items-center text-center">
              <div className="font-mono text-[52px] font-bold leading-none tracking-[-0.04em]">
                <span className="text-ink-faint">cali</span>
                <span className="text-ink-strong">code</span>
              </div>
              <div className="mt-2.5 flex items-center justify-center gap-2 font-mono">
                <span
                  data-empty-game-hint
                  className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] leading-none text-ink-subtle"
                >
                  <span aria-hidden className="text-ink-faint">▸</span>
                  {projectSlug}
                </span>
              </div>
              <p className="mt-5 text-[13px] text-ink-subtle">Build, run, and improve the game from one task.</p>
              <div className="mt-4 grid w-full grid-cols-2 gap-2">
                {GAME_STARTERS.map((starter) => {
                  const Icon = starter.icon;
                  return (
                    <button
                      key={starter.label}
                      type="button"
                      onClick={() => {
                        setInput(starter.prompt);
                        window.requestAnimationFrame(() => inputRef.current?.focus());
                      }}
                      className="flex min-h-10 items-center gap-2 rounded-lg border border-line bg-surface-1 px-3 py-2 text-left text-[12px] text-ink transition-colors hover:bg-surface-2 active:bg-surface-3 focus-visible:outline-none"
                    >
                      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" strokeWidth={1.7} />
                      <span>{starter.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Now that the conversation is the app's center column, the readable
            measure is capped and centered rather than filling the panel. */}
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-[18px]">
          {messages.map((message, index) => {
            if (message.turnId) {
              if (activityAnchors.get(message.turnId) !== index) return null;
              return (
                <ActivityTurnRow
                  key={`activity-${message.turnId}`}
                  turnId={message.turnId}
                  messages={activityGroups.get(message.turnId) ?? [message]}
                  onOpenFile={onOpenActivityFile}
                />
              );
            }
            if (message.role === "user") {
              return (
                <div
                  key={index}
                  data-role="user"
                  className="max-w-[88%] self-end rounded-[9px_9px_2px_9px] bg-surface-3 px-3.5 py-2.5 text-[13px] leading-[1.55] text-ink-strong"
                >
                  {message.content}
                </div>
              );
            }
            if (message.role === "tool") return <ToolRow key={index} message={message} />;
            return (
              <div key={index} data-role="assistant" className="max-w-[94%] self-start">
                <div className="mb-1.5 text-[9.5px] tracking-[0.24em] text-ink-subtle">CALICODE</div>
                <div className="text-[13px] leading-[1.6] text-ink">
                  <AgentText content={message.content} />
                </div>
              </div>
            );
          })}

          {busy && (
            <div className="self-start" aria-label="Agent is thinking">
              <div className="flex items-baseline gap-2">
                <span className="cb-shimmer text-[12.5px] font-medium">
                  {messages.some((message) => message.status === "running") ? "Working…" : "Thinking…"}
                </span>
                {thinkingSeconds > 0 ? <span className="text-[10.5px] text-ink-faint">{thinkingSeconds}s</span> : null}
              </div>
            </div>
          )}

          {approval && (
            <div className="w-full self-start rounded-lg border border-line-strong bg-surface-1 p-3">
              <p className="text-[13px] text-ink-strong">Approve {approval.tool}?</p>
              <pre className="mt-1.5 max-h-24 overflow-auto text-[11px] text-ink-subtle">
                {JSON.stringify(approval.arguments, null, 2)}
              </pre>
              <div className="mt-2.5 flex gap-2">
                <Button size="sm" onClick={() => void respondToApproval(true)}>
                  <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Approve
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void respondToApproval(false)}>
                  <ShieldOff className="mr-1 h-3.5 w-3.5" /> Deny
                </Button>
              </div>
            </div>
          )}
        </div>

        {!atBottom && (
          <div className="pointer-events-none sticky bottom-2 flex justify-center">
            <button
              type="button"
              aria-label="Scroll to latest"
              onClick={() =>
                transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" })
              }
              className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-full border border-line-strong bg-raised text-ink-subtle shadow-md transition-colors hover:text-ink-strong active:bg-surface-2"
            >
              <ArrowDown aria-hidden className="h-3.5 w-3.5" strokeWidth={1.8} />
            </button>
          </div>
        )}
      </div>

      <div className="shrink-0 bg-surface-0 px-3.5 pb-3.5 pt-2.5">
        <div className="mx-auto w-full max-w-[760px]">
        {messages.some((message) => isTurnMarker(message)) ? (
          <div
            data-session-worked-time
            className="mb-2 flex items-center gap-1.5 px-1 text-[10px] text-ink-faint"
            aria-label={`Worked ${formatDuration(workedMs)} this session`}
          >
            <Clock3 aria-hidden className="h-3 w-3" strokeWidth={1.8} />
            <span>Worked {formatDuration(workedMs)} this session</span>
          </div>
        ) : null}
        {menuActive && (
          <div className="mb-2 overflow-hidden rounded-[10px] border border-line-strong bg-popover">
            {commandMenu.map((command, index) => (
              <button
                key={command.name}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  completeCommand(command.name);
                }}
                className={`flex min-h-[28px] w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs transition-colors focus-visible:outline-none active:bg-surface-3 ${
                  index === activeMenuIndex ? "bg-surface-2" : "hover:bg-surface-2"
                }`}
              >
                <span className="font-mono text-ink-strong">/{command.name}</span>
                {command.usage && <span className="font-mono text-[10px] text-ink-faint">{command.usage}</span>}
                <span className="ml-auto truncate text-ink-subtle">{command.summary}</span>
              </button>
            ))}
          </div>
        )}

        <div
          data-agent-composer
          className="@container min-w-0 rounded-[20px] border border-line-strong bg-raised p-1.5 shadow-[0_14px_34px_rgba(0,0,0,0.18)] transition-[border-color,box-shadow] duration-200 focus-within:border-ink-faint focus-within:shadow-[0_16px_38px_rgba(0,0,0,0.24)]"
        >
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (menuActive) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMenuIndex((current) => (current + 1) % commandMenu.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMenuIndex((current) => (current - 1 + commandMenu.length) % commandMenu.length);
                  return;
                }
                if (event.key === "Tab") {
                  event.preventDefault();
                  completeCommand(commandMenu[activeMenuIndex].name);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !parseSlash(input)?.command) {
                  event.preventDefault();
                  completeCommand(commandMenu[activeMenuIndex].name);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            aria-label="Agent prompt"
            placeholder="What should we build or improve?  Type / for commands"
            className="min-h-[56px] resize-none border-0 bg-transparent px-3 py-2.5 text-[13px] leading-[1.55] text-ink-strong shadow-none placeholder:text-ink-faint focus-visible:!outline-none"
          />
          <div className="flex min-h-10 items-center gap-1.5 px-1.5 pb-0.5">
            <Select value={permissionMode} onValueChange={setPermissionMode}>
              <SelectTrigger
                className={`h-8 w-[132px] shrink-0 justify-start gap-1.5 whitespace-nowrap rounded-full border-0 bg-transparent px-2 text-[11px] tracking-normal shadow-none transition-colors hover:bg-surface-2 ${
                  permissionMode === "full-access" ? "text-[#e58a52]" : "text-ink-subtle"
                }`}
                aria-label="Permission mode"
              >
                <ShieldCheck aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                {/* Manual label instead of <SelectValue />: SelectItem portals
                    its whole children (label + hint) into the value slot. */}
                <span className="truncate">
                  {PERMISSION_OPTIONS.find((option) => option.value === permissionMode)?.label ?? permissionMode}
                </span>
              </SelectTrigger>
              <SelectContent className="min-w-[300px]">
                {PERMISSION_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex flex-col items-start gap-1 py-0.5">
                      <span className="text-[13px] leading-none text-ink-strong">{option.label}</span>
                      <span className="text-[11px] leading-snug text-ink-faint">{option.hint}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Compact tokens/context meter — driven by agent.usage events;
                hidden until the first model call reports usage. The bar warns
                as occupancy approaches the auto-compaction threshold. */}
            {usage ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    aria-label={`Context ${contextPercent}% full`}
                    className="hidden shrink-0 cursor-default items-center gap-1.5 @[420px]:flex"
                  >
                    <div className="h-1 w-10 overflow-hidden rounded-full bg-surface-3">
                      <div
                        className={`h-full rounded-full transition-[width] duration-300 ${
                          contextPercent >= 90 ? "bg-danger-soft" : contextPercent >= 70 ? "bg-[#e58a52]" : "bg-ink-faint"
                        }`}
                        style={{ width: `${Math.max(contextPercent, 4)}%` }}
                      />
                    </div>
                    <span className="text-[10px] tabular-nums text-ink-faint">
                      {formatTokens(usage.lastPromptTokens)} · {contextPercent}%
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {usage.totalTokens.toLocaleString()} tokens this session, context{" "}
                  {formatTokens(usage.lastPromptTokens)} of {formatTokens(contextWindow)}. /usage for details.
                </TooltipContent>
              </Tooltip>
            ) : null}

            {/* Model + effort as one control: the trigger reads
                "model · effort" and sizes to its text; each model in the menu
                opens an effort submenu on hover, so picking an effort picks
                the model with it. */}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  aria-label="Active model"
                  disabled={!modelList || modelChoices.length === 0 || busy || looping}
                  title={modelList ? `${modelList.active.provider} · ${modelList.active.model}${effort ? ` · ${effort}` : ""}` : "No model"}
                  className="ml-auto flex h-8 max-w-[320px] shrink items-center gap-1.5 rounded-full px-2 text-[10.5px] text-ink-subtle transition-colors enabled:hover:bg-surface-2 enabled:hover:text-ink focus-visible:outline-none disabled:opacity-50 data-[state=open]:bg-surface-2"
                >
                  <Zap aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink" strokeWidth={1.8} />
                  {/* In a narrow composer the model name is the first thing to
                      go: the trigger collapses to the bolt icon alone (the
                      title/aria-label still carry the full model). */}
                  <span className="hidden min-w-0 truncate @[360px]:inline">
                    {activeModelId ? `${activeModelId}${effort ? ` · ${effort}` : ""}` : "No model"}
                  </span>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={6}
                  collisionPadding={8}
                  className="z-50 max-h-[min(480px,60vh)] min-w-[300px] max-w-[420px] overflow-y-auto rounded-[14px] border border-line bg-popover p-1.5 text-[13px] text-popover-foreground shadow-[0_18px_45px_rgba(0,0,0,0.28)] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
                >
                  {modelChoices.map((choice) => {
                    const active = choice.value === activeModelValue;
                    const levels = effortLevelsFor(effortIndex, choice.label);
                    const rowBody = (
                      <>
                        <Check
                          aria-hidden
                          className={`h-3.5 w-3.5 shrink-0 ${active ? "text-ink-strong" : "opacity-0"}`}
                          strokeWidth={2}
                        />
                        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                          <span className="max-w-full truncate font-mono text-[12.5px] leading-tight text-ink-strong">
                            {choice.label}
                          </span>
                          <span className="text-[10.5px] leading-tight text-ink-faint">{choice.hint}</span>
                        </span>
                      </>
                    );
                    // Registry says this model has no effort control: a plain
                    // row that just switches the model.
                    if (levels.length === 0) {
                      return (
                        <DropdownMenu.Item
                          key={choice.value}
                          onSelect={() => {
                            if (!active) void switchModel(choice.value);
                          }}
                          className="flex min-h-8 w-full cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 outline-none transition-colors data-[highlighted]:bg-surface-2"
                        >
                          {rowBody}
                        </DropdownMenu.Item>
                      );
                    }
                    const chosen = effortByModel[choice.label];
                    const modelEffort = chosen && levels.includes(chosen) ? chosen : defaultEffort(levels);
                    return (
                      <DropdownMenu.Sub key={choice.value}>
                        <DropdownMenu.SubTrigger className="flex min-h-8 w-full cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 outline-none transition-colors data-[highlighted]:bg-surface-2 data-[state=open]:bg-surface-2">
                          {rowBody}
                          <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" strokeWidth={1.8} />
                        </DropdownMenu.SubTrigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.SubContent
                            sideOffset={6}
                            collisionPadding={8}
                            className="z-50 min-w-[150px] rounded-[12px] border border-line bg-popover p-1 text-[12px] text-popover-foreground shadow-[0_18px_45px_rgba(0,0,0,0.28)] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
                          >
                            <DropdownMenu.Label className="px-2 py-1 text-[10px] font-medium text-ink-faint">
                              Reasoning effort
                            </DropdownMenu.Label>
                            {levels.map((level) => (
                              <DropdownMenu.Item
                                key={level}
                                onSelect={() => {
                                  selectEffort(choice.label, level);
                                  if (!active) void switchModel(choice.value);
                                }}
                                className="flex min-h-7 cursor-default select-none items-center gap-2 rounded-md px-2 py-1 capitalize outline-none transition-colors data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink-strong"
                              >
                                <Check
                                  aria-hidden
                                  className={`h-3 w-3 shrink-0 ${modelEffort === level ? "text-ink-strong" : "opacity-0"}`}
                                  strokeWidth={2}
                                />
                                {level}
                              </DropdownMenu.Item>
                            ))}
                          </DropdownMenu.SubContent>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Sub>
                    );
                  })}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>

            {looping ? (
              <button
                type="button"
                aria-label="Stop agent loop"
                onClick={stopLoop}
                disabled={cancelLoopRef.current}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#7a2a2a] bg-[#3a1f1f] text-[#f0c0c0] transition-[background-color,transform] enabled:hover:bg-[#492525] enabled:active:scale-[0.96] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Square aria-hidden className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send message"
                onClick={() => void send()}
                disabled={busy || !input.trim()}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[background-color,transform,opacity] enabled:hover:opacity-90 enabled:active:scale-[0.96] focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-faint disabled:opacity-70"
              >
                <ArrowUp aria-hidden className="h-4 w-4" strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
