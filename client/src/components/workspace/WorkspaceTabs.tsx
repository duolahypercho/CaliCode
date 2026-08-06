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
      <div role="tablist" aria-label="Workspace" className="flex overflow-hidden rounded-md border border-white/[0.09]">
        {WORKSPACE_TABS.map((tab) => {
          const selected = tab === active;
          const badge = badges[tab];
          return (
            <button
              key={tab}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => onChange(tab)}
              className={`border-r border-white/[0.08] px-[15px] py-2 text-[11px] font-bold uppercase tracking-[0.14em] last:border-r-0 ${
                selected ? "bg-[#1c1c1c] text-[#e0e0e0]" : "text-[#767676] hover:text-[#b0b0b0]"
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
      <span className="ml-auto hidden truncate text-[11px] text-[#4f4f4f] xl:inline">{previewUrl}</span>
      <button
        type="button"
        onClick={onNewGame}
        className="shrink-0 rounded-md border border-white/[0.12] px-3 py-[7px] text-[11px] tracking-[0.12em] text-[#c0c0c0] hover:border-white/30"
      >
        NEW GAME
      </button>
      <button
        type="button"
        onClick={onExport}
        disabled={exporting}
        className="shrink-0 rounded-md border border-white/[0.12] bg-[#2a2a2a] px-[15px] py-[7px] text-[11px] font-bold tracking-[0.12em] text-[#dcdcdc] hover:bg-[#333] disabled:opacity-50"
      >
        {exporting ? "SAVING…" : "EXPORT"}
      </button>
    </div>
  );
}
