import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Eye,
  FilePenLine,
  Gamepad2,
  Hand,
  Loader2,
  MessageCircleQuestion,
  ScanSearch,
  Search,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  ShieldPlus,
  Square,
  Terminal,
  TestTube2,
  X,
  Workflow,
} from "lucide-react";
import { AgentText } from "./AgentText";
import { CommandPanelView } from "./CommandPanels";
import { ReasoningRow } from "./ReasoningRow";
import { ModelPicker, buildModelChoices } from "./ModelPicker";
import { RunStatusPill, type ActiveLoopRun } from "./RunStatusPill";
import type { SideChatAnchor } from "./SideChat";
import { SlashMenu } from "./SlashMenu";
import { TurnFileSummaryCard } from "./TurnFileSummaryCard";
import {
  checkpointTakenAtMs,
  formatCheckpointAge,
  formatCheckpointList,
  restoreWarning,
  type CheckpointKind,
  type ListedCheckpoint,
} from "../../lib/checkpoints";
import { SubagentChips, type SubagentChipItem } from "./SubagentChips";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { connectEvents, rpc, type AgentEvent, type UsageTotals } from "../../lib/rpc";
import { classifySendFailure, route } from "../../lib/approvalRouter";
import {
  APPROVAL_TTL_MS,
  approvalTarget,
  argumentsWorthShowing,
  emptyStore,
  headApproval,
  lapsedExplanation,
  planFrom,
  reduce,
  visibleApprovals,
  type ApprovalEntry,
  type ApprovalEvent,
  type ApprovalStore,
  type LapsedReason,
  type ResolvedOutcome,
} from "../../lib/approvalStore";
import {
  contextWindowOf,
  formatTokens,
  readCoreConfig,
  sandboxSummary,
  type CoreConfig,
} from "../../lib/coreConfig";
import {
  listAgentDefs,
  listFileCommands,
  listSkills,
  renderFileCommand,
  type FileCommandInfo,
  type SkillInfo,
} from "../../lib/extensions";
import {
  DEFAULT_LOOP_PROFILE,
  formatInterval,
  type LoopProfile,
} from "../../lib/interval";
import {
  SLASH_COMMANDS,
  completeSlashToken,
  matchCommandsIn,
  runsBare,
  parseSlashIn,
  fileCommands,
  skillCommands,
  slashTokenAt,
  type SlashCommand,
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
import {
  contextLimitFor,
  defaultEffort,
  effortLevelsFor,
  loadModelDev,
  type ContextLimits,
  type GuardianModels,
  type EffortIndex,
} from "../../lib/modelMeta";
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
  summariseChangedFiles,
  type ActivityAction,
  type ActivityFileChange,
} from "../../lib/activity";
import {
  listLoopRuns,
  openLoopReport,
  startLoopRun,
  stopLoopRun,
  type LoopReport,
} from "../../lib/loopReports";
import type {
  AgentMessage,
  BrowserTool,
  CommandPanel,
  ModelList,
  SubagentResult,
} from "../../lib/types";

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

/** Items and characters of carry-forward inlined into an iteration prompt. */
const CARRY_ITEM_CAP = 6;
const CARRY_CHARS_CAP = 1_200;

/**
 * The previous iteration's unresolved punch list and memory, as prompt text.
 *
 * The report on disk stays the source of truth — it outlives the session and
 * is what the REPORTS page renders. But telling the model to go read it makes
 * remembering optional: a skipped `loop_report_open` loses the whole carry
 * silently, and the completion gate only checks that memory *exists*, not that
 * anyone used it. Inlining the latest slice costs a bounded amount of prompt
 * and removes the turn that fetching it would take.
 */
export function loopCarryForward(report: LoopReport): string {
  const latest = report.iterations.at(-1);
  if (!latest) return "";
  const lines: string[] = [];
  const unresolved = latest.punchList.filter((item) => !item.resolved);
  if (unresolved.length > 0) {
    lines.push(
      `Unresolved punch list: ${unresolved
        .slice(0, CARRY_ITEM_CAP)
        .map((item) => `[${item.priority}] ${item.item}`)
        .join("; ")}`,
    );
  }
  const memory = latest.nextIterationMemory;
  const groups: Array<[string, string[]]> = [
    ["Next actions", memory.nextActions],
    ["Decisions to keep", memory.decisions],
    ["Risks", memory.risks],
    ["Observations", memory.observations],
  ];
  for (const [label, values] of groups) {
    if (values.length > 0) lines.push(`${label}: ${values.slice(0, CARRY_ITEM_CAP).join("; ")}`);
  }
  if (lines.length === 0) return "";
  const block = `Carried forward from iteration ${latest.iteration} (${latest.outcome}): ${lines.join(" | ")}`;
  return block.length > CARRY_CHARS_CAP ? `${block.slice(0, CARRY_CHARS_CAP)}…` : block;
}

