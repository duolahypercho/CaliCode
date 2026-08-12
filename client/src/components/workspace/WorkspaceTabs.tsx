import { Boxes, Code2, FileChartColumn, FlaskConical, Hammer, Image, Play } from "lucide-react";

export const WORKSPACE_TABS = ["play", "code", "art", "build", "scene", "test", "reports"] as const;

export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

interface WorkspaceTabsProps {
  active: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
  badges: Partial<Record<WorkspaceTab, number>>;
}

const TAB_META = {
  play: { label: "Play", icon: Play },
  code: { label: "Code", icon: Code2 },
  art: { label: "Assets", icon: Image },
  build: { label: "Build", icon: Hammer },
  scene: { label: "Scene", icon: Boxes },
  test: { label: "Test", icon: FlaskConical },
  reports: { label: "Reports", icon: FileChartColumn },
} satisfies Record<WorkspaceTab, { label: string; icon: typeof Play }>;

/**
 * Workspace header for the game-specific tools dock.
 * There is no SAVE button — the project document autosaves on edit.
 */
export function WorkspaceTabs({ active, onChange, badges }: WorkspaceTabsProps) {
  return (
    <div data-tauri-drag-region="deep" className="@container flex h-[52px] shrink-0 select-none items-center border-b border-line bg-surface-0 px-2.5">
      {/* The tab cells stay equal-width and hide their labels below the
          container threshold, so every tab — including TEST's failure badge —
          remains a one-click target even in the narrow drawer. */}
      <div
        role="tablist"
        aria-label="Workspace"
        aria-orientation="horizontal"
        className="grid min-w-0 flex-1 grid-cols-7 overflow-hidden rounded-md border border-line"
      >
        {WORKSPACE_TABS.map((tab) => {
          const selected = tab === active;
          const badge = badges[tab];
          const meta = TAB_META[tab];
          const Icon = meta.icon;
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
                const index = WORKSPACE_TABS.indexOf(tab);
                const nextIndex =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? WORKSPACE_TABS.length - 1
                      : event.key === "ArrowRight"
                        ? (index + 1) % WORKSPACE_TABS.length
                        : event.key === "ArrowLeft"
                          ? (index - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length
                          : -1;
                if (nextIndex < 0) return;
                event.preventDefault();
                const next = WORKSPACE_TABS[nextIndex];
                onChange(next);
                document.getElementById(`workspace-tab-${next}`)?.focus();
              }}
              onClick={() => onChange(tab)}
              aria-label={tab}
              title={meta.label}
              className={`relative inline-flex min-w-0 items-center justify-center gap-0.5 border-r border-line px-1 py-2 text-[10px] font-medium transition-colors last:border-r-0 focus-visible:outline-none ${
                selected
                  ? "bg-surface-3 text-ink-strong shadow-[inset_0_0_0_1px_var(--line-strong)] active:bg-surface-3"
                  : "text-ink-subtle hover:bg-surface-2 hover:text-ink active:bg-surface-3"
              }`}
            >
              <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
              <span className="hidden truncate @[520px]:inline">{meta.label}</span>
              {badge ? (
                <span
                  className={`absolute right-1 top-1 rounded-lg px-1 py-px text-[8px] font-bold leading-none text-surface-0 @[520px]:static @[520px]:ml-0.5 ${
                    selected ? "bg-ink" : "bg-ink-faint"
                  }`}
                >
                  {badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
