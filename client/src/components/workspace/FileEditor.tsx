import { useEffect, useRef, useState } from "react";
import type { ActivityFileChange } from "../../lib/activity";
import type { DiffRow } from "../../lib/diff";
import { readWorkspaceFile, writeWorkspaceFile, type FileContent } from "../../lib/workspace";

interface FileEditorProps {
  workspaceId: string;
  path: string | null;
  /** The latest agent edit for this file, if the activity row was opened. */
  activityFile?: ActivityFileChange | null;
  /**
   * Unsaved buffer for `path`, held by App. Read once when the path changes;
   * later values are echoes of `onDraftChange` and must not re-seed the
   * textarea under the cursor.
   */
  preservedDraft?: string | null;
  /**
   * Reports the buffer up on every keystroke. `null` means it matches disk and
   * the entry can be retired. `verified` is false when the file could not be
   * read: the text is still the user's and must be kept, but nobody knows what
   * is on disk, so it cannot honestly be called a modification of it.
   */
  onDraftChange?: (path: string, draft: string | null, verified: boolean) => void;
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
 *
 * The unsaved buffer lives in App, not here: this component unmounts on every
 * tab change, and it used to reset `draft` unconditionally when the path
 * changed, so switching files or tabs threw away typed work with no prompt.
 */
export function FileEditor({
  workspaceId,
  path,
  activityFile = null,
  preservedDraft = null,
  onDraftChange,
  onSaved,
  onError,
}: FileEditorProps) {
  // See FileTree: an inline onError in the dependency list turns any RPC
  // failure into an unbounded request loop.
  const reportError = useRef(onError);
  reportError.current = onError;
  const reportDraft = useRef(onDraftChange);
  reportDraft.current = onDraftChange;
  // Read at path-change time only. As a dependency it would re-run the read
  // effect on every keystroke, since each keystroke updates the App map.
  const preservedRef = useRef(preservedDraft);
  preservedRef.current = preservedDraft;
  // The path this render is for, readable from async callbacks that were
  // dispatched for an earlier one (see `reload`).
  const pathRef = useRef(path);
  pathRef.current = path;
  const [file, setFile] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState("");
  // Which path `draft` (and `file`) actually belong to. A path change renders
  // once with the new prop but the previous file's state — the read effect can
  // only *schedule* the swap — so every consumer of the buffer has to wait for
  // this to catch up or it will attribute one file's text to another.
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const settled = draftPath === path;
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  // Set when the read for `draftPath` failed. Nothing retries on its own, so
  // until the user reloads, the on-disk contents of this path are unknown.
  const [readError, setReadError] = useState<string | null>(null);
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
      setDraftPath(null);
      setConflict(false);
      setReadError(null);
      setMode("file");
      return;
    }
    let cancelled = false;
    // Seeded before the read is even dispatched, so returning to a file with
    // unsaved edits never flashes — or keeps — the on-disk text underneath.
    const preserved = preservedRef.current;
    setFile(null);
    setDraft(preserved ?? "");
    setDraftPath(path);
    setConflict(false);
    setReadError(null);
    setMode("file");
    readWorkspaceFile(workspaceId, path)
      .then((result) => {
        if (cancelled) return;
        setFile(result);
        if (preserved === null) setDraft(result.content ?? "");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setReadError(describe(error));
        reportError.current(`cannot read ${path}: ${describe(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, path]);

  // Hand the buffer to App on every change so it survives this component's
  // unmount. `null` retires the entry: saving, or typing the file back to its
  // on-disk contents, clears the MODIFIED marker in the tree too.
  useEffect(() => {
    if (!path) return;
    // The commit that carries a new `path` still holds the previous file's
    // draft, so reporting here would file one file's text under another file's
    // key. Later that entry is seeded back into the textarea *and* suppresses
    // the disk read, while `file` carries the real target's sha256 — a save
    // would then write the wrong contents straight past the sha guard. A read
    // that never resolves leaves that entry until the path is opened again.
    if (!settled) return;
    if (readError && !file) {
      // The read failed and nothing retries it, so the on-disk contents are
      // unknown: this buffer cannot be diffed against them or saved until a
      // reload succeeds. Keep it — it is the user's typing, and this component
      // unmounts on every tab change — but hand it up as unverified so nothing
      // claims a modification against a disk state nobody has seen.
      reportDraft.current?.(path, draft === "" ? null : draft, false);
      return;
    }
    if (!file) {
      // Read still in flight. The textarea is live, so anything in it is the
      // preserved copy or something typed since.
      if (draft !== "") reportDraft.current?.(path, draft, true);
      return;
    }
    reportDraft.current?.(path, draft === (file.content ?? "") ? null : draft, true);
  }, [draft, file, path, readError, settled]);

  // A new activity selection is a deliberate jump to the agent's diff. Do
  // not derive this from `file` or `draft`: those can change after the agent
  // finished and the activity must remain a trustworthy historical snapshot.
  useEffect(() => {
    setMode(activityHasDiff ? "diff" : "file");
  }, [activityKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    // `settled` again: effects run after paint, so a click landing in the frame
    // between a path change and the read effect would otherwise write the
    // previous file's buffer into the newly opened path.
    if (!file || !path || busy || !settled) return;
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
    // RELOAD after a failed read is a retry, not a discard: it is the only way
    // out of the unverifiable state and the banner sends the user here, so the
    // text they typed survives it. A successful retry is exactly the moment
    // that text becomes a real diff again — against the sha256 just read.
    const unverified = readError !== null && draft !== "" ? draft : null;
    readWorkspaceFile(workspaceId, path)
      .then((result) => {
        // Same hazard as a stale draft: without this the reloaded contents and
        // sha256 of the file the user left land in the file they moved to.
        if (pathRef.current !== path) return;
        setFile(result);
        setDraft(unverified ?? result.content ?? "");
        setDraftPath(path);
        setConflict(false);
        setReadError(null);
      })
      .catch((error: unknown) => {
        // Same guard: a retry that fails after the user moved on must not
        // stamp this path's failure onto the file they are looking at now.
        if (pathRef.current === path) setReadError(describe(error));
        reportError.current(`cannot reload ${path}: ${describe(error)}`);
      });
  };

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-ink-subtle">
        Select a file to edit.
      </div>
    );
  }

  if (settled && file?.encoding === "binary") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-ink-subtle">
        <span>{path}</span>
        <span>Binary file · {file.bytes.toLocaleString()} bytes</span>
      </div>
    );
  }

  // Never MODIFIED, and never saveable, on the strength of a buffer that
  // belongs to a different file.
  const dirty = file !== null && settled && draft !== file.content;
  // Unsaved text whose file could not be read. It is kept, like any other
  // unsaved buffer, but it is not MODIFIED: there is no known disk state to
  // have modified. Say that in its own words rather than borrowing the badge
  // that promises a real, saveable diff.
  // A failed *reload* leaves `file` behind, so that buffer is still diffable
  // and still saveable under the sha256 it was read with: MODIFIED is honest
  // there. Only a file with no known contents at all is unverifiable.
  const unverifiedBuffer = settled && readError !== null && file === null && draft !== "";
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
        {settled && readError ? (
          <span
            title={`This file could not be read: ${readError}`}
            className="shrink-0 text-[10px] tracking-[0.1em] text-danger-soft"
          >
            READ FAILED
          </span>
        ) : null}
        {unverifiedBuffer ? (
          <span
            title="Unsaved — disk state unknown. Your text is kept, but it cannot be compared with the file on disk or saved until a reload succeeds."
            className="shrink-0 text-[10px] tracking-[0.1em] text-danger-soft"
          >
            UNSAVED · DISK UNKNOWN
          </span>
        ) : null}
        {settled && file?.truncated ? (
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
              className={`inline-flex min-h-[28px] items-center rounded border px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] transition-colors ${
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
              className={`inline-flex min-h-[28px] items-center rounded border px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] transition-colors ${
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
          className={`${activityHasDiff ? "" : "ml-auto "}inline-flex min-h-[28px] shrink-0 items-center rounded border border-line px-2.5 py-1 text-[10px] tracking-[0.1em] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink active:bg-surface-3`}
        >
          RELOAD
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !dirty || file?.truncated}
          className="inline-flex min-h-[28px] shrink-0 items-center rounded border border-line-strong bg-secondary px-3 py-1 text-[10px] font-bold tracking-[0.1em] text-ink-strong transition-colors enabled:hover:bg-secondary/80 active:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "SAVING…" : "SAVE"}
        </button>
      </div>
      {settled && readError ? (
        <p className="shrink-0 border-b border-line bg-destructive/10 px-4 py-2 text-[11px] text-danger-soft">
          {file === null ? (
            <>
              This file could not be read ({readError}), so its contents on disk are unknown. Anything below is your
              own unsaved text: it is kept and it survives switching files or tabs, but it cannot be compared with the
              file on disk or saved until a read succeeds. RELOAD to try again — your text is carried over.
            </>
          ) : (
            <>
              Reload failed ({readError}). What is below is still your text over the version read earlier; saving is
              guarded by that version's checksum, so a file that has since changed on disk will be reported as a
              conflict rather than overwritten.
            </>
          )}
        </p>
      ) : null}
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
          // Until the read effect has run for this path, `draft` is still the
          // file the user just left; show what that effect is about to seed
          // rather than another file's text under this file's name.
          value={settled ? draft : preservedDraft ?? ""}
          // Editable even when the read failed: the buffer is reported up and
          // held above this component, so typing here is no more perishable
          // than typing into any other file. It just cannot be saved until a
          // reload establishes what is on disk — the SAVE button says so.
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
