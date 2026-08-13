import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Boxes,
  Code2,
  FileChartColumn,
  FlaskConical,
  Hammer,
  Image,
  Maximize2,
  Minimize2,
  Minus,
  Play,
  Plus,
  X,
} from "lucide-react";

export const WORKSPACE_TABS = ["play", "code", "art", "build", "scene", "test", "reports"] as const;

export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

interface WorkspaceTabsProps {
  /** Views open as tabs, in strip order. Never empty. */
  openTabs: readonly WorkspaceTab[];
  active: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
  /** Open a view that is not currently a tab. */
  onAdd: (tab: WorkspaceTab) => void;
  /** Close a tab. The last remaining tab cannot be closed. */
  onClose: (tab: WorkspaceTab) => void;
  badges: Partial<Record<WorkspaceTab, number>>;
  /** Dock fills the window. */
  expanded: boolean;
  onToggleExpand: () => void;
  /** Hide the dock entirely. */
  onCollapse?: () => void;
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

const HEADER_BUTTON =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink-strong active:bg-surface-3 disabled:opacity-35";

/**
 * The tools dock header: a browser-style tab strip over the game views.
 *
 * Every view can be closed and re-added, so the dock carries only what the
 * current task needs. The strip scrolls rather than shrinking its cells — a
 * tab collapsed to an unreadable sliver is not a target, and TEST's failure
 * badge has to stay legible at any dock width.
 */
export function WorkspaceTabs({
  openTabs,
  active,
  onChange,
  onAdd,
  onClose,
  badges,
  expanded,
  onToggleExpand,
  onCollapse,
}: WorkspaceTabsProps) {
  // Closing the last tab would leave the dock with nothing to show, so the
  // affordance disappears rather than failing on click.
  const closable = openTabs.length > 1;
  const addable = WORKSPACE_TABS.filter((tab) => !openTabs.includes(tab));

  return (
    <div
      data-tauri-drag-region="deep"
      className="flex h-[52px] shrink-0 select-none items-center gap-1 border-b border-line bg-surface-0 px-2"
    >
      <div
        role="tablist"
        aria-label="Workspace"
        aria-orientation="horizontal"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {openTabs.map((tab) => {
          const selected = tab === active;
          const badge = badges[tab];
          const meta = TAB_META[tab];
          const Icon = meta.icon;
          return (
            <div
              key={tab}
              className={`group relative flex shrink-0 items-center rounded-md transition-colors ${
                selected ? "bg-surface-2 shadow-[inset_0_0_0_1px_var(--line-strong)]" : "hover:bg-surface-2"
              }`}
            >
              <button
                id={`workspace-tab-${tab}`}
                role="tab"
                type="button"
                aria-selected={selected}
                aria-controls={`workspace-panel-${tab}`}
                // Roving tabindex: the strip is one tab stop and arrows move
                // within it, which is the pattern role="tablist" promises.
                tabIndex={selected ? 0 : -1}
                onKeyDown={(event) => {
                  const index = openTabs.indexOf(tab);
                  const nextIndex =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? openTabs.length - 1
                        : event.key === "ArrowRight"
                          ? (index + 1) % openTabs.length
                          : event.key === "ArrowLeft"
                            ? (index - 1 + openTabs.length) % openTabs.length
                            : -1;
                  if (nextIndex < 0) return;
                  event.preventDefault();
                  const next = openTabs[nextIndex];
                  onChange(next);
                  document.getElementById(`workspace-tab-${next}`)?.focus();
                }}
                onClick={() => onChange(tab)}
                // The accessible name stays the bare view id: it is the handle
                // every keyboard user and e2e spec addresses a view by.
                aria-label={tab}
                title={meta.label}
                className={`inline-flex min-w-0 items-center gap-1.5 rounded-md py-1.5 pl-2.5 text-[11.5px] font-medium transition-colors ${
                  closable ? "pr-1" : "pr-2.5"
                } ${selected ? "text-ink-strong" : "text-ink-subtle group-hover:text-ink"}`}
              >
                <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
                <span className="truncate">{meta.label}</span>
                {badge ? (
                  <span
                    className={`ml-0.5 shrink-0 rounded-full px-1.5 py-px text-[9px] font-bold text-surface-0 ${
                      selected ? "bg-ink" : "bg-ink-faint"
                    }`}
                  >
                    {badge}
                  </span>
                ) : null}
              </button>
              {closable ? (
                <button
                  type="button"
                  aria-label={`Close ${meta.label} tab`}
                  onClick={() => onClose(tab)}
                  className={`mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink-strong ${
                    selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  <X aria-hidden className="h-3 w-3" strokeWidth={2.2} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild disabled={addable.length === 0}>
          <button
            type="button"
            aria-label="Add view"
            title={addable.length === 0 ? "Every view is already open" : "Add view"}
            className={HEADER_BUTTON}
          >
            <Plus aria-hidden className="h-4 w-4" strokeWidth={1.9} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 min-w-[184px] rounded-[10px] border border-line bg-popover p-1.5 text-[13px] text-popover-foreground shadow-[0_18px_45px_rgba(0,0,0,0.28)]"
          >
            {addable.map((tab) => {
              const meta = TAB_META[tab];
              const Icon = meta.icon;
              return (
                <DropdownMenu.Item
                  key={tab}
                  onSelect={() => onAdd(tab)}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none transition-colors data-[highlighted]:bg-surface-2"
                >
                  <Icon aria-hidden className="h-3.5 w-3.5 text-ink-subtle" strokeWidth={1.7} />
                  {meta.label}
                </DropdownMenu.Item>
              );
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <button
        type="button"
        aria-label={expanded ? "Exit full screen" : "Expand to full screen"}
        onClick={onToggleExpand}
        className={HEADER_BUTTON}
      >
        {expanded ? (
          <Minimize2 aria-hidden className="h-4 w-4" strokeWidth={1.7} />
        ) : (
          <Maximize2 aria-hidden className="h-4 w-4" strokeWidth={1.7} />
        )}
      </button>

      {onCollapse ? (
        <button type="button" aria-label="Hide tools panel" onClick={onCollapse} className={HEADER_BUTTON}>
          <Minus aria-hidden className="h-4 w-4" strokeWidth={1.9} />
        </button>
      ) : null}
    </div>
  );
}
