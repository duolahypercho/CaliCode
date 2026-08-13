import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
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

  it("keeps unsaved work when the user switches files and comes back", async () => {
    vi.spyOn(workspace, "readWorkspaceFile").mockImplementation(async (_workspaceId, path) => ({
      path,
      content: `// ${path}`,
      encoding: "utf8" as const,
      bytes: 8,
      sha256: "sha",
      truncated: false,
    }));

    // Mirrors App: the buffer map lives above the editor, because the editor
    // unmounts on tab change and resets its draft when the path changes.
    function Host() {
      const [path, setPath] = useState("a.ts");
      const [drafts, setDrafts] = useState<Record<string, string>>({});
      return (
        <>
          <button type="button" onClick={() => setPath((current) => (current === "a.ts" ? "b.ts" : "a.ts"))}>
            swap
          </button>
          <FileEditor
            workspaceId="ws-1"
            path={path}
            preservedDraft={drafts[path] ?? null}
            onDraftChange={(target, draft) =>
              setDrafts((current) => {
                const next = { ...current };
                if (draft === null) delete next[target];
                else next[target] = draft;
                return next;
              })
            }
            onSaved={() => {}}
            onError={() => {}}
          />
        </>
      );
    }

    render(<Host />);

    fireEvent.change(await screen.findByRole("textbox", { name: "a.ts source" }), {
      target: { value: "forty lines of work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "swap" }));
    expect((await screen.findByRole("textbox", { name: "b.ts source" }) as HTMLTextAreaElement).value).toBe("// b.ts");

    fireEvent.click(screen.getByRole("button", { name: "swap" }));
    const restored = (await screen.findByRole("textbox", { name: "a.ts source" })) as HTMLTextAreaElement;
    expect(restored.value).toBe("forty lines of work");
    await waitFor(() => expect(screen.getByText("MODIFIED")).toBeTruthy());
  });

  // Mirrors App: the buffer map lives above the editor, and every path is
  // reachable from the tree, so anything filed under a path comes back the
  // next time that path is opened. Entries carry App's `verified` flag —
  // false means "kept, but its disk state is unknown", which is what keeps the
  // path out of the tree's MODIFIED set without throwing the text away.
  function DraftHost({
    paths,
    onDraftChange,
  }: {
    paths: string[];
    onDraftChange?: (path: string, draft: string | null, verified: boolean) => void;
  }) {
    const [path, setPath] = useState(paths[0]);
    const [drafts, setDrafts] = useState<Record<string, { text: string; verified: boolean }>>({});
    // Exactly App's `dirtyPaths`: what the file tree would badge MODIFIED.
    const dirtyPaths = Object.entries(drafts)
      .filter(([, buffer]) => buffer.verified)
      .map(([target]) => target);
    return (
      <>
        {paths.map((candidate) => (
          <button key={candidate} type="button" onClick={() => setPath(candidate)}>
            {`open ${candidate}`}
          </button>
        ))}
        <span data-testid="drafts">{JSON.stringify(drafts)}</span>
        <span data-testid="tree-modified">{JSON.stringify(dirtyPaths)}</span>
        <FileEditor
          workspaceId="ws-1"
          path={path}
          preservedDraft={drafts[path]?.text ?? null}
          onDraftChange={(target, draft, verified = true) => {
            onDraftChange?.(target, draft, verified);
            setDrafts((current) => {
              const next = { ...current };
              if (draft === null) delete next[target];
              else next[target] = { text: draft, verified };
              return next;
            });
          }}
          onSaved={() => {}}
          onError={() => {}}
        />
      </>
    );
  }

  it("never files the previous file's buffer under a path whose read is still in flight", async () => {
    // The read effect only *schedules* the swap to the new file, so the commit
    // that carries the new path still holds the old draft. A read that never
    // resolves means nothing ever comes along to correct a bad entry.
    vi.spyOn(workspace, "readWorkspaceFile").mockImplementation((_workspaceId, path) =>
      path === "b.ts"
        ? new Promise<workspace.FileContent>(() => {})
        : Promise.resolve({
            path,
            content: `// ${path}`,
            encoding: "utf8" as const,
            bytes: 8,
            sha256: `sha-${path}`,
            truncated: false,
          }),
    );
    const onDraftChange = vi.fn();

    render(<DraftHost paths={["a.ts", "b.ts"]} onDraftChange={onDraftChange} />);

    fireEvent.change(await screen.findByRole("textbox", { name: "a.ts source" }), {
      target: { value: "forty lines of work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "open b.ts" }));

    const editor = (await screen.findByRole("textbox", { name: "b.ts source" })) as HTMLTextAreaElement;
    // The pending file is empty on screen and empty in the map: a.ts's work is
    // filed under a.ts and nowhere else.
    expect(editor.value).toBe("");
    await waitFor(() =>
      expect(screen.getByTestId("drafts").textContent).toBe('{"a.ts":{"text":"forty lines of work","verified":true}}'),
    );
    expect(onDraftChange.mock.calls.filter(([target]) => target === "b.ts")).toEqual([]);
    expect(screen.queryByText("MODIFIED")).toBeNull();
  });

  it("keeps the unsaved buffer when the read fails, marked unverifiable rather than MODIFIED", async () => {
    // Nothing retries a failed read, so `file` stays null: the buffer cannot be
    // diffed against disk or saved, and the tree must not badge the file (or
    // every folder above it) MODIFIED on the strength of a disk state nobody
    // knows. That is a reason to demote the entry, never to delete it — the
    // text is the user's, and this component unmounts on every tab change.
    let rejectRead: ((error: Error) => void) | undefined;
    vi.spyOn(workspace, "readWorkspaceFile").mockImplementation(
      () =>
        new Promise<workspace.FileContent>((_resolve, reject) => {
          rejectRead = reject;
        }),
    );

    render(<DraftHost paths={["a.ts", "b.ts"]} />);

    const editor = (await screen.findByRole("textbox", { name: "a.ts source" })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "forty lines of work" } });
    await waitFor(() =>
      expect(screen.getByTestId("drafts").textContent).toBe('{"a.ts":{"text":"forty lines of work","verified":true}}'),
    );

    rejectRead?.(new Error("permission denied"));

    // Still held above the editor, so it outlives this component — but flagged
    // unverified, which is what keeps it out of the tree's MODIFIED set.
    await waitFor(() =>
      expect(screen.getByTestId("drafts").textContent).toBe('{"a.ts":{"text":"forty lines of work","verified":false}}'),
    );
    expect(screen.getByTestId("tree-modified").textContent).toBe("[]");
    // Distinct on screen too: its own badge and banner, not the MODIFIED badge
    // that promises a real, saveable diff.
    expect(screen.getByText("READ FAILED")).toBeTruthy();
    expect(screen.getByText("UNSAVED · DISK UNKNOWN")).toBeTruthy();
    expect(screen.queryByText("MODIFIED")).toBeNull();
    expect((screen.getByRole("button", { name: "SAVE" }) as HTMLButtonElement).disabled).toBe(true);
    // Still editable, because what is typed here now survives the unmount.
    expect(editor.readOnly).toBe(false);
    fireEvent.change(editor, { target: { value: "forty lines of work, plus one" } });

    // The repro that lost the work: leave and come back while the read is
    // still failing.
    fireEvent.click(screen.getByRole("button", { name: "open b.ts" }));
    await screen.findByRole("textbox", { name: "b.ts source" });
    fireEvent.click(screen.getByRole("button", { name: "open a.ts" }));
    const reopened = (await screen.findByRole("textbox", { name: "a.ts source" })) as HTMLTextAreaElement;
    expect(reopened.value).toBe("forty lines of work, plus one");
  });

  it("carries the unverifiable buffer through a successful RELOAD instead of discarding it", async () => {
    // The banner sends the user to RELOAD, so RELOAD cannot be the thing that
    // eats their text. A read that finally lands is the moment the buffer
    // becomes a real diff again — against the sha256 just read.
    let reads = 0;
    vi.spyOn(workspace, "readWorkspaceFile").mockImplementation(async (_workspaceId, path) => {
      if (reads++ === 0) throw new Error("permission denied");
      return { path, content: "// a.ts", encoding: "utf8" as const, bytes: 7, sha256: "sha-a", truncated: false };
    });

    render(<DraftHost paths={["a.ts"]} />);

    const editor = (await screen.findByRole("textbox", { name: "a.ts source" })) as HTMLTextAreaElement;
    await screen.findByText("READ FAILED");
    fireEvent.change(editor, { target: { value: "forty lines of work" } });

    fireEvent.click(screen.getByRole("button", { name: "RELOAD" }));

    await waitFor(() => expect(screen.queryByText("READ FAILED")).toBeNull());
    expect(editor.value).toBe("forty lines of work");
    // Verified again: saveable, and honestly MODIFIED in the tree.
    expect(screen.getByText("MODIFIED")).toBeTruthy();
    expect((screen.getByRole("button", { name: "SAVE" }) as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() =>
      expect(screen.getByTestId("drafts").textContent).toBe('{"a.ts":{"text":"forty lines of work","verified":true}}'),
    );
    expect(screen.getByTestId("tree-modified").textContent).toBe('["a.ts"]');
  });

  it("keeps a buffer verified and saveable when only the reload retry fails", async () => {
    // A failed retry does not unlearn the contents read a moment ago: the
    // buffer is still a real diff against a known version, and the sha256 guard
    // still stands behind SAVE. Demoting it here would be as dishonest in the
    // other direction — and would drop it from the tree for no reason.
    let reads = 0;
    vi.spyOn(workspace, "readWorkspaceFile").mockImplementation(async (_workspaceId, path) => {
      if (reads++ === 1) throw new Error("core restarted");
      return { path, content: "// a.ts", encoding: "utf8" as const, bytes: 7, sha256: "sha-a", truncated: false };
    });

    render(<DraftHost paths={["a.ts"]} />);

    const editor = (await screen.findByRole("textbox", { name: "a.ts source" })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "forty lines of work" } });
    fireEvent.click(screen.getByRole("button", { name: "RELOAD" }));

    await screen.findByText("READ FAILED");
    expect(editor.value).toBe("forty lines of work");
    expect(editor.readOnly).toBe(false);
    expect(screen.getByText("MODIFIED")).toBeTruthy();
    expect(screen.queryByText("UNSAVED · DISK UNKNOWN")).toBeNull();
    expect((screen.getByRole("button", { name: "SAVE" }) as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() =>
      expect(screen.getByTestId("drafts").textContent).toBe('{"a.ts":{"text":"forty lines of work","verified":true}}'),
    );
    expect(screen.getByTestId("tree-modified").textContent).toBe('["a.ts"]');
  });

  it("cannot save one file's unsaved buffer into another file", async () => {
    // The reviewer's repro: type in a.ts, bounce off b.ts before its read
    // lands, then come back to b.ts. A seeded stale buffer would also suppress
    // the disk read while `file` still carries b.ts's sha256, so the write
    // sails past the conflict guard and lands a.ts's text in b.ts.
    let bReads = 0;
    vi.spyOn(workspace, "readWorkspaceFile").mockImplementation((_workspaceId, path) => {
      if (path === "b.ts" && bReads++ === 0) return new Promise<workspace.FileContent>(() => {});
      return Promise.resolve({
        path,
        content: `// ${path}`,
        encoding: "utf8" as const,
        bytes: 8,
        sha256: `sha-${path}`,
        truncated: false,
      });
    });
    const write = vi.spyOn(workspace, "writeWorkspaceFile").mockResolvedValue({
      path: "b.ts",
      written: true,
      sha256: "next",
    });

    render(<DraftHost paths={["a.ts", "b.ts"]} />);

    fireEvent.change(await screen.findByRole("textbox", { name: "a.ts source" }), {
      target: { value: "forty lines of work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "open b.ts" }));
    await screen.findByRole("textbox", { name: "b.ts source" });
    fireEvent.click(screen.getByRole("button", { name: "open a.ts" }));
    // Leaving before the read resolved must not have cost the real work.
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "a.ts source" }) as HTMLTextAreaElement).value).toBe(
        "forty lines of work",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "open b.ts" }));
    const editor = (await screen.findByRole("textbox", { name: "b.ts source" })) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("// b.ts"));

    const saveButton = screen.getByRole("button", { name: "SAVE" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    fireEvent.click(saveButton);
    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    await waitFor(() => expect(editor.value).toBe("// b.ts"));
    // Cmd+S saves whether or not the buffer is dirty, so assert on what would
    // reach disk rather than on the write never happening.
    for (const [, target, contents, sha] of write.mock.calls) {
      expect(target).toBe("b.ts");
      expect(contents).toBe("// b.ts");
      expect(sha).toBe("sha-b.ts");
    }
  });

  it("reports the buffer up only while it differs from disk", async () => {
    vi.spyOn(workspace, "readWorkspaceFile").mockResolvedValue({
      path: "src/game.ts",
      content: "one",
      encoding: "utf8",
      bytes: 3,
      sha256: "sha",
      truncated: false,
    });
    const onDraftChange = vi.fn();

    render(
      <FileEditor
        workspaceId="ws-1"
        path="src/game.ts"
        onDraftChange={onDraftChange}
        onSaved={() => {}}
        onError={() => {}}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "src/game.ts source" });
    expect(onDraftChange).toHaveBeenLastCalledWith("src/game.ts", null, true);

    fireEvent.change(editor, { target: { value: "one more" } });
    // Read against a known disk state: a real modification, badge and all.
    expect(onDraftChange).toHaveBeenLastCalledWith("src/game.ts", "one more", true);

    // Typed back to the on-disk contents: nothing is at risk any more, so the
    // marker has to retire itself.
    fireEvent.change(editor, { target: { value: "one" } });
    expect(onDraftChange).toHaveBeenLastCalledWith("src/game.ts", null, true);
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
