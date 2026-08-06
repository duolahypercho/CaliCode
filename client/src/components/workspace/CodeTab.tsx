import { useMemo, useState } from "react";
import { collapseContext, diffLines } from "../../lib/diff";
import type { Script } from "../../lib/types";

interface CodeTabProps {
  scripts: Script[];
  /** Scripts as they were when the project was last loaded or saved. */
  baseline: Record<string, string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (script: Script) => void;
  onAdd: () => void;
}

type Mode = "diff" | "edit";

/**
 * Changed-files list plus a real diff, matching the design's CODE surface.
 *
 * The +/- counts come from an actual line diff against the loaded project, so
 * a script with no edits genuinely shows nothing.
 */
export function CodeTab({ scripts, baseline, selectedId, onSelect, onChange, onAdd }: CodeTabProps) {
  const [mode, setMode] = useState<Mode>("diff");

  const changes = useMemo(
    () =>
      scripts.map((script) => {
        const summary = diffLines(baseline[script.id] ?? "", script.code);
        return { script, added: summary.added, removed: summary.removed, summary };
      }),
    [scripts, baseline],
  );

  const changed = changes.filter((entry) => entry.added > 0 || entry.removed > 0);
  const active = changes.find((entry) => entry.script.id === selectedId) ?? changes[0];
  const rows = useMemo(
    () => (active ? collapseContext(active.summary.rows) : []),
    [active],
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 w-[236px] shrink-0 flex-col border-r border-white/5 bg-[#0a0a0a]">
        <div className="calicode-label flex items-center px-3 pb-2.5 pt-3">
          Changed files
          <span className="ml-auto text-[#9c9c9c]">{changed.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          {changes.map((entry) => {
            const isActive = entry.script.id === active?.script.id;
            const dirty = entry.added > 0 || entry.removed > 0;
            return (
              <button
                key={entry.script.id}
                type="button"
                onClick={() => onSelect(entry.script.id)}
                className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-[7px] text-left text-xs ${
                  isActive ? "bg-[#161616] text-[#dcdcdc]" : "text-[#8f8f8f] hover:text-[#c0c0c0]"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{entry.script.name}</span>
                {dirty ? (
                  <>
                    <span className="shrink-0 text-[#8f8f8f]">+{entry.added}</span>
                    <span className="shrink-0 text-[#8f8f8f]">−{entry.removed}</span>
                  </>
                ) : (
                  <span className="shrink-0 text-[10px] text-[#7d7d7d]">clean</span>
                )}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="m-2 rounded-md border border-white/10 py-2 text-[11px] tracking-[0.14em] text-[#a0a0a0] hover:border-white/25 hover:text-[#d0d0d0]"
        >
          NEW SCRIPT
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[38px] shrink-0 items-center gap-2.5 border-b border-white/5 px-4 text-xs text-[#9a9a9a]">
          <span className="min-w-0 truncate">{active?.script.name ?? "No scripts"}</span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {(["diff", "edit"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                aria-pressed={mode === option}
                className={`rounded border px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] ${
                  mode === option
                    ? "border-white/25 bg-[#1c1c1c] text-[#dcdcdc]"
                    : "border-white/10 text-[#9c9c9c] hover:text-[#b0b0b0]"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        {!active ? (
          <p className="p-4 text-xs text-[#8f8f8f]">No scripts in this project yet.</p>
        ) : mode === "edit" ? (
          <textarea
            value={active.script.code}
            onChange={(event) => onChange({ ...active.script, code: event.target.value })}
            spellCheck={false}
            aria-label={`${active.script.name} source`}
            className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[12.5px] leading-[1.75] text-[#c8c8c8] outline-none"
          />
        ) : rows.length === 0 ? (
          <p className="p-4 text-xs text-[#8f8f8f]">
            No changes in {active.script.name} since the project was loaded.
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto py-2 font-mono text-[12.5px] leading-[1.75]">
            {rows.map((row, index) => (
              <div
                key={`${row.type}-${row.oldLine ?? "x"}-${row.newLine ?? "x"}-${index}`}
                className={`whitespace-pre px-3 ${
                  row.type === "added"
                    ? "bg-white/[0.05] text-[#e0e0e0]"
                    : row.type === "removed"
                      ? "bg-white/[0.02] text-[#9c9c9c]"
                      : "text-[#a6a6a6]"
                }`}
              >
                <span className="inline-block w-10 select-none pr-3.5 text-right text-[#404040]">
                  {row.newLine ?? row.oldLine}
                </span>
                <span
                  className={`inline-block w-4 select-none ${
                    row.type === "added" ? "text-[#cfcfcf]" : row.type === "removed" ? "text-[#6a6a6a]" : "text-[#404040]"
                  }`}
                >
                  {row.type === "added" ? "+" : row.type === "removed" ? "−" : ""}
                </span>
                {row.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
