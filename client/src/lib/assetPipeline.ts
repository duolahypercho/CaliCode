import { rpc } from "./rpc";

/**
 * Client-side composition of the core image-to-3D RPCs into a single flow:
 * ingest -> spec -> validate -> generate.
 *
 * The image provider is injected rather than imported so the pipeline stays
 * provider-agnostic (local model, hosted API, or a fake in tests).
 */

/** Mimes the core can decode on ingest. */
export const SUPPORTED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/jpg", "image/webp"] as const;

export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIMES)[number];

/** Produces a `data:` URL for a text prompt. Injected so it can be faked. */
export type ImageProvider = (prompt: string) => Promise<string>;

export interface ParsedDataUrl {
  mime: string;
  base64: string;
}

export interface IngestResult {
  assetId: string;
  name: string;
  sourceHash: string;
  width: number;
  height: number;
  admission: string;
  notes: string;
}

export interface CaliComponent {
  id: string;
  parent: string | null;
  name?: string;
  level?: string;
  topologyClass?: string;
  primitive?: string;
  dimensions?: Record<string, number>;
  transform?: {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
  };
}

export interface CaliMaterial {
  id: string;
  name?: string;
  pbr?: { baseColor?: string; metalness?: number; roughness?: number };
}

export interface CaliBuildPass {
  id: string;
  componentRefs: string[];
}

export interface CaliRuntime {
  pivots: { id: string; node: string; axis: [number, number, number] }[];
  sockets: unknown[];
  colliders: { id: string; node: string; kind: string }[];
  destructionGroups: unknown[];
}

/** The `.cali` spec shape produced by `image3d_spec`. */
export interface CaliSpec {
  schemaVersion: string;
  targetName: string;
  sourceHash: string;
  suitability: string;
  silhouette: { width: number; height: number; anchor: string };
  componentTree: CaliComponent[];
  materials: CaliMaterial[];
  proceduralStrategy: string[];
  runtime: CaliRuntime;
  buildPasses: CaliBuildPass[];
  reviewHistory: unknown[];
  /** Set by the pipeline so the generated asset keeps the ingested source image. */
  assetId?: string;
  seed?: number;
}

/** The `.cali` asset written by `image3d_generate`. */
export interface CaliAsset {
  schemaVersion: number;
  assetId: string;
  name: string;
  sourceHash: string;
  seed: number;
  componentTree: CaliComponent[];
  materials: CaliMaterial[];
  runtime: CaliRuntime;
  reviewHistory: unknown[];
}

export interface SpecValidation {
  valid: boolean;
  strictQuality: boolean;
  errors: string[];
}

export interface GenerateFromImageInput {
  slug: string;
  name: string;
  dataUrl: string;
  /**
   * Also register the source image in the project asset list. Off by default:
   * `image3d_ingest` already persists the bytes under `assets/sources`, so this
   * only matters when the image should be browsable as its own asset.
   */
  importSource?: boolean;
}

export interface GenerateFromPromptInput {
  slug: string;
  name: string;
  prompt: string;
  imageProvider: ImageProvider;
  importSource?: boolean;
}

export interface GeneratedAsset {
  assetId: string;
  spec: CaliSpec;
  asset: CaliAsset;
}

const DATA_URL_PATTERN = /^data:([^;,]+)(;[^,]*)?,(.*)$/s;
const BASE64_MARKER = ";base64";

export function isSupportedImageMime(mime: string): mime is SupportedImageMime {
  const normalized = mime.trim().toLowerCase();
  return SUPPORTED_IMAGE_MIMES.some((supported) => supported === normalized);
}

/**
 * Splits a `data:` URL into its mime and base64 payload. Throws rather than
 * returning null so callers get one consistent failure mode with context.
 */
export function parseDataUrl(dataUrl: string): ParsedDataUrl {
  if (typeof dataUrl !== "string" || dataUrl.trim() === "") {
    throw new Error("data URL is empty");
  }
  const match = DATA_URL_PATTERN.exec(dataUrl.trim());
  if (!match) {
    throw new Error("expected a data: URL of the form data:<mime>;base64,<payload>");
  }
  const [, mime, parameters, payload] = match;
  if (!(parameters ?? "").toLowerCase().includes(BASE64_MARKER)) {
    throw new Error(`data URL for ${mime} is not base64 encoded`);
  }
  const base64 = payload.trim();
  if (base64 === "") {
    throw new Error(`data URL for ${mime} carries no payload`);
  }
  return { mime: mime.trim().toLowerCase(), base64 };
}

