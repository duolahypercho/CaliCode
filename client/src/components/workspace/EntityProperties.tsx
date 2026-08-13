import { useEffect, useRef, useState, type RefObject } from "react";
import type { Entity, Vec3 } from "../../lib/types";
import { ConfirmDialog } from "./ConfirmDialog";

interface EntityPropertiesProps {
  entity: Entity | null;
  onChange: (patch: Partial<Entity>) => void;
  onRemove: (id: string) => void;
}

/**
 * Numeric editing for the selected entity.
 *
 * The previous inspector seeded its form on first render — when nothing was
 * selected — and hydrated a tick later, so anything typed in that window was
 * silently overwritten. This keys the whole form on the entity id, so a fresh
 * component mounts already holding the right values and there is no
 * hydration window at all.
 */
export function EntityProperties({ entity, onChange, onRemove }: EntityPropertiesProps) {
  // Deleting the selected entity unmounts the whole form, DELETE button
  // included, so there is nothing left for Radix to return focus to. The empty
  // state is the one node that survives the removal and it is already the
  // panel's new content — send focus there so the keyboard stays in the
  // inspector and a screen reader hears why the form went away.
  const emptyStateRef = useRef<HTMLDivElement>(null);

  if (!entity) {
    return (
      <div
        ref={emptyStateRef}
        tabIndex={-1}
        className="focus-ring-inset flex h-full items-center justify-center px-4 text-center text-xs text-ink-subtle"
      >
        Select a node to edit its transform and material.
      </div>
    );
  }
  return (
    <PropertiesForm
      key={entity.id}
      entity={entity}
      onChange={onChange}
      onRemove={onRemove}
      returnFocusRef={emptyStateRef}
    />
  );
}

function PropertiesForm({
  entity,
  onChange,
  onRemove,
  returnFocusRef,
}: EntityPropertiesProps & { entity: Entity; returnFocusRef: RefObject<HTMLDivElement | null> }) {
  const [name, setName] = useState(entity.name);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const material = entity.material as Record<string, unknown>;
  const color = String(material.color ?? "#6b7280");
  const metalness = Number(material.metalness ?? 0.1);
  const roughness = Number(material.roughness ?? 0.7);

  const setVec = (key: "position" | "rotation" | "scale", axis: 0 | 1 | 2, value: number) => {
    const next = [...entity.transform[key]] as Vec3;
    next[axis] = value;
    onChange({ transform: { ...entity.transform, [key]: next } });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3.5">
      <div className="calicode-label mb-2.5">Properties</div>

      <label className="mb-1 block text-[10.5px] text-ink-subtle" htmlFor="entity-name">
        Name
      </label>
      <input
        id="entity-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => name.trim() && name !== entity.name && onChange({ name: name.trim() })}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="focus-ring-inset mb-3.5 w-full rounded-md border border-line bg-surface-1 px-2.5 py-1.5 text-xs text-ink-strong transition-colors focus:border-ink-faint"
      />

      {(
        [
          ["position", "Position", 0.1],
          ["rotation", "Rotation", 0.05],
          ["scale", "Scale", 0.1],
        ] as const
      ).map(([key, label, step]) => (
        <div key={key} className="mb-3">
          <div className="mb-1 text-[10.5px] text-ink-subtle">{label}</div>
          <div className="grid grid-cols-3 gap-1.5">
            {(["X", "Y", "Z"] as const).map((axisLabel, axis) => (
              <NumericField
                key={axisLabel}
                step={step}
                aria-label={`${label} ${axisLabel}`}
                value={entity.transform[key][axis as 0 | 1 | 2]}
                onCommit={(value) => setVec(key, axis as 0 | 1 | 2, value)}
                className="focus-ring-inset w-full rounded-md border border-line bg-surface-1 px-2 py-1.5 text-xs text-ink-strong transition-colors focus:border-ink-faint"
              />
            ))}
          </div>
        </div>
      ))}

      <div className="mb-1 text-[10.5px] text-ink-subtle">Material</div>
      <div className="mb-3.5 grid grid-cols-3 gap-1.5">
        <input
          type="color"
          aria-label="Colour"
          value={color}
          onChange={(event) => onChange({ material: { ...material, color: event.target.value } })}
          className="focus-ring-inset h-[30px] w-full rounded-md border border-line bg-surface-1 p-1 transition-colors focus:border-ink-faint"
        />
        <NumericField
          step={0.05}
          min={0}
          max={1}
          aria-label="Metalness"
          value={metalness}
          onCommit={(value) => onChange({ material: { ...material, metalness: value } })}
          className="focus-ring-inset w-full rounded-md border border-line bg-surface-1 px-2 py-1.5 text-xs text-ink-strong transition-colors focus:border-ink-faint"
        />
        <NumericField
          step={0.05}
          min={0}
          max={1}
          aria-label="Roughness"
          value={roughness}
          onCommit={(value) => onChange({ material: { ...material, roughness: value } })}
          className="focus-ring-inset w-full rounded-md border border-line bg-surface-1 px-2 py-1.5 text-xs text-ink-strong transition-colors focus:border-ink-faint"
        />
      </div>

      <button
        type="button"
        onClick={() => setConfirmingRemove(true)}
        className="mt-auto rounded-md border border-line py-2 text-[11px] tracking-[0.14em] text-ink-subtle transition-colors hover:text-danger-soft active:border-danger-soft"
      >
        DELETE ENTITY
      </button>

      {/* The scene document has no undo, so the node's scripts and material
          are gone the moment this lands — say so first. */}
      <ConfirmDialog
        open={confirmingRemove}
        title={`Delete ${entity.name}?`}
        description={describeEntityRemoval(entity)}
        confirmLabel="Delete entity"
        onConfirm={() => {
          setConfirmingRemove(false);
          onRemove(entity.id);
        }}
        onOpenChange={setConfirmingRemove}
        returnFocusRef={returnFocusRef}
      />
    </div>
  );
}

