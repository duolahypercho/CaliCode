import { useMemo, useState } from "react";
import { Box, Download, ImagePlus, SlidersHorizontal } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { AssetPreview, type PreviewParams } from "./AssetPreview";
import type { Asset } from "../../lib/types";

const GENERATORS = ["box", "sphere", "cylinder", "cone", "torus", "terrain", "plane"] as const;

interface AssetWorkbenchProps {
  onAddAsset: (asset: Partial<Asset>) => Asset | null;
  onPromote: (assetId: string) => void;
  onImportImage: (file: File) => void;
}

export function AssetWorkbench({ onAddAsset, onPromote, onImportImage }: AssetWorkbenchProps) {
  const [kind, setKind] = useState<string>("box");
  const [params, setParams] = useState<PreviewParams>({ width: 1, height: 1, depth: 1, color: "#f97316", metalness: 0.2, roughness: 0.45, seed: 7 });
  const [assetId, setAssetId] = useState<string | null>(null);

  const generated = useMemo(() => ({ kind, params }), [kind, params]);

  const createAsset = () => {
    const asset: Partial<Asset> = {
      name: `${kind[0].toUpperCase()}${kind.slice(1)} Asset`,
      type: "procedural",
      source: `procedural:${kind}`,
      tags: [kind, "workbench"],
      metadata: { generator: kind, ...params },
    };
    const added = onAddAsset(asset);
    setAssetId(added?.id ?? null);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-medium">Asset Workbench</span>
        <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
      </div>
      <Tabs defaultValue="generate" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="px-2">
          <TabsTrigger value="generate">Generate</TabsTrigger>
          <TabsTrigger value="import">Import</TabsTrigger>
        </TabsList>
        <TabsContent value="generate" className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <Label>Primitive</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GENERATORS.map((generator) => (
                    <SelectItem key={generator} value={generator}>
                      {generator}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Width</Label>
              <Input type="number" step="0.1" value={params.width} onChange={(event) => setParams({ ...params, width: Number(event.target.value) })} />
            </div>
            <div>
              <Label>Height</Label>
              <Input type="number" step="0.1" value={params.height} onChange={(event) => setParams({ ...params, height: Number(event.target.value) })} />
            </div>
            <div>
              <Label>Depth</Label>
              <Input type="number" step="0.1" value={params.depth} onChange={(event) => setParams({ ...params, depth: Number(event.target.value) })} />
            </div>
            <div>
              <Label>Color</Label>
              <Input type="color" value={params.color} onChange={(event) => setParams({ ...params, color: event.target.value })} />
            </div>
            <div>
              <Label>Metal</Label>
              <Input type="number" step="0.05" value={params.metalness} onChange={(event) => setParams({ ...params, metalness: Number(event.target.value) })} />
            </div>
            <div>
              <Label>Rough</Label>
              <Input type="number" step="0.05" value={params.roughness} onChange={(event) => setParams({ ...params, roughness: Number(event.target.value) })} />
            </div>
          </div>
          <div className="h-40 overflow-hidden rounded-md border border-border">
            <AssetPreview kind={generated.kind} params={generated.params} />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={createAsset}>
              <Box className="h-3.5 w-3.5" />
              Add to library
            </Button>
            <Button size="sm" variant="secondary" disabled={!assetId} onClick={() => assetId && onPromote(assetId)}>
              <Download className="h-3.5 w-3.5" />
              Promote to scene
            </Button>
          </div>
        </TabsContent>
        <TabsContent value="import" className="p-3">
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground hover:bg-accent">
            <ImagePlus className="h-6 w-6" />
            Choose an image, glTF, OBJ, or JSON file
            <input
              type="file"
              className="hidden"
              accept=".png,.jpg,.jpeg,.glb,.gltf,.obj,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onImportImage(file);
              }}
            />
          </label>
        </TabsContent>
      </Tabs>
    </div>
  );
}