export function dataUrlToBase64(dataUrl: string): string {
  return parseDataUrl(dataUrl).base64;
}

/** One-line human summary of a spec, for logs and the asset inspector. */
export function describeSpec(spec: CaliSpec): string {
  const components = spec.componentTree?.length ?? 0;
  const materials = spec.materials?.length ?? 0;
  const passes = spec.buildPasses?.length ?? 0;
  const pivots = spec.runtime?.pivots?.length ?? 0;
  const width = spec.silhouette?.width ?? 0;
  const height = spec.silhouette?.height ?? 0;
  const parts = [
    plural(components, "component"),
    plural(materials, "material"),
    plural(pivots, "pivot"),
    plural(passes, "build pass", "build passes"),
  ];
  return `${spec.targetName} — ${parts.join(", ")} · ${width}x${height} · ${spec.suitability}`;
}

/** Runs ingest -> spec -> validate -> generate for an already-rendered image. */
export async function generateAssetFromImage(input: GenerateFromImageInput): Promise<GeneratedAsset> {
  const { slug, name, dataUrl, importSource = false } = input;
  requireText(slug, "slug");
  requireText(name, "name");

  const { mime, base64 } = parseDataUrl(dataUrl);
  if (!isSupportedImageMime(mime)) {
    throw new Error(
      `unsupported image type ${mime}; expected one of ${SUPPORTED_IMAGE_MIMES.join(", ")}`,
    );
  }

  if (importSource) {
    await step(`asset_import_file for ${name}`, () =>
      rpc("asset_import_file", { slug, name, data: base64, mime, tags: ["image-to-3d"] }),
    );
  }

  const ingested = await step(`image3d_ingest for ${name}`, () =>
    rpc<IngestResult>("image3d_ingest", { slug, name, image: base64 }),
  );

  const drafted = await step(`image3d_spec for ${name}`, () =>
    rpc<CaliSpec>("image3d_spec", {
      name,
      sourceHash: ingested.sourceHash,
      width: ingested.width,
      height: ingested.height,
    }),
  );

  // Carrying the ingest asset id into the spec is what lets a later review
  // locate the source image; the core falls back to a fresh id without it.
  const spec: CaliSpec = { ...drafted, assetId: ingested.assetId };

  const validation = await step(`image3d_validate for ${name}`, () =>
    rpc<SpecValidation>("image3d_validate", { spec }),
  );
  if (!validation.valid) {
    const detail = validation.errors.length > 0 ? validation.errors.join("; ") : "no detail reported";
    throw new Error(`spec for ${name} failed validation: ${detail}`);
  }

  const asset = await step(`image3d_generate for ${name}`, () =>
    rpc<CaliAsset>("image3d_generate", { slug, spec }),
  );
  if (!asset.assetId) {
    throw new Error(`image3d_generate for ${name} returned no assetId`);
  }

  return { assetId: asset.assetId, spec, asset };
}

/** Renders an image for the prompt via the injected provider, then builds the asset. */
export async function generateAssetFromPrompt(input: GenerateFromPromptInput): Promise<GeneratedAsset> {
  const { slug, name, prompt, imageProvider, importSource } = input;
  requireText(prompt, "prompt");
  if (typeof imageProvider !== "function") {
    throw new Error("imageProvider must be a function returning a data URL");
  }

  let dataUrl: string;
  try {
    dataUrl = await imageProvider(prompt);
  } catch (error) {
    throw new Error(`image provider failed for prompt "${prompt}": ${messageOf(error)}`, {
      cause: error,
    });
  }
  if (typeof dataUrl !== "string" || dataUrl.trim() === "") {
    throw new Error(`image provider returned no image for prompt "${prompt}"`);
  }

  return generateAssetFromImage({ slug, name, dataUrl, importSource });
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function requireText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${label} failed: ${messageOf(error)}`, { cause: error });
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "unknown error";
}
