export const WORKSPACE_TABS = ["play", "code", "art", "scene", "test"] as const;

export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

interface WorkspaceTabsProps {
  active: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
  badges: Partial<Record<WorkspaceTab, number>>;
  previewUrl: string;
  onNewGame: () => void;
  onExport: () => void;
  exporting: boolean;
}

/**
 * Workspace header: the PLAY/CODE/ART/SCENE/TEST segmented control,
 * the live preview URL, and the new-game / export actions.
 */
export function WorkspaceTabs({
  active,
  onChange,
  badges,
  previewUrl,
  onNewGame,
  onExport,
  exporting,
}: WorkspaceTabsProps) {
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-3.5 border-b border-white/[0.06] bg-[#0b0b0b] px-3.5">
      {/* shrink-0: NEW GAME and EXPORT were shrink-0 while the tablist was not,
          so from ~1512px down the tab strip was clipped and TEST — the tab
          carrying the failure badge — could not be seen or clicked. */}
      <div
        role="tablist"
        aria-label="Workspace"
        className="flex shrink-0 overflow-x-auto rounded-md border border-white/[0.09]"
      >
        {WORKSPACE_TABS.map((tab) => {
          const selected = tab === active;
          const badge = badges[tab];
          return (
            <button
              key={tab}
              id={`workspace-tab-${tab}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`workspace-panel-${tab}`}
              // Roving tabindex: the tablist is one stop, and arrows move
              // within it. Every tab was tabIndex 0 with no key handling, so
              // the role promised a pattern that was not implemented.
              tabIndex={selected ? 0 : -1}
              onKeyDown={(event) => {
                const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (delta === 0) return;
                event.preventDefault();
                const index = WORKSPACE_TABS.indexOf(tab);
                const next = WORKSPACE_TABS[(index + delta + WORKSPACE_TABS.length) % WORKSPACE_TABS.length];
                onChange(next);
                document.getElementById(`workspace-tab-${next}`)?.focus();
              }}
              onClick={() => onChange(tab)}
              className={`shrink-0 border-r border-white/[0.08] px-[15px] py-2 text-[11px] font-bold uppercase tracking-[0.14em] transition-colors last:border-r-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/30 ${
                selected
                  ? "bg-[#1c1c1c] text-[#e0e0e0] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] active:bg-[#232323]"
                  : "text-[#9c9c9c] hover:bg-white/[0.03] hover:text-[#b0b0b0] active:bg-white/[0.06]"
              }`}
            >
              {tab}
              {badge ? (
                <span
                  className={`ml-[7px] rounded-lg px-[5px] py-px text-[9px] font-bold text-[#0a0a0a] ${
                    selected ? "bg-[#c0c0c0]" : "bg-[#7a7a7a]"
                  }`}
                >
                  {badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <span className="ml-auto hidden truncate text-[11px] text-[#8a8a8a] xl:inline">{previewUrl}</span>
      <button
        type="button"
        onClick={onNewGame}
        className="shrink-0 rounded-md border border-white/[0.12] px-3 py-[7px] text-[11px] tracking-[0.12em] text-[#c0c0c0] transition-colors hover:border-white/30 active:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
      >
        NEW GAME
      </button>
      <button
        type="button"
        onClick={onExport}
        disabled={exporting}
        className="shrink-0 rounded-md border border-white/[0.12] bg-[#2a2a2a] px-[15px] py-[7px] text-[11px] font-bold tracking-[0.12em] text-[#dcdcdc] transition-colors hover:bg-[#333] active:bg-[#3a3a3a] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[#2a2a2a]"
      >
        {exporting ? "SAVING…" : "SAVE"}
      </button>
    </div>
  );
}
