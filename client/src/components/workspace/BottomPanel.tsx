import { Plus, SquareTerminal, Terminal as TerminalIcon, X } from "lucide-react";

export interface BottomTab {
  id: string;
  title: string;
  /** A console tab reports the app's own log; it is not a shell and cannot be closed. */
  kind?: "terminal" | "console";
  /** Unread error count, shown so a failure is visible before the tab is opened. */
  badge?: number;
}

interface BottomPanelProps {
  /** Terminal sessions open as tabs. Never empty while the panel is open. */
  tabs: BottomTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  /** Close one session. Closing the last one closes the panel. */
  onCloseTab: (id: string) => void;
  /** Dismiss the whole panel, keeping its sessions for next time. */
  onClose: () => void;
  children: React.ReactNode;
}

const ICON_BUTTON =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink-strong active:bg-surface-3";

/**
 * The bottom dock: terminals live here rather than in the right-hand tools
 * column, because a shell wants the window's full width and the editor views
 * beside it want their own.
 *
 * The panel is a sibling of the workbench row, so opening it shortens the chat
 * and the tools dock together instead of overlaying either.
 */
export function BottomPanel({
  tabs,
  activeId,
  onSelect,
  onAdd,
  onCloseTab,
  onClose,
  children,
}: BottomPanelProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface-0">
      <div className="flex h-10 shrink-0 select-none items-center gap-1 border-b border-line px-1.5">
        <div
          role="tablist"
          aria-label="Terminals"
          className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)]"
        >
          {tabs.map((tab) => {
            const selected = tab.id === activeId;
            const closable = tab.kind !== "console";
            const Icon = tab.kind === "console" ? TerminalIcon : SquareTerminal;
            return (
              <div
                key={tab.id}
                className={`group relative flex shrink-0 items-center rounded-md transition-colors ${
                  selected ? "bg-surface-2 shadow-[inset_0_0_0_1px_var(--line-strong)]" : "hover:bg-surface-2"
                }`}
              >
                <button
                  role="tab"
                  type="button"
                  aria-selected={selected}
                  onClick={() => onSelect(tab.id)}
                  className={`inline-flex min-w-0 items-center gap-1.5 rounded-md py-1 pl-2.5 text-[11.5px] ${closable ? "pr-1" : "pr-2.5"} font-medium transition-colors ${
                    selected ? "text-ink-strong" : "text-ink-subtle group-hover:text-ink"
                  }`}
                >
                  <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
                  <span className="max-w-[140px] truncate">{tab.title}</span>
                  {tab.badge ? (
                    <span className="ml-0.5 shrink-0 rounded-full border border-danger-soft/40 bg-danger-soft/15 px-1.5 py-px text-[9px] font-bold tabular-nums text-danger-soft">
                      {tab.badge}
                    </span>
                  ) : null}
                </button>
                {closable ? (
                <button
                  type="button"
                  aria-label={`Close ${tab.title} terminal`}
                  onClick={() => onCloseTab(tab.id)}
                  // Reserved space revealed on hover, so the strip does not
                  // reflow under the pointer as it arrives.
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

        <button type="button" aria-label="New terminal" onClick={onAdd} className={ICON_BUTTON}>
          <Plus aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.9} />
        </button>
        <button type="button" aria-label="Close terminal panel" onClick={onClose} className={ICON_BUTTON}>
          <X aria-hidden className="h-[15px] w-[15px]" strokeWidth={1.9} />
        </button>
      </div>

      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
