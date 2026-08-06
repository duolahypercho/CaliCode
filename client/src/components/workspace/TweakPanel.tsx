import type { Entity } from "../../lib/types";

export interface TweakControl {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (value: number) => void;
}

interface TweakPanelProps {
  title: string;
  controls: TweakControl[];
  onClose: () => void;
}

/** Floating live-tweak inspector shown over the PLAY viewport. */
export function TweakPanel({ title, controls, onClose }: TweakPanelProps) {
  return (
    <div className="absolute bottom-3.5 right-3.5 z-10 w-[242px] rounded-lg border border-white/[0.16] bg-[#0c0c0c]/95 p-3.5 backdrop-blur">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#dadada]">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close tweak panel"
          className="ml-auto h-5 w-5 rounded border border-white/[0.12] text-[11px] leading-none text-[#828282] hover:text-[#d0d0d0]"
        >
          ✕
        </button>
      </div>
      <div className="flex flex-col gap-3">
        {controls.length === 0 ? (
          <p className="text-[11px] text-[#8f8f8f]">Nothing to tweak here yet.</p>
        ) : (
          controls.map((control) => (
            <div key={control.key}>
              <div className="mb-1.5 flex justify-between text-[10.5px]">
                <label htmlFor={`tweak-${control.key}`} className="text-[#8f8f8f]">
                  {control.label}
                </label>
                <span className="text-[#d4d4d4]">{control.display}</span>
              </div>
              <input
                id={`tweak-${control.key}`}
                type="range"
                min={control.min}
                max={control.max}
                step={control.step}
                value={control.value}
                onChange={(event) => control.onChange(Number(event.target.value))}
                className="h-[3px] w-full accent-[#9a9a9a]"
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Derives live-tweak controls for an entity: transform height, uniform scale,
 * and PBR material response. Each control writes straight back to the project
 * so the running PIE viewport reflects the change on the next frame.
 */
export function entityTweakControls(entity: Entity, onPatch: (patch: Partial<Entity>) => void): TweakControl[] {
  const [x, y, z] = entity.transform.position;
  const scale = entity.transform.scale[0];
  const metalness = Number(entity.material.metalness ?? 0.1);
  const roughness = Number(entity.material.roughness ?? 0.7);

  return [
    {
      key: "height",
      label: "Height",
      min: -5,
      max: 10,
      step: 0.1,
      value: y,
      display: y.toFixed(1),
      onChange: (value) => onPatch({ transform: { ...entity.transform, position: [x, value, z] } }),
    },
    {
      key: "scale",
      label: "Scale",
      min: 0.1,
      max: 5,
      step: 0.1,
      value: scale,
      display: `${scale.toFixed(1)}×`,
      onChange: (value) => onPatch({ transform: { ...entity.transform, scale: [value, value, value] } }),
    },
    {
      key: "metalness",
      label: "Metalness",
      min: 0,
      max: 1,
      step: 0.05,
      value: metalness,
      display: metalness.toFixed(2),
      onChange: (value) => onPatch({ material: { ...entity.material, metalness: value } }),
    },
    {
      key: "roughness",
      label: "Roughness",
      min: 0,
      max: 1,
      step: 0.05,
      value: roughness,
      display: roughness.toFixed(2),
      onChange: (value) => onPatch({ material: { ...entity.material, roughness: value } }),
    },
  ];
}
