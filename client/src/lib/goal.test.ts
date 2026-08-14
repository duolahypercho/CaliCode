import { describe, expect, test } from "vitest";
import {
  buildEvaluatorTranscript,
  buildTranscriptWindow,
  formatGoalStatus,
  goalContinuationPrompt,
  goalIsVerifiable,
  parseGoalCommand,
} from "./goal";

describe("parseGoalCommand", () => {
  test("empty arguments show the current goal", () => {
    expect(parseGoalCommand("")).toEqual({ action: "show" });
    expect(parseGoalCommand("   ")).toEqual({ action: "show" });
  });

  test("clear words retire the goal", () => {
    expect(parseGoalCommand("clear")).toEqual({ action: "clear" });
    expect(parseGoalCommand("off")).toEqual({ action: "clear" });
    expect(parseGoalCommand(" DONE ")).toEqual({ action: "clear" });
  });

  test("anything else sets the goal, trimmed", () => {
    expect(parseGoalCommand("  ship the double jump  ")).toEqual({
      action: "set",
      goal: "ship the double jump",
    });
  });

  test("a clear word inside a longer goal still sets", () => {
    expect(parseGoalCommand("clear the level of debris")).toEqual({
      action: "set",
      goal: "clear the level of debris",
    });
  });
});

describe("buildTranscriptWindow", () => {
  const messages = [
    { role: "user", content: "add a double jump" },
    { role: "assistant", content: "on it" },
    { role: "tool", content: "3 tests passed", tool: "run_tests" },
  ];

  test("reports a whole transcript as untruncated", () => {
    expect(buildTranscriptWindow(messages)).toMatchObject({ kept: 3, total: 3, truncated: false });
  });

  test("counts what the budget dropped", () => {
    const window = buildTranscriptWindow(messages, 45);
    expect(window).toMatchObject({ kept: 1, total: 3, truncated: true });
    expect(window.text).toContain("3 tests passed");
  });

  test("reports a head-clipped single entry as truncated", () => {
    const window = buildTranscriptWindow([{ role: "user", content: "x".repeat(200) }], 40);
    expect(window).toMatchObject({ kept: 1, total: 1, truncated: true });
  });

  test("ignores entries with no content when counting", () => {
    const window = buildTranscriptWindow([...messages, { role: "assistant", content: "  " }]);
    expect(window).toMatchObject({ kept: 3, total: 3, truncated: false });
  });
});

describe("buildEvaluatorTranscript", () => {
  const messages = [
    { role: "user", content: "add a double jump" },
    { role: "assistant", content: "on it" },
    { role: "tool", content: "3 tests passed", tool: "run_tests" },
  ];

  test("labels every entry by role and names the tool", () => {
    const excerpt = buildEvaluatorTranscript(messages);
    expect(excerpt).toBe("user: add a double jump\nassistant: on it\ntool(run_tests): 3 tests passed");
  });

  test("keeps the newest entries and drops the oldest when capped", () => {
    const excerpt = buildEvaluatorTranscript(messages, 45);
    expect(excerpt).toContain("tool(run_tests): 3 tests passed");
    expect(excerpt).not.toContain("add a double jump");
    expect(excerpt.length).toBeLessThanOrEqual(45);
  });

  test("truncates the front of a single over-long entry but keeps its label", () => {
    const excerpt = buildEvaluatorTranscript(
      [{ role: "tool", content: `${"x".repeat(200)}THE-END`, tool: "run_tests" }],
      40,
    );
    expect(excerpt.startsWith("tool(run_tests): …")).toBe(true);
    expect(excerpt.endsWith("THE-END")).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(40);
  });

  test("skips blank entries", () => {
    const excerpt = buildEvaluatorTranscript([
      { role: "assistant", content: "   " },
      { role: "user", content: "keep going" },
    ]);
    expect(excerpt).toBe("user: keep going");
  });

  test("returns nothing for an empty transcript or a zero budget", () => {
    expect(buildEvaluatorTranscript([])).toBe("");
    expect(buildEvaluatorTranscript(messages, 0)).toBe("");
  });
});

describe("goalContinuationPrompt", () => {
  test("restates the goal, the reason, and the coming re-check", () => {
    const prompt = goalContinuationPrompt("ship the jump", "the jump height is still 0", 2);
    expect(prompt).toContain("Goal: ship the jump");
    expect(prompt).toContain("the jump height is still 0");
    expect(prompt).toContain("check 3");
    expect(prompt.split("\n")).toHaveLength(4);
  });

  test("reads as an instruction to continue", () => {
    expect(goalContinuationPrompt("x goal", "y reason", 0).startsWith("Keep going")).toBe(true);
  });
});

describe("formatGoalStatus", () => {
  test("reports no goal", () => {
    expect(formatGoalStatus(null)).toBe("goal: none");
  });

  test("a freshly set goal has not been checked", () => {
    expect(formatGoalStatus({ goal: "ship the jump", startedAtMs: 1, evaluations: 0 })).toBe(
      "goal: ship the jump — set",
    );
  });

  test("counts checks and singularises one", () => {
    expect(formatGoalStatus({ goal: "ship the jump", startedAtMs: 1, evaluations: 3 })).toBe(
      "goal: ship the jump — unmet (3 checks)",
    );
    expect(formatGoalStatus({ goal: "ship the jump", startedAtMs: 1, evaluations: 1 })).toBe(
      "goal: ship the jump — unmet (1 check)",
    );
  });

  test("appends the latest evaluator reason", () => {
    expect(
      formatGoalStatus({ goal: "ship the jump", startedAtMs: 1, evaluations: 2, lastReason: "no jump input yet" }),
    ).toBe("goal: ship the jump — unmet (2 checks): no jump input yet");
  });
});

describe("goalIsVerifiable", () => {
  test("accepts goals with an observable end state", () => {
    expect(goalIsVerifiable("add a double jump and cover it with a test")).toEqual({ ok: true });
    expect(goalIsVerifiable("hold the frame time under 16ms while 200 crates spawn")).toEqual({ ok: true });
  });

  test("hints on goals too short to check", () => {
    const verdict = goalIsVerifiable("fix it");
    expect(verdict.ok).toBe(false);
    expect(verdict.hint).toContain("what should be true");
  });

  test("hints on purely subjective wording", () => {
    for (const goal of ["make the platforming feel better", "the lighting should look nicer overall"]) {
      const verdict = goalIsVerifiable(goal);
      expect(verdict.ok).toBe(false);
      expect(verdict.hint).toContain("observable end state");
    }
  });

  test("a subjective word paired with a named check passes", () => {
    expect(goalIsVerifiable("make the jump feel better until the jump test passes")).toEqual({ ok: true });
    expect(goalIsVerifiable("improve the frame time to 60 fps")).toEqual({ ok: true });
  });

  test("does not flag ordinary goals that merely contain no metrics", () => {
    expect(goalIsVerifiable("replace the placeholder crate mesh with the library one")).toEqual({ ok: true });
  });
});
