import { useEffect } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Boxes,
  Code2,
  FileChartColumn,
  FlaskConical,
  Globe,
  Hammer,
  Image,
  Maximize2,
  Minimize2,
  MessageCircleQuestion,
  Minus,
  Play,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";

export const WORKSPACE_TABS = ["play", "code", "art", "build", "scene", "test", "terminal", "browser", "sidechat", "reports"] as const;

export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

/**
 * Views that can be open more than once at a time. A side chat is a thread,
 * not a tool: asking a second question while the first answer is still being
 * read means a second thread, the way `/side` twice reads as two of them.
 */
export const MULTI_INSTANCE_TABS: readonly WorkspaceTab[] = ["sidechat"];

/**
 * A tab in the strip. Single-instance views use their bare kind as the id;
 * a repeatable view's extra instances carry a `-2`, `-3` … suffix. The first
 * instance keeps the bare id, so the accessible name every keyboard user and
 * e2e spec addresses a view by does not move when a second one opens.
 */
export type WorkspaceTabId = WorkspaceTab | `${WorkspaceTab}-${number}`;

/** The view an instance id belongs to: `sidechat-3` → `sidechat`. */
export function tabKind(id: WorkspaceTabId): WorkspaceTab {
  const [kind] = id.split("-");
  return WORKSPACE_TABS.includes(kind as WorkspaceTab) ? (kind as WorkspaceTab) : "play";
}

/** The next free id for a view: `sidechat`, then `sidechat-2`, `sidechat-3` … */
export function nextTabId(kind: WorkspaceTab, open: readonly WorkspaceTabId[]): WorkspaceTabId {
  if (!open.includes(kind)) return kind;
  for (let instance = 2; ; instance += 1) {
    const candidate = `${kind}-${instance}` as WorkspaceTabId;
    if (!open.includes(candidate)) return candidate;
  }
}

interface WorkspaceTabsProps {
  /** Views open as tabs, in strip order. Never empty. */
  openTabs: readonly WorkspaceTabId[];
  active: WorkspaceTabId;
  onChange: (tab: WorkspaceTabId) => void;
  /** Open a view. Repeatable views open another instance. */
  onAdd: (tab: WorkspaceTab) => void;
  /** Close a tab. The last remaining tab cannot be closed. */
  onClose: (tab: WorkspaceTabId) => void;
  badges: Partial<Record<WorkspaceTab, number>>;
  /**
   * Per-tab display overrides. BROWSER uses them to show the page it has open,
   * the way a browser tab does.
   *
   * Display only: the accessible name stays the bare view id below, so a page
   * title can never move the handle that keyboard users and e2e specs address
   * a view by.
   */
  tabTitles?: Partial<Record<WorkspaceTabId, string | undefined>>;
  /** Icon image (a data url) shown in place of the view's glyph. */
  tabIcons?: Partial<Record<WorkspaceTab, string | undefined>>;
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
  terminal: { label: "Terminal", icon: SquareTerminal },
  browser: { label: "Browser", icon: Globe },
  sidechat: { label: "Side chat", icon: MessageCircleQuestion },
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
  tabTitles,
  tabIcons,
  expanded,
  onToggleExpand,
  onCollapse,
}: WorkspaceTabsProps) {
  // Selecting a tab that sits past the fade leaves the strip showing only
  // inactive tabs, so the view you are in is the one you cannot see. Opening a
  // view from elsewhere in the app (the header's side-chat button, a badge)
  // is exactly when that happens.
  useEffect(() => {
    document
      .getElementById(`workspace-tab-${active}`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  // Closing the last tab would leave the dock with nothing to show, so the
  // affordance disappears rather than failing on click.
  const closable = openTabs.length > 1;
  // Views not currently in the strip. A repeatable view drops out once one is
  // open: "Add view" is for reaching a view you do not have, and stacking a
  // second side chat is a deliberate act — `/side` — not a menu pick that
  // looks the same as the one that just focuses it.
  const addable = WORKSPACE_TABS.filter((kind) => !openTabs.some((id) => tabKind(id) === kind));

  return (
    <div
      data-tauri-drag-region="deep"
      className="flex h-10 shrink-0 select-none items-center gap-1 border-b border-line bg-surface-0 px-1.5"
    >
      <div
        role="tablist"
        aria-label="Workspace"
        aria-orientation="horizontal"
        className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)]"
      >
        {openTabs.map((tab, index) => {
          const selected = tab === active;
          // A hairline divides plain tabs. It is suppressed either side of the
          // selected pill, where the fill already separates them and a rule
          // would read as a stray mark against the rounded edge.
          const divided = index > 0 && !selected && openTabs[index - 1] !== active;
          const kind = tabKind(tab);
          const badge = badges[kind];
          const meta = TAB_META[kind];
          const Icon = meta.icon;
          const override = tabTitles?.[tab]?.trim();
          const label = override || meta.label;
          const iconUrl = tabIcons?.[kind];
          return (
            <div
              key={tab}
              className={`group relative flex shrink-0 items-center rounded-md transition-colors ${
                divided ? "before:mr-1 before:h-3.5 before:w-px before:bg-line-strong before:content-['']" : ""
              } ${selected ? "bg-surface-2 shadow-[inset_0_0_0_1px_var(--line-strong)]" : "hover:bg-surface-2"}`}
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
                // The tooltip carries the full title; the label below is
                // clipped so one tab cannot eat the strip.
                // "Side chat — Side chat 2" says the view twice; an override
                // that already names the view stands on its own.
                title={override && !override.startsWith(meta.label) ? `${meta.label} — ${override}` : override || meta.label}
                className={`inline-flex min-w-0 items-center gap-1.5 rounded-md py-1 pl-2.5 text-[11.5px] font-medium transition-colors ${
                  closable ? "pr-1" : "pr-2.5"
                } ${selected ? "text-ink-strong" : "text-ink-subtle group-hover:text-ink"}`}
              >
                {iconUrl ? (
                  <img
                    aria-hidden
                    alt=""
                    src={iconUrl}
                    className="h-3.5 w-3.5 shrink-0 rounded-[2px] object-contain"
                  />
                ) : (
                  <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
                )}
                <span className={`truncate ${override ? "max-w-[120px]" : "max-w-[84px]"}`}>{label}</span>
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
                  // The resolved label, not the view's: with two side chats
                  // open, one "Close Side chat tab" button per instance is
                  // ambiguous to anything that addresses controls by name.
                  aria-label={`Close ${label} tab`}
                  onClick={() => onClose(tab)}
                  // Reserved space, revealed on hover — and kept visible on the
                  // active tab and while focused, so a keyboard user can reach
                  // a control that is otherwise only discoverable by pointer.
                  className={`mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint transition-opacity hover:bg-surface-3 hover:text-ink-strong focus-visible:opacity-100 group-hover:opacity-100 ${
                    selected ? "opacity-100" : "opacity-0"
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
            <Plus aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.9} />
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
          <Minimize2 aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.7} />
        ) : (
          <Maximize2 aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.7} />
        )}
      </button>

      {onCollapse ? (
        <button type="button" aria-label="Hide tools panel" onClick={onCollapse} className={HEADER_BUTTON}>
          <Minus aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.9} />
        </button>
      ) : null}
    </div>
  );
}
