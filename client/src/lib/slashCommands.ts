import { parseRestoreArgs } from "./checkpoints";
import { parseInterval, parseLoopArgs, type LoopProfile } from "./interval";
import type { FileCommandInfo, SkillInfo } from "./extensions";
import type { CommandPanel } from "./types";

// Slash-command registry for the agent panel — the harness surface that codex,
// opencode, and t3-code all expose. Commands are data; execution is delegated to
// a `SlashContext` the panel supplies so this module stays free of React state.

export interface SlashContext {
  /** Push a transcript line. `role` defaults to assistant. */
  say: (content: string, role?: "assistant" | "tool") => void;
  /**
   * Push a structured readout. `text` rides along as the fallback body, so a
   * transcript read back without the renderer is still readable.
   */
  showPanel: (panel: CommandPanel, text: string) => void;
  /** Clear the visible transcript. */
  clear: () => void;
  /** Start a fresh session (new sessionId, empty transcript). */
  newSession: () => void;
  /** Switch model from a `<provider>:<model>` or bare `<model>` argument. */
  switchModel: (raw: string) => Promise<void>;
  /**
   * Run the autonomous loop toward a goal. `intervalMs` turns it into a watch:
   * the loop waits that long between iterations and keeps going after the goal
   * is met, instead of finishing at the first accepted DONE. `profile` picks
   * how much process is imposed on the goal — see [`LoopProfile`].
   */
  runLoop: (goal: string, intervalMs: number | null, profile: LoopProfile) => Promise<void>;
  /**
   * Compact the core session in place (session_compact RPC). `instructions`
   * steer what the summary keeps and are remembered for this session, so the
   * automatic compactions that follow obey them too; `""` forgets them.
   */
  compact: (instructions?: string) => Promise<void>;
  /** Print session token totals and context occupancy. */
  usage: () => void | Promise<void>;
  /** List the files the agent changed this session. */
  diff: () => Promise<void>;
  /** Resume a saved session by id (or its prefix); the newest without one. */
  resumeLast: (target?: string) => Promise<void>;
  /** Fork the current session into a new one. */
  fork: () => Promise<void>;
  /** Print the saved session list into the transcript. */
  listSessions: () => Promise<void>;
  /** Spawn a scoped subagent: a role plus a one-line task. */
  spawnSubagent: (role: string, task: string) => Promise<void>;
  /**
   * Open the side chat — the read-only observer conversation about this run.
   * A draft is put in its composer unsent: `/side <question>` is a way *into*
   * the side chat, and firing the question on the way would deny the operator
   * the chance to edit it there.
   */
  openSideChat: (draft?: string) => void;
  /** Plan a task graph for a goal and run it (optionally from a template). */
  runGraphGoal: (goal: string, template?: string) => Promise<void>;
  /** Cancel the active task graph, if any. */
  stopGraph: () => void | Promise<void>;
  /** Print the restore points automatic checkpointing recorded. */
  listCheckpoints: () => void | Promise<void>;
  /**
   * Revert the project to a checkpoint. `confirmed` is the whole guard: the
   * first, unconfirmed call must only describe what would be overwritten.
   */
  restoreCheckpoint: (id: string, confirmed: boolean) => Promise<void>;
  /**
   * Subagent names core reports (`agent_list`), beyond the built-in roles.
   * Absent means "built-ins only", which is what an older client sends.
   */
  agentNames?: readonly string[];
  /** Run an installed skill by name, with an optional task tail. */
  runSkill: (name: string, task: string) => Promise<void>;
  /**
   * Run a file-defined command: expand its markdown body through core
   * (`command_render`, which substitutes `$ARGUMENTS` and `$1..$9`) and send
   * the result as an ordinary turn. Expansion happens in core so one
   * definition of the syntax serves every client.
   */
  runFileCommand: (name: string, args: string) => Promise<void>;
  /**
   * Everything the panel's menu offers, built-ins plus skills. `/help` reads
   * it so the listing matches the menu; absent, it falls back to the built-ins.
   */
  commands?: readonly NamedCommand[];
}

