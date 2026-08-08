import { describe, expect, test } from "vitest";
import { matchCommands, parseSlash, SLASH_COMMANDS } from "./slashCommands";

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
