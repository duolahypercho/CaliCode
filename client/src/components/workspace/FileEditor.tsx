import { useEffect, useRef, useState } from "react";
import type { ActivityFileChange } from "../../lib/activity";
import type { DiffRow } from "../../lib/diff";
import { readWorkspaceFile, writeWorkspaceFile, type FileContent } from "../../lib/workspace";

interface FileEditorProps {
  workspaceId: string;
  path: string | null;
  /** The latest agent edit for this file, if the activity row was opened. */
  activityFile?: ActivityFileChange | null;
  onSaved: (path: string) => void;
  onError: (message: string) => void;
}

type EditorMode = "diff" | "file";

/**
 * Reads and writes a real file in the workspace. Saving carries the sha256 the
 * buffer was loaded with, so a file changed on disk by HMR, git, or another
 * tool produces a conflict rather than a silent overwrite. When an activity
 * row is opened the persisted agent diff is shown first; FILE always returns
 * to the actual, editable workspace content.
 */
export function FileEditor({ workspaceId, path, activityFile = null, onSaved, onError }: FileEditorProps) {
  // See FileTree: an inline onError in the dependency list turns any RPC
  // failure into an unbounded request loop.
  const reportError = useRef(onError);
  reportError.current = onError;
  const [file, setFile] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [mode, setMode] = useState<EditorMode>("file");
  const activeActivity = activityFile && activityFile.path === path ? activityFile : null;
  const activityHasDiff = Boolean(
    activeActivity && (activeActivity.operation === "edit" || activeActivity.operation === "write"),
  );
  const activityKey = activeActivity
    ? [
        activeActivity.path,
        activeActivity.workspaceRoot ?? "",
        activeActivity.operation,
        activeActivity.turnId ?? "",
        activeActivity.toolCallId ?? "",
      ].join("\u0000")
    : null;

  useEffect(() => {
    if (!path) {
      setFile(null);
      setDraft("");
      setConflict(false);
      setMode("file");
      return;
    }
    let cancelled = false;
    setFile(null);
    setDraft("");
    setConflict(false);
    setMode("file");
    readWorkspaceFile(workspaceId, path)
      .then((result) => {
        if (cancelled) return;
        setFile(result);
        setDraft(result.content ?? "");
      })
      .catch((error: unknown) => reportError.current(`cannot read ${path}: ${describe(error)}`));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, path]);

  // A new activity selection is a deliberate jump to the agent's diff. Do
  // not derive this from `file` or `draft`: those can change after the agent
  // finished and the activity must remain a trustworthy historical snapshot.
  useEffect(() => {
    setMode(activityHasDiff ? "diff" : "file");
  }, [activityKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!file || !path || busy) return;
    setBusy(true);
    try {
      const result = await writeWorkspaceFile(workspaceId, path, draft, file.sha256);
      setFile({ ...file, content: draft, sha256: result.sha256 });
      setConflict(false);
      onSaved(path);
    } catch (error) {
      const message = describe(error);
      setConflict(message.includes("changed on disk"));
      reportError.current(`save failed: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const reload = () => {
    if (!path) return;
    readWorkspaceFile(workspaceId, path)
      .then((result) => {
        setFile(result);
        setDraft(result.content ?? "");
        setConflict(false);
      })
      .catch((error: unknown) => reportError.current(`cannot reload ${path}: ${describe(error)}`));
  };

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-ink-subtle">
        Select a file to edit.
      </div>
    );
  }

  if (file?.encoding === "binary") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-ink-subtle">
        <span>{path}</span>
        <span>Binary file · {file.bytes.toLocaleString()} bytes</span>
      </div>
    );
  }

  const dirty = file !== null && draft !== file.content;
  const diffRows: DiffRow[] = activeActivity?.diff ?? [];
  const additions = activeActivity?.additions ?? diffRows.filter((row) => row.type === "added").length;
  const deletions = activeActivity?.deletions ?? diffRows.filter((row) => row.type === "removed").length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[38px] shrink-0 items-center gap-2.5 border-b border-line px-4 text-xs text-ink-subtle">
        <span className="min-w-0 truncate">{path}</span>
        {activeActivity ? (
          <span className="shrink-0 text-[10px] uppercase tracking-[0.1em] text-ink-faint">
            {activeActivity.operation}
          </span>
        ) : null}
        {dirty ? <span className="shrink-0 text-[10px] tracking-[0.1em] text-ink">MODIFIED</span> : null}
        {file?.truncated ? (
          <span className="shrink-0 text-[10px] tracking-[0.1em] text-danger-soft">TRUNCATED: READ ONLY</span>
        ) : activeActivity?.truncated ? (
          <span className="shrink-0 text-[10px] tracking-[0.1em] text-danger-soft">TRUNCATED DIFF PREVIEW</span>
        ) : null}
        {activityHasDiff ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5" role="group" aria-label="File view">
            <span
              data-file-change-counts
              aria-label={`${additions} ${additions === 1 ? "addition" : "additions"}, ${deletions} ${deletions === 1 ? "deletion" : "deletions"}`}
              className="mr-1 inline-flex gap-1 text-[10px] tabular-nums"
            >
              <span aria-hidden className="text-success-soft">+{additions}</span>
              <span aria-hidden className="text-danger-soft">−{deletions}</span>
            </span>
            <button
              type="button"
              onClick={() => setMode("diff")}
              aria-label="Show diff"
              aria-pressed={mode === "diff"}
              className={`inline-flex min-h-[28px] items-center rounded border px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] transition-colors focus-visible:outline-none ${
                mode === "diff"
                  ? "border-line-strong bg-surface-3 text-ink-strong active:bg-surface-3"
                  : "border-line text-ink-subtle hover:bg-surface-2 hover:text-ink active:bg-surface-3"
              }`}
            >
              DIFF
            </button>
            <button
              type="button"
              onClick={() => setMode("file")}
              aria-label="Show file"
              aria-pressed={mode === "file"}
              className={`inline-flex min-h-[28px] items-center rounded border px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] transition-colors focus-visible:outline-none ${
                mode === "file"
                  ? "border-line-strong bg-surface-3 text-ink-strong active:bg-surface-3"
                  : "border-line text-ink-subtle hover:bg-surface-2 hover:text-ink active:bg-surface-3"
              }`}
            >
              FILE
            </button>
          </div>
        ) : null}
        <button
          type="button"
          onClick={reload}
          className={`${activityHasDiff ? "" : "ml-auto "}inline-flex min-h-[28px] shrink-0 items-center rounded border border-line px-2.5 py-1 text-[10px] tracking-[0.1em] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink active:bg-surface-3 focus-visible:outline-none`}
        >
          RELOAD
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !dirty || file?.truncated}
          className="inline-flex min-h-[28px] shrink-0 items-center rounded border border-line-strong bg-secondary px-3 py-1 text-[10px] font-bold tracking-[0.1em] text-ink-strong transition-colors enabled:hover:bg-secondary/80 active:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none"
        >
          {busy ? "SAVING…" : "SAVE"}
        </button>
      </div>
      {conflict ? (
        <p className="shrink-0 border-b border-line bg-destructive/10 px-4 py-2 text-[11px] text-danger-soft">
          This file changed on disk since it was opened. Reload to pick up the new version; saving would discard it.
        </p>
      ) : null}
      {activityHasDiff && mode === "diff" ? (
        diffRows.length === 0 ? (
          <p className="p-4 text-xs text-ink-subtle">No file changes recorded for this activity.</p>
        ) : (
          <div
            role="region"
            aria-label={`${path} diff`}
            className="min-h-0 flex-1 overflow-auto py-2 font-mono text-[12.5px] leading-[1.7]"
          >
            {diffRows.map((row, index) => (
              <div
                key={`${row.type}-${row.oldLine ?? "x"}-${row.newLine ?? "x"}-${index}`}
                className={`whitespace-pre px-3 ${
                  row.type === "added"
                    ? "bg-success-soft/10 text-success-soft"
                    : row.type === "removed"
                      ? "bg-surface-1 text-ink-subtle"
                      : "text-ink-subtle"
                }`}
              >
                <span className="inline-block w-10 select-none pr-3.5 text-right text-ink-faint">
                  {row.newLine ?? row.oldLine}
                </span>
                <span
                  className={`inline-block w-4 select-none ${
                    row.type === "added" ? "text-ink" : row.type === "removed" ? "text-ink-faint" : "text-ink-faint/70"
                  }`}
                >
                  {row.type === "added" ? "+" : row.type === "removed" ? "−" : ""}
                </span>
                {row.text}
              </div>
            ))}
          </div>
        )
      ) : (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              void save();
            }
          }}
          spellCheck={false}
          aria-label={`${path} source`}
          className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[12.5px] leading-[1.7] text-ink outline-none transition-colors"
        />
      )}
    </div>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
