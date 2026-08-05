import { Box, Lightbulb, Plus, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../ui/utils";
import type { Entity } from "../../lib/types";

interface SceneGraphProps {
  entities: Entity[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}

export function SceneGraph({ entities, selectedId, onSelect, onAdd, onRemove }: SceneGraphProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
        <span className="text-[11px] font-bold tracking-[0.16em] text-[#dcdcdc]">Scene Graph</span>
        <Button variant="ghost" size="icon" aria-label="Add entity" onClick={onAdd}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {entities.length === 0 ? (
          <p className="px-2 py-3 text-xs text-[#616161]">No entities yet. Add one to start building.</p>
        ) : (
          entities.map((entity) => (
            <div
              key={entity.id}
              className={cn(
                "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[#171717]",
                selectedId === entity.id && "bg-[#171717] text-[#e0e0e0]",
              )}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => onSelect(entity.id)}
              >
                {entity.kind === "light" ? (
                  <Lightbulb className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <Box className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{entity.name}</span>
              </button>
              <button
                className="hidden rounded p-0.5 text-muted-foreground hover:bg-border group-hover:block"
                aria-label={`Remove ${entity.name}`}
                onClick={() => onRemove(entity.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
