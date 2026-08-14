import { useEffect, useRef } from "react";
import type { NamedCommand } from "../../lib/slashCommands";

export interface SlashMenuProps<Command extends NamedCommand> {
  commands: readonly Command[];
  /** Index of the row Enter/Tab would complete. */
  activeIndex: number;
  onPick: (name: string) => void;
}

/**
 * The autocomplete list above a composer. Shared so the agent panel and the
 * side chat complete commands the same way; each supplies its own set.
 */
export function SlashMenu<Command extends NamedCommand>({ commands, activeIndex, onPick }: SlashMenuProps<Command>) {
  const activeRef = useRef<HTMLButtonElement>(null);
  // With skills in the list this scrolls, so keyboard selection has to drag
  // the viewport along or the highlight walks off the bottom.
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="mb-2 max-h-[280px] overflow-y-auto overscroll-contain rounded-[10px] border border-line-strong bg-popover">
      {commands.map((command, index) => (
        <button
          key={command.name}
          ref={index === activeIndex ? activeRef : undefined}
          type="button"
          // mousedown, not click: the composer must keep focus, or the menu
          // closes on blur before the click lands.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(command.name);
          }}
          className={`flex min-h-[28px] w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs transition-colors active:bg-surface-3 ${
            index === activeIndex ? "bg-surface-2" : "hover:bg-surface-2"
          }`}
        >
          <span className="font-mono text-ink-strong">/{command.name}</span>
          {command.usage && <span className="font-mono text-[10px] text-ink-faint">{command.usage}</span>}
          {command.kind === "skill" && (
            <span className="rounded-[4px] bg-surface-3 px-1 text-[9px] uppercase tracking-[0.08em] text-ink-faint">
              skill
            </span>
          )}
          <span className="ml-auto truncate text-ink-subtle">{command.summary}</span>
        </button>
      ))}
    </div>
  );
}
