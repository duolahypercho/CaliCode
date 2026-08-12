import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileEditor } from "./FileEditor";
import * as workspace from "../../lib/workspace";
import type { ActivityFileChange } from "../../lib/activity";

describe("FileEditor", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const activity: ActivityFileChange = {
    path: "src/game.ts",
    workspaceRoot: "/tmp/game",
    operation: "edit",
    additions: 1,
    deletions: 1,
    diff: [
      { type: "context", oldLine: 1, newLine: 1, text: "const score = 0;" },
      { type: "removed", oldLine: 2, newLine: null, text: "const lives = 3;" },
      { type: "added", oldLine: null, newLine: 2, text: "const lives = 5;" },
    ],
    turnId: "turn-1",
    toolCallId: "call-1",
  };

  it("opens an edit activity in the persisted diff view with accurate counts", async () => {
    vi.spyOn(workspace, "readWorkspaceFile").mockResolvedValue({
      path: "src/game.ts",
      content: "const score = 0;\nconst lives = 5;",
      encoding: "utf8",
      bytes: 32,
      sha256: "sha",
      truncated: false,
    });

    render(
      <FileEditor
        workspaceId="ws-1"
        path="src/game.ts"
        activityFile={activity}
        onSaved={() => {}}
        onError={() => {}}
      />,
    );

    expect((await screen.findByRole("button", { name: "Show diff" })).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("1 addition, 1 deletion").textContent).toBe("+1−1");
    expect(screen.getByText("const lives = 3;")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("switches from DIFF to FILE and preserves editable current contents", async () => {
    vi.spyOn(workspace, "readWorkspaceFile").mockResolvedValue({
      path: "src/game.ts",
      content: "const score = 0;\nconst lives = 5;",
      encoding: "utf8",
      bytes: 32,
      sha256: "sha",
      truncated: false,
    });

    render(
      <FileEditor
        workspaceId="ws-1"
        path="src/game.ts"
        activityFile={activity}
        onSaved={() => {}}
        onError={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Show file" }));
    const editor = await screen.findByRole("textbox", { name: "src/game.ts source" });
    expect((editor as HTMLTextAreaElement).value).toBe("const score = 0;\nconst lives = 5;");
    expect(screen.getByRole("button", { name: "Show file" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("const lives = 3;")).toBeNull();
  });

  it("opens a read activity directly in the actual file view", async () => {
    vi.spyOn(workspace, "readWorkspaceFile").mockResolvedValue({
      path: "src/game.ts",
      content: "export const ready = true;",
      encoding: "utf8",
      bytes: 26,
      sha256: "sha",
      truncated: false,
    });

    render(
      <FileEditor
        workspaceId="ws-1"
        path="src/game.ts"
        activityFile={{ ...activity, operation: "read", additions: 0, deletions: 0, diff: [] }}
        onSaved={() => {}}
        onError={() => {}}
      />,
    );

    expect((await screen.findByRole("textbox", { name: "src/game.ts source" }) as HTMLTextAreaElement).value).toBe(
      "export const ready = true;",
    );
    expect(screen.queryByRole("button", { name: "Show diff" })).toBeNull();
  });

  it("direct file reload keeps conflict and truncated save guards intact", async () => {
    const read = vi.spyOn(workspace, "readWorkspaceFile").mockResolvedValue({
      path: "src/game.ts",
      content: "one",
      encoding: "utf8",
      bytes: 3,
      sha256: "sha",
      truncated: true,
    });
    const write = vi.spyOn(workspace, "writeWorkspaceFile").mockResolvedValue({
      path: "src/game.ts",
      written: true,
      sha256: "next",
    });

    render(
      <FileEditor
        workspaceId="ws-1"
        path="src/game.ts"
        onSaved={() => {}}
        onError={() => {}}
      />,
    );

    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(screen.getByText("TRUNCATED: READ ONLY")).toBeTruthy();
    expect((screen.getByRole("button", { name: "SAVE" }) as HTMLButtonElement).disabled).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
});
