import { useEffect, useRef } from "react";
import {
  Box,
  CircleHelp,
  Eraser,
  FileDiff,
  GaugeCircle,
  GitFork,
  History,
  LayoutTemplate,
  MessageSquare,
  MessagesSquare,
  Minimize2,
  Play,
  PlusCircle,
  Repeat,
  RotateCcw,
  Sparkles,
  Square,
  Target,
  Users,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { commandLabel, type NamedCommand } from "../../lib/slashCommands";

export interface SlashMenuProps<Command extends NamedCommand> {
  commands: readonly Command[];
  /** Index of the row Enter/Tab would complete. */
  activeIndex: number;
  onPick: (name: string) => void;
}

// Icons live here rather than on the command definitions so lib/slashCommands
// stays free of React — it is imported by tests and by the side chat, and a
// component import would drag the icon set into both.
const ICONS: Record<string, LucideIcon> = {
  help: CircleHelp,
  loop: Repeat,
  model: Box,
  spawn: Users,
  side: MessageSquare,
  graph: Workflow,
  "graph-template": LayoutTemplate,
  "graph-stop": Square,
  goal: Target,
  compact: Minimize2,
  usage: GaugeCircle,
  diff: FileDiff,
  checkpoints: History,
  restore: RotateCcw,
  sessions: MessagesSquare,
  resume: Play,
  fork: GitFork,
  clear: Eraser,
  new: PlusCircle,
  close: X,
};

/**
 * The autocomplete list above a composer. Shared so the agent panel and the
 * side chat complete commands the same way; each supplies its own set.
 *
 * Rows read as sentences — icon, name, then what it does — rather than as a
 * slug plus an argument grammar. The usage string still exists for `/help`,
 * which is where you go to learn the arguments; here it would be noise on
 * every row and push the summary out of alignment.
 */
export function SlashMenu<Command extends NamedCommand>({
  commands,
  activeIndex,
  onPick,
}: SlashMenuProps<Command>) {
  const activeRef = useRef<HTMLButtonElement>(null);
  // With skills in the list this scrolls, so keyboard selection has to drag
  // the viewport along or the highlight walks off the bottom.
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  return (
    // `bg-popover`, not `bg-raised`: popover is the extreme of each theme
    // (white / 5%), so the `surface-2` selection fill reads as a highlight in
    // both. On `raised` the dark selection came out darker than its own card.
    <div className="mb-2 max-h-[320px] overflow-y-auto overscroll-contain rounded-xl border border-line bg-popover p-1.5">
      {commands.map((command, index) => {
        const Icon = ICONS[command.name] ?? (command.kind === "skill" ? Sparkles : CircleHelp);
        const active = index === activeIndex;
        return (
          <button
            key={command.name}
            ref={active ? activeRef : undefined}
            type="button"
            // mousedown, not click: the composer must keep focus, or the menu
            // closes on blur before the click lands.
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(command.name);
            }}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left transition-colors ${
              active ? "bg-surface-2" : "hover:bg-surface-2"
            }`}
          >
            <Icon size={15} strokeWidth={1.7} className="shrink-0 text-ink-subtle" aria-hidden />
            <span className="shrink-0 text-[13px] leading-none text-ink-strong">
              {commandLabel(command)}
            </span>
            <span className="ml-auto min-w-0 truncate text-right text-[12px] leading-none text-ink-faint">
              {command.summary}
            </span>
          </button>
        );
      })}
    </div>
  );
}
