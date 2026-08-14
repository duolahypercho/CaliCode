import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Zap } from "lucide-react";
import { defaultEffort, effortLevelsFor, type EffortIndex } from "../../lib/modelMeta";
import type { ModelList } from "../../lib/types";

export interface ModelChoice {
  /** `<provider>:<model>` — what the caller switches to. */
  value: string;
  /** The model id, shown as the row title and used for effort lookup. */
  label: string;
  hint: string;
}

/**
 * Configured models first, then what models.dev says the provider offers today
 * (newest release first) — capped so aggregators with hundreds of models don't
 * swamp the menu.
 */
export function buildModelChoices(
  modelList: ModelList | null,
  registryCatalog: Record<string, string[]> | null,
): ModelChoice[] {
  return (modelList?.providers ?? []).flatMap((provider) => {
    const configured = [
      ...(modelList?.active.provider === provider.id && modelList.active.model ? [modelList.active.model] : []),
      ...(provider.models ?? []),
    ];
    const fromRegistry = (registryCatalog?.[provider.id] ?? [])
      .filter((model) => !configured.includes(model))
      .slice(0, 24);
    const models = [...configured, ...fromRegistry].filter(
      (model, index, choices) => model && choices.indexOf(model) === index,
    );
    return models.map((model) => ({ value: `${provider.id}:${model}`, label: model, hint: provider.label }));
  });
}

export interface ModelPickerProps {
  choices: ModelChoice[];
  /** `<provider>:<model>` currently in force. */
  activeValue: string;
  /** Model id for the trigger; empty renders "No model". */
  activeLabel: string;
  /** Effort in force for the active model, if it has an effort control. */
  effort?: string;
  effortIndex: EffortIndex | null;
  /** Saved-or-default effort for a model; null when it has no effort control. */
  effortOf: (modelId: string) => string | null;
  disabled?: boolean;
  /** Accessible name. E2E specs bind to it, so callers own the wording. */
  label: string;
  title?: string;
  /** `effort` is null when the chosen model exposes no effort control. */
  onSelect: (value: string, effort: string | null) => void;
}

/**
 * Model + effort as one control: the trigger reads "model · effort" and sizes
 * to its text; each model in the menu opens an effort submenu on hover, so
 * picking an effort picks the model with it.
 *
 * Shared by the agent composer and the side chat so the two read as one
 * product — and so the side chat's own model pick behaves identically to the
 * one that moves the run.
 */
export function ModelPicker({
  choices,
  activeValue,
  activeLabel,
  effort,
  effortIndex,
  effortOf,
  disabled,
  label,
  title,
  onSelect,
}: ModelPickerProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled || choices.length === 0}
          title={title}
          className="ml-auto flex h-8 max-w-[320px] shrink items-center gap-1.5 rounded-full px-2 text-[10.5px] text-ink-subtle transition-colors enabled:hover:bg-surface-2 enabled:hover:text-ink disabled:opacity-50 data-[state=open]:bg-surface-2"
        >
          <Zap aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink" strokeWidth={1.8} />
          {/* In a narrow composer the model name is the first thing to go: the
              trigger collapses to the bolt icon alone (the title/aria-label
              still carry the full model). */}
          <span className="hidden min-w-0 truncate @[360px]:inline">
            {activeLabel ? `${activeLabel}${effort ? ` · ${effort}` : ""}` : "No model"}
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-h-[min(480px,60vh)] min-w-[300px] max-w-[420px] overflow-y-auto rounded-[14px] border border-line bg-popover p-1.5 text-[13px] text-popover-foreground shadow-[0_18px_45px_rgba(0,0,0,0.28)] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          {choices.map((choice) => {
            const active = choice.value === activeValue;
            const levels = effortLevelsFor(effortIndex, choice.label);
            const rowBody = (
              <>
                <Check
                  aria-hidden
                  className={`h-3.5 w-3.5 shrink-0 ${active ? "text-ink-strong" : "opacity-0"}`}
                  strokeWidth={2}
                />
                <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span className="max-w-full truncate font-mono text-[12.5px] leading-tight text-ink-strong">
                    {choice.label}
                  </span>
                  <span className="text-[10.5px] leading-tight text-ink-faint">{choice.hint}</span>
                </span>
              </>
            );
            // Registry says this model has no effort control: a plain row that
            // just switches the model.
            if (levels.length === 0) {
              return (
                <DropdownMenu.Item
                  key={choice.value}
                  onSelect={() => {
                    if (!active) onSelect(choice.value, null);
                  }}
                  className="flex min-h-8 w-full cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 outline-none transition-colors data-[highlighted]:bg-surface-2"
                >
                  {rowBody}
                </DropdownMenu.Item>
              );
            }
            const chosen = effortOf(choice.label);
            const modelEffort = chosen && levels.includes(chosen) ? chosen : defaultEffort(levels);
            return (
              <DropdownMenu.Sub key={choice.value}>
                <DropdownMenu.SubTrigger className="flex min-h-8 w-full cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 outline-none transition-colors data-[highlighted]:bg-surface-2 data-[state=open]:bg-surface-2">
                  {rowBody}
                  <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" strokeWidth={1.8} />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent
                    sideOffset={6}
                    collisionPadding={8}
                    className="z-50 min-w-[150px] rounded-[12px] border border-line bg-popover p-1 text-[12px] text-popover-foreground shadow-[0_18px_45px_rgba(0,0,0,0.28)] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
                  >
                    <DropdownMenu.Label className="px-2 py-1 text-[10px] font-medium text-ink-faint">
                      Reasoning effort
                    </DropdownMenu.Label>
                    {levels.map((level) => (
                      <DropdownMenu.Item
                        key={level}
                        onSelect={() => onSelect(choice.value, level)}
                        className="flex min-h-7 cursor-default select-none items-center gap-2 rounded-md px-2 py-1 capitalize outline-none transition-colors data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink-strong"
                      >
                        <Check
                          aria-hidden
                          className={`h-3 w-3 shrink-0 ${modelEffort === level ? "text-ink-strong" : "opacity-0"}`}
                          strokeWidth={2}
                        />
                        {level}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
