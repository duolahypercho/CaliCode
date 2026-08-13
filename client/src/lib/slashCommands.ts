import { parseGoalCommand, type GoalCommand } from "./goal";

// Slash-command registry for the agent panel — the harness surface that codex,
// opencode, and t3-code all expose. Commands are data; execution is delegated to
// a `SlashContext` the panel supplies so this module stays free of React state.

export interface SlashContext {
  /** Push a transcript line. `role` defaults to assistant. */
  say: (content: string, role?: "assistant" | "tool") => void;
  /** Clear the visible transcript. */
  clear: () => void;
  /** Start a fresh session (new sessionId, empty transcript). */
  newSession: () => void;
  /** Switch model from a `<provider>:<model>` or bare `<model>` argument. */
  switchModel: (raw: string) => Promise<void>;
  /** Run the autonomous loop toward a goal until the agent reports done. */
  runLoop: (goal: string) => Promise<void>;
  /** Compact the core session in place (session_compact RPC). */
  compact: () => Promise<void>;
  /** Print session token totals and context occupancy. */
  usage: () => void | Promise<void>;
  /** List the files the agent changed this session. */
  diff: () => Promise<void>;
  /** Resume the most recent saved session. */
  resumeLast: () => Promise<void>;
  /** Fork the current session into a new one. */
  fork: () => Promise<void>;
  /** Print the saved session list into the transcript. */
  listSessions: () => Promise<void>;
  /** Spawn a scoped subagent: a role plus a one-line task. */
  spawnSubagent: (role: string, task: string) => Promise<void>;
  /** Plan a task graph for a goal and run it (optionally from a template). */
  runGraphGoal: (goal: string, template?: string) => Promise<void>;
  /** Cancel the active task graph, if any. */
  stopGraph: () => void | Promise<void>;
  /** Set, show or clear the session goal (see lib/goal). */
  runGoalCommand: (command: GoalCommand) => void | Promise<void>;
}

/** Roles core's subagent_spawn understands. */
export const SUBAGENT_ROLES = ["planner", "coder", "tester", "critic"] as const;

export interface SlashCommand {
  name: string;
  summary: string;
  usage?: string;
  run: (args: string, ctx: SlashContext) => void | Promise<void>;
}

/**
 * Iterations `/loop` will run before it stops asking for tools and hands back
 * a summary. This is a runaway backstop, not a product limit: the loop's real
 * exit is its completion gate, and the real runaway guard is `detectStall`
 * in lib/loopGuards — a counter only catches a stuck loop by accident, since
 * twenty iterations of genuine progress and twenty repeats of one failing
 * action look identical to it. Comparable harnesses bear this out: Codex and
 * opencode ship no cap at all, and Hermes — the one that does — sits at 90.
 */
export const MAX_LOOP_ITERATIONS = 100;

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "help",
    summary: "List available commands",
    run: (_args, ctx) => {
      const lines = SLASH_COMMANDS.map(
        (command) => `/${command.name}${command.usage ? ` ${command.usage}` : ""} — ${command.summary}`,
      );
      ctx.say(["Commands:", ...lines].join("\n"));
    },
  },
  {
    name: "loop",
    summary: "Run autonomously toward a goal until done",
    usage: "<goal>",
    run: (args, ctx) => {
      if (!args.trim()) {
        ctx.say("Usage: /loop <goal> — I'll keep working until the goal is met or I hit the iteration cap.");
        return;
      }
      return ctx.runLoop(args.trim());
    },
  },
  {
    name: "model",
    summary: "Switch the active model",
    usage: "<provider>:<model>",
    run: (args, ctx) => {
      if (!args.trim()) {
        ctx.say("Usage: /model <provider>:<model> or /model <model>");
        return;
      }
      return ctx.switchModel(args.trim());
    },
  },
  {
    name: "spawn",
    summary: "Run a subagent (planner, coder, tester, critic)",
    usage: "<role> <task>",
    run: (args, ctx) => {
      const match = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
      const role = match?.[1].toLowerCase();
      if (!match || !SUBAGENT_ROLES.includes(role as (typeof SUBAGENT_ROLES)[number])) {
        ctx.say(`Usage: /spawn <${SUBAGENT_ROLES.join("|")}> <task>`);
        return;
      }
      return ctx.spawnSubagent(role as string, match[2].trim());
    },
  },
  {
    name: "graph",
    summary: "Plan a task graph for a goal and run it",
    usage: "<goal>",
    run: (args, ctx) => {
      if (!args.trim()) {
        ctx.say("Usage: /graph <goal> — plans a task DAG and runs it node by node.");
        return;
      }
      return ctx.runGraphGoal(args.trim());
    },
  },
  {
    name: "graph-template",
    summary: "Run a goal through a graph template (aaa-fps, polished-asset, …)",
    usage: "<template> <goal>",
    run: (args, ctx) => {
      const match = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
      if (!match) {
        ctx.say("Usage: /graph-template <template-id> <goal>");
        return;
      }
      return ctx.runGraphGoal(match[2].trim(), match[1]);
    },
  },
  {
    name: "goal",
    summary: "Keep working toward a goal, re-checked after every turn",
    usage: "[<objective> | clear]",
    run: (args, ctx) => ctx.runGoalCommand(parseGoalCommand(args)),
  },
  {
    name: "graph-stop",
    summary: "Cancel the running task graph",
    run: (_args, ctx) => ctx.stopGraph(),
  },
  {
    name: "compact",
    summary: "Compact the session: summarize old turns, keep head and tail",
    run: (_args, ctx) => ctx.compact(),
  },
  {
    name: "usage",
    summary: "Show token usage and context occupancy",
    run: (_args, ctx) => ctx.usage(),
  },
  {
    name: "diff",
    summary: "List files changed in this session",
    run: (_args, ctx) => ctx.diff(),
  },
  {
    name: "sessions",
    summary: "List saved sessions",
    run: (_args, ctx) => ctx.listSessions(),
  },
  {
    name: "resume",
    summary: "Resume your most recent session",
    run: (_args, ctx) => ctx.resumeLast(),
  },
  {
    name: "fork",
    summary: "Fork the current session into a new one",
    run: (_args, ctx) => ctx.fork(),
  },
  {
    name: "clear",
    summary: "Clear the transcript (keeps the session)",
    run: (_args, ctx) => ctx.clear(),
  },
  {
    name: "new",
    summary: "Start a fresh session",
    run: (_args, ctx) => ctx.newSession(),
  },
];

export interface ParsedSlash {
  name: string;
  args: string;
  command: SlashCommand | null;
}

/** Parse `/name rest` from input, or null if it is not a slash command. */
export function parseSlash(input: string): ParsedSlash | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/(\S*)\s*([\s\S]*)$/.exec(trimmed);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const args = match[2] ?? "";
  const command = SLASH_COMMANDS.find((candidate) => candidate.name === name) ?? null;
  return { name, args, command };
}

/**
 * Commands to show in the autocomplete menu: only while the user is still
 * typing the command word (a leading `/` with no space yet).
 */
export function matchCommands(input: string): SlashCommand[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/") || /\s/.test(trimmed)) return [];
  const prefix = trimmed.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(prefix));
}
