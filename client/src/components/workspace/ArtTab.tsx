import { useEffect, useState } from "react";
import { assetObject, renderThumbnail } from "../../lib/procedural";
import { slugify, uid } from "../../lib/store";
import type { Asset, Entity } from "../../lib/types";
import { AssetPreview } from "./AssetPreview";

interface ArtTabProps {
  slug: string;
  theme: "dark" | "light";
  assets: Asset[];
  entities: Entity[];
  onGenerate: (assets: Asset[]) => void;
  onPromote: (assetId: string) => void;
  onRemove: (assetId: string) => void;
  onImportImage: (file: File) => Promise<Asset | null>;
  onLog: (message: string) => void;
  onPreviewAssetChange?: (asset: Asset | null) => void;
  /** Open the asset in the 3D asset builder (BUILD tab). */
  onEdit?: (assetId: string) => void;
}

/** Primitive shapes a generated batch varies across. */
const SHAPES = ["box", "sphere", "cylinder", "cone", "torus", "terrain"] as const;
const BATCH = 4;

/**
 * The design's ART surface: a prompt, a GENERATE batch, and a 4-column grid.
 *
 * Generation is real — each card is a procedural asset rendered to an actual
 * thumbnail through the same pipeline the workbench uses, added to the
 * project, and promotable into the scene. The prompt seeds shape, palette and
 * surface deterministically, so the same words produce the same batch.
 */
