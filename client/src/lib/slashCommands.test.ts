import { describe, expect, test, vi } from "vitest";
import type { SkillInfo } from "./extensions";
import {
  completeSlashToken,
  matchCommands,
  matchCommandsIn,
  runsBare,
  parseSlashIn,
  parseSlash,
  skillCommands,
  slashTokenAt,
  SLASH_COMMANDS,
  type SlashContext,
} from "./slashCommands";

const skill = (overrides: Partial<SkillInfo> = {}): SkillInfo => ({
  name: "playtest",
  description: "Drive the game and report what broke",
  scope: "global",
  path: "/skills/playtest.md",
  enabled: true,
  ...overrides,
});

describe("parseSlash", () => {
  test("returns null for non-slash input", () => {
    expect(parseSlash("build a wall")).toBeNull();
  });

  test("resolves a known command with no args", () => {
    const parsed = parseSlash("/help");
    expect(parsed?.name).toBe("help");
    expect(parsed?.args).toBe("");
    expect(parsed?.command?.name).toBe("help");
  });

  test("captures the argument tail for /loop", () => {
    const parsed = parseSlash("/loop add a double jump then playtest");
    expect(parsed?.name).toBe("loop");
    expect(parsed?.args).toBe("add a double jump then playtest");
    expect(parsed?.command?.name).toBe("loop");
  });

  test("is case-insensitive on the command name", () => {
    expect(parseSlash("/HELP")?.command?.name).toBe("help");
  });

  test("returns a null command for an unknown name", () => {
    const parsed = parseSlash("/nope");
    expect(parsed?.name).toBe("nope");
    expect(parsed?.command).toBeNull();
  });
});

describe("/side", () => {
  test("opens the side chat", () => {
    const openSideChat = vi.fn();
    const parsed = parseSlash("/side");
    parsed?.command?.run(parsed.args, { openSideChat } as unknown as SlashContext);
    expect(openSideChat).toHaveBeenCalledWith(undefined);
  });

  test("hands the question over as a draft rather than asking it", () => {
    const openSideChat = vi.fn();
    const parsed = parseSlash("/side why did the build fail?");
    parsed?.command?.run(parsed.args, { openSideChat } as unknown as SlashContext);
    expect(openSideChat).toHaveBeenCalledWith("why did the build fail?");
  });
});

describe("matchCommands", () => {
  test("lists all commands for a bare slash", () => {
    expect(matchCommands("/")).toHaveLength(SLASH_COMMANDS.length);
  });

  test("filters by prefix", () => {
    const names = matchCommands("/c").map((command) => command.name);
    expect(names).toContain("compact");
    expect(names).toContain("clear");
    expect(names).not.toContain("loop");
  });

  test("closes the menu once a space is typed", () => {
    expect(matchCommands("/loop ")).toHaveLength(0);
  });

  test("returns nothing for non-slash input", () => {
    expect(matchCommands("hello")).toHaveLength(0);
  });
});

describe("slash token under the caret", () => {
  test("opens the menu for a command typed mid-message", () => {
    const input = "add a double jump then /gr";
    const names = matchCommands(input, input.length).map((command) => command.name);
    expect(names).toContain("graph");
    expect(names).toContain("graph-stop");
    expect(names).not.toContain("loop");
  });

  test("matches the token the caret sits in, not the last one typed", () => {
    const input = "/he and later /co";
    expect(matchCommands(input, 3).map((command) => command.name)).toEqual(["help"]);
    expect(matchCommands(input, input.length).map((command) => command.name)).toContain("compact");
  });

  test("ignores a slash inside a word, so paths and dates stay quiet", () => {
    expect(slashTokenAt("src/lib")).toBeNull();
    expect(slashTokenAt("shipped 3/4")).toBeNull();
    expect(matchCommands("open src/h")).toHaveLength(0);
  });

  test("closes once the token ends", () => {
    expect(slashTokenAt("fix it /loop ")).toBeNull();
  });
});

describe("completeSlashToken", () => {
  test("replaces the token in place and leaves the rest of the message", () => {
    const input = "then /gr the level";
    const completed = completeSlashToken(input, 8, "graph");
    expect(completed.text).toBe("then /graph the level");
    expect(completed.caret).toBe("then /graph ".length);
  });

  test("completes a leading command the way it always did", () => {
    expect(completeSlashToken("/lo", 3, "loop")).toEqual({ text: "/loop ", caret: 6 });
  });
});

