import { useEffect, useState } from "react";
import { readWorkspaceFile, writeWorkspaceFile, type FileContent } from "../../lib/workspace";

interface FileEditorProps {
  workspaceId: string;
  path: string | null;
  onSaved: (path: string) => void;
  onError: (message: string) => void;
}

/**
 * Reads and writes a real file in the workspace. Saving carries the sha256 the
 * buffer was loaded with, so a file changed on disk by HMR, git, or another
 * tool produces a conflict rather than a silent overwrite.
 */
export function FileEditor({ workspaceId, path, onSaved, onError }: FileEditorProps) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (!path) {
      setFile(null);
      setDraft("");
      return;
    }
    let cancelled = false;
    setConflict(false);
    readWorkspaceFile(workspaceId, path)
      .then((result) => {
        if (cancelled) return;
        setFile(result);
        setDraft(result.content ?? "");
      })
      .catch((error: unknown) => onError(`cannot read ${path}: ${describe(error)}`));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, path, onError]);

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
      onError(`save failed: ${message}`);
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
      .catch((error: unknown) => onError(`cannot reload ${path}: ${describe(error)}`));
  };

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[#8f8f8f]">
        Select a file to edit.
      </div>
    );
  }

  if (file?.encoding === "binary") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-[#8f8f8f]">
        <span>{path}</span>
        <span>Binary file · {file.bytes.toLocaleString()} bytes</span>
      </div>
    );
  }

  const dirty = file !== null && draft !== file.content;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[38px] shrink-0 items-center gap-2.5 border-b border-white/5 px-4 text-xs text-[#9a9a9a]">
        <span className="min-w-0 truncate">{path}</span>
        {dirty ? <span className="shrink-0 text-[10px] tracking-[0.1em] text-[#c0c0c0]">MODIFIED</span> : null}
        {file?.truncated ? (
          <span className="shrink-0 text-[10px] tracking-[0.1em] text-[#c98b8b]">TRUNCATED — READ ONLY</span>
        ) : null}
        <button
          type="button"
          onClick={reload}
          className="ml-auto shrink-0 rounded border border-white/10 px-2.5 py-1 text-[10px] tracking-[0.1em] text-[#8f8f8f] hover:border-white/25"
        >
          RELOAD
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !dirty || file?.truncated}
          className="shrink-0 rounded border border-white/[0.12] bg-[#2a2a2a] px-3 py-1 text-[10px] font-bold tracking-[0.1em] text-[#dcdcdc] hover:bg-[#333] disabled:opacity-40"
        >
          {busy ? "SAVING…" : "SAVE"}
        </button>
      </div>
      {conflict ? (
        <p className="shrink-0 border-b border-white/5 bg-[#1a1414] px-4 py-2 text-[11px] text-[#c98b8b]">
          This file changed on disk since it was opened. Reload to pick up the new version — saving would discard it.
        </p>
      ) : null}
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
        className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[12.5px] leading-[1.7] text-[#c8c8c8] outline-none"
      />
    </div>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
