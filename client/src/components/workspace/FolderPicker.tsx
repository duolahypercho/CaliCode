import { useRef, useState } from "react";
import { ChevronRight, CornerLeftUp, Folder, FolderPlus, Loader2, X } from "lucide-react";
import { Button } from "../ui/button";
import { browseFolders, chooseNativeWorkspace, type FolderListing } from "../../lib/workspace";
import { isDesktopShell } from "../../lib/desktop";

interface FolderPickerProps {
  /** Absolute path of the chosen folder, or null when nothing is picked. */
  value: string | null;
  onChange: (path: string | null) => void;
  disabled?: boolean;
}

/**
 * The desktop shell uses the system folder picker so macOS can grant access to
 * protected roots. Plain browsers fall back to `workspace_browse`; only roots
 * that `workspace_open` accepts (package.json or .git) are selectable there.
 */
export function FolderPicker({ value, onChange, disabled = false }: FolderPickerProps) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Drops responses that arrive after a newer navigation.
  const requestSeq = useRef(0);

  const chooseNativeFolder = async () => {
    setLoading(true);
    setError("");
    try {
      const selected = await chooseNativeWorkspace();
      if (selected) onChange(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const load = async (path?: string) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError("");
    try {
      const next = await browseFolders(path);
      if (seq !== requestSeq.current) return;
      setListing(next);
    } catch (cause) {
      if (seq !== requestSeq.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  if (value) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-border bg-muted/50 px-3 py-2.5">
        <Folder aria-hidden="true" className="h-4 w-4 shrink-0 text-foreground" />
        <span className="min-w-0 flex-1 truncate text-left text-xs text-[var(--color-text-strong)]" title={value}>
          {value}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Remove folder"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  if (!browsing) {
    return (
      <div className="space-y-2">
        {/* No ring utility here: the shared `:where(button):focus-visible` outline in
            index.css already draws this button's focus indicator, and a Tailwind ring
            on top of it would paint a second one. */}
        <button
          type="button"
          disabled={disabled || loading}
          onClick={() => {
            if (isDesktopShell()) void chooseNativeFolder();
            else {
              setBrowsing(true);
              void load();
            }
          }}
          className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-card px-4 py-8 text-sm text-[var(--color-text-subtle)] transition-colors hover:bg-accent/50"
        >
          {loading ? (
            <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />
          ) : (
            <FolderPlus aria-hidden="true" className="h-5 w-5" />
          )}
          {loading ? "Opening folder picker…" : "Add a folder CaliCode can read and edit"}
        </button>
        {error ? (
          <p role="alert" className="px-1 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Parent folder"
          disabled={disabled || loading || !listing?.parent}
          onClick={() => listing?.parent && void load(listing.parent)}
        >
          <CornerLeftUp aria-hidden="true" className="h-4 w-4" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={listing?.path ?? ""}>
          {listing?.path ?? "…"}
        </span>
        {loading ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
      </div>

      <div className="max-h-56 overflow-y-auto p-1 [scrollbar-width:thin]">
        {error ? (
          <p role="alert" className="px-2 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : listing && listing.dirs.length === 0 && !loading ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No folders here.</p>
        ) : (
          listing?.dirs.map((dir) => (
            <div key={dir.path} className="group flex items-center gap-1 rounded-md hover:bg-accent/50">
              {/* `focus-ring-inset` rather than a Tailwind ring: the shared outline is the
                  app's single indicator, and this row sits inside the max-h-56 scroller,
                  which clips an outset one. */}
              <button
                type="button"
                disabled={disabled || loading}
                onClick={() => void load(dir.path)}
                className="focus-ring-inset flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--color-text-strong)]"
              >
                <Folder aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{dir.name}</span>
                <ChevronRight
                  aria-hidden="true"
                  className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100"
                />
              </button>
              {dir.isProject ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mr-1 shrink-0"
                  disabled={disabled || loading}
                  onClick={() => onChange(dir.path)}
                >
                  Select
                </Button>
              ) : null}
            </div>
          ))
        )}
      </div>

      <p className="border-t border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        Folders with a package.json or .git can be selected.
      </p>
    </div>
  );
}