function describeEntityRemoval(entity: Entity): string {
  const scripts = entity.scriptIds.length;
  const attached =
    scripts === 0
      ? ""
      : scripts === 1
        ? " Its script stays in the game but stops running."
        : ` Its ${scripts} scripts stay in the game but stop running.`;
  return `It leaves the scene with its transform and material.${attached} This cannot be undone.`;
}

interface NumericFieldProps {
  value: number;
  step: number;
  min?: number;
  max?: number;
  "aria-label": string;
  className: string;
  onCommit: (value: number) => void;
}

/**
 * Keep the text the user is typing separate from the project number.
 *
 * A controlled `type="number"` input cannot represent intermediate values such
 * as `-` or `1.`: the browser sanitizes them, and converting every change with
 * `Number()` commits `NaN` or collapses the decimal before the next keystroke.
 * Text input plus decimal keyboard hints preserves those states until blur or
 * until a complete finite number is available.
 */
function NumericField({ value, step, min, max, onCommit, ...props }: NumericFieldProps) {
  const [draft, setDraft] = useState(() => formatNumber(value));
  const [dirty, setDirty] = useState(false);
  const lastCommittedDraft = useRef<string | null>(null);

  useEffect(() => {
    if (!dirty) {
      setDraft(formatNumber(value));
      lastCommittedDraft.current = null;
    }
  }, [value]);

  const clamp = (next: number) => {
    if (min !== undefined && next < min) return min;
    if (max !== undefined && next > max) return max;
    return next;
  };

  const parse = (raw: string): number | null => {
    const trimmed = raw.trim();
    // Accept decimal/exponent forms but leave a lone sign, trailing exponent,
    // or empty string as an editable intermediate state.
    if (!/^[+-]?(?:(?:\d+(?:\.\d+)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? clamp(parsed) : null;
  };

  const commit = (raw: string): number | null => {
    const parsed = parse(raw);
    if (parsed === null) return null;
    if (raw === lastCommittedDraft.current) return parsed;
    lastCommittedDraft.current = raw;
    onCommit(parsed);
    return parsed;
  };

  return (
    <input
      {...props}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      data-numeric-input
      data-step={step}
      value={draft}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        setDirty(true);
        commit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          const committed = commit(draft);
          setDraft(formatNumber(committed ?? value));
          setDirty(false);
          event.currentTarget.blur();
          return;
        }
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const current = parse(draft) ?? value;
        const next = clamp(current + (event.key === "ArrowUp" ? step : -step));
        setDraft(formatNumber(next));
        setDirty(true);
        commit(formatNumber(next));
      }}
      onBlur={() => {
        const committed = commit(draft);
        setDraft(formatNumber(committed ?? value));
        setDirty(false);
      }}
    />
  );
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}
