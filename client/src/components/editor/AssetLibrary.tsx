import { useMemo, useState } from "react";
import { Copy, Download, Search, Trash2 } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import type { Asset, Entity } from "../../lib/types";

interface AssetLibraryProps {
  assets: Asset[];
  entities: Entity[];
  onPromote: (asset: Asset) => void;
  onRemove: (assetId: string) => void;
  onDedupe: () => void;
  onSearch: (query: string) => void;
  search: string;
}

export function AssetLibrary({ assets, entities, onPromote, onRemove, onDedupe, onSearch, search }: AssetLibraryProps) {
  const usageCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entity of entities) {
      if (entity.assetId) counts.set(entity.assetId, (counts.get(entity.assetId) ?? 0) + 1);
    }
    return counts;
  }, [entities]);
  const filtered = assets.filter((asset) => asset.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium">Asset Library</span>
        <div className="flex-1" />
        <Button variant="ghost" size="icon" aria-label="Find duplicates" onClick={onDedupe}>
          <Copy className="h-4 w-4" />
        </Button>
      </div>
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input className="pl-7" placeholder="Search assets" value={search} onChange={(event) => onSearch(event.target.value)} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground">No assets match. Generate or import one in the workbench.</p>
        ) : (
          filtered.map((asset) => (
            <div key={asset.id} className="mb-2 flex items-start gap-2 rounded-md border border-border p-2">
              {asset.thumbnail ? (
                <img src={asset.thumbnail} alt="" className="h-12 w-12 rounded object-cover" />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded bg-muted text-xs text-muted-foreground">
                  {asset.type}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{asset.name}</span>
                  <Badge>{asset.type}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Used by {usageCount.get(asset.id) ?? 0} entities
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {asset.tags.slice(0, 4).map((tag) => (
                    <Badge key={tag} className="bg-muted text-muted-foreground">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="secondary" size="icon" aria-label={`Promote ${asset.name}`} onClick={() => onPromote(asset)}>
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Promote to scene</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={`Remove ${asset.name}`} onClick={() => onRemove(asset.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Remove asset</TooltipContent>
                </Tooltip>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
