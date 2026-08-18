import { describe, expect, test } from "vitest";
import { buildTranscriptWindow } from "./transcript";

describe("buildTranscriptWindow", () => {
  const messages = [
    { role: "user", content: "add a double jump" },
    { role: "assistant", content: "on it" },
    { role: "tool", content: "3 tests passed", tool: "run_tests" },
  ];

  test("labels a whole transcript and reports it as untruncated", () => {
    expect(buildTranscriptWindow(messages)).toEqual({
      text: "user: add a double jump\nassistant: on it\ntool(run_tests): 3 tests passed",
      kept: 3,
      total: 3,
      truncated: false,
    });
  });

  test("keeps the newest entries and reports what the budget dropped", () => {
    const window = buildTranscriptWindow(messages, 45);
    expect(window).toMatchObject({ kept: 1, total: 3, truncated: true });
    expect(window.text).toContain("tool(run_tests): 3 tests passed");
    expect(window.text).not.toContain("add a double jump");
    expect(window.text.length).toBeLessThanOrEqual(45);
  });

  test("clips the front of a single long entry but keeps its label", () => {
    const window = buildTranscriptWindow(
      [{ role: "tool", content: `${"x".repeat(200)}THE-END`, tool: "run_tests" }],
      40,
    );
    expect(window).toMatchObject({ kept: 1, total: 1, truncated: true });
    expect(window.text.startsWith("tool(run_tests): …")).toBe(true);
    expect(window.text.endsWith("THE-END")).toBe(true);
  });

  test("ignores blank entries and handles a zero budget", () => {
    const withBlank = [...messages, { role: "assistant", content: "  " }];
    expect(buildTranscriptWindow(withBlank)).toMatchObject({ kept: 3, total: 3, truncated: false });
    expect(buildTranscriptWindow(messages, 0)).toEqual({ text: "", kept: 0, total: 3, truncated: true });
  });
});