export function ArtTab({
  slug,
  theme,
  assets,
  entities,
  onGenerate,
  onPromote,
  onRemove,
  onImportImage,
  onLog,
  onPreviewAssetChange,
  onEdit,
}: ArtTabProps) {
  const [prompt, setPrompt] = useState("a hovering enemy drone with a glowing eye");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const generate = () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const base = hash(text);
      const created = Array.from({ length: BATCH }, (_, index) => {
        const seed = base + index * 977;
        const kind = SHAPES[seed % SHAPES.length];
        const asset: Asset = {
          id: uid("asset"),
          name: `${slugify(text).slice(0, 22) || "sprite"}-${index + 1}`,
          type: "procedural",
          source: `procedural:${kind}`,
          tags: ["generated", kind],
          usage: [],
          thumbnail: null,
          metadata: {
            generator: kind,
            prompt: text,
            seed,
            color: greyFromSeed(seed),
            metalness: ((seed >> 3) % 80) / 100,
            roughness: 0.25 + ((seed >> 5) % 60) / 100,
          },
        };
        return { ...asset, thumbnail: safeThumbnail(asset) };
      });
      onGenerate(created);
      onLog(`generated ${created.length} assets from "${text}"`);
    } finally {
      setBusy(false);
    }
  };

  const query = search.trim().toLowerCase();
  const visible = query
    ? assets.filter((asset) => asset.name.toLowerCase().includes(query) || asset.tags.some((tag) => tag.includes(query)))
    : assets;
  // Derived rather than stored, so removing the previewed asset closes the
  // panel instead of leaving it rendering a deleted spec.
  const previewAsset = assets.find((asset) => asset.id === previewId) ?? null;

  useEffect(() => {
    onPreviewAssetChange?.(previewAsset);
  }, [onPreviewAssetChange, previewAsset]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-[22px] py-[18px]">
      <div className="mb-1.5 flex flex-wrap items-center gap-3">
        <span className="font-display text-[15px] font-bold text-ink-strong">Sprite generator</span>
        <span className="text-[11px] tracking-[0.06em] text-ink-subtle">PROCEDURAL · SEEDED · MONOCHROME</span>
      </div>

      <div className="mb-[18px] mt-2.5 flex flex-wrap gap-2.5">
        <div className="flex min-w-[240px] flex-1 items-center rounded-lg border border-line bg-surface-1 px-3.5 py-2.5 transition-colors focus-within:border-ink-faint">
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") generate();
            }}
            aria-label="Sprite prompt"
            placeholder="a hovering enemy drone with a glowing eye"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-strong outline-none placeholder:text-ink-subtle"
          />
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={busy || !prompt.trim()}
          className="shrink-0 rounded-lg border border-line-strong bg-secondary px-[18px] text-[11px] font-bold tracking-[0.12em] text-ink-strong transition-colors hover:bg-secondary/80 active:bg-secondary/70 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-secondary"
        >
          {busy ? "GENERATING…" : `GENERATE ${BATCH}`}
        </button>
        <label className="inline-flex shrink-0 cursor-pointer items-center rounded-lg border border-line-strong px-[18px] py-2.5 text-[11px] tracking-[0.12em] text-ink transition-colors active:bg-surface-3">
          {importing ? "IMPORTING…" : "IMPORT"}
          <input
            type="file"
            accept="image/*,.blend,.glb,.gltf,.obj"
            disabled={importing}
            className="sr-only"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              setImporting(true);
              try {
                const imported = await onImportImage(file);
                if (imported) setPreviewId(imported.id);
              } finally {
                setImporting(false);
              }
            }}
          />
        </label>
      </div>

      <div className="mb-3 flex items-center gap-2 rounded-md border border-line bg-surface-1 px-2.5 py-[7px] transition-colors focus-within:border-ink-faint">
        <span aria-hidden className="text-ink-faint">
          /
        </span>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search assets"
          placeholder="search assets"
          className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-subtle"
        />
        <span className="shrink-0 text-[10px] text-ink-subtle">{visible.length}</span>
      </div>

      {previewAsset ? (
        <AssetPreview asset={previewAsset} slug={slug} theme={theme} onClose={() => setPreviewId(null)} />
      ) : null}

      {visible.length === 0 ? (
        <p className="text-xs text-ink-subtle">
          {assets.length === 0 ? "No assets yet — describe one above and generate." : "No assets match that search."}
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3.5">
          {visible.map((asset) => {
            const uses = entities.filter((entity) => entity.assetId === asset.id).length;
            return (
              <div key={asset.id} className="overflow-hidden rounded-[10px] border border-line bg-surface-1">
                {/* Rings rather than borders on the thumbnail: the card grid is
                    snapshotted by the visual suite, and a border would resize
                    every card by a pixel. */}
                <button
                  type="button"
                  onClick={() => setPreviewId((current) => (current === asset.id ? null : asset.id))}
                  aria-pressed={previewId === asset.id}
                  aria-label={`Preview ${asset.name}`}
                  className="flex h-[118px] w-full items-center justify-center bg-[repeating-linear-gradient(45deg,#141414,#141414_8px,#1c1c1c_8px,#1c1c1c_16px)] text-[#8f8f8f] transition-colors hover:text-[#dcdcdc] focus-visible:outline-none aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-white/40"
                >
                  {asset.thumbnail ? (
                    <img src={asset.thumbnail} alt="" className="h-full w-full object-contain" />
                  ) : (
                    <span className="text-[10px] tracking-[0.1em]">NO PREVIEW</span>
                  )}
                </button>
                <div className="flex items-center gap-2 px-2.5 py-2">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-ink-subtle" title={asset.name}>
                    {asset.name}
                  </span>
                  <span
                    className={`shrink-0 text-[10px] tracking-[0.08em] ${uses > 0 ? "text-ink-subtle" : "text-ink-faint"}`}
                  >
                    {uses > 0 ? `IN USE ${uses}` : "READY"}
                  </span>
                </div>
                <div className="flex gap-1.5 border-t border-line px-2.5 py-2">
                  <button
                    type="button"
                    onClick={() => onPromote(asset.id)}
                    aria-label={`Promote ${asset.name}`}
                    className="inline-flex min-h-[28px] flex-1 items-center justify-center rounded border border-line py-1 text-[10px] tracking-[0.1em] text-ink transition-colors active:border-ink-subtle focus-visible:outline-none"
                  >
                    PROMOTE
                  </button>
                  {onEdit ? (
                    <button
                      type="button"
                      onClick={() => onEdit(asset.id)}
                      aria-label={`Edit ${asset.name} in the builder`}
                      className="inline-flex min-h-[28px] items-center justify-center rounded border border-line px-2 py-1 text-[10px] tracking-[0.1em] text-ink transition-colors active:border-ink-subtle focus-visible:outline-none"
                    >
                      EDIT
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onRemove(asset.id)}
                    aria-label={`Remove ${asset.name}`}
                    className="inline-flex min-h-[28px] items-center justify-center rounded border border-line px-2 py-1 text-[10px] text-ink-subtle transition-colors hover:text-ink active:border-ink-subtle focus-visible:outline-none"
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Thumbnails need WebGL; a headless or context-exhausted browser must not break generation. */
function safeThumbnail(asset: Asset): string | null {
  try {
    return renderThumbnail(assetObject(asset));
  } catch {
    return null;
  }
}

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}

/** Keeps generated assets inside the monochrome design language. */
function greyFromSeed(seed: number): string {
  const level = 90 + (seed % 120);
  return `#${level.toString(16).padStart(2, "0").repeat(3)}`;
}
