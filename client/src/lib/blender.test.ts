import { describe, expect, it } from "vitest";
import { frameAtTime, importMime, isBlenderAsset, timeAtFrame, versionedUrl } from "./blender";
import type { Asset } from "./types";

const asset = (metadata: Record<string, unknown> = {}): Asset => ({
  id: "runner",
  name: "Runner",
  type: "gltf",
  source: "runner.glb",
  tags: [],
  usage: [],
  thumbnail: null,
  metadata,
});

describe("Blender asset helpers", () => {
  it("recognizes assets with a source and watched output", () => {
    expect(isBlenderAsset(asset({ blender: { source: "source.blend", output: "model.glb" } }))).toBe(true);
    expect(isBlenderAsset(asset())).toBe(false);
  });

  it("infers browser-omitted model MIME types", () => {
    expect(importMime({ name: "walk.GLB", type: "" })).toBe("model/gltf-binary");
    expect(importMime({ name: "walk.gltf", type: "" })).toBe("model/gltf+json");
    expect(importMime({ name: "walk.obj", type: "" })).toBe("model/obj");
    expect(importMime({ name: "walk.bin", type: "" })).toBe("application/octet-stream");
  });

  it("adds cache versions without discarding an existing query", () => {
    expect(versionedUrl("/runner.glb", "12-40")).toBe("/runner.glb?v=12-40");
    expect(versionedUrl("/runner.glb?raw=1", "12 40")).toBe("/runner.glb?raw=1&v=12%2040");
  });

  it("converts and clamps timeline frames", () => {
    expect(frameAtTime(1.5, 30, 2)).toBe(45);
    expect(frameAtTime(4, 30, 2)).toBe(60);
    expect(timeAtFrame(45, 30, 2)).toBe(1.5);
    expect(timeAtFrame(-2, 30, 2)).toBe(0);
  });
});
