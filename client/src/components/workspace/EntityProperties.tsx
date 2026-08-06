import { useState } from "react";
import type { Entity, Vec3 } from "../../lib/types";

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
  if (!entity) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-[#8f8f8f]">
        Select a node to edit its transform and material.
      </div>
    );
  }
  return <PropertiesForm key={entity.id} entity={entity} onChange={onChange} onRemove={onRemove} />;
}

function PropertiesForm({ entity, onChange, onRemove }: EntityPropertiesProps & { entity: Entity }) {
  const [name, setName] = useState(entity.name);

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

      <label className="mb-1 block text-[10.5px] text-[#8f8f8f]" htmlFor="entity-name">
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
        className="mb-3.5 w-full rounded-md border border-white/10 bg-[#101010] px-2.5 py-1.5 text-xs text-[#d0d0d0] outline-none focus-visible:border-white/30"
      />

      {(
        [
          ["position", "Position", 0.1],
          ["rotation", "Rotation", 0.05],
          ["scale", "Scale", 0.1],
        ] as const
      ).map(([key, label, step]) => (
        <div key={key} className="mb-3">
          <div className="mb-1 text-[10.5px] text-[#8f8f8f]">{label}</div>
          <div className="grid grid-cols-3 gap-1.5">
            {(["X", "Y", "Z"] as const).map((axisLabel, axis) => (
              <input
                key={axisLabel}
                type="number"
                step={step}
                aria-label={`${label} ${axisLabel}`}
                value={entity.transform[key][axis as 0 | 1 | 2]}
                onChange={(event) => setVec(key, axis as 0 | 1 | 2, Number(event.target.value))}
                className="w-full rounded-md border border-white/10 bg-[#101010] px-2 py-1.5 text-xs text-[#d0d0d0] outline-none focus-visible:border-white/30"
              />
            ))}
          </div>
        </div>
      ))}

      <div className="mb-1 text-[10.5px] text-[#8f8f8f]">Material</div>
      <div className="mb-3.5 grid grid-cols-3 gap-1.5">
        <input
          type="color"
          aria-label="Colour"
          value={color}
          onChange={(event) => onChange({ material: { ...material, color: event.target.value } })}
          className="h-[30px] w-full rounded-md border border-white/10 bg-[#101010] p-1 outline-none focus-visible:border-white/30"
        />
        <input
          type="number"
          step={0.05}
          min={0}
          max={1}
          aria-label="Metalness"
          value={metalness}
          onChange={(event) => onChange({ material: { ...material, metalness: Number(event.target.value) } })}
          className="w-full rounded-md border border-white/10 bg-[#101010] px-2 py-1.5 text-xs text-[#d0d0d0] outline-none focus-visible:border-white/30"
        />
        <input
          type="number"
          step={0.05}
          min={0}
          max={1}
          aria-label="Roughness"
          value={roughness}
          onChange={(event) => onChange({ material: { ...material, roughness: Number(event.target.value) } })}
          className="w-full rounded-md border border-white/10 bg-[#101010] px-2 py-1.5 text-xs text-[#d0d0d0] outline-none focus-visible:border-white/30"
        />
      </div>

      <button
        type="button"
        onClick={() => onRemove(entity.id)}
        className="mt-auto rounded-md border border-white/10 py-2 text-[11px] tracking-[0.14em] text-[#8f8f8f] hover:border-[#c98b8b]/50 hover:text-[#c98b8b]"
      >
        DELETE ENTITY
      </button>
    </div>
  );
}
