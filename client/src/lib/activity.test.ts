import { describe, expect, it } from "vitest";
import {
  activitySummary,
  buildActivityFileChange,
  classifyActivityOperation,
  createTurnMarker,
  durationForTurn,
  formatDuration,
  isSafeActivityPath,
  repairLegacyActivitySummary,
  sessionWorkedMs,
} from "./activity";

describe("activity paths", () => {
  it("accepts workspace-relative source paths", () => {
    expect(isSafeActivityPath("src/App.tsx")).toBe(true);
    expect(isSafeActivityPath("scripts/game.ts")).toBe(true);
  });

  it("rejects traversal, absolute, and malformed paths", () => {
    expect(isSafeActivityPath("../secrets.txt")).toBe(false);
    expect(isSafeActivityPath("src/../../secrets.txt")).toBe(false);
    expect(isSafeActivityPath("/etc/passwd")).toBe(false);
    expect(isSafeActivityPath("C:\\Windows\\system32")).toBe(false);
    expect(isSafeActivityPath("")).toBe(false);
  });
});

describe("activity operations and file changes", () => {
  it("classifies common core tools", () => {
    expect(classifyActivityOperation("file_read")).toBe("read");
    expect(classifyActivityOperation("file_grep")).toBe("search");
    expect(classifyActivityOperation("file_edit")).toBe("edit");
    expect(classifyActivityOperation("file_write")).toBe("write");
    expect(classifyActivityOperation("shell_exec")).toBe("command");
    expect(classifyActivityOperation("editor_scene_inspect")).toBe("tool");
    expect(classifyActivityOperation("editor_object_update")).toBe("edit");
  });

  it("stores only a bounded collapsed diff", () => {
    const change = buildActivityFileChange(
      {
        operation: "edit",
        path: "src/App.tsx",
        before: "one\ntwo\nthree\nfour",
        after: "one\nchanged\nthree\nfour",
      },
      { tool: "file_edit", turnId: "turn-1", toolCallId: "call-1" },
    );
    expect(change).toMatchObject({
      path: "src/App.tsx",
      operation: "edit",
      additions: 1,
      deletions: 1,
      turnId: "turn-1",
      toolCallId: "call-1",
    });
    expect(change).not.toHaveProperty("before");
    expect(change).not.toHaveProperty("after");
    expect(change?.diff.some((row) => row.text === "changed")).toBe(true);
  });

  it("marks truncated previews without pretending they are complete", () => {
    const change = buildActivityFileChange(
      {
        operation: "write",
        path: "game.ts",
        afterSnippet: "line 1\nline 2",
        truncated: true,
      },
      { tool: "file_write", turnId: "turn-1" },
    );
    expect(change?.truncated).toBe(true);
    expect(activitySummary("file_write", "write", undefined, change)).toContain("partial");
  });

  it("scales truncated edit snippets by the replacement count", () => {
    const change = buildActivityFileChange(
      {
        operation: "edit",
        path: "game.ts",
        beforeSnippet: "old",
        afterSnippet: "new",
        truncated: true,
        replacements: 3,
      },
      { tool: "file_edit", turnId: "turn-1" },
    );
    expect(change).toMatchObject({ additions: 3, deletions: 3, truncated: true });
  });

  it("does not persist transient snapshots in tool detail", async () => {
    const { activityDetail } = await import("./activity");
    const detail = activityDetail({
      ok: true,
      __cali_internal_activity: { before: "secret", after: "secret" },
      before: "secret",
      after: "secret",
    });
    expect(detail).toBe('{\n  "ok": true\n}');
    expect(detail).not.toContain("secret");
  });

  it("summarises reads, searches, edits, and commands", () => {
    expect(activitySummary("file_read", "read", { path: "src/App.tsx" })).toBe("Read App.tsx");
    expect(activitySummary("file_grep", "search", { pattern: "openProject" })).toBe("Searched for openProject");
    expect(
      activitySummary("file_edit", "edit", undefined, {
        path: "App.tsx",
        operation: "edit",
        additions: 11,
        deletions: 0,
        diff: [],
      }),
    ).toBe("Edited App.tsx +11 -0");
    expect(activitySummary("shell_exec", "command", { command: "pnpm test" })).toBe("Ran pnpm test");
    expect(activitySummary("editor_scene_inspect", "tool", {})).toBe("Used editor_scene_inspect");
    expect(activitySummary("editor_object_update", "edit", {})).toBe("Used editor_object_update");
  });

  it("repairs only the known pre-token-classifier activity labels", () => {
    expect(repairLegacyActivitySummary("editor_scene_inspect", "Edited file")).toBe(
      "Used editor_scene_inspect",
    );
    expect(repairLegacyActivitySummary("file_edit", "Edited README.md +2 -1")).toBe(
      "Edited README.md +2 -1",
    );
    expect(repairLegacyActivitySummary(undefined, "Edited file")).toBe("Edited file");
  });
});

describe("turn timing", () => {
  it("creates a synthetic marker without adding metadata to user/assistant messages", () => {
    expect(createTurnMarker("turn-1", 100)).toEqual({
      role: "tool",
      tool: "turn",
      content: "",
      status: "running",
      turnId: "turn-1",
      startedAtMs: 100,
    });
  });

  it("formats live and long-running durations", () => {
    expect(durationForTurn(100, 1_100)).toBe(1_000);
    expect(formatDuration(0)).toBe("<1s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_600_000 + 120_000)).toBe("1h 2m");
  });

  it("sums persisted turn markers once across resume", () => {
    const messages = [
      createTurnMarker("one", 0),
      { ...createTurnMarker("one", 0), completedAtMs: 1_000, status: "done" as const },
      { ...createTurnMarker("two", 2_000), completedAtMs: 5_000, status: "done" as const },
      { role: "user" as const, content: "no metadata here" },
    ];
    expect(sessionWorkedMs(messages, 10_000)).toBe(4_000);
  });
});
