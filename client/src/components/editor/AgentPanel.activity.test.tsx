import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityTurnRow, ToolRow, activityAnchorIndexes, activityTaskSummary, ownsBrowserToolEvent } from "./AgentPanel";
import { createTurnMarker } from "../../lib/activity";
import type { TaskGraph } from "../../lib/graph";
import type { AgentMessage } from "../../lib/types";

afterEach(cleanup);

describe("ActivityTurnRow", () => {
  it("derives a concise title from the turn narrative before falling back to the prompt", () => {
    expect(
      activityTaskSummary([{ role: "assistant", content: "I’ll verify the desktop app color update after install." }]),
    ).toBe("Verify the desktop app color update after install");
    expect(activityTaskSummary([], "Rebuild the desktop app and check the installed renderer.")).toBe(
      "Rebuild the desktop app and check the installed renderer",
    );
  });

  it("uses a compact task title while a tool is in flight", () => {
    const startedAtMs = Date.now();
    const marker = createTurnMarker("turn-live", startedAtMs);
    render(
      <ActivityTurnRow
        turnId="turn-live"
        messages={[
          marker,
          {
            role: "tool",
            tool: "file_read",
            toolCallId: "call-read",
            turnId: "turn-live",
            status: "running",
            startedAtMs,
            content: "Read App.tsx",
          },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: /Expand activity for turn turn-live/ }).textContent).toContain("Read files");
    expect(screen.queryByText(/Working for/)).toBeNull();
    expect(screen.queryByText("Read App.tsx")).toBeNull();
  });

  it("uses the loop task title while loop work is in flight", () => {
    const startedAtMs = Date.now();
    const marker = createTurnMarker("turn-loop", startedAtMs);
    render(
      <ActivityTurnRow
        turnId="turn-loop"
        taskTitle="Start Loop"
        messages={[
          marker,
          {
            role: "tool",
            tool: "skill_load",
            toolCallId: "call-skill",
            turnId: "turn-loop",
            status: "running",
            startedAtMs,
            content: "Loaded goal-loop",
          },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: /Expand activity for turn turn-loop/ }).textContent).toContain("Start Loop");
  });

  it("shows one compact latest summary and expands all actions", () => {
    const marker = createTurnMarker("turn-1", 1_000);
    const messages: AgentMessage[] = [
      { ...marker, status: "done", completedAtMs: 2_000 },
      {
        role: "tool",
        tool: "file_read",
        toolCallId: "call-read",
        turnId: "turn-1",
        status: "done",
        startedAtMs: 1_100,
        completedAtMs: 1_200,
        content: "Read App.tsx",
      },
      {
        role: "tool",
        tool: "file_edit",
        toolCallId: "call-edit",
        turnId: "turn-1",
        status: "done",
        startedAtMs: 1_300,
        completedAtMs: 1_900,
        content: "Edited App.tsx +2 -1",
        activity: {
          path: "src/App.tsx",
          operation: "edit",
          additions: 2,
          deletions: 1,
          diff: [{ type: "added", oldLine: null, newLine: 4, text: "new line" }],
          workspaceRoot: "/tmp/game",
        },
      },
    ];
    render(<ActivityTurnRow turnId="turn-1" messages={messages} />);

    const activityButton = screen.getByRole("button", { name: /Expand activity for turn turn-1/ });
    expect(activityButton.textContent).toContain("Worked for 1s");
    expect(activityButton.textContent).not.toContain("actions");
    expect(activityButton.textContent).not.toContain("Edited App.tsx +2 -1");
    expect(screen.queryByText("Read App.tsx")).toBeNull();
    expect(screen.getByText("1 file changed").parentElement?.textContent).toContain("+2-1");

    fireEvent.click(screen.getByRole("button", { name: /Expand activity for turn turn-1/ }));
    expect(screen.getByText("Read App.tsx")).toBeTruthy();
    expect(screen.getAllByText("Edited App.tsx +2 -1").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("+2 -1", { exact: true })).toBeNull();
    // Each action keeps its own output folded away until that row is clicked.
    expect(screen.queryByText("new line")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Edited App.tsx \+2 -1/ }));
    expect(screen.getByText("new line")).toBeTruthy();
  });

  it("shows a failed action in red and only reveals its output on click", () => {
    const marker = { ...createTurnMarker("turn-error", 1_000), status: "done" as const, completedAtMs: 1_400 };
    render(
      <ActivityTurnRow
        turnId="turn-error"
        messages={[
          marker,
          {
            role: "tool",
            tool: "loop_report_start",
            toolCallId: "call-loop",
            turnId: "turn-error",
            status: "error",
            content: "Used loop_report_start",
            detail: '{\n  "error": "loop report already exists"\n}',
          },
        ]}
      />,
    );

    const activityButton = screen.getByRole("button", { name: /Expand activity for turn turn-error/ });
    expect(activityButton.textContent).toContain("Start Loop");
    expect(activityButton.textContent).toContain("Did not finish after <1s");
    fireEvent.click(screen.getByRole("button", { name: /Expand activity for turn turn-error/ }));
    expect(screen.queryByText(/loop report already exists/)).toBeNull();
    const row = screen.getByRole("button", { name: /Used loop_report_start/ });
    expect(row.querySelector(".text-danger-soft")).toBeTruthy();

    fireEvent.click(row);
    expect(screen.getByText(/loop report already exists/)).toBeTruthy();
  });

  it("opens only safe relative activity files", () => {
    const onOpen = vi.fn();
    const marker = { ...createTurnMarker("turn-2", 1_000), status: "done" as const, completedAtMs: 1_100 };
    const file = {
      path: "src/App.tsx",
      operation: "read" as const,
      additions: 0,
      deletions: 0,
      diff: [],
    };
    render(
      <ActivityTurnRow
        turnId="turn-2"
        messages={[
          marker,
          {
            role: "tool",
            tool: "file_read",
            toolCallId: "call-read",
            turnId: "turn-2",
            status: "done",
            content: "Read App.tsx",
            activity: file,
          },
        ]}
        onOpenFile={onOpen}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Expand activity for turn turn-2/ }));
    fireEvent.click(screen.getByRole("button", { name: /Read App.tsx/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open src/App.tsx" }));
    expect(onOpen).toHaveBeenCalledWith(file);
  });

  it("counts each changed file once while summing every edit", () => {
    const marker = { ...createTurnMarker("turn-3", 1_000), status: "done" as const, completedAtMs: 1_500 };
    const edit = (toolCallId: string, additions: number, deletions: number): AgentMessage => ({
      role: "tool",
      tool: "file_edit",
      toolCallId,
      turnId: "turn-3",
      status: "done",
      content: "Edited App.tsx",
      activity: {
        path: "src/App.tsx",
        operation: "edit",
        additions,
        deletions,
        diff: [],
      },
    });

    render(
      <ActivityTurnRow
        turnId="turn-3"
        messages={[marker, edit("call-first", 2, 1), edit("call-second", 3, 4)]}
      />,
    );

    expect(screen.getByText("1 file changed").parentElement?.textContent).toContain("+5-5");
  });
});

