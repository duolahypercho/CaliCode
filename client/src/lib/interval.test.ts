import { describe, expect, test } from "vitest";
import { formatInterval, parseInterval, parseLoopArgs } from "./interval";

describe("parseInterval", () => {
  test("reads the units every other harness spells", () => {
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("15m")).toBe(900_000);
    expect(parseInterval("2h")).toBe(7_200_000);
    expect(parseInterval("1.5m")).toBe(90_000);
    expect(parseInterval("15M")).toBe(900_000);
  });

  test("rejects anything that is not an interval", () => {
    // A bare number is a goal fragment, not minutes: guessing here would park
    // `/loop 3 failing tests to fix` for three of something.
    expect(parseInterval("3")).toBeNull();
    expect(parseInterval("0m")).toBeNull();
    expect(parseInterval("soon")).toBeNull();
    expect(parseInterval("15min")).toBeNull();
    expect(parseInterval("")).toBeNull();
  });
});

describe("formatInterval", () => {
  test("prints the largest whole unit", () => {
    expect(formatInterval(30_000)).toBe("30s");
    expect(formatInterval(900_000)).toBe("15m");
    expect(formatInterval(7_200_000)).toBe("2h");
    expect(formatInterval(90_000)).toBe("90s");
  });
});

describe("parseLoopArgs", () => {
  test("takes an interval only in first position", () => {
    expect(parseLoopArgs("15m run the tests and fix what fails")).toEqual({
      intervalMs: 900_000,
      profile: "standard",
      goal: "run the tests and fix what fails",
    });
  });

  test("leaves a plain goal alone", () => {
    expect(parseLoopArgs("add a double jump then playtest")).toEqual({
      intervalMs: null,
      profile: "standard",
      goal: "add a double jump then playtest",
    });
  });

  test("keeps an interval-shaped word that is part of the goal", () => {
    expect(parseLoopArgs("make the dash 30s cooldown")).toEqual({
      intervalMs: null,
      profile: "standard",
      goal: "make the dash 30s cooldown",
    });
  });

  test("an interval with no goal is not a loop", () => {
    expect(parseLoopArgs("15m")).toEqual({ intervalMs: null, profile: "standard", goal: "15m" });
  });

  test("defaults to the standard profile — the pipeline is opt-in", () => {
    expect(parseLoopArgs("fix the typo in the README").profile).toBe("standard");
  });

  test("--aaa opts into the quality pipeline", () => {
    expect(parseLoopArgs("--aaa make the boss fight feel good")).toEqual({
      intervalMs: null,
      profile: "aaa",
      goal: "make the boss fight feel good",
    });
  });

  test("the flag and the interval are order-independent", () => {
    const flagFirst = parseLoopArgs("--aaa 15m polish the arena");
    const intervalFirst = parseLoopArgs("15m --aaa polish the arena");
    expect(flagFirst).toEqual({ intervalMs: 900_000, profile: "aaa", goal: "polish the arena" });
    expect(intervalFirst).toEqual(flagFirst);
  });

  test("a flag-shaped word later in the goal is part of the goal", () => {
    expect(parseLoopArgs("document the --aaa flag")).toEqual({
      intervalMs: null,
      profile: "standard",
      goal: "document the --aaa flag",
    });
  });
});
