import type { ModelList } from "../../lib/types";

interface TitleBarProps {
  projectTitle: string;
  modelList: ModelList | null;
  onToggleSidebar: () => void;
  onToggleAgent: () => void;
}

/**
 * Top chrome: window dots, wordmark, active game, active model.
 * Mirrors the 44px header in the CaliCode design language.
 */
export function TitleBar({ projectTitle, modelList, onToggleSidebar, onToggleAgent }: TitleBarProps) {
  const provider = modelList?.active.provider ?? "OFFLINE";
  const model = modelList?.active.model ?? "NO MODEL";

  return (
    <header className="flex h-11 shrink-0 items-center gap-3.5 border-b border-white/[0.06] bg-[#0c0c0c] px-4">
      {/* Below md the games rail leaves the layout; this opens it as a drawer. */}
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label="Toggle games sidebar"
        className="shrink-0 rounded border border-white/10 px-2 py-1 text-[11px] text-[#9a9a9a] hover:border-white/30 md:hidden"
      >
        ☰
      </button>
      <div aria-hidden className="hidden gap-2 sm:flex">
        <span className="h-[11px] w-[11px] rounded-full bg-[#2e2e2e]" />
        <span className="h-[11px] w-[11px] rounded-full bg-[#2e2e2e]" />
        <span className="h-[11px] w-[11px] rounded-full bg-[#2e2e2e]" />
      </div>
      <h1 className="font-display text-sm font-extrabold tracking-[0.32em] text-[#d6d6d6]">CALICODE</h1>
      <span className="hidden min-w-0 items-center gap-3.5 sm:flex">
        <span className="text-[#6f6f6f]">/</span>
        <span className="truncate text-xs uppercase tracking-[0.12em] text-[#828282]">{projectTitle}</span>
      </span>
      <div className="ml-auto flex items-center gap-3">
        {/* data-active-model: masked in visual snapshots — depends on
            whichever provider the machine has configured. */}
        <span
          data-active-model
          className="hidden text-[11px] uppercase tracking-[0.14em] text-[#949494] md:inline"
        >
          {provider} · {model}
        </span>
        {/* Below lg the agent column leaves the layout; this opens it as a drawer. */}
        <button
          type="button"
          onClick={onToggleAgent}
          aria-label="Toggle agent panel"
          className="shrink-0 rounded border border-white/10 px-2 py-1 text-[11px] tracking-[0.1em] text-[#9a9a9a] hover:border-white/30 lg:hidden"
        >
          AGENT
        </button>
      </div>
    </header>
  );
}
