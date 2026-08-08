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
  /** Summarize the transcript to reclaim context. */
  compact: () => Promise<void>;
  /** List the files the agent changed this session. */
  diff: () => Promise<void>;
  /** Resume the most recent saved session. */
  resumeLast: () => Promise<void>;
  /** Fork the current session into a new one. */
  fork: () => Promise<void>;
  /** Print the saved session list into the transcript. */
  listSessions: () => Promise<void>;
}

export interface SlashCommand {
  name: string;
  summary: string;
  usage?: string;
  run: (args: string, ctx: SlashContext) => void | Promise<void>;
}

/** Max iterations `/loop` will run before stopping on its own. */
export const MAX_LOOP_ITERATIONS = 25;

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
    name: "compact",
    summary: "Summarize the conversation to reclaim context",
    run: (_args, ctx) => ctx.compact(),
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