describe("activityAnchorIndexes", () => {
  it("anchors a compact turn at its latest action, after intervening narration", () => {
    const messages: AgentMessage[] = [
      createTurnMarker("turn-timeline", 1_000),
      {
        role: "tool",
        tool: "file_read",
        toolCallId: "call-read",
        turnId: "turn-timeline",
        status: "done",
        content: "Read App.tsx",
      },
      { role: "assistant", content: "I found the editor entry point." },
      {
        role: "tool",
        tool: "file_edit",
        toolCallId: "call-edit",
        turnId: "turn-timeline",
        status: "done",
        content: "Edited App.tsx",
      },
    ];

    expect(activityAnchorIndexes(messages).get("turn-timeline")).toBe(3);
  });
});

const ownedGraph: TaskGraph = {
  schemaVersion: 1,
  graphId: "graph-owned",
  goal: "build it",
  projectSlug: "demo",
  ownerSession: "session-owner",
  workspaceRoot: "/tmp/demo-worktree",
  status: "running",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  nodes: [
    {
      id: "build",
      title: "Build",
      kind: "build",
      role: "coder",
      instructions: "",
      acceptance: [],
      maxTurns: 8,
      deps: [],
      status: "running",
      attempts: 1,
      punchList: [],
      sessionId: "session-node",
    },
  ],
};