describe("skillCommands", () => {
  test("offers each usable skill as a command that runs it", async () => {
    const runSkill = vi.fn().mockResolvedValue(undefined);
    const [command] = skillCommands([skill()]);
    expect(command.name).toBe("playtest");
    expect(command.summary).toBe("Drive the game and report what broke");
    await command.run("check the boss arena", { runSkill } as unknown as SlashContext);
    expect(runSkill).toHaveBeenCalledWith("playtest", "check the boss arena");
  });

  test("leaves out disabled and broken skills — the agent cannot load either", () => {
    const commands = skillCommands([
      skill({ name: "off", enabled: false }),
      skill({ name: "broken", error: "invalid frontmatter YAML" }),
      skill({ name: "good" }),
    ]);
    expect(commands.map((command) => command.name)).toEqual(["good"]);
  });

  test("never shadows a built-in command", () => {
    expect(skillCommands([skill({ name: "loop" })])).toHaveLength(0);
  });

  test("joins the menu beside the built-ins", () => {
    const commands = [...SLASH_COMMANDS, ...skillCommands([skill()])];
    expect(matchCommandsIn("/play", commands).map((command) => command.name)).toEqual(["playtest"]);
    expect(parseSlashIn("/playtest the boss arena", commands)?.command?.name).toBe("playtest");
  });
});

describe("/help", () => {
  test("lists the skills the menu offers, not just the built-ins", () => {
    const say = vi.fn();
    const commands = [...SLASH_COMMANDS, ...skillCommands([skill()])];
    const parsed = parseSlashIn("/help", commands);
    parsed?.command?.run("", { say, commands } as unknown as SlashContext);
    expect(say.mock.calls[0][0]).toContain("/playtest [task] — Drive the game and report what broke");
  });
});

describe("runsBare", () => {
  test("/side is the only command Enter fires on its own", () => {
    const firing = SLASH_COMMANDS.filter(runsBare).map((command) => command.name);
    expect(firing).toEqual(["side"]);
  });

  test("every other built-in completes into the composer instead", () => {
    // Named explicitly because these are the ones that used to fire the moment
    // the word was spelled, before any instructions could be added to them.
    for (const name of ["compact", "clear", "goal", "usage", "diff", "loop", "model", "restore"]) {
      expect(runsBare(SLASH_COMMANDS.find((command) => command.name === name)!)).toBe(false);
    }
  });

  test("a skill waits for its task", () => {
    expect(runsBare(skillCommands([skill()])[0])).toBe(false);
  });
});

describe("/loop", () => {
  const runLoop = vi.fn();
  const say = vi.fn();
  const run = (input: string) => {
    runLoop.mockReset();
    say.mockReset();
    const parsed = parseSlash(input);
    parsed?.command?.run(parsed.args, { runLoop, say } as unknown as SlashContext);
  };

  test("passes a leading interval through as pacing", () => {
    run("/loop 15m run the tests and fix what fails");
    expect(runLoop).toHaveBeenCalledWith("run the tests and fix what fails", 900_000);
  });

  test("runs flat out when no interval is given", () => {
    run("/loop add a double jump then playtest");
    expect(runLoop).toHaveBeenCalledWith("add a double jump then playtest", null);
  });

  test("explains itself instead of looping on nothing", () => {
    run("/loop");
    expect(runLoop).not.toHaveBeenCalled();
    expect(say.mock.calls[0][0]).toContain("/loop <interval> <goal>");

    // An interval with no goal is the same mistake with more typing.
    run("/loop 15m");
    expect(runLoop).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalled();
  });
});

describe("/compact", () => {
  const compact = vi.fn();
  const run = (input: string) => {
    compact.mockReset();
    const parsed = parseSlash(input);
    parsed?.command?.run(parsed.args, { compact } as unknown as SlashContext);
  };

  test("compacts with no steer when given none", () => {
    run("/compact");
    // undefined, not "": an empty string is the instruction to forget the
    // standing one, which a bare /compact must not do.
    expect(compact).toHaveBeenCalledWith(undefined);
  });

  test("passes instructions through", () => {
    run("/compact keep the repro steps and the failing test names");
    expect(compact).toHaveBeenCalledWith("keep the repro steps and the failing test names");
  });

  test("clears the standing instructions", () => {
    run("/compact clear");
    expect(compact).toHaveBeenCalledWith("");
    run("/compact CLEAR");
    expect(compact).toHaveBeenCalledWith("");
  });
});
