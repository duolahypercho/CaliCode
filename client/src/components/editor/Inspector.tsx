import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import type { Entity } from "../../lib/types";

const schema = z.object({
  name: z.string().min(1),
  px: z.coerce.number(),
  py: z.coerce.number(),
  pz: z.coerce.number(),
  rx: z.coerce.number(),
  ry: z.coerce.number(),
  rz: z.coerce.number(),
  sx: z.coerce.number(),
  sy: z.coerce.number(),
  sz: z.coerce.number(),
  color: z.string(),
  metalness: z.coerce.number().min(0).max(1),
  roughness: z.coerce.number().min(0).max(1),
});

type FormValues = z.infer<typeof schema>;

interface InspectorProps {
  entity: Entity | null;
  onSave: (entity: Entity) => void;
}

export function Inspector({ entity, onSave }: InspectorProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    // Seed from the entity on the very first render. Starting empty and
    // hydrating a tick later left a window in which anything typed was
    // overwritten by the reset below — the field visibly reverted and Apply
    // then saved the old value.
    defaultValues: entity ? toValues(entity) : emptyValues(),
  });

  // Reset only when the selection actually changes. `entity` is a fresh
  // object on every project update (the store is immutable), so depending on
  // its identity discarded in-progress edits on any unrelated scene change.
  const loadedId = useRef(entity?.id ?? null);
  useEffect(() => {
    if (entity && entity.id !== loadedId.current) {
      loadedId.current = entity.id;
      form.reset(toValues(entity));
    }
    if (!entity) loadedId.current = null;
  }, [entity, form]);
  if (!entity) {
    return <p className="px-3 py-3 text-xs text-muted-foreground">Select an entity to edit its transform and material.</p>;
  }
  return (
    <form
      className="grid gap-3 p-3"
      onSubmit={form.handleSubmit((values) => {
        onSave({
          ...entity,
          name: values.name,
          transform: {
            position: [values.px, values.py, values.pz],
            rotation: [values.rx, values.ry, values.rz],
            scale: [values.sx, values.sy, values.sz],
          },
          material: { ...entity.material, color: values.color, metalness: values.metalness, roughness: values.roughness },
        });
      })}
    >
      <div>
        <Label htmlFor="entity-name">Name</Label>
        <Input id="entity-name" {...form.register("name")} />
        {form.formState.errors.name && <p className="mt-1 text-xs text-destructive">{form.formState.errors.name.message}</p>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(["px", "py", "pz"] as const).map((key) => (
          <div key={key}>
            <Label htmlFor={key}>{key.toUpperCase()}</Label>
            <Input id={key} type="number" step="0.1" {...form.register(key)} />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(["rx", "ry", "rz"] as const).map((key) => (
          <div key={key}>
            <Label htmlFor={key}>{key.toUpperCase()}</Label>
            <Input id={key} type="number" step="0.05" {...form.register(key)} />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(["sx", "sy", "sz"] as const).map((key) => (
          <div key={key}>
            <Label htmlFor={key}>{key.toUpperCase()}</Label>
            <Input id={key} type="number" step="0.1" {...form.register(key)} />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-1">
          <Label htmlFor="color">Color</Label>
          <Input id="color" type="color" className="p-1" {...form.register("color")} />
        </div>
        <div>
          <Label htmlFor="metalness">Metal</Label>
          <Input id="metalness" type="number" step="0.05" {...form.register("metalness")} />
        </div>
        <div>
          <Label htmlFor="roughness">Rough</Label>
          <Input id="roughness" type="number" step="0.05" {...form.register("roughness")} />
        </div>
      </div>
      <Button type="submit" size="sm" className="justify-self-start">
        Apply
      </Button>
    </form>
  );
}

function emptyValues(): FormValues {
  return { name: "", px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, color: "#6b7280", metalness: 0.1, roughness: 0.7 };
}

function toValues(entity: Entity): FormValues {
  const [px, py, pz] = entity.transform.position;
  const [rx, ry, rz] = entity.transform.rotation;
  const [sx, sy, sz] = entity.transform.scale;
  return {
    name: entity.name,
    px,
    py,
    pz,
    rx,
    ry,
    rz,
    sx,
    sy,
    sz,
    color: String(entity.material.color ?? "#6b7280"),
    metalness: Number(entity.material.metalness ?? 0.1),
    roughness: Number(entity.material.roughness ?? 0.7),
  };
}

