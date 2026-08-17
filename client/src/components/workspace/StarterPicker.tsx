import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { listStarters, type Starter } from "../../lib/starters";

interface StarterPickerProps {
  /** Selected starter id, or null while nothing is chosen. */
  value: string | null;
  onChange: (id: string | null) => void;
  path: string;
  onPathChange: (path: string) => void;
  disabled?: boolean;
}

/**
 * Chooses a starter and where to put it. The destination is typed rather than
 * browsed because the folder does not exist yet — the folder browser can only
 * offer directories that are already there.
 */
export function StarterPicker({
  value,
  onChange,
  path,
  onPathChange,
  disabled = false,
}: StarterPickerProps) {
  const [starters, setStarters] = useState<Starter[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    listStarters()
      .then((next) => {
        if (!live) return;
        setStarters(next);
        // Preselecting the only starter saves a click without hiding the choice
        // when there is more than one.
        if (next.length === 1 && !value) onChange(next[0].id);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
    // Deliberately once. `value`/`onChange` are read only to preselect a lone
    // starter; listing them would re-fetch on every keystroke in the path field.

  }, []);

  if (error) {
    return (
      <p role="alert" className="px-1 text-xs text-danger-soft">
        {error}
      </p>
    );
  }

  if (!starters) {
    return (
      <div className="flex items-center gap-2 px-1 py-6 text-xs text-ink-subtle">
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
        Loading starters…
      </div>
    );
  }

  if (starters.length === 0) {
    return <p className="px-1 py-6 text-xs text-ink-subtle">No starters are available.</p>;
  }

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Starter" className="space-y-1.5">
        {starters.map((starter) => {
          const selected = starter.id === value;
          return (
            <button
              key={starter.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(starter.id)}
              className={`flex w-full flex-col items-start gap-1 rounded-lg border border-line px-3 py-2.5 text-left transition-colors ${
                selected ? "bg-surface-2" : "hover:bg-surface-1"
              }`}
            >
              <span className="flex w-full items-center gap-2">
                <Sparkles aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.7} />
                <span className="text-xs font-medium text-ink-strong">{starter.name}</span>
                {starter.scope === "user" ? (
                  <span className="ml-auto rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                    yours
                  </span>
                ) : null}
              </span>
              <span className="text-[11px] leading-relaxed text-ink-subtle">{starter.description}</span>
            </button>
          );
        })}
      </div>

      <label className="block space-y-1.5">
        <span className="text-[11px] text-ink-subtle">New folder</span>
        <input
          type="text"
          value={path}
          disabled={disabled}
          onChange={(event) => onPathChange(event.target.value)}
          aria-label="New folder path"
          spellCheck={false}
          className="w-full rounded-lg border border-line bg-surface-0 px-3 py-2 font-mono text-xs text-ink-strong"
        />
      </label>

      <p className="text-[11px] leading-relaxed text-ink-faint">
        The folder must be empty or not exist yet. Dependencies are not installed for you — run the starter&rsquo;s
        install command in the terminal once it is attached.
      </p>
    </div>
  );
}
