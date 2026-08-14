import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityTurnRow } from "./AgentPanel";
import { createTurnMarker } from "../../lib/activity";
import type { AgentMessage } from "../../lib/types";

afterEach(cleanup);

const finished = { ...createTurnMarker("turn-files", 1_000), status: "done" as const, completedAtMs: 5_000 };

function edit(
  path: string,
  additions: number,
  deletions: number,
  overrides: Partial<AgentMessage> = {},
): AgentMessage {
  return {
    role: "tool",
    tool: "file_edit",
    toolCallId: `call-${path}-${additions}-${deletions}`,
    turnId: "turn-files",
    status: "done",
    content: `Edited ${path}`,
    activity: {
      path,
      operation: "edit",
      additions,
      deletions,
      diff: [],
      workspaceRoot: "/tmp/game",
    },
    ...overrides,
  };
}

function card() {
  return document.querySelector("[data-activity-change-summary]");
}

describe("turn file summary card", () => {
  it("counts each path once and sums the totals it was edited with", () => {
    render(
      <ActivityTurnRow
        turnId="turn-files"
        messages={[finished, edit("src/a.ts", 2, 1), edit("src/b.ts", 4, 0), edit("src/a.ts", 3, 5)]}
        onOpenFile={() => undefined}
      />,
    );

    expect(screen.getByText("2 files changed").parentElement?.textContent).toContain("+9-6");
    expect(screen.getByRole("button", { name: "Open src/a.ts" }).textContent).toContain("+5-6");
  });

  it("separates the thousands in a large turn", () => {
    render(<ActivityTurnRow turnId="turn-files" messages={[finished, edit("src/a.ts", 3_677, 743)]} />);
    expect(screen.getByText("1 file changed").parentElement?.textContent).toContain("+3,677-743");
  });

  it("previews three files and reveals the rest on request", () => {
    const files = ["a", "b", "c", "d", "e"].map((name) => edit(`src/${name}.ts`, 1, 0));
    render(<ActivityTurnRow turnId="turn-files" messages={[finished, ...files]} />);

    expect(screen.getByText("src/c.ts")).toBeTruthy();
    expect(screen.queryByText("src/d.ts")).toBeNull();

    const toggle = screen.getByRole("button", { name: "Show 2 more files" });
    fireEvent.click(toggle);
    expect(screen.getByText("src/d.ts")).toBeTruthy();
    expect(screen.getByText("src/e.ts")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show fewer files" }));
    expect(screen.queryByText("src/e.ts")).toBeNull();
  });

  it("says how many files are left in the singular", () => {
    const files = ["a", "b", "c", "d"].map((name) => edit(`src/${name}.ts`, 1, 0));
    render(<ActivityTurnRow turnId="turn-files" messages={[finished, ...files]} />);
    expect(screen.getByRole("button", { name: "Show 1 more file" })).toBeTruthy();
  });

  it("opens a file through the same path the activity rows use", () => {
    const onOpenFile = vi.fn();
    const message = edit("src/a.ts", 2, 1);
    render(<ActivityTurnRow turnId="turn-files" messages={[finished, message]} onOpenFile={onOpenFile} />);

    fireEvent.click(screen.getByRole("button", { name: "Open src/a.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ path: "src/a.ts", additions: 2, deletions: 1 }));
  });

  it("never offers to open a path that escapes the workspace", () => {
    const onOpenFile = vi.fn();
    render(
      <ActivityTurnRow
        turnId="turn-files"
        messages={[finished, edit("../../etc/passwd", 1, 0)]}
        onOpenFile={onOpenFile}
      />,
    );

    const row = screen.getByRole("button", { name: "../../etc/passwd" });
    fireEvent.click(row);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("stays away while the turn is still running", () => {
    const running = createTurnMarker("turn-files", 1_000);
    render(<ActivityTurnRow turnId="turn-files" messages={[running, edit("src/a.ts", 2, 1)]} />);
    expect(card()).toBeNull();
  });

  it("stays away when the turn only read and searched", () => {
    render(
      <ActivityTurnRow
        turnId="turn-files"
        messages={[
          finished,
          edit("src/a.ts", 0, 0, {
            tool: "file_read",
            content: "Read a.ts",
            activity: { path: "src/a.ts", operation: "read", additions: 0, deletions: 0, diff: [] },
          }),
        ]}
      />,
    );
    expect(card()).toBeNull();
  });

  it("gives way to the full action list once the turn is expanded", () => {
    render(<ActivityTurnRow turnId="turn-files" messages={[finished, edit("src/a.ts", 2, 1)]} />);
    expect(card()).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Expand activity for turn turn-files/ }));
    expect(card()).toBeNull();
  });
});
