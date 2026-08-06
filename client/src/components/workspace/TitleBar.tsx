import type { ModelList } from "../../lib/types";

interface TitleBarProps {
  projectTitle: string;
  modelList: ModelList | null;
}

/**
 * Top chrome: window dots, wordmark, active game, active model.
 * Mirrors the 44px header in the CaliCode design language.
 */
export function TitleBar({ projectTitle, modelList }: TitleBarProps) {
  const provider = modelList?.active.provider ?? "OFFLINE";
  const model = modelList?.active.model ?? "NO MODEL";

  return (
    <header className="flex h-11 shrink-0 items-center gap-3.5 border-b border-white/[0.06] bg-[#0c0c0c] px-4">
      <div aria-hidden className="hidden gap-2 sm:flex">
        <span className="h-[11px] w-[11px] rounded-full bg-[#2e2e2e]" />
        <span className="h-[11px] w-[11px] rounded-full bg-[#2e2e2e]" />
        <span className="h-[11px] w-[11px] rounded-full bg-[#2e2e2e]" />
      </div>
      <h1 className="font-display text-sm font-extrabold tracking-[0.32em] text-[#d6d6d6]">CALICODE</h1>
      <span className="hidden min-w-0 items-center gap-3.5 sm:flex">
        <span className="text-[#3a3a3a]">/</span>
        <span className="truncate text-xs uppercase tracking-[0.12em] text-[#828282]">{projectTitle}</span>
      </span>
      <div className="ml-auto flex items-center gap-3">
        <span className="hidden text-[11px] uppercase tracking-[0.14em] text-[#616161] md:inline">
          {provider} · {model}
        </span>
        <span aria-hidden className="inline-block h-5 w-6 rounded border border-white/[0.14]" />
      </div>
    </header>
  );
}