const ownership = {
  clientId: "client-owned",
  projectSlug: "demo",
  workspaceRoot: "/tmp/demo-worktree",
  sessionId: "session-owner",
  activeGraph: ownedGraph,
};

describe("ownsBrowserToolEvent", () => {
  it("accepts an exact routed client only inside its project and workspace", () => {
    expect(
      ownsBrowserToolEvent(
        {
          targetClientId: "client-owned",
          targetSessionId: "otherwise-unrecognised",
          projectSlug: "demo",
          workspaceRoot: "/tmp/demo-worktree",
        },
        ownership,
      ),
    ).toBe(true);
    expect(
      ownsBrowserToolEvent(
        {
          targetClientId: "client-owned",
          projectSlug: "other",
          workspaceRoot: "/tmp/demo-worktree",
        },
        ownership,
      ),
    ).toBe(false);
    expect(
      ownsBrowserToolEvent(
        {
          targetClientId: "client-owned",
          projectSlug: "demo",
          workspaceRoot: "/tmp/other-worktree",
        },
        ownership,
      ),
    ).toBe(false);
  });

  it("never falls back to a local session when a foreign client token is present", () => {
    expect(
      ownsBrowserToolEvent(
        {
          targetClientId: "client-foreign",
          targetSessionId: "session-owner",
          projectSlug: "demo",
          workspaceRoot: "/tmp/demo-worktree",
        },
        ownership,
      ),
    ).toBe(false);
  });

  it("accepts token-less legacy events for the graph owner and node sessions", () => {
    for (const sessionId of ["session-owner", "session-node"]) {
      expect(
        ownsBrowserToolEvent(
          {
            sessionId,
            projectSlug: "demo",
            workspaceRoot: "/tmp/demo-worktree",
          },
          ownership,
        ),
      ).toBe(true);
    }
  });

  it("rejects token-less events for foreign sessions", () => {
    expect(
      ownsBrowserToolEvent(
        {
          targetSessionId: "session-foreign",
          sessionId: "session-node",
          projectSlug: "demo",
          workspaceRoot: "/tmp/demo-worktree",
        },
        ownership,
      ),
    ).toBe(false);
  });
});

describe("ToolRow", () => {
  const ran: AgentMessage = {
    role: "tool",
    tool: "run_tests",
    status: "error",
    content: "3 failed",
    detail: "Jump.test.ts: expected 1 got 0",
  };

  it("offers a step to the side chat with its name and output", () => {
    const onAsk = vi.fn();
    render(<ToolRow message={ran} onAsk={onAsk} />);

    fireEvent.click(screen.getByRole("button", { name: "Ask about run_tests in side chat" }));
    expect(onAsk).toHaveBeenCalledWith(ran);
  });

  it("offers nothing on this panel's own informational lines", () => {
    // Slash-command output and session notes carry no tool or status: they are
    // the panel talking, not the run working.
    render(<ToolRow message={{ role: "tool", content: "Started a new session.", tool: "session" }} onAsk={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Ask about/ })).toBeNull();
  });

  it("offers nothing when no side chat is available to ask in", () => {
    render(<ToolRow message={ran} />);
    expect(screen.queryByRole("button", { name: /Ask about/ })).toBeNull();
  });
});
