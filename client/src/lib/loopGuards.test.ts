import { describe, expect, test } from "vitest";
import { budgetNotice, detectStall, exhaustionPrompt, type LoopAction } from "./loopGuards";

const action = (tool: string, signature: string, failed?: boolean): LoopAction => ({ tool, signature, failed });

const repeat = (count: number, value: LoopAction): LoopAction[] => Array.from({ length: count }, () => ({ ...value }));

describe("detectStall", () => {
  test("no actions is ok", () => {
    expect(detectStall([])).toEqual({ level: "ok", reason: "" });
  });

  test("a varied sequence stays ok", () => {
    const verdict = detectStall([
      action("read_file", "a.ts"),
      action("edit_file", "a.ts"),
      action("run_tests", "unit"),
      action("read_file", "b.ts"),
    ]);
    expect(verdict.level).toBe("ok");
    expect(verdict.reason).toBe("");
  });

  test("the same tool with different arguments is progress, not a stall", () => {
    const verdict = detectStall([
      action("read_file", "a.ts"),
      action("read_file", "b.ts"),
      action("read_file", "c.ts"),
      action("read_file", "d.ts"),
      action("read_file", "e.ts"),
    ]);
    expect(verdict.level).toBe("ok");
  });

  test("warns at two identical actions in a row", () => {
    const verdict = detectStall(repeat(2, action("run_tests", "unit")));
    expect(verdict.level).toBe("warn");
    expect(verdict.reason).toContain("run_tests");
    expect(verdict.reason).toContain("2 times");
  });

  test("blocks at five identical actions in a row", () => {
    const verdict = detectStall(repeat(5, action("run_tests", "unit")));
    expect(verdict.level).toBe("block");
    expect(verdict.reason).toContain("5 times");
  });

  test("an intervening different action resets the run", () => {
    const verdict = detectStall([
      ...repeat(4, action("run_tests", "unit")),
      action("edit_file", "player.ts"),
      action("run_tests", "unit"),
    ]);
    expect(verdict.level).toBe("ok");
  });

  test("counts consecutive failures across different actions", () => {
    const warn = detectStall([
      action("read_file", "a.ts"),
      action("edit_file", "a.ts", true),
      action("run_tests", "unit", true),
    ]);
    expect(warn.level).toBe("warn");
    expect(warn.reason).toContain("2 steps");
    expect(warn.reason).toContain("run_tests");

    const block = detectStall([
      action("edit_file", "a.ts", true),
      action("edit_file", "b.ts", true),
      action("run_tests", "unit", true),
      action("edit_file", "c.ts", true),
      action("run_tests", "e2e", true),
    ]);
    expect(block.level).toBe("block");
    expect(block.reason).toContain("5 steps");
  });

  test("a successful step ends the failure run", () => {
    const verdict = detectStall([
      action("edit_file", "a.ts", true),
      action("edit_file", "b.ts", true),
      action("run_tests", "unit"),
    ]);
    expect(verdict.level).toBe("ok");
  });

  test("thresholds are configurable", () => {
    const actions = repeat(3, action("run_tests", "unit"));
    expect(detectStall(actions, { warnAfter: 4, blockAfter: 6 }).level).toBe("ok");
    expect(detectStall(actions, { warnAfter: 2, blockAfter: 3 }).level).toBe("block");
  });

  test("repeated failing calls report the repetition", () => {
    const verdict = detectStall(repeat(3, action("run_tests", "unit", true)));
    expect(verdict.level).toBe("warn");
    expect(verdict.reason).toContain("identical arguments");
  });
});

describe("budgetNotice", () => {
  test("states used and remaining iterations", () => {
    expect(budgetNotice(3, 12)).toContain("iteration 3 of 12");
    expect(budgetNotice(3, 12)).toContain("9 iterations remaining");
  });

  test("singularises the last iteration", () => {
    expect(budgetNotice(11, 12)).toContain("1 iteration remaining");
  });

  test("tells the model to wrap up when the budget is gone", () => {
    expect(budgetNotice(12, 12)).toContain("none remaining");
    expect(budgetNotice(99, 12)).toContain("iteration 12 of 12");
  });
});

describe("exhaustionPrompt", () => {
  test("asks for a handoff instead of more tool calls", () => {
    const prompt = exhaustionPrompt("  ship the double jump  ", 25);
    expect(prompt).toContain("25 iterations");
    expect(prompt).toContain("Goal: ship the double jump");
    expect(prompt).toContain("Stop calling tools");
    expect(prompt).toContain("what still remains");
    expect(prompt).toContain("exact next step");
  });
});
