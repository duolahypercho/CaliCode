// Session-scoped objective for `/goal`. The goal outlives a turn: after each
// one a tool-less evaluator judges it, and while it is unmet the evaluator's
// reason is injected as the next turn's directive. Everything here is pure so
// the panel owns the state and the RPC.

export interface GoalState {
  goal: string;
  /** Epoch ms when it was set. */
  startedAtMs: number;
  /** Turns evaluated so far. */
  evaluations: number;
  /** Latest evaluator reason, shown in the status line. */
  lastReason?: string;
}

export type GoalCommand =
  | { action: "set"; goal: string }
  | { action: "show" }
  | { action: "clear" };

/** Words that retire a goal without the evaluator having to agree. */
const CLEAR_WORDS = new Set(["clear", "off", "done"]);

const DEFAULT_TRANSCRIPT_CHARS = 8000;

/** Parse `/goal` arguments: empty → show, "clear"/"off"/"done" → clear, else set. */
export function parseGoalCommand(args: string): GoalCommand {
  const trimmed = args.trim();
  if (!trimmed) return { action: "show" };
  if (CLEAR_WORDS.has(trimmed.toLowerCase())) return { action: "clear" };
  return { action: "set", goal: trimmed };
}

function labelFor(entry: { role: string; tool?: string }): string {
  const role = entry.role.trim().toLowerCase() || "message";
  const tool = entry.tool?.trim();
  // The evaluator has to tell a claim ("I fixed it") from a result, so tool
  // entries carry the tool that produced them.
  return tool ? `${role}(${tool})` : role;
}

/**
 * Drop the head of an over-long entry but keep its label; a bare tail would
 * leave the evaluator unable to attribute the text.
 */
function truncateFront(line: string, limit: number): string {
  if (line.length <= limit) return line;
  const separator = line.indexOf(": ");
  const label = separator > 0 ? line.slice(0, separator + 2) : "";
  const budget = limit - label.length - 1;
  if (budget <= 0) return line.slice(line.length - limit);
  return `${label}…${line.slice(line.length - budget)}`;
}

export interface TranscriptWindow {
  /** The excerpt itself. */
  text: string;
  /** Entries that made the excerpt. */
  kept: number;
  /** Entries with content that could have. */
  total: number;
  /** True when the budget dropped an entry, or clipped the head of one. */
  truncated: boolean;
}

/**
 * The excerpt plus what it left out.
 *
 * The counts exist so a caller can say so: a reader who cannot tell that the
 * head of a long run was dropped will read a confident answer about a step the
 * model never saw as if it were grounded.
 */
export function buildTranscriptWindow(
  messages: Array<{ role: string; content: string; tool?: string }>,
  maxChars = DEFAULT_TRANSCRIPT_CHARS,
): TranscriptWindow {
  const total = messages.filter((entry) => entry.content?.trim()).length;
  const limit = Math.floor(maxChars);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { text: "", kept: 0, total, truncated: total > 0 };
  }
  const kept: string[] = [];
  let used = 0;
  let clipped = false;
  // Walk backwards: the recent turns decide whether the goal is met, so the
  // budget is spent from the newest entry outwards and the head is dropped.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    const content = entry.content?.trim();
    if (!content) continue;
    const line = `${labelFor(entry)}: ${content}`;
    const cost = kept.length ? line.length + 1 : line.length;
    if (used + cost <= limit) {
      kept.unshift(line);
      used += cost;
      continue;
    }
    if (!kept.length) {
      kept.push(truncateFront(line, limit));
      clipped = true;
    }
    break;
  }
  return { text: kept.join("\n"), kept: kept.length, total, truncated: clipped || kept.length < total };
}

/** The excerpt handed to the evaluator: the tail of the transcript, capped. */
export function buildEvaluatorTranscript(
  messages: Array<{ role: string; content: string; tool?: string }>,
  maxChars = DEFAULT_TRANSCRIPT_CHARS,
): string {
  return buildTranscriptWindow(messages, maxChars).text;
}

/** The directive injected as the next turn's user message when a goal is unmet. */
export function goalContinuationPrompt(goal: string, reason: string, evaluations: number): string {
  const check = Math.max(0, Math.floor(evaluations)) + 1;
  return [
    "Keep going — your goal is not met yet.",
    `Goal: ${goal.trim()}`,
    `Not met because: ${reason.trim()}`,
    `Fix exactly that, then continue. It is re-checked after this turn (check ${check}).`,
  ].join("\n");
}

/** One-line status for the transcript, e.g. `goal: ship the jump — unmet (3 checks)`. */
export function formatGoalStatus(state: GoalState | null): string {
  if (!state) return "goal: none";
  const goal = state.goal.trim();
  const evaluations = Math.max(0, Math.floor(state.evaluations));
  // A met goal is cleared by the caller, so any surviving state is unmet.
  const head =
    evaluations === 0
      ? `goal: ${goal} — set`
      : `goal: ${goal} — unmet (${evaluations === 1 ? "1 check" : `${evaluations} checks`})`;
  const reason = state.lastReason?.trim();
  return reason ? `${head}: ${reason}` : head;
}

/**
 * Words that describe a feeling rather than an end state. A tool-less
 * evaluator cannot decide "nicer", so it would either never pass or pass
 * arbitrarily.
 */
const SUBJECTIVE_WORDS = [
  "better",
  "nicer",
  "nice",
  "good",
  "great",
  "cool",
  "pretty",
  "prettier",
  "polished",
  "polish",
  "awesome",
  "fun",
  "clean",
  "improve",
  "improved",
];

/**
 * Cues that a check was named anyway ("looks better once the jump test
 * passes"). Their presence keeps a subjective word from tripping the hint.
 */
const CHECK_CUES = ["test", "tests", "passes", "pass", "assert", "until", "verify", "check", "fps", "ms", "error", "errors"];

const MIN_GOAL_CHARS = 12;

/**
 * Advisory only — the caller still sets the goal. This is a hint printed
 * beside it, never a block, because the heuristic is deliberately crude and
 * would otherwise reject perfectly good goals it does not understand.
 */
export function goalIsVerifiable(goal: string): { ok: boolean; hint?: string } {
  const trimmed = goal.trim();
  if (trimmed.length < MIN_GOAL_CHARS) {
    return {
      ok: false,
      hint: "That is short enough that I cannot tell when it is done. Say what should be true at the end.",
    };
  }
  const words = trimmed.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const vague = SUBJECTIVE_WORDS.find((word) => words.includes(word));
  if (!vague) return { ok: true };
  const hasCheck = words.some((word) => CHECK_CUES.includes(word)) || /\d/.test(trimmed);
  if (hasCheck) return { ok: true };
  return {
    ok: false,
    hint: `"${vague}" has no observable end state. Name the check that decides it, e.g. "…until the jump test passes".`,
  };
}
