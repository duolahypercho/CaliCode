import { useState } from "react";
import { FilePenLine } from "lucide-react";
import { isSafeActivityPath, type ActivityFileChange, type ChangedFileSummary } from "../../lib/activity";

/** Files shown before the card asks to be expanded. */
const PREVIEW_FILES = 3;

function Counts({ additions, deletions, truncated }: { additions: number; deletions: number; truncated?: boolean }) {
  return (
    <span className="inline-flex shrink-0 gap-1 font-mono tabular-nums">
      <span className="text-success-soft">
        {truncated ? "≈" : ""}+{additions.toLocaleString()}
      </span>
      <span className="text-danger-soft">-{deletions.toLocaleString()}</span>
    </span>
  );
}

/**
 * What a finished turn did to the workspace, in one quiet block: how many
 * files, the totals, and the files themselves. It is a summary, not an alert —
 * the only colour is the +/- the transcript already uses.
 */
export function TurnFileSummaryCard({
  summary,
  onOpenFile,
}: {
  summary: ChangedFileSummary;
  onOpenFile?: (file: ActivityFileChange) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const files = summary.files;
  if (files.length === 0) return null;
  const visible = showAll ? files : files.slice(0, PREVIEW_FILES);
  const hidden = files.length - visible.length;
  return (
    <div
      data-activity-change-summary
      className="mt-1 overflow-hidden rounded-lg border border-line px-2.5 py-1.5 text-[10px] text-ink-subtle"
    >
      <div className="flex items-center gap-2">
        <FilePenLine aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" strokeWidth={1.7} />
        <span className="min-w-0 flex-1 truncate tabular-nums">
          {files.length.toLocaleString()} {files.length === 1 ? "file" : "files"} changed
        </span>
        <Counts additions={summary.additions} deletions={summary.deletions} />
      </div>
      <div className="mt-1 space-y-0.5">
        {visible.map((file) => {
          const canOpen = Boolean(onOpenFile && isSafeActivityPath(file.path, file.workspaceRoot));
          return (
            <button
              key={file.path}
              type="button"
              disabled={!canOpen}
              onClick={() => {
                if (canOpen) onOpenFile?.(file);
              }}
              aria-label={canOpen ? `Open ${file.path}` : file.path}
              className={`flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left transition-colors ${
                canOpen ? "hover:bg-surface-2 hover:text-ink active:bg-surface-3" : "cursor-default"
              }`}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-ink-faint">{file.path}</span>
              <Counts additions={file.additions} deletions={file.deletions} truncated={file.truncated} />
            </button>
          );
        })}
      </div>
      {files.length > PREVIEW_FILES ? (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          aria-expanded={showAll}
          className="mt-1 rounded px-1 py-0.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink active:bg-surface-3"
        >
          {showAll ? "Show fewer files" : `Show ${hidden} more ${hidden === 1 ? "file" : "files"}`}
        </button>
      ) : null}
    </div>
  );
}