export function loopIterationPrompt(
  goal: string,
  loopId: string,
  iteration: number,
  carry = "",
): string {
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
  const carried = carry
    ? `${carry} Treat that as already read — open the report only if you need detail it omits. `
    : "Read loop_report_open first and use its nextIterationMemory plus punch list. ";
  return `Continue /loop ${loopId}, iteration ${iteration}, toward the goal. ${carried}${topology} ${verification} ${reporting} When a fresh judge crosses threshold, the report has at least two iterations, and every check passes, call loop_report_update and reply with exactly DONE on its own line and nothing else.`;
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

/**
 * This window's stable id.
 *
 * Per-tab, and deliberately not shared: core addresses each approval at
 * exactly one client id, and two windows answering to the same id would put
 * two panels back in one inbox — the condition the address exists to remove.
 * A reload keeps the id so prompts raised before it are still answerable.
 */
export function readEditorClientId(): string {
  const KEY = "cali.editorClientId";
  try {
    const stored = window.sessionStorage.getItem(KEY);
    if (stored && stored.trim().length > 0) return stored;
    const fresh = crypto.randomUUID();
    window.sessionStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    // Private mode or a locked-down webview: a per-mount id still works, it
    // just does not survive a reload.
    return crypto.randomUUID();
  }
}

/**
 * When core says it raised this prompt, sanity-checked.
 *
 * Core and the client run on the same machine, so this is normally exact. A
 * value from the future, or older than the TTL it is about to be measured
 * against, means something is wrong with a clock rather than with the request —
 * and a card that vanishes the instant it appears is a far worse failure than
 * one that lives a few seconds long.
 */
export function sanitizeRaisedAt(raisedAtMs: unknown, nowMs = Date.now()): number {
  if (typeof raisedAtMs !== "number" || !Number.isFinite(raisedAtMs)) return nowMs;
  if (raisedAtMs > nowMs || nowMs - raisedAtMs >= APPROVAL_TTL_MS) return nowMs;
  return raisedAtMs;
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

/**
 * This control answers one question only: **when does the agent ask?**
 *
 * It deliberately does NOT offer a "Sandbox" mode, which is what it used to
 * call core's `auto`. CaliCode has no OS-level confinement — no Seatbelt, no
 * Landlock, no bubblewrap — so that label promised process isolation nothing
 * implements, and a user picking the "safe-sounding" option got the opposite
 * of what they thought. Codex's own rule is the right one: only auto-approve
 * what you can actually enforce. If real confinement lands later, it belongs
 * beside this as a second control, not inside it.
 *
 * What *is* enforced is path confinement: file tools resolve through
 * `workspace::safe_resolve`, which rejects `..` escapes, so writes stay inside
 * the selected game's folder in every mode. That is stated under the composer
 * as a fact rather than offered as a choice.
 *
 * Core still accepts all five strings (core/src/agent.rs `requires_approval`),
 * so a persisted `auto-accept-edits` keeps working; the UI just stops offering
 * it, because it differed from `auto` only in whether the dev server prompted
 * — and the dev server now prompts in both.
 */
const PERMISSION_OPTIONS = [
  {
    value: "supervised",
    label: "Manual",
    hint: "Asks before every tool",
    icon: Hand,
    danger: false,
  },
  {
    value: "auto",
    label: "Auto",
    hint: "Asks when a call warrants it",
    icon: ShieldCheck,
    danger: false,
  },
  {
    value: "full-access",
    label: "Full access",
    hint: "Never asks · no approval gate",
    icon: ShieldOff,
    danger: true,
  },
] as const;

/**
 * Plan is not a rung on the approval ladder — it restricts which tools may be
 * dispatched at all, so it sits below a divider rather than among the modes
 * that only decide when to ask.
 */
const PLAN_OPTION = {
  value: "plan",
  label: "Plan",
  hint: "Reads · writes only plan.md",
  icon: Eye,
  danger: false,
} as const;

const ALL_PERMISSION_OPTIONS = [...PERMISSION_OPTIONS, PLAN_OPTION];

// Which efforts each model accepts comes from the models.dev registry (the
// catalog opencode's picker is built on) — a gpt-4.1-mini has none, an
// o-series has low/medium/high, a deepseek-v4-flash has low/high/max. The
// user's chosen effort is remembered per model.
const EFFORT_STORAGE_KEY = "calicode-model-effort-map";

/** How much of a step's output rides along when a question is anchored to it. */
const ANCHOR_DETAIL_CHARS = 2000;

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
  /**
   * Read-only mirror of the transcript for the side chat. The observer must
   * never reach into this panel's state, so it is handed a copy rather than
   * given a way to change it.
   */
  onTranscriptChange?: (messages: AgentMessage[]) => void;
  /** Reveals the side chat — what `/side` runs. The draft arrives unsent. */
  /**
   * Reveal the side chat. `fresh` opens another thread beside the ones already
   * open — what `/side` means every time it is run; without it the newest
   * existing thread is focused, so a per-step question does not multiply tabs.
   */
  onOpenSideChat?: (draft?: string, anchor?: SideChatAnchor, options?: { fresh?: boolean }) => void;
  onSessionActivated?: (session: SessionSummary) => void;
  /** Opens a workspace file when a safe activity path is selected. */
  onOpenActivityFile?: (file: ActivityFileChange) => void;
  /** Publishes the live graph to the right-side workspace dock. */
  onGraphChange?: (graph: TaskGraph | null, tickers: Record<string, string>) => void;
  /** Reveals the graph tab when the in-chat graph summary is selected. */
  onOpenGraph?: () => void;
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

/** One visible assistant block; a turn renderer uses `continuation` to keep one speaker label. */
function AssistantMessageRow({
  message,
  continuation = false,
}: {
  message: AgentMessage;
  continuation?: boolean;
}) {
  return (
    <div
      data-role="assistant"
      className={`max-w-[94%] self-start ${continuation ? "" : "mt-3"}`}
    >
      {continuation ? null : (
        <div className="mb-1.5 text-[9.5px] tracking-[0.24em] text-ink-subtle">CALICODE</div>
      )}
      <div className="text-[13px] leading-[1.6] text-ink">
        {message.panel ? <CommandPanelView panel={message.panel} /> : <AgentText content={message.content} />}
      </div>
    </div>
  );
}

function previousUserIndex(messages: AgentMessage[], beforeIndex: number): number {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

/**
 * One tool execution as a slim status row — spinner while running, a muted
 * check or a red cross when finished — with the full output expandable under
 * a left rule (the opencode/t3code idiom). Tool messages without a `status`
 * are informational lines (slash-command output, session notes).
 */
export function ToolRow({ message, onAsk }: { message: AgentMessage; onAsk?: (message: AgentMessage) => void }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(message.detail);
  const heading =
    message.status === "running"
      ? `Running ${message.tool}`
      : message.status
        ? `Ran ${message.tool}`
        : null;
  // A step is worth asking about once it has a name; slash-command output and
  // session notes are this panel's own words, not the run's work.
  const askable = Boolean(onAsk && message.tool && message.status);
  return (
    <div data-role="tool" className="group/tool flex w-full max-w-[94%] flex-col self-start">
      <div className="flex w-full items-center gap-1">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={expandable ? open : undefined}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs text-ink-subtle transition-colors ${
          expandable ? "hover:bg-surface-2 active:bg-surface-3" : "cursor-default"
        }`}
      >
        {/* One stroke weight across the set. The informational row used to
            fall through to a filled square, which made the least significant
            row in the transcript its heaviest mark. */}
        {message.status === "running" ? (
          <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin text-ink-subtle" strokeWidth={1.9} />
        ) : message.status === "error" ? (
          <X aria-hidden className="h-3 w-3 shrink-0 text-danger-soft" strokeWidth={1.9} />
        ) : message.status === "done" ? (
          <Check aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" strokeWidth={1.9} />
        ) : message.decision === "approved" ? (
          <ShieldCheck aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" strokeWidth={1.7} />
        ) : message.decision === "denied" ? (
          <ShieldOff aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" strokeWidth={1.7} />
        ) : (
          <span aria-hidden className="flex h-3 w-3 shrink-0 items-center justify-center">
            <span className="h-1 w-1 rounded-full bg-ink-faint" />
          </span>
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
      {askable ? (
        <button
          type="button"
          aria-label={`Ask about ${message.tool} in side chat`}
          title="Ask about this step in the side chat"
          onClick={() => onAsk?.(message)}
          className="shrink-0 rounded p-1 text-ink-faint opacity-0 transition-[opacity,background-color,color] hover:bg-surface-2 hover:text-ink group-hover/tool:opacity-100"
        >
          <MessageCircleQuestion aria-hidden className="h-3 w-3" strokeWidth={1.8} />
        </button>
      ) : null}
      </div>
      {open && message.detail ? (
        <pre className="ml-[5px] mt-1 max-h-64 overflow-auto whitespace-pre-wrap border-l border-line pl-3 font-mono text-[11px] leading-[1.6] text-ink-subtle">
          {message.detail}
        </pre>
      ) : null}
    </div>
  );
}

function ActivityIcon({
  operation,
  running,
  failed,
  stopped,
}: {
  operation: string;
  running?: boolean;
  failed?: boolean;
  stopped?: boolean;
}) {
  if (running) {
    return <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin text-ink-subtle" strokeWidth={1.9} />;
  }
  if (failed) {
    return <X aria-hidden className="h-3 w-3 shrink-0 text-danger-soft" strokeWidth={1.9} />;
  }
  // A stopped turn is neither done nor failed; a ✓ beside the word "Stopped"
  // reads as though the work finished.
  if (stopped) {
    return <Square aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" strokeWidth={1.7} />;
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
  return <Check aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" strokeWidth={1.9} />;
}

export function ActivityDetailRow({
  action,
  onOpenFile,
}: {
  action: ActivityAction;
  onOpenFile?: (file: ActivityFileChange) => void;
}) {
  const [open, setOpen] = useState(false);
  const file = action.file;
  const canOpen = Boolean(file && isSafeActivityPath(file.path, file.workspaceRoot));
  const fileLabel = file ? file.path : null;
  const failed = action.status === "error";
  const counts = Boolean(
    file && (file.additions > 0 || file.deletions > 0) && !/[+]\d+\s+[−-]\d+/.test(action.content),
  );
  // A row only opens when it has something under it. Collapsed by default keeps
  // a long turn readable: the output of one tool call used to bury the next.
  const expandable = Boolean(action.detail || fileLabel || (file && file.diff.length > 0));
  return (
    <div className="border-l border-line pl-3">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={expandable ? open : undefined}
        className={`flex w-full min-w-0 items-center gap-2 rounded-md py-1 pr-1 text-left text-[11px] text-ink-subtle transition-colors ${
          expandable ? "hover:bg-surface-2 active:bg-surface-3" : "cursor-default"
        }`}
      >
        <ActivityIcon operation={file?.operation ?? "tool"} running={action.status === "running"} failed={failed} />
        <span className={`min-w-0 flex-1 truncate ${failed ? "text-danger-soft" : ""}`}>
          {action.content || `Ran ${action.tool}`}
        </span>
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
        {expandable ? (
          <ChevronRight
            aria-hidden
            className={`h-3 w-3 shrink-0 text-ink-faint transition-transform ${open ? "rotate-90" : ""}`}
            strokeWidth={2}
          />
        ) : null}
      </button>
      {open && fileLabel ? (
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
      {open && action.detail ? (
        <pre
          className={`mb-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-[1.5] ${
            failed ? "text-danger-soft" : "text-ink-faint"
          }`}
        >
          {action.detail}
        </pre>
      ) : null}
      {open && file && file.diff.length > 0 ? (
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
  const summary = latest?.content || (live ? "Working…" : marker?.stopped ? "Stopped" : "Completed");
  const statusLabel = live ? `Working for ${formatDuration(elapsed)}` : summary;
  const latestFailed = !live && latest?.status === "error";
  const changed = summariseChangedFiles(actions.map((action) => action.activity));
  return (
    <div data-role="activity-turn" data-turn-id={turnId} className="w-full max-w-[94%] self-start">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} activity for turn ${turnId}`}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs text-ink-subtle transition-colors hover:bg-surface-2 active:bg-surface-3"
      >
        <ActivityIcon operation={operation} running={live} failed={latestFailed} stopped={marker?.stopped} />
        <span className={`min-w-0 flex-1 truncate ${latestFailed ? "text-danger-soft" : "text-ink"}`}>{statusLabel}</span>
        {!live && actions.length > 1 ? (
          <span className="shrink-0 text-[10px] text-ink-faint">{actions.length} actions</span>
        ) : null}
        {!live ? <span className="shrink-0 text-[10px] text-ink-faint">{formatDuration(elapsed)}</span> : null}
        <ChevronRight
          aria-hidden
          className={`h-3 w-3 shrink-0 text-ink-faint transition-transform ${expanded ? "rotate-90" : ""}`}
          strokeWidth={2}
        />
      </button>
      {/* Only once the turn is over: a running turn's totals are a moving
          target, and the expanded view already lists every action. */}
      {!expanded && !live ? <TurnFileSummaryCard summary={changed} onOpenFile={onOpenFile} /> : null}
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

/**
 * Answers one question — when does the agent ask? — and says plainly what it
 * cannot answer. The rows read as a ladder from most to least supervised, so
 * "further down is more freedom" is legible without reading every hint, and
 * the footer states the confinement that holds in all of them rather than
 * leaving the picker to imply it.
 */
function PermissionPicker({
  value,
  onChange,
  projectSlug,
  sandboxNote,
}: {
  value: string;
  onChange: (next: string) => void;
  projectSlug: string;
  /** Core's resolved confinement state; null when core has not said. */
  sandboxNote: string | null;
}) {
  const active = ALL_PERMISSION_OPTIONS.find((option) => option.value === value);
  const ActiveIcon = active?.icon ?? ShieldCheck;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Permission mode"
          className={`inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[11px] transition-colors hover:bg-surface-2 active:bg-surface-3 ${
            active?.danger ? "text-[#e58a52]" : "text-ink-subtle"
          }`}
        >
          <ActiveIcon aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
          <span>{active?.label ?? value}</span>
          <ChevronDown aria-hidden className="h-3 w-3 shrink-0 opacity-60" strokeWidth={2} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={8}
          collisionPadding={8}
          className="z-50 w-[248px] overflow-hidden rounded-[12px] border border-line bg-popover p-1 text-popover-foreground shadow-[0_18px_45px_rgba(0,0,0,0.28)]"
        >
          {PERMISSION_OPTIONS.map((option) => (
            <PermissionRow
              key={option.value}
              option={option}
              selected={option.value === value}
              onSelect={() => onChange(option.value)}
            />
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <PermissionRow
            option={PLAN_OPTION}
            selected={PLAN_OPTION.value === value}
            onSelect={() => onChange(PLAN_OPTION.value)}
          />
          {/* Two lines, not one. The note comes from core's resolved state
              rather than a constant — this used to claim "not sandboxed"
              unconditionally, which could not be right in every case and was
              checked against nothing. But the resolved wording is longer than
              the constant it replaced, and sharing a line truncated the slug to
              "Writes sta…", which tells the user nothing at all. When core says
              nothing, the second line is simply absent. */}
          <div className="mt-1 border-t border-line px-2 pb-0.5 pt-1.5 text-[10px] text-ink-faint">
            <p className="truncate">
              Writes stay in <span className="text-ink-subtle">{projectSlug}</span>
            </p>
            {sandboxNote ? <p className="truncate">{sandboxNote}</p> : null}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function PermissionRow({
  option,
  selected,
  onSelect,
}: {
  option: (typeof ALL_PERMISSION_OPTIONS)[number];
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = option.icon;
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={`flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 outline-none transition-colors data-[highlighted]:bg-surface-2 ${
        selected ? "bg-surface-2" : ""
      }`}
    >
      <Icon
        aria-hidden
        className={`mt-[2px] h-3.5 w-3.5 shrink-0 ${option.danger ? "text-[#e58a52]" : "text-ink-subtle"}`}
        strokeWidth={1.8}
      />
      <span className="min-w-0 flex-1">
        <span className={`block text-[12.5px] leading-none ${option.danger ? "text-[#e58a52]" : "text-ink-strong"}`}>
          {option.label}
        </span>
        <span className="mt-0.5 block text-[10.5px] leading-snug text-ink-faint">{option.hint}</span>
      </span>
      {selected ? <Check aria-hidden className="mt-[2px] h-3 w-3 shrink-0 text-ink-subtle" strokeWidth={2.6} /> : null}
    </DropdownMenu.Item>
  );
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
  onTranscriptChange,
  onOpenSideChat,
  onSessionActivated,
  onOpenActivityFile,
  onActiveSessionChange,
  onSessionRunningChange,
  onGraphChange,
  onOpenGraph,
}: AgentPanelProps) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const messagesRef = useRef<AgentMessage[]>(messages);
  messagesRef.current = messages;
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Caret offset in the composer. The slash menu keys off the token under the
  // caret rather than the head of the message, so it has to follow the caret,
  // not just the text.
  const [caret, setCaret] = useState(0);
  // Where completing a command should leave the caret, applied after the
  // controlled value lands — setting it before React re-renders would be
  // overwritten by the value swap.
  const pendingCaretRef = useRef<number | null>(null);
  // Installed skills, offered as `/<skill>` beside the built-in commands.
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const skillsLoadedRef = useRef<string | null>(null);
  const [fileCommandInfos, setFileCommandInfos] = useState<FileCommandInfo[]>([]);
  const [agentNames, setAgentNames] = useState<string[]>([]);
  /// The core-side run this panel is rendering, if any.
  const activeLoopIdRef = useRef<string | null>(null);
  const loopActivityTurnRef = useRef<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionWorkspaceRoot, setSessionWorkspaceRoot] = useState<string | null>(workspaceRoot);
  const [busy, setBusy] = useState(false);
  // The approval queue. One map, one reducer, one writer — see
  // lib/approvalStore.ts. `approvalsRef` is the reducer's authoritative copy
  // so the mount-once SSE handler can dispatch without re-subscribing; the
  // state is a render mirror and is never read to make a decision.
  const approvalsRef = useRef<ApprovalStore>(emptyStore());
  const [approvals, setApprovals] = useState<ApprovalStore>(approvalsRef.current);
  // What the user typed into a card's Deny box, keyed by request id. Kept
  // beside the store rather than in it: the store is the approval state
  // machine, and a half-typed sentence is not a state transition.
  const [denyReasons, setDenyReasons] = useState<Record<string, string>>({});
  // Sandbox by default: safe tools run freely, irreversible writes ask. A
  // full-access default would silently bypass the permission rules and plan
  // mode on a newcomer's very first prompt.
  const [permissionMode, setPermissionMode] = useState("auto");
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  // Reasoning effort is remembered per model and forwarded on every agent
  // turn; graph/subagent workers inherit the coordinator's selected value.
  const [effortByModel, setEffortByModel] = useState<Record<string, string>>(readStoredEfforts);
  const [effortIndex, setEffortIndex] = useState<EffortIndex | null>(null);
  const [contextLimits, setContextLimits] = useState<ContextLimits | null>(null);
  const [guardianModels, setGuardianModels] = useState<GuardianModels | null>(null);
  // models.dev per-provider catalogs, used to surface current models the
  // hand-maintained config hasn't caught up to yet.
  const [registryCatalog, setRegistryCatalog] = useState<Record<string, string[]> | null>(null);
  const [providerTarget, setProviderTarget] = useState("openai");
  const [modelInput, setModelInput] = useState("");
  const [looping, setLooping] = useState(false);
  // What the running loop is for, kept beside `looping` so the composer's
  // status pill can name the objective after its start line has scrolled away.
  const [activeLoop, setActiveLoop] = useState<ActiveLoopRun | null>(null);
  // Stop is state, not a ref: the old ref-only flag re-rendered nothing, so
  // the button's disabled/label flipped at whatever unrelated render came next.
  const [stopping, setStopping] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  // Latest task graph snapshot from `graph.updated` events, and a per-node
  // live output ticker (last ~200 chars of each subagent's stream). The
  // parent mirrors these into the right-side graph workspace.
  const [activeGraph, setActiveGraph] = useState<TaskGraph | null>(null);
  const [graphTickers, setGraphTickers] = useState<Record<string, string>>({});
  // Streamed model reasoning, per activity turn. Deliberately NOT part of
  // `messages`: reasoning is display-only, so keeping it out of the transcript
  // is what stops it being persisted into the saved session or replayed back
  // to the provider as if the model had said it.
  const [reasoningByTurn, setReasoningByTurn] = useState<
    Record<string, { text: string; startedAtMs: number; endedAtMs?: number }>
  >({});
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
  // The in-flight agent_chat for the current turn (plain or loop iteration).
  // Stop aborts it so cancellation costs one round-trip instead of the rest of
  // core's `maxTurns` budget.
  const turnAbortRef = useRef<AbortController | null>(null);
  const saveTimer = useRef<number | null>(null);
  // Each mounted editor panel is an SSE consumer. Core includes this token
  // on editor/browser tool requests so another CaliCode window cannot answer
  // the request first just because it shares the broadcast event stream.
  // Backed by sessionStorage so a reload reclaims this window's inbox rather
  // than orphaning every prompt core addressed at the pre-reload id.
  // sessionStorage, never localStorage: two windows sharing an id would break
  // the one-window-one-inbox invariant the whole design rests on.
  const editorClientIdRef = useRef<string | null>(null);
  if (!editorClientIdRef.current) editorClientIdRef.current = readEditorClientId();
  const onTranscriptChangeRef = useRef(onTranscriptChange);
  onTranscriptChangeRef.current = onTranscriptChange;
  useEffect(() => {
    onTranscriptChangeRef.current?.(messages);
  }, [messages]);
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
  const onGraphChangeRef = useRef(onGraphChange);
  onGraphChangeRef.current = onGraphChange;
  const applyGraphSnapshot = (graph: TaskGraph) => {
    activeGraphRef.current = graph;
    setActiveGraph(graph);
  };
  useEffect(() => {
    onGraphChangeRef.current?.(activeGraph, graphTickers);
  }, [activeGraph, graphTickers]);
  useEffect(
    () => () => {
      // A session switch unmounts this keyed panel. Clear the dock so a graph
      // from the previous game cannot remain visible beside the new chat.
      onGraphChangeRef.current?.(null, {});
    },
    [],
  );
  const activeTurnRef = useRef<{ turnId: string; startedAtMs: number } | null>(null);

  // The single writer. Everything that touches the approval queue goes through
  // here, and the ref is updated synchronously so the mount-once SSE handler
  // and a click in the same tick agree on what has already happened.
  const dispatchApproval = (event: ApprovalEvent): ApprovalStore => {
    const next = reduce(approvalsRef.current, event);
    if (next !== approvalsRef.current) {
      approvalsRef.current = next;
      setApprovals(next);
    }
    return next;
  };

  // Every card lapses with a stated reason. Note what this is not: it does not
  // answer anything. A panel going away is not a decision about a request core
  // is still holding — core's own timer, or the run ending, is what closes it.
  const discardApprovals = (reason: LapsedReason): void => {
    dispatchApproval({ kind: "Discarded", reason });
  };

  const targetProvider = modelList?.providers.find((provider) => provider.id === providerTarget);
  const availableModels = [
    ...(modelList?.active.provider === providerTarget && modelList.active.model ? [modelList.active.model] : []),
    ...(targetProvider?.models ?? []),
  ].filter((model, index, models) => model && models.indexOf(model) === index);

  // Keep the active model in the compact composer, where it is visible and
  // switchable without opening the larger session-settings popover.
  const modelChoices = buildModelChoices(modelList, registryCatalog);
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

  // Skills change outside this panel — a file dropped in the skills dir, a
  // toggle in Settings — so the list is refetched each time the menu opens
  // and not only on mount. The dependency is the boolean, so that is one call
  // per open rather than one per keystroke; the mount load is what makes a
  // pasted or typed-through `/<skill>` resolve without opening the menu at all.
  const slashMenuOpen = slashTokenAt(input, caret) !== null;
  useEffect(() => {
    if (!slashMenuOpen && skillsLoadedRef.current === projectSlug) return;
    let cancelled = false;
    void listSkills(projectSlug)
      .then((list) => {
        if (cancelled) return;
        // Marked loaded on arrival, not on dispatch: StrictMode mounts twice
        // and this ref outlives the remount, so claiming the load up front
        // made the discarded first attempt the only one — and skills stayed
        // empty until the menu was opened by hand.
        skillsLoadedRef.current = projectSlug;
        setSkills(list);
      })
      .catch(() => {});
    // Loaded on the same trigger as skills, and deliberately re-read whenever
    // the menu opens: a command is a file the user edits outside the app, so
    // caching it for the life of the session would show them a stale menu.
    void listFileCommands(projectSlug)
      .then((list) => {
        if (!cancelled) setFileCommandInfos(list);
      })
      .catch(() => {});
    void listAgentDefs(projectSlug)
      .then(({ agents }) => {
        if (cancelled) return;
        setAgentNames(agents.filter((agent) => !agent.error).map((agent) => agent.name));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectSlug, slashMenuOpen]);

  // A loop lives in core, so it survives this tab. On mount — and whenever the
  // session being shown changes — ask whether one is still running and take
  // the UI back over. Without this the run keeps working with nobody rendering
  // it, every `loop.*` event is discarded because there is no active id to
  // match, and the composer would cheerfully start a second loop on top.
  //
  // Two cases, and they need different rules. With a session open, only a run
  // belonging to *that* session may be adopted — anything else would stream a
  // different chat's turns into this transcript. With no session open, which
  // is what a browser reload leaves behind (`activeSessionId` is not
  // persisted), the project's running loop is adopted along with its session,
  // because that session is precisely the chat the loop is talking in.
  useEffect(() => {
    if (looping) return;
    let cancelled = false;
    // Deferred through a resolved promise so a throwing or absent
    // `listLoopRuns` becomes a rejection this `.catch` swallows. Rejoining is
    // an enhancement on top of a working panel; it must never be able to stop
    // one from mounting.
    void Promise.resolve()
      .then(() => listLoopRuns())
      .then(async (runs) => {
        if (cancelled) return;
        const live = runs.filter((run) => run.status === "running" && run.slug === projectSlug);
        const mine = sessionId
          ? live.find((run) => run.sessionId === sessionId)
          : live.find((run) => Boolean(run.sessionId));
        if (!mine) return;
        if (!sessionId && mine.sessionId) {
          // Adopt the run's chat, so its deltas and tool rows have somewhere
          // to land. Silent: `resumeSession` says nothing either.
          try {
            await resumeSession(mine.sessionId);
          } catch {
            // A stale session record must not hide a live core run; keep the
            // stream attached to its owner so Stop can still reach it.
            setSessionId(mine.sessionId);
            sessionIdRef.current = mine.sessionId;
            setSessionWorkspaceRoot(workspaceRoot);
            workspaceRootRef.current = workspaceRoot;
          }
          if (cancelled) return;
        }
        activeLoopIdRef.current = mine.loopId;
        loopActivityTurnRef.current = beginActivityTurn();
        setActiveLoop({
          objective: mine.goal,
          startedAtMs: mine.startedAtMs,
          every: mine.intervalMs ? formatInterval(mine.intervalMs) : null,
        });
        setLooping(true);
        setBusy(true);
        say(`▶ rejoined loop at iteration ${mine.iteration} — it kept running`, "tool");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, projectSlug, looping]);

  useEffect(() => {
    const target = pendingCaretRef.current;
    if (target === null) return;
    pendingCaretRef.current = null;
    const field = inputRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(target, target);
  }, [input]);

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
      if (event.type === "loop.iteration" && event.loopId === activeLoopIdRef.current) {
        setMessages((current) => [...current, { role: "user", content: String(event.prompt ?? "") }]);
        say(`loop iteration ${event.iteration}`, "tool");
        return;
      }
      if (event.type === "loop.done_refused" && event.loopId === activeLoopIdRef.current) {
        say(`DONE refused: ${event.reason ?? "completion could not be proven"}`, "tool");
        return;
      }
      if (event.type === "loop.completed" && event.loopId === activeLoopIdRef.current) {
        say(`✔ loop complete in ${event.iteration} iterations`, "tool");
        return;
      }
      if (event.type === "loop.finished" && event.loop?.loopId === activeLoopIdRef.current) {
        if (event.loop.status === "failed") say(`Loop failed: ${event.loop.detail ?? "unknown error"}`);
        else if (event.loop.status === "stopped") say(`■ ${event.loop.detail ?? "loop stopped"}`, "tool");
        finishLoopUi(event.loop.status === "stopped" ? "stopped" : "done");
        return;
      }
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
        const turnId = turnForEvent(event);
        const delta = event.delta ?? "";
        // A late broadcast must not append to the previous turn's answer. The
        // active turn is the client-side equivalent of DeepSeek's stable
        // message id: every visible stream fragment belongs to exactly one
        // assistant block, even when tools interleave several blocks.
        if (!turnId || !delta) return;
        // The first visible block follows the reasoning block in providers
        // that expose both. Mark that disclosure settled without waiting for
        // the whole tool turn to finish.
        setReasoningByTurn((current) => {
          const existing = current[turnId];
          return existing && existing.endedAtMs === undefined
            ? { ...current, [turnId]: { ...existing, endedAtMs: Date.now() } }
            : current;
        });
        setMessages((current) => {
          const copy = [...current];
          const last = copy[copy.length - 1];
          if (last?.role === "assistant" && last.turnId === turnId) {
            copy[copy.length - 1] = { ...last, content: last.content + delta };
          } else {
            copy.push({ role: "assistant", content: delta, turnId });
          }
          return copy;
        });
      }
      if (event.type === "agent.reasoning") {
        // Same demux as deltas. Subagent reasoning would drown the parent
        // transcript, so only our own session's thinking is shown; a worker's
        // progress is already visible through its chip and ticker.
        const foreign = Boolean(event.sessionId && sessionIdRef.current && event.sessionId !== sessionIdRef.current);
        if (foreign || event.subagentSessionId) return;
        const turnId = activeTurnRef.current?.turnId;
        if (!turnId) return;
        const delta = event.delta ?? "";
        if (!delta) return;
        setReasoningByTurn((current) => {
          const existing = current[turnId];
          return {
            ...current,
            [turnId]: existing
              ? { ...existing, text: existing.text + delta }
              : { text: delta, startedAtMs: Date.now() },
          };
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
          // Auto-compaction rewrites the transcript without being asked, so
          // the line has to say that it was automatic — otherwise the context
          // meter drops and nothing explains why.
          const opening = event.trigger === "auto" ? "Auto-compacted context" : "Compacted context";
          const parts =
            event.strategy === "prune"
              ? [`${opening}: pruned ${event.prunedToolResults ?? 0} old tool result${(event.prunedToolResults ?? 0) === 1 ? "" : "s"}, no summary needed`]
              : [
                  `${opening}: archived ${event.archivedMessages ?? 0} message${(event.archivedMessages ?? 0) === 1 ? "" : "s"}`,
                ];
          if (event.strategy !== "prune" && event.prunedToolResults)
            parts.push(`pruned ${event.prunedToolResults} old tool result${event.prunedToolResults === 1 ? "" : "s"}`);
          if (event.estimatedTokensBefore != null && event.estimatedTokensAfter != null) {
            parts.push(`~${formatTokens(event.estimatedTokensBefore)} → ~${formatTokens(event.estimatedTokensAfter)} tokens`);
          }
          if (event.strategy !== "prune" && event.instructions) parts.push("kept what you asked it to keep");
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
        // Routed at the door. A prompt that is not this window's never enters
        // the map — there must be no container a foreign request can sit in,
        // because a container is a button.
        const owned = route(event, {
          clientId: editorClientIdRef.current,
          sessionId: sessionIdRef.current,
        });
        if (owned === "not-mine") return;
        dispatchApproval({
          kind: "Arrived",
          requestId: event.requestId,
          tool: event.tool,
          arguments: event.arguments,
          graphLabel: typeof event.ownerGraph === "string" ? event.ownerGraph : null,
          reason: typeof event.reason === "string" && event.reason.trim() ? event.reason : null,
          reasonSource: event.reasonSource === "agent" || event.reasonSource === "guardian" ? event.reasonSource : null,
          raisedAtMs: sanitizeRaisedAt(event.raisedAtMs),
        });
      }
      // Core announces every exit from its pending map. This is what turns the
      // TTL sweep below into a backstop rather than a parallel clock, and it
      // gives the losing window in any race a truthful card instead of a stale
      // one. It never produces a denial — it reports one core already has.
      if (event.type === "agent.approval_resolved" && event.requestId) {
        dispatchApproval({
          kind: "Resolved",
          requestId: event.requestId,
          outcome: (event.outcome ?? "session-gone") as ResolvedOutcome,
        });
      }
      if (event.type === "agent.permission_mode" && event.sessionId === sessionIdRef.current) {
        const mode = event.mode;
        if ((mode === "auto" || mode === "supervised" || mode === "full-access" || mode === "plan") && permissionModeRef.current === "plan") {
          setPermissionMode(mode);
        }
      }
      if (event.type === "agent.tool_started" && event.tool && eventIsLocalActivity(event)) {
        const turnId = turnForEvent(event);
        if (!turnId) return;
        // A tool request is emitted after the provider closed its reasoning
        // block. Keep the reasoning disclosure independent from the longer
        // tool execution clock, as DeepSeek's block timeline does.
        setReasoningByTurn((current) => {
          const existing = current[turnId];
          return existing && existing.endedAtMs === undefined
            ? { ...current, [turnId]: { ...existing, endedAtMs: Date.now() } }
            : current;
        });
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
    },
    // Re-attach on every (re)connection. `editor_attachment` is the map core
    // reads to address an approval, and an EventSource that silently
    // reconnected would otherwise leave core addressing prompts at a window
    // that has not spoken since before the gap. This is the whole of the
    // reconnect story — no second registry, no claim protocol.
    () => {
      const id = sessionIdRef.current;
      const root = workspaceRootRef.current;
      if (!id || !root) return;
      void rpc("editor_attach", {
        sessionId: id,
        clientId: editorClientIdRef.current,
        projectSlug,
        workspaceRoot: root,
      }).catch(() => {});
    });
    return () => {
      disconnect();
      // The panel is going away. Cards lapse; nothing is answered.
      discardApprovals("panel-gone");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // The TTL sweep. It removes cards and it never sends anything — core's
  // `agent.approval_resolved` is the primary signal, and this only catches the
  // case where that announcement was lost (a core restart, an SSE gap). A card
  // that lapses here says so; the request itself is core's to end.
  useEffect(() => {
    const timer = window.setInterval(
      () => dispatchApproval({ kind: "Tick", nowMs: Date.now() }),
      Math.max(1_000, Math.floor(APPROVAL_TTL_MS / 30)),
    );
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop only means anything while a turn is running. Retiring it here (rather
  // than on each exit path) covers every producer of `busy`, including the ones
  // with no abortable request, so the control can never stick on "Stopping…".
  useEffect(() => {
    if (!busy) setStopping(false);
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
  }, [messages, approvals]);

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
      setContextLimits(data.contextLimits);
      setGuardianModels(data.guardians);
    });
    // Compaction tuning for the context meter; offline core just means the
    // meter measures against the built-in default window.
    void readCoreConfig()
      .then(setCoreConfig)
      .catch(() => {});
  }, []);

  const activeModelId = modelList?.active.model ?? "";
  /**
   * The active model's advertised context window, or null while the registry
   * loads. Sent to core with every turn so compaction sizes itself to this
   * model — core keeps no catalog of its own on purpose.
   */
  const activeContextLimit = contextLimitFor(contextLimits, activeModelId);
  const activeProvider = modelList?.active.provider ?? "";
  const guardianModel = (() => {
    const cheapest = guardianModels?.[activeProvider];
    return cheapest && activeProvider ? `${activeProvider}:${cheapest}` : undefined;
  })();
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

  const showPanel = (panel: CommandPanel, text: string) => {
    appendMessage({ role: "assistant", content: text, panel });
  };

  // A stopped turn drops the response core would have replied with, so any tool
  // row still spinning will never receive its finish event. Settle those rows
  // and say plainly what the stop could not undo: `agent_cancel` refuses the
  // rest of the batch, but a tool already dispatched runs to its own end.
  const noteTurnCancelled = (turnId: string): void => {
    const settled = settleRunningToolRows(messagesRef.current, turnId, Date.now());
    if (settled !== messagesRef.current) {
      messagesRef.current = settled;
      setMessages(settled);
    }
    say("Turn cancelled — tools already dispatched may still finish.", "tool");
  };

  const beginActivityTurn = (turnId = crypto.randomUUID(), startedAtMs = Date.now()): string => {
    activeTurnRef.current = { turnId, startedAtMs };
    setMessages((current) => [...current, createTurnMarker(turnId, startedAtMs)]);
    return turnId;
  };

  const completeActivityTurn = (
    turnId: string,
    completedAtMs = Date.now(),
    outcome: "done" | "stopped" = "done",
  ): void => {
    if (activeTurnRef.current?.turnId === turnId) activeTurnRef.current = null;
    setReasoningByTurn((current) =>
      current[turnId] && current[turnId].endedAtMs === undefined
        ? { ...current, [turnId]: { ...current[turnId], endedAtMs: completedAtMs } }
        : current,
    );
    setMessages((current) =>
      current.map((message) =>
        isTurnMarker(message) && message.turnId === turnId
          ? { ...message, status: "done" as const, completedAtMs, stopped: outcome === "stopped" }
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
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; reply: string; toolCalls: unknown[] }> => {
    const base = {
      projectSlug,
      permissionMode,
      effort,
      ...(guardianModel ? { guardianModel } : {}),
      // Tool-heavy build turns routinely need more than ten model/tool
      // round-trips. Keep the request bounded, but leave enough headroom for
      // a complete build before the explicit loop/continue controls take over.
      maxTurns: 20,
      // Core has no model catalog by design, so the window travels with the
      // turn. Omitted while the registry is still loading — core then falls
      // back rather than being told a wrong number.
      ...(activeContextLimit ? { contextLength: activeContextLimit } : {}),
      workspaceRoot: attachedWorkspaceRoot,
      loopId: activeLoopId,
      finalResponseDrain: Boolean(activeLoopId),
    };
    try {
      return (await rpc(
        "agent_chat",
        {
          ...base,
          sessionId: session,
          messages: session ? [userMessage] : [...history, userMessage],
        },
        { signal },
      )) as { sessionId: string; reply: string; toolCalls: unknown[] };
    } catch (error) {
      if (signal?.aborted) throw error;
      const notFound = session && error instanceof Error && /session .*not found|not found/i.test(error.message);
      if (!notFound) throw error;
      // Core lost the session. The retry used to send `sessionId: null` and
      // learn the new id only from the result — so any tool this turn
      // dispatched raised its approval against a session this panel had not
      // attached to, and core addressed the prompt at nobody. Create and
      // attach first, then run: no RPC that can cause a tool call is issued
      // before the panel knows AND has attached its session.
      const attached = await ensureEditorSession(true);
      return (await rpc(
        "agent_chat",
        {
          ...base,
          sessionId: attached.id,
          workspaceRoot: attached.workspaceRoot,
          messages: [...history, userMessage],
        },
        { signal },
      )) as { sessionId: string; reply: string; toolCalls: unknown[] };
    }
  };

  const ensureEditorSession = async (
    forceFresh = false,
  ): Promise<{ id: string; workspaceRoot: string }> => {
    let id = forceFresh ? null : sessionIdRef.current;
    let root = forceFresh ? null : workspaceRootRef.current;
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
    const controller = new AbortController();
    turnAbortRef.current = controller;
    try {
      const attached = await ensureEditorSession();
      const history = messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({ role: message.role, content: message.content }));
      const result = await agentChat(
        history,
        userMessage,
        attached.id,
        attached.workspaceRoot,
        undefined,
        controller.signal,
      );
      setSessionId(result.sessionId);
      const reply = result.reply || "Done.";
      setMessages((current) => {
        const last = current[current.length - 1];
        const sameTurn = last?.role === "assistant" && last.turnId === turnId;
        if (sameTurn && last?.content === reply) return current;
        // A no-tool response is one streamed assistant block. The RPC result
        // is its settled value, so replace the in-flight text instead of
        // painting the same answer twice. Once tools ran, the provider may
        // have emitted commentary before a later assistant block; keep that
        // ordered block and append the final report to the same turn.
        if (sameTurn && last && result.toolCalls.length === 0) {
          const copy = [...current];
          copy[copy.length - 1] = { ...last, content: reply, turnId };
          return copy;
        }
        return [...current, { role: "assistant", content: reply, turnId }];
      });
      if (result.toolCalls.length > 0) {
        onLog(`agent completed ${result.toolCalls.length} tool calls`);
      }
      return reply;
    } catch (error) {
      // The user pressing Stop is not a failure — report it as a cancellation
      // instead of an "Error:" bubble attributed to the model.
      if (controller.signal.aborted) {
        noteTurnCancelled(turnId);
        onLog("agent turn cancelled by the user");
        return "";
      }
      const message = error instanceof Error ? error.message : String(error);
      setMessages((current) => [...current, { role: "assistant", content: `Error: ${message}`, turnId }]);
      onLog(`agent error: ${message}`);
      return "";
    } finally {
      if (turnAbortRef.current === controller) turnAbortRef.current = null;
      completeActivityTurn(turnId, Date.now(), controller.signal.aborted ? "stopped" : "done");
      setBusy(false);
    }
  };

  const listCheckpoints = async () => {
    try {
      const listed = await rpc<{ checkpoints?: ListedCheckpoint[] }>("checkpoint_list", { slug: projectSlug });
      say(formatCheckpointList(listed.checkpoints ?? [], Date.now()), "tool");
    } catch (error) {
      say(`Could not list restore points: ${error instanceof Error ? error.message : String(error)}`, "tool");
    }
  };

  // /restore — the only destructive command in the panel, and the reason it
  // takes two sends. The first prints what `project_revert` replaces; only the
  // explicit `confirm` reaches core.
  const restoreCheckpoint = async (id: string, confirmed: boolean) => {
    if (busy || looping) {
      say("stop the current run before restoring — a revert under a live turn would fight it.", "tool");
      return;
    }
    if (!confirmed) {
      // Core is asked which mechanism owns this id rather than guessing from
      // its spelling: the two kinds cover opposite halves of the game, so
      // naming the wrong one in a confirmation is how someone approves a
      // rollback that does not do what they just read. An unreachable core
      // falls back to the more conservative project-copy wording.
      let kind: CheckpointKind = "project";
      let createdAtMs = checkpointTakenAtMs(id);
      try {
        const listed = await rpc<{ checkpoints?: ListedCheckpoint[] }>("checkpoint_list", { slug: projectSlug });
        const entry = listed?.checkpoints?.find((candidate) => candidate.id === id);
        if (entry?.kind === "git") kind = "git";
        if (typeof entry?.createdAtMs === "number") createdAtMs = entry.createdAtMs;
      } catch {
        /* fall through to the project-copy wording */
      }
      const age = createdAtMs === null ? null : formatCheckpointAge(Math.max(0, Date.now() - createdAtMs));
      say(restoreWarning(id, age, Boolean(workspaceRootRef.current), kind), "tool");
      return;
    }
    try {
      // Paired with the core loop's `checkpoint_create`: restore dispatches on
      // the id's own kind, so a git snapshot comes back through `git restore`
      // (HEAD and the branch untouched) and a copy-kind id through the project
      // directory copy.
      await rpc("checkpoint_restore", { slug: projectSlug, id });
      say(
        `restored ${id}. Reload the window so the editor re-reads the project — the copy still open here would otherwise autosave straight back over it.`,
        "tool",
      );
    } catch (error) {
      say(`restore failed: ${error instanceof Error ? error.message : String(error)}`, "tool");
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
  const compact = async (instructions?: string) => {
    if (busy || looping) return;
    // Setting a steer before the first turn is a normal thing to do — it is
    // exactly when you know what this chat must not lose. Without a session
    // there is nothing to store it on, so make one rather than dropping the
    // instruction on the floor.
    let target = sessionId;
    if (!target) {
      if (instructions === undefined) {
        say("Nothing to compact yet. Send a message first.");
        return;
      }
      try {
        target = (await ensureEditorSession()).id;
      } catch (error) {
        say(`Could not start a chat to remember that: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    setBusy(true);
    try {
      const result = await rpc<{ compacted: boolean; reason?: string; estimatedTokens?: number }>(
        "session_compact",
        // Omitted rather than null when nothing was said: core reads an absent
        // key as "keep the standing instructions" and an empty string as
        // "forget them".
        instructions === undefined ? { sessionId: target } : { sessionId: target, instructions },
      );
      if (instructions !== undefined) {
        say(
          instructions
            ? `Compaction instructions set — this and every automatic compaction in this chat will keep: ${instructions}`
            : "Compaction instructions cleared.",
          "tool",
        );
      }
      if (!result.compacted) {
        // Core's reason is a machine string ("nothing to compact"); echoing it
        // after the same words read as "Nothing to compact: nothing to compact".
        const reason = result.reason && result.reason !== "nothing to compact" ? ` (${result.reason})` : "";
        say(`Nothing to compact — the context already fits the budget${reason}.`, "tool");
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
    const window = contextWindowOf(coreConfig, activeContextLimit);
    const percent = Math.min(999, Math.round((usage.lastPromptTokens / window) * 100));
    const compaction = coreConfig?.compaction;
    const autoLine =
      compaction && !compaction.auto
        ? "auto-compaction: off"
        : `auto-compacts at ${Math.round((compaction?.threshold ?? 0.75) * 100)}% of the context window`;
    const latestPrompt = usage.lastPromptTokens;
    const latestCached = Math.min(latestPrompt, usage.lastCacheReadTokens ?? 0);
    const cachePercent = latestPrompt > 0 ? Math.round((latestCached / latestPrompt) * 100) : 0;
    showPanel(
      {
        kind: "usage",
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        totalTokens: usage.totalTokens,
        lastPromptTokens: latestPrompt,
        lastCacheReadTokens: latestCached,
        contextWindow: window,
        autoCompactAt: compaction && !compaction.auto ? null : (compaction?.threshold ?? 0.75),
      },
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

  // Core owns the loop driver; this panel only starts and renders it.
  const finishLoopUi = (outcome: "done" | "stopped" = "done") => {
    const activityTurnId = loopActivityTurnRef.current;
    if (activityTurnId) completeActivityTurn(activityTurnId, Date.now(), outcome);
    loopActivityTurnRef.current = null;
    activeLoopIdRef.current = null;
    setActiveLoop(null);
    setLooping(false);
    setBusy(false);
    setStopping(false);
  };

  // Autonomous loop: register a detached core-side run, then render its SSE events.
  const runLoop = async (
    goal: string,
    intervalMs: number | null = null,
    profile: LoopProfile = DEFAULT_LOOP_PROFILE,
  ) => {
    if (busy || looping) return;
    setLooping(true);
    setBusy(true);
    const activityTurnId = beginActivityTurn();
    loopActivityTurnRef.current = activityTurnId;
    try {
      const attached = await ensureEditorSession();
      const run = await startLoopRun({
        projectSlug,
        goal,
        profile,
        intervalMs,
        sessionId: attached.id,
        workspaceRoot: attached.workspaceRoot,
        permissionMode,
        ...(guardianModel ? { guardianModel } : {}),
      });
      activeLoopIdRef.current = run.loopId;
      setActiveLoop({ objective: goal, startedAtMs: Date.now(), every: intervalMs ? formatInterval(intervalMs) : null });
      say(`▶ loop started: ${goal}`, "tool");
    } catch (error) {
      say(`Loop error: ${error instanceof Error ? error.message : String(error)}`);
      finishLoopUi();
    }
    return;
  };

  const stopAgent = () => {
    if (!busy || stopping) return;
    setStopping(true);
    const loopId = activeLoopIdRef.current;
    if (loopId) void stopLoopRun(loopId).catch(() => {});
    // No literal glyph: the tool row draws its own ■, so spelling one here
    // rendered "■ ■ Stopping…".
    say("Stopping — finishing the current step, then halting.", "tool");
    const sessionToCancel = sessionIdRef.current;
    if (sessionToCancel) {
      // Best-effort by design: a stop that lands after the turn already
      // returned answers `found: false`, which is not a failure worth
      // surfacing to someone who just asked the run to end.
      void rpc("agent_cancel", { sessionId: sessionToCancel }).catch(() => {});
    }
    turnAbortRef.current?.abort();
  };

  const resumeSession = async (id: string) => {
    if (looping) return;
    try {
      activeTurnRef.current = null;
      // This chat is moving on. The cards lapse and say so; nothing is
      // answered on the way out.
      discardApprovals("session-changed");
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

  const resumeLast = async (target?: string) => {
    if (target) {
      // Ids are long, and /sessions prints them in full — a prefix is enough
      // as long as it is unambiguous.
      const matches = sessions.filter(
        (session) => session.id === target || session.id.startsWith(target),
      );
      if (matches.length === 0) {
        say(`No saved chat matches "${target}". /sessions lists them.`);
        return;
      }
      if (matches.length > 1) {
        say(`"${target}" matches ${matches.length} chats. Use more of the id — /sessions lists them.`);
        return;
      }
      await resumeSession(matches[0].id);
      return;
    }
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
      discardApprovals("session-changed");
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
      // Naming this panel's session is what makes the child's prompts
      // answerable here: the child asks under a fresh session id no window has
      // open, so without an owner core addresses its approvals at nobody and
      // they park until the timeout. Read from the RPC params by core, never
      // from the tool arguments a model controls.
      const attached = await ensureEditorSession();
      const result = await rpc<SubagentResult>("subagent_spawn", {
        role,
        instructions: task,
        projectSlug,
        maxTurns: 8,
        ownerSession: attached.id,
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
      void runGraph(graph.graphId, { ownerSession: attached.id })
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

  // Built-ins first: a skill cannot take a command name the composer owns.
  const allCommands: readonly SlashCommand[] = useMemo(
    () => [...SLASH_COMMANDS, ...skillCommands(skills), ...fileCommands(fileCommandInfos)],
    [skills, fileCommandInfos],
  );

  // Running a skill is a normal turn with a normal prompt — core's system
  // prompt already indexes the installed skills, so naming one is enough for
  // the agent to pull its body in with skill_load.
  const runSkill = async (name: string, task: string) => {
    await runTurn(task ? `Use the ${name} skill: ${task}` : `Use the ${name} skill.`);
  };

  const runFileCommand = async (name: string, args: string) => {
    let prompt: string;
    try {
      prompt = await renderFileCommand(name, args, projectSlug);
    } catch (error) {
      say(`/${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!prompt.trim()) {
      say(`/${name} expanded to an empty prompt — check its body.`);
      return;
    }
    await runTurn(prompt);
  };

  const slashContext: SlashContext = {
    say,
    showPanel,
    runSkill,
    runFileCommand,
    agentNames,
    commands: allCommands,
    clear: () => setMessages([]),
    newSession: () => {
      activeTurnRef.current = null;
      discardApprovals("session-changed");
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
    openSideChat: (draft) => {
      if (!onOpenSideChat) {
        say("Side chat is not available here.");
        return;
      }
      onOpenSideChat(draft, undefined, { fresh: true });
      say(
        draft
          ? "Opened a side chat with your question waiting in its composer, unsent."
          : "Opened a side chat. It reads this transcript but cannot change the run.",
        "tool",
      );
    },
    runGraphGoal,
    stopGraph,
    listCheckpoints,
    restoreCheckpoint,
  };

  /**
   * Run a command picked from the menu, clearing the composer the way sending
   * does. Enter on a row that needs no argument runs it here rather than
   * completing the word and waiting for a second Enter — `/side` is a whole
   * instruction already.
   */
  const runPickedCommand = async (command: SlashCommand) => {
    if (busy || looping) return;
    setInput("");
    setCaret(0);
    setMenuIndex(0);
    await command.run("", slashContext);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy || looping) return;
    setInput("");
    setCaret(0);
    setMenuIndex(0);
    const parsed = parseSlashIn(text, allCommands);
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

  // The click handler. `UserAnswered` returns the post-transition store, so
  // the reducer itself is the double-send guard: a second click finds the
  // entry already `answering` and no RPC is issued. There is no in-flight
  // `Set` beside it that could disagree.
  //
  // Note what this function cannot do: it cannot decide. `approved` comes from
  // the button the human pressed and from nowhere else. No transport failure,
  // no state transition, and no run ending reaches an `agent_approval_response`
  // call anywhere in this file.
  const respondToApproval = async (
    entry: ApprovalEntry,
    approved: boolean,
    always = false,
  ): Promise<void> => {
    const before = approvalsRef.current;
    const after = dispatchApproval({
      kind: "UserAnswered",
      requestId: entry.requestId,
      approved,
      nowMs: Date.now(),
    });
    if (after === before) return;
    // A bare denial tells the model the door is shut, so it tries the same
    // door. The sentence the user typed is what redirects it, and core only
    // forwards one on a denial.
    const reason = approved ? "" : (denyReasons[entry.requestId] ?? "").trim();
    try {
      const answer = (await rpc("agent_approval_response", {
        requestId: entry.requestId,
        clientId: editorClientIdRef.current,
        approved,
        // Only ever widens, so it rides along with an approval and is ignored
        // on a denial. Core grants the exact tool name, never the server or a
        // prefix, and refuses outright if config denies it.
        ...(always ? { always: true } : {}),
        ...(reason ? { reason } : {}),
      })) as { alsoApproved?: number } | null;
      // Core answers the sibling cards the grant already covers. Saying how
      // many is what tells the user those cards went away because of their
      // click and not because something dropped them.
      const cascaded = typeof answer?.alsoApproved === "number" ? answer.alsoApproved : 0;
      dispatchApproval({ kind: "SendAccepted", requestId: entry.requestId });
      // The tool name alone is not an identity: four `file_write` grants in a
      // turn leave four identical rows, and the transcript stops being a
      // record of what was permitted.
      const target = approvalTarget(entry.arguments);
      const label = target ? `${entry.tool} · ${target}` : entry.tool;
      setMessages((current) => [
        ...current,
        {
          role: "tool",
          content: approved
            ? always
              ? `Approved ${label} — won't ask again for ${entry.tool} this session${
                  cascaded > 0 ? `, cleared ${cascaded} waiting request${cascaded === 1 ? "" : "s"}` : ""
                }`
              : `Approved ${label}`
            : reason
              ? `Denied ${label} — ${reason}`
              : `Denied ${label}`,
          tool: entry.tool,
          decision: approved ? "approved" : "denied",
        },
      ]);
      setDenyReasons(({ [entry.requestId]: _answered, ...rest }) => rest);
    } catch (error) {
      // The only classifier in this file, with exactly one call site, and its
      // default is "retry" — the card stays up and the click is repeatable.
      // Anything else would be this panel inventing an outcome for a request
      // core is still holding.
      dispatchApproval({
        kind: "SendFailed",
        requestId: entry.requestId,
        failure: classifySendFailure(error),
      });
    }
  };

  // Context meter: occupancy = the last model call's prompt size against the
  // window core's compaction budget measures (see /usage).
  const contextWindow = contextWindowOf(coreConfig, activeContextLimit);
  const contextPercent = usage ? Math.min(100, Math.round((usage.lastPromptTokens / contextWindow) * 100)) : 0;

  const commandMenu = matchCommandsIn(input, allCommands, caret);
  const menuActive = commandMenu.length > 0;
  const activeMenuIndex = Math.min(menuIndex, commandMenu.length - 1);
  const activeReasoning = activeTurnRef.current
    ? reasoningByTurn[activeTurnRef.current.turnId]
    : undefined;
  // A live tool turn already carries its own spinner and elapsed time in the
  // activity row. Rendering the generic busy line as well makes one operation
  // look like two separate runs, especially when the transcript is short.
  const activeTurnId = activeTurnRef.current?.turnId;
  const hasLiveActivity = messages.some(
    (message) =>
      Boolean(
        activeTurnId &&
          message.turnId === activeTurnId &&
          message.toolCallId &&
          message.status === "running",
      ),
  );
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
  // Chips ride on the newest turn, which is the one the fan-out belongs to.
  const latestTurnId = [...activityAnchors.keys()].at(-1);
  const subagentChips: SubagentChipItem[] = (activeGraph?.nodes ?? [])
    .filter((node) => node.status !== "pending" && node.status !== "ready")
    .map((node) => ({
      id: node.id,
      title: node.title,
      status:
        node.status === "running" || node.status === "monitoring"
          ? ("running" as const)
          : node.status === "passed"
            ? ("done" as const)
            : node.status === "failed" || node.status === "rejected"
              ? ("failed" as const)
              : ("pending" as const),
    }));

  /**
   * Open the side chat pinned to one step. The question is left to the
   * operator: the anchor names what they are asking about, which is the part
   * the transcript excerpt cannot be relied on to make unambiguous.
   */
  const askAboutStep = onOpenSideChat
    ? (message: AgentMessage) => {
        const label = `${message.status === "running" ? "Running" : "Ran"} ${message.tool}`;
        const detail = [message.content, message.detail]
          .filter(Boolean)
          .join("\n")
          .slice(0, ANCHOR_DETAIL_CHARS);
        onOpenSideChat(undefined, { label, detail });
      }
    : undefined;

  // Ghost text for a command's parameters — `/loop ` shows `[interval] <goal>`
  // where the argument will go, the way codex and opencode's `argument-hint`
  // does. Only while the composer holds exactly the command and its trailing
  // space: once anything is typed the hint would be describing text that is
  // already there.
  const argumentHint = (() => {
    const parsed = parseSlashIn(input, allCommands);
    if (!parsed?.command?.usage || parsed.args) return null;
    return input === `/${parsed.name} ` ? parsed.command.usage : null;
  })();

  const completeCommand = (name: string) => {
    const completed = completeSlashToken(input, caret, name);
    setInput(completed.text);
    setCaret(completed.caret);
    pendingCaretRef.current = completed.caret;
    setMenuIndex(0);
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
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
                      className="flex min-h-10 items-center gap-2 rounded-lg border border-line bg-surface-1 px-3 py-2 text-left text-[12px] text-ink transition-colors hover:bg-surface-2 active:bg-surface-3"
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
            measure is capped and centered rather than filling the panel.

            The base gap is the tight one, because most rows in a long turn are
            single-line tool steps: at a uniform 18px they read as unrelated
            fragments rather than one run. Prose and prompts buy their own air
            back with a top margin. */}
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-2">
          {activeGraph ? (
            <div
              data-graph-chat-card
              className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-1 px-3 py-2.5 text-xs"
            >
              <Workflow aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-subtle" strokeWidth={1.8} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 font-medium text-ink-strong">Task graph</span>
                  <span className="min-w-0 truncate text-ink-subtle" title={activeGraph.goal}>
                    {activeGraph.goal}
                  </span>
                  <span className="shrink-0 rounded border border-line px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em] text-ink-subtle">
                    {activeGraph.status}
                  </span>
                </div>
                <div className="mt-1 text-[10.5px] text-ink-faint">
                  {activeGraph.nodes.filter((node) => node.status === "passed").length}/{activeGraph.nodes.length} nodes passed
                  {activeGraph.nodes.some((node) => node.status === "running" || node.status === "monitoring")
                    ? " · workers active"
                    : ""}
                </div>
              </div>
              {onOpenGraph ? (
                <button
                  type="button"
                  onClick={onOpenGraph}
                  className="shrink-0 rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink-strong"
                >
                  Open graph
                </button>
              ) : null}
            </div>
          ) : null}

          {messages.map((message, index) => {
            if (message.turnId) {
              if (activityAnchors.get(message.turnId) !== index) return null;
              const turnMessages = activityGroups.get(message.turnId) ?? [message];
              const marker = turnMessages.find((candidate) => isTurnMarker(candidate));
              const firstActionIndex = turnMessages.findIndex((candidate) => Boolean(candidate.toolCallId));
              const actions = turnMessages.filter((candidate) => isTurnMarker(candidate) || candidate.toolCallId);
              const assistantMessages = turnMessages.filter(
                (candidate): candidate is AgentMessage & { role: "assistant" } => candidate.role === "assistant",
              );
              const reasoning = reasoningByTurn[message.turnId];
              const showActivity = actions.some((candidate) => Boolean(candidate.toolCallId)) || marker?.stopped === true;
              const beforeActions =
                firstActionIndex < 0
                  ? []
                  : turnMessages
                      .slice(0, firstActionIndex)
                      .filter(
                        (candidate): candidate is AgentMessage & { role: "assistant" } => candidate.role === "assistant",
                      );
              const afterActions =
                firstActionIndex < 0
                  ? assistantMessages
                  : turnMessages
                      .slice(firstActionIndex + 1)
                      .filter(
                        (candidate): candidate is AgentMessage & { role: "assistant" } => candidate.role === "assistant",
                      );
              const lastUserIndex = previousUserIndex(messages, index);
              // Older/resumed transcripts may contain a visible assistant
              // fragment without the client turn id. If it precedes this
              // tagged group, it still belongs to the same user turn and has
              // already claimed the speaker label.
              const hasExternalAssistantBefore = messages
                .slice(lastUserIndex + 1, index)
                .some((candidate) => candidate.role === "assistant" && candidate.turnId !== message.turnId);
              const headingOffset = hasExternalAssistantBefore ? 1 : 0;
              const assistantRows = (items: Array<AgentMessage & { role: "assistant" }>, continuationOffset = 0) =>
                items.map((assistant, assistantIndex) => (
                  <AssistantMessageRow
                    key={`${message.turnId}-assistant-${assistantIndex + continuationOffset}`}
                    message={assistant}
                    continuation={assistantIndex + continuationOffset > 0}
                  />
                ));
              return (
                <Fragment key={`turn-${message.turnId}`}>
                  {firstActionIndex >= 0 ? assistantRows(beforeActions, headingOffset) : null}
                  {reasoning ? (
                    <ReasoningRow
                      text={reasoning.text}
                      streaming={reasoning.endedAtMs === undefined}
                      durationMs={(reasoning.endedAtMs ?? Date.now()) - reasoning.startedAtMs}
                      defaultCollapsed
                      showDuration={false}
                    />
                  ) : null}
                  {message.turnId === latestTurnId && subagentChips.length > 0 ? (
                    <SubagentChips items={subagentChips} />
                  ) : null}
                  {showActivity ? (
                    <ActivityTurnRow
                      turnId={message.turnId}
                      messages={actions}
                      onOpenFile={onOpenActivityFile}
                    />
                  ) : null}
                  {firstActionIndex >= 0
                    ? assistantRows(afterActions, headingOffset + beforeActions.length)
                    : assistantRows(afterActions, headingOffset)}
                </Fragment>
              );
            }
            if (message.role === "user") {
              return (
                <div
                  key={index}
                  data-role="user"
                  className="mt-4 max-w-[88%] self-end rounded-[9px_9px_2px_9px] bg-surface-3 px-3.5 py-2.5 text-[13px] leading-[1.55] text-ink-strong"
                >
                  {message.content}
                </div>
              );
            }
            if (message.role === "tool") return <ToolRow key={index} message={message} onAsk={askAboutStep} />;
            // The eyebrow names a speaker, and the speaker does not change
            // between two consecutive blocks from the agent. Repeating it
            // splits one answer into two that look like different turns.
            const lastUserIndex = previousUserIndex(messages, index);
            const continuation = messages
              .slice(lastUserIndex + 1, index)
              .some((candidate) => candidate.role === "assistant");
            return <AssistantMessageRow key={index} message={message} continuation={continuation} />;
          })}

          {busy && !activeReasoning && !hasLiveActivity && (
            <div className="self-start" aria-label="Agent is thinking">
              <div className="flex items-baseline gap-2">
                <span className="cb-shimmer text-[12.5px] font-medium">
                  {messages.some((message) => message.status === "running") ? "Working…" : "Thinking…"}
                </span>
                {/* Same formatter as the activity row's clock. Raw seconds
                    here put "331s" and "5m 31s" on screen together, one
                    duration written two ways. */}
                {thinkingSeconds > 0 ? (
                  <span className="text-[10.5px] text-ink-faint">{formatDuration(thinkingSeconds * 1000)}</span>
                ) : null}
              </div>
            </div>
          )}

          {/* One card per pending request, oldest first. Parallel graph nodes
              prompt together and are answered independently in any order; a
              card whose send is in flight sinks below the others so a hung
              request cannot hide the queue behind it. A card that can no
              longer be answered stays visible and says why, rather than
              vanishing or being answered on the user's behalf. */}
          {visibleApprovals(approvals).map((entry) => {
            const answering = entry.state.kind === "answering";
            const settled = entry.state.kind === "settled";
            const lapsed = entry.state.kind === "lapsed";
            const finished = settled || lapsed;
            const target = approvalTarget(entry.arguments);
            const plan = entry.tool === "exit_plan_mode" ? planFrom(entry.arguments) : null;
            // A finished card keeps its own past tense. Leaving the question
            // form up is the defect that made a transcript of completed work
            // read as a wall of unanswered prompts.
            const title = settled
              ? entry.state.kind === "settled" && entry.state.approved
                ? plan
                  ? "Plan approved"
                  : `Approved ${entry.tool}`
                : plan
                  ? "Still planning"
                  : `Denied ${entry.tool}`
              : lapsed
                ? plan
                  ? "The plan was never answered"
                  : `Approval for ${entry.tool} lapsed`
                : plan
                  ? "Start work on this plan?"
                  : `Approve ${entry.tool}?`;
            return (
              <div
                key={entry.requestId}
                data-approval={entry.requestId}
                data-approval-state={entry.state.kind}
                className={`mt-2 w-full self-start rounded-lg border ${
                  finished ? "border-line bg-surface-1 px-3 py-2" : "border-line-strong bg-surface-1 p-3"
                }`}
              >
                <p className={`text-[13px] ${finished ? "text-ink-subtle" : "text-ink-strong"}`}>
                  {title}
                  {entry.graphLabel ? (
                    <span className="ml-1.5 text-[11px] text-ink-subtle">for run {entry.graphLabel}</span>
                  ) : null}
                </p>
                {target && !plan ? (
                  <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint" title={target}>
                    {target}
                  </p>
                ) : null}
                {entry.reason && !plan ? (
                  <p
                    className="mt-1.5 text-[11.5px] leading-[1.5] text-ink"
                    data-approval-reason={entry.reasonSource ?? "unattributed"}
                  >
                    {entry.reasonSource ? (
                      <span className="mr-1 text-ink-faint">
                        {entry.reasonSource === "agent" ? "The agent asks:" : "Flagged for review:"}
                      </span>
                    ) : null}
                    {entry.reason}
                  </p>
                ) : null}
                {plan ? (
                  <div data-approval-plan className="mt-2 max-h-80 overflow-auto rounded-md border border-line bg-surface-0 px-2.5 py-2">
                    {plan.heading ? <p className="mb-1.5 text-[13px] font-bold text-ink-strong">{plan.heading}</p> : null}
                    <AgentText content={plan.body} />
                  </div>
                ) : null}
                {/* Only when there is something the target line did not
                    already say. `null` used to print verbatim, which reads as
                    a bug in the request. */}
                {!plan && !finished && argumentsWorthShowing(entry.arguments, target) ? (
                  <pre className="mt-1.5 max-h-24 overflow-auto text-[11px] leading-[1.5] text-ink-subtle">
                    {JSON.stringify(entry.arguments, null, 2)}
                  </pre>
                ) : null}
                {lapsed && entry.state.kind === "lapsed" ? (
                  <p className="mt-1 text-[11.5px] text-ink-faint first-letter:uppercase">
                    {lapsedExplanation(entry.state.reason)}.
                  </p>
                ) : settled && entry.state.kind === "settled" ? (
                  <p className="mt-1 text-[11.5px] text-ink-faint">
                    {/* Only an always-allow can still be on screen once
                        settled, and nobody clicked this card — saying
                        "Approved." alone would credit the user with a decision
                        they were never shown. */}
                    {entry.state.via === "always-allowed"
                      ? "Covered by the permission you just granted — this one was never asked."
                      : entry.state.approved
                        ? "Approved."
                        : "Denied."}
                  </p>
                ) : (
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button size="sm" disabled={answering} onClick={() => void respondToApproval(entry, true)}>
                      <ShieldCheck className="mr-1 h-3.5 w-3.5" /> {plan ? "Start work" : "Approve"}
                    </Button>
                    {!plan ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={answering}
                        onClick={() => void respondToApproval(entry, true, true)}
                        title={`Stop asking about ${entry.tool} for the rest of this chat`}
                      >
                        <ShieldPlus className="mr-1 h-3.5 w-3.5" /> Always
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={answering}
                      onClick={() => void respondToApproval(entry, false)}
                    >
                      {plan ? (
                        <>
                          <Eye className="mr-1 h-3.5 w-3.5" /> Keep planning
                        </>
                      ) : (
                        <>
                          <ShieldOff className="mr-1 h-3.5 w-3.5" /> Deny
                        </>
                      )}
                    </Button>
                    {/* Optional, and deliberately not a modal step: a denial
                        must stay one click. Enter denies with what is typed,
                        so a reason never needs a second reach for the mouse. */}
                    <input
                      type="text"
                      aria-label={plan ? "What to change about the plan" : `Reason for denying ${entry.tool}`}
                      placeholder={plan ? "What should change? (optional)" : "Deny with a reason (optional)"}
                      disabled={answering}
                      value={denyReasons[entry.requestId] ?? ""}
                      onChange={(event) =>
                        setDenyReasons((current) => ({ ...current, [entry.requestId]: event.target.value }))
                      }
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        void respondToApproval(entry, false);
                      }}
                      className="min-w-[10rem] flex-1 rounded-md border border-line bg-surface-0 px-2 text-[11.5px] text-ink placeholder:text-ink-faint"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {!atBottom && (
          <div className="pointer-events-none sticky bottom-2 flex justify-center">
            <button
              type="button"
              aria-label="Scroll to latest"
              onClick={() =>
                transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" })
              }
              /* The halo is what separates a floating control from whatever it
                 happens to be over. Without it the button sits exactly on a
                 card's top border and reads as part of the card. */
              className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-full border border-line-strong bg-raised text-ink-subtle shadow-[0_0_0_5px_var(--surface-0),0_2px_8px_rgba(0,0,0,0.14)] transition-colors hover:text-ink-strong active:bg-surface-2"
            >
              <ArrowDown aria-hidden className="h-3.5 w-3.5" strokeWidth={1.8} />
            </button>
          </div>
        )}
      </div>

      <div className="shrink-0 bg-surface-0 px-3.5 pb-3.5 pt-2.5">
        <div className="mx-auto w-full max-w-[760px]">
        <RunStatusPill loop={activeLoop} onStop={stopAgent} />
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
          <SlashMenu commands={commandMenu} activeIndex={activeMenuIndex} onPick={completeCommand} />
        )}

        <div
          data-agent-composer
          className="@container relative min-w-0 rounded-[20px] border border-line-strong bg-raised p-1.5 shadow-[0_14px_34px_rgba(0,0,0,0.18)] transition-[border-color,box-shadow] duration-200 focus-within:border-ink-faint focus-within:shadow-[0_16px_38px_rgba(0,0,0,0.24)]"
        >
          {/* Mirrors the textarea's typography and padding so the hint sits
              exactly where the next character will land. */}
          {argumentHint ? (
            <div
              aria-hidden
              data-argument-hint
              className="pointer-events-none absolute left-1.5 right-1.5 top-1.5 px-3 py-2.5 text-[13px] leading-[1.55]"
            >
              <span className="invisible whitespace-pre">{input}</span>
              <span className="text-ink-faint">{argumentHint}</span>
            </div>
          ) : null}
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
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
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  // A fully-typed name beats the highlighted row: `/graph` also
                  // prefixes graph-template and graph-stop, and Enter must run
                  // what was actually typed.
                  const picked = parseSlashIn(input, allCommands)?.command ?? commandMenu[activeMenuIndex];
                  // Run it only when the command is the whole message. Picked
                  // out of the middle of a sentence, Enter completes instead:
                  // running would clear the composer and take the rest of the
                  // message with it. Tab always completes, which is how a
                  // question gets typed after `/side`.
                  const token = slashTokenAt(input, caret);
                  const alone =
                    token !== null &&
                    input.slice(0, token.start).trim() === "" &&
                    input.slice(token.end).trim() === "";
                  if (!alone || !runsBare(picked)) completeCommand(picked.name);
                  else void runPickedCommand(picked);
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
            className="min-h-[56px] resize-none border-0 bg-transparent px-3 py-2.5 text-[13px] leading-[1.55] text-ink-strong shadow-none placeholder:text-ink-faint focus-ring-inset"
          />
          <div className="flex min-h-10 items-center gap-1.5 px-1.5 pb-0.5">
            <PermissionPicker
              value={permissionMode}
              onChange={setPermissionMode}
              projectSlug={projectSlug}
              sandboxNote={sandboxSummary(coreConfig?.sandboxStatus)}
            />

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

            <ModelPicker
              choices={modelChoices}
              activeValue={activeModelValue}
              activeLabel={activeModelId}
              effort={effort}
              effortIndex={effortIndex}
              effortOf={effortFor}
              disabled={!modelList || busy || looping}
              label="Active model"
              title={
                modelList
                  ? `${modelList.active.provider} · ${modelList.active.model}${effort ? ` · ${effort}` : ""}`
                  : "No model"
              }
              onSelect={(value, level) => {
                const modelId = value.split(":").slice(1).join(":");
                if (level) selectEffort(modelId, level);
                if (value !== activeModelValue) void switchModel(value);
              }}
            />

            {/* Every busy turn is stoppable, not just a /loop: a plain prompt
                can spend twenty tool round-trips and used to leave closing the
                window as the only escape. */}
            {busy ? (
              <button
                type="button"
                aria-label={looping ? "Stop agent loop" : "Stop agent"}
                onClick={stopAgent}
                disabled={stopping}
                className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border border-danger-soft/60 bg-danger-soft/15 px-3 text-[11px] text-danger-soft transition-[background-color,transform] enabled:hover:bg-danger-soft/25 enabled:active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Square aria-hidden className="h-3.5 w-3.5 shrink-0" />
                <span>{stopping ? "Stopping…" : "Stop"}</span>
              </button>
            ) : (
              <button
                type="button"
                aria-label="Send message"
                onClick={() => void send()}
                disabled={!input.trim()}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[background-color,transform,opacity] enabled:hover:opacity-90 enabled:active:scale-[0.96] disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-faint disabled:opacity-70"
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
