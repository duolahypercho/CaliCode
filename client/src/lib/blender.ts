import type { Asset } from "./types";

export interface BlenderAssetStatus {
  ready: boolean;
  version: string | null;
  bytes: number;
}

interface BlenderMetadata {
  source?: unknown;
  output?: unknown;
  bridge?: unknown;
}

export function blenderMetadata(asset: Asset): BlenderMetadata | null {
  const value = asset.metadata?.blender;
  return value && typeof value === "object" ? (value as BlenderMetadata) : null;
}

export function isBlenderAsset(asset: Asset | null | undefined): asset is Asset {
  const metadata = asset ? blenderMetadata(asset) : null;
  return typeof metadata?.source === "string" && typeof metadata.output === "string";
}

export function importMime(file: Pick<File, "name" | "type">): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".glb")) return "model/gltf-binary";
  if (name.endsWith(".gltf")) return "model/gltf+json";
  if (name.endsWith(".obj")) return "model/obj";
  return "application/octet-stream";
}

export function versionedUrl(url: string, version: string | null): string {
  if (!version) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}v=${encodeURIComponent(version)}`;
}

export function frameAtTime(time: number, fps: number, duration: number): number {
  if (!Number.isFinite(time) || !Number.isFinite(fps) || fps <= 0) return 0;
  const bounded = Math.max(0, Math.min(Number.isFinite(duration) ? duration : 0, time));
  return Math.round(bounded * fps);
}

export function timeAtFrame(frame: number, fps: number, duration: number): number {
  if (!Number.isFinite(frame) || !Number.isFinite(fps) || fps <= 0) return 0;
  return Math.max(0, Math.min(Number.isFinite(duration) ? duration : 0, frame / fps));
}