/**
 * Roles that work with no file behind them. Core mirrors this list in
 * `agents::BUILTIN_ROLES`, and refuses a definition that claims one of these
 * names, so the same word cannot mean two things.
 *
 * This is no longer the whole set: `~/.cali/agents/<name>.md` defines more,
 * and `SlashContext.agentNames` carries whatever core reports. Validation goes
 * through [`knownSubagentRoles`] rather than this constant.
 */
export const SUBAGENT_ROLES = ["planner", "coder", "tester", "critic"] as const;

/** Built-ins plus whatever files define, lowercased and deduped. */
export function knownSubagentRoles(defined: readonly string[] = []): string[] {
  const names = new Set<string>(SUBAGENT_ROLES);
  for (const name of defined) {
    const trimmed = name.trim().toLowerCase();
    if (trimmed) names.add(trimmed);
  }
  return [...names];
}

export interface SlashCommand extends NamedCommand {
  run: (args: string, ctx: SlashContext) => void | Promise<void>;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "help",
    summary: "List available commands",
    run: (_args, ctx) => {
      const commands = ctx.commands ?? SLASH_COMMANDS;
      const lines = commands.map(
        (command) => `/${command.name}${command.usage ? ` ${command.usage}` : ""} — ${command.summary}`,
      );
      ctx.showPanel(
        {
          kind: "help",
          commands: commands.map((command) => ({
            name: command.name,
            usage: command.usage,
            summary: command.summary,
            kind: command.kind,
          })),
        },
        ["Commands:", ...lines].join("\n"),
      );
    },
  },
  {
    name: "loop",
    summary: "Work toward a goal until done, or re-check it on an interval",
    usage: "[--aaa] [interval] <goal>",
    run: (args, ctx) => {
      const { intervalMs, profile, goal } = parseLoopArgs(args);
      // `/loop 15m` on its own is an interval with nothing to do: run it and
      // the loop would spend an hour chasing the goal "15m".
      if (!goal || parseInterval(goal) !== null) {
        ctx.say(
          "Usage: /loop <goal> — I'll keep working until the goal is met or you stop the run.\n" +
            "/loop <interval> <goal> — same work, paced: `/loop 15m run the tests and fix what fails` keeps re-checking every 15m until you stop it. Units are s, m, h.\n" +
            "/loop --aaa <goal> — the quality pipeline: a specialist task graph, PIE evidence, and a judge that has to score the result before DONE is believed.",
        );
        return;
      }
      return ctx.runLoop(goal, intervalMs, profile);
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
    summary: "Run a subagent — a built-in role, or one you defined in agents/",
    usage: "<role> <task>",
    run: (args, ctx) => {
      const roles = knownSubagentRoles(ctx.agentNames);
      const match = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
      const role = match?.[1].toLowerCase();
      if (!match || !role || !roles.includes(role)) {
        ctx.say(
          `Usage: /spawn <${roles.join("|")}> <task>\n` +
            "Define more in ~/.cali/agents/<name>.md — the body becomes that agent's system prompt.",
        );
        return;
      }
      return ctx.spawnSubagent(role, match[2].trim());
    },
  },
  {
    name: "side",
    summary: "Open a side chat: ask about this run without touching it",
    usage: "[question]",
    // The one command Enter fires on its own — it opens a panel, it changes
    // nothing about the run, and waiting for a second keystroke to get there
    // would be friction for the sake of consistency.
    runsOnEnter: true,
    run: (args, ctx) => ctx.openSideChat(args.trim() || undefined),
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
    name: "graph-stop",
    summary: "Cancel the running task graph",
    run: (_args, ctx) => ctx.stopGraph(),
  },
  {
    name: "compact",
    summary: "Compact the session, optionally saying what the summary must keep",
    usage: "[instructions | clear]",
    run: (args, ctx) => {
      const trimmed = args.trim();
      // `clear` is a word, not an instruction: nobody means "summarize with
      // particular attention to the word clear".
      if (trimmed.toLowerCase() === "clear") return ctx.compact("");
      return ctx.compact(trimmed || undefined);
    },
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
    name: "checkpoints",
    summary: "List restore points taken during unattended runs",
    run: (_args, ctx) => ctx.listCheckpoints(),
  },
  {
    name: "restore",
    summary: "Roll this game back to a restore point (destructive; needs confirm)",
    usage: "<id> [confirm]",
    run: (args, ctx) => {
      const parsed = parseRestoreArgs(args);
      if (!parsed) {
        ctx.say("Usage: /restore <checkpoint-id>, then /restore <checkpoint-id> confirm to apply it. /checkpoints lists the ids.");
        return;
      }
      return ctx.restoreCheckpoint(parsed.id, parsed.confirmed);
    },
  },
  {
    name: "sessions",
    summary: "List saved sessions",
    run: (_args, ctx) => ctx.listSessions(),
  },
  {
    name: "resume",
    summary: "Resume a saved chat, or your most recent one",
    usage: "[chat-id]",
    run: (args, ctx) => ctx.resumeLast(args.trim() || undefined),
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

/**
 * The shape both composers' menus render. The side chat carries its own
 * commands over its own context, so the parsing helpers are keyed on the name
 * alone and stay agnostic about what running one does.
 */
export interface NamedCommand {
  name: string;
  summary: string;
  usage?: string;
  /** Menu label; defaults to the name title-cased (see [`commandLabel`]). */
  label?: string;
  /** Skills and file commands are tagged so the menu can say where a row
   * came from. */
  kind?: "skill" | "command";
  /**
   * Enter on the bare name runs the command instead of completing it into the
   * composer. Off for everything but `/side`: see [`runsBare`].
   */
  runsOnEnter?: boolean;
}

export interface ParsedSlash<Command extends NamedCommand = SlashCommand> {
  name: string;
  args: string;
  command: Command | null;
}

/** Parse `/name rest` against a command set, or null if it is not a slash command. */
export function parseSlashIn<Command extends NamedCommand>(
  input: string,
  commands: readonly Command[],
): ParsedSlash<Command> | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/(\S*)\s*([\s\S]*)$/.exec(trimmed);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const args = match[2] ?? "";
  const command = commands.find((candidate) => candidate.name === name) ?? null;
  return { name, args, command };
}

/** The `/word` being typed at the caret, as a slice of the input. */
export interface SlashToken {
  /** Text between the `/` and the caret, lowercased. */
  prefix: string;
  /** Index of the `/`. */
  start: number;
  /** Index just past the token — the caret. */
  end: number;
}

/**
 * The slash token under the caret, or null if there is none.
 *
 * The token does not have to start the message: `fix the jump then /gr` opens
 * the menu, because a command word is worth completing wherever it is typed.
 * A `/` only counts at a word boundary, so paths and dates (`a/b`, `1/2`)
 * never open it.
 */
export function slashTokenAt(input: string, caret: number = input.length): SlashToken | null {
  const end = Math.max(0, Math.min(caret, input.length));
  let start = end;
  while (start > 0 && !/\s/.test(input[start - 1])) start -= 1;
  if (input[start] !== "/") return null;
  const prefix = input.slice(start + 1, end);
  if (/[^A-Za-z0-9_-]/.test(prefix)) return null;
  return { prefix: prefix.toLowerCase(), start, end };
}

/**
 * Whether a command is useless without an argument — `<angle>` in its usage,
 * outside the `[optional]` groups. It decides what Enter does on a menu row:
 * `/loop` needs a goal, so picking it completes the word and waits, while
 * `/side` and `/clear` are whole commands already and simply run.
 */
/**
 * Whether Enter on a bare `/name` runs it, or completes it into the composer
 * and waits.
 *
 * Completing is the rule and running is the exception, because Enter is the
 * key you press by reflex after typing a word. Firing on it means `/compact`
 * or `/clear` executes the instant the name is spelled, with no chance to add
 * the instructions the command takes — and no chance to change your mind. So
 * the first Enter only finishes the word; a second one, on the completed
 * `/name `, runs it.
 *
 * `/side` opts out via `runsOnEnter`: it opens a panel rather than acting on
 * the run, nothing it does is hard to undo, and one keystroke into the side
 * chat is the whole point of it.
 */
export function runsBare(command: NamedCommand): boolean {
  return command.runsOnEnter === true;
}

/** Words that must not be sentence-cased when a label is derived. */
const ACRONYMS: Record<string, string> = { mcp: "MCP", ui: "UI", qa: "QA" };

/**
 * The human label for a menu row: `graph-template` reads as "Graph template".
 *
 * Derived rather than authored so a label can never drift from the name the
 * user actually types — the menu shows no slash, and a label that said
 * something else would leave no way to guess the command.
 */
export function commandLabel(command: NamedCommand): string {
  if (command.label) return command.label;
  return command.name
    .split("-")
    .map((word, index) =>
      ACRONYMS[word] ?? (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word),
    )
    .join(" ");
}

/**
 * Commands to show in the autocomplete menu for the token under the caret,
 * ordered the way the menu draws them.
 *
 * Sorted here rather than in the menu component because the caller indexes
 * this same array to decide what Enter runs; sorting only the view would point
 * the highlight at one row and fire another.
 */
export function matchCommandsIn<Command extends NamedCommand>(
  input: string,
  commands: readonly Command[],
  caret: number = input.length,
): Command[] {
  const token = slashTokenAt(input, caret);
  if (!token) return [];
  return commands
    .filter((command) => command.name.startsWith(token.prefix))
    .sort((a, b) => commandLabel(a).localeCompare(commandLabel(b)));
}

/**
 * Accept a menu row: swap the token under the caret for `/name `, leaving the
 * rest of the message alone. Returns the new text and where the caret goes.
 */
export function completeSlashToken(
  input: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const token = slashTokenAt(input, caret);
  const start = token?.start ?? Math.max(0, Math.min(caret, input.length));
  const end = token?.end ?? start;
  // One separator, wherever the token sits: mid-message the space after it is
  // already there, and adding a second would leave `/graph  the level`.
  const separator = /\s/.test(input[end] ?? "") ? "" : " ";
  const text = `${input.slice(0, start)}/${name}${separator}${input.slice(end)}`;
  return { text, caret: start + 1 + name.length + 1 };
}

/**
 * Installed skills as slash commands, so `/<skill>` runs one the same way a
 * built-in runs. Broken and disabled skills are left out — they are not in
 * core's prompt index either, so the agent could not load them. A skill may
 * not shadow a built-in: the composer's own commands win the name.
 */
export function skillCommands(skills: readonly SkillInfo[]): SlashCommand[] {
  const taken = new Set(SLASH_COMMANDS.map((command) => command.name));
  const commands: SlashCommand[] = [];
  for (const skill of skills) {
    if (!skill.enabled || skill.error) continue;
    const name = skill.name.trim().toLowerCase();
    if (!name || taken.has(name)) continue;
    taken.add(name);
    commands.push({
      name,
      summary: skill.description || `Run the ${skill.name} skill`,
      usage: "[task]",
      kind: "skill",
      run: (args, ctx) => ctx.runSkill(skill.name, args.trim()),
    });
  }
  return commands;
}

/**
 * File-defined commands (`~/.cali/commands/*.md`, plus the project's own) as
 * slash commands. Broken files are left out — they are listed in core's
 * `command_list` so the menu could show the parse error, but running one would
 * send an empty prompt. Like a skill, a file command may not shadow a
 * built-in; core refuses those names too, so this is the second of two locks
 * on the same door.
 */
export function fileCommands(commands: readonly FileCommandInfo[]): SlashCommand[] {
  const taken = new Set(SLASH_COMMANDS.map((command) => command.name));
  const out: SlashCommand[] = [];
  for (const command of commands) {
    if (command.error) continue;
    const name = command.name.trim().toLowerCase();
    if (!name || taken.has(name)) continue;
    taken.add(name);
    out.push({
      name,
      summary: command.description || `Run the ${name} command`,
      usage: command.argumentHint ?? "[arguments]",
      kind: "command",
      run: (args, ctx) => ctx.runFileCommand(name, args.trim()),
    });
  }
  return out;
}

/** Parse `/name rest` from input, or null if it is not a slash command. */
export function parseSlash(input: string): ParsedSlash | null {
  return parseSlashIn(input, SLASH_COMMANDS);
}

export function matchCommands(input: string, caret: number = input.length): SlashCommand[] {
  return matchCommandsIn(input, SLASH_COMMANDS, caret);
}
