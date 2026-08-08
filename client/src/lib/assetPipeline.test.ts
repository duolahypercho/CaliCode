import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dataUrlToBase64,
  describeSpec,
  generateAssetFromImage,
  generateAssetFromPrompt,
  isSupportedImageMime,
  parseDataUrl,
  type CaliSpec,
  type ImageProvider,
} from "./assetPipeline";
import { rpc } from "./rpc";

vi.mock("./rpc", () => ({ rpc: vi.fn() }));

const rpcMock = vi.mocked(rpc);

const PNG_DATA_URL = "data:image/png;base64,aGVsbG8=";

function fakeSpec(overrides: Partial<CaliSpec> = {}): CaliSpec {
  return {
    schemaVersion: "1.0",
    targetName: "Vase",
    sourceHash: "hash-1",
    suitability: "pass",
    silhouette: { width: 512, height: 512, anchor: "center" },
    componentTree: [{ id: "root", parent: null, primitive: "box" }],
    materials: [{ id: "material-primary", pbr: { baseColor: "#b9a48a" } }],
    proceduralStrategy: ["primitives"],
    runtime: {
      pivots: [{ id: "pivot-primary", node: "root", axis: [0, 1, 0] }],
      sockets: [],
      colliders: [{ id: "collider-root", node: "root", kind: "box" }],
      destructionGroups: [],
    },
    buildPasses: [
      { id: "blockout", componentRefs: ["root"] },
      { id: "structural-pass", componentRefs: ["root"] },
    ],
    reviewHistory: [],
    ...overrides,
  };
}

/** Wires the mock to the happy-path response for each RPC method. */
function stubHappyPath(spec: CaliSpec = fakeSpec()): void {
  rpcMock.mockImplementation(async (method: string) => {
    switch (method) {
      case "asset_import_file":
        return { id: "asset-1" };
      case "image3d_ingest":
        return {
          assetId: "cali-1",
          name: spec.targetName,
          sourceHash: spec.sourceHash,
          width: spec.silhouette.width,
          height: spec.silhouette.height,
          admission: "pass",
          notes: "single reference image",
        };
      case "image3d_spec":
        return spec;
      case "image3d_validate":
        return { valid: true, strictQuality: true, errors: [] };
      case "image3d_generate":
        return { assetId: "cali-1", name: spec.targetName, schemaVersion: 1 };
      default:
        throw new Error(`unexpected method ${method}`);
    }
  });
}

function methodsCalled(): string[] {
  return rpcMock.mock.calls.map((call) => call[0]);
}

describe("data URL helpers", () => {
  it("splits a base64 data URL into mime and payload", () => {
    const parsed = parseDataUrl(PNG_DATA_URL);

    expect(parsed).toEqual({ mime: "image/png", base64: "aGVsbG8=" });
  });

  it("returns just the payload from dataUrlToBase64", () => {
    expect(dataUrlToBase64(PNG_DATA_URL)).toBe("aGVsbG8=");
  });

  it("rejects a non-base64 data URL", () => {
    expect(() => parseDataUrl("data:image/png,plain-text")).toThrow(/not base64/);
  });

  it("rejects a data URL with no payload", () => {
    expect(() => parseDataUrl("data:image/png;base64,")).toThrow(/no payload/);
  });

  it("rejects a value that is not a data URL", () => {
    expect(() => parseDataUrl("https://example.com/cat.png")).toThrow(/data: URL/);
  });

  it("rejects an empty string", () => {
    expect(() => parseDataUrl("   ")).toThrow(/empty/);
  });
});

describe("isSupportedImageMime", () => {
  it("accepts the mimes the core can decode, case-insensitively", () => {
    expect(isSupportedImageMime("image/png")).toBe(true);
    expect(isSupportedImageMime("IMAGE/JPEG")).toBe(true);
    expect(isSupportedImageMime("image/webp")).toBe(true);
  });

  it("rejects unsupported mimes", () => {
    expect(isSupportedImageMime("image/gif")).toBe(false);
    expect(isSupportedImageMime("application/pdf")).toBe(false);
  });
});

describe("describeSpec", () => {
  it("summarizes counts and silhouette", () => {
    const summary = describeSpec(fakeSpec());

    expect(summary).toBe("Vase — 1 component, 1 material, 1 pivot, 2 build passes · 512x512 · pass");
  });

  it("pluralizes multi-item specs", () => {
    const spec = fakeSpec({
      componentTree: [
        { id: "root", parent: null },
        { id: "cap", parent: "root" },
      ],
      materials: [{ id: "a" }, { id: "b" }],
    });

    expect(describeSpec(spec)).toContain("2 components, 2 materials");
  });
});

describe("generateAssetFromImage", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it("runs ingest, spec, validate, and generate in order", async () => {
    // Arrange
    const spec = fakeSpec();
    stubHappyPath(spec);

    // Act
    const result = await generateAssetFromImage({ slug: "demo", name: "Vase", dataUrl: PNG_DATA_URL });

    // Assert
    expect(methodsCalled()).toEqual([
      "image3d_ingest",
      "image3d_spec",
      "image3d_validate",
      "image3d_generate",
    ]);
    expect(result.assetId).toBe("cali-1");
    expect(result.spec.targetName).toBe("Vase");
  });

  it("passes the decoded base64 payload, not the data URL, to ingest", async () => {
    stubHappyPath();

    await generateAssetFromImage({ slug: "demo", name: "Vase", dataUrl: PNG_DATA_URL });

    const ingestCall = rpcMock.mock.calls.find((call) => call[0] === "image3d_ingest");
    expect(ingestCall?.[1]).toEqual({ slug: "demo", name: "Vase", image: "aGVsbG8=" });
  });

  it("carries the ingested assetId into the spec sent to generate", async () => {
    const spec = fakeSpec();
    stubHappyPath(spec);

    const result = await generateAssetFromImage({ slug: "demo", name: "Vase", dataUrl: PNG_DATA_URL });

    const generateCall = rpcMock.mock.calls.find((call) => call[0] === "image3d_generate");
    expect((generateCall?.[1] as { spec: CaliSpec }).spec.assetId).toBe("cali-1");
    expect(result.spec.assetId).toBe("cali-1");
  });

  it("does not mutate the spec returned by the core", async () => {
    const spec = fakeSpec();
    stubHappyPath(spec);

    await generateAssetFromImage({ slug: "demo", name: "Vase", dataUrl: PNG_DATA_URL });

    expect(spec.assetId).toBeUndefined();
  });

  it("imports the source file only when asked", async () => {
    stubHappyPath();

    await generateAssetFromImage({
      slug: "demo",
      name: "Vase",
      dataUrl: PNG_DATA_URL,
      importSource: true,
    });

    expect(methodsCalled()[0]).toBe("asset_import_file");
  });

  it("rejects an unsupported image mime before calling any RPC", async () => {
    stubHappyPath();

    await expect(
      generateAssetFromImage({ slug: "demo", name: "Bad", dataUrl: "data:image/gif;base64,AAAA" }),
    ).rejects.toThrow(/unsupported image type image\/gif/);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects a blank slug before calling any RPC", async () => {
    stubHappyPath();

    await expect(
      generateAssetFromImage({ slug: "  ", name: "Vase", dataUrl: PNG_DATA_URL }),
    ).rejects.toThrow(/slug is required/);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("reports which RPC step failed", async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === "image3d_ingest") {
        throw new Error("core offline");
      }
      return {};
    });

    await expect(
      generateAssetFromImage({ slug: "demo", name: "Vase", dataUrl: PNG_DATA_URL }),
    ).rejects.toThrow(/image3d_ingest for Vase failed: core offline/);
  });

  it("surfaces validation errors and never calls generate", async () => {
    stubHappyPath();
    rpcMock.mockImplementation(async (method: string) => {
      if (method === "image3d_ingest") {
        return { assetId: "cali-1", sourceHash: "hash-1", width: 512, height: 512 };
      }
      if (method === "image3d_spec") {
        return fakeSpec();
      }
      if (method === "image3d_validate") {
        return { valid: false, strictQuality: false, errors: ["materials must contain at least one"] };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(
      generateAssetFromImage({ slug: "demo", name: "Vase", dataUrl: PNG_DATA_URL }),
    ).rejects.toThrow(/failed validation: materials must contain at least one/);
    expect(methodsCalled()).not.toContain("image3d_generate");
  });

  it("fails when generate returns no assetId", async () => {
    stubHappyPath();
    const happy = rpcMock.getMockImplementation();
    rpcMock.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "image3d_generate") {
        return { name: "Vase" };
      }
      return happy?.(method, params ?? {});
    });

    await expect(
      generateAssetFromImage({ slug: "demo", name: "Vase", dataUrl: PNG_DATA_URL }),
    ).rejects.toThrow(/returned no assetId/);
  });
});

describe("generateAssetFromPrompt", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it("renders the prompt through the provider and builds the asset", async () => {
    stubHappyPath();
    const provider = vi.fn<ImageProvider>().mockResolvedValue(PNG_DATA_URL);

    const result = await generateAssetFromPrompt({
      slug: "demo",
      name: "Vase",
      prompt: "a clay vase",
      imageProvider: provider,
    });

    expect(provider).toHaveBeenCalledWith("a clay vase");
    expect(result.assetId).toBe("cali-1");
    expect(methodsCalled()).toContain("image3d_generate");
  });

  it("wraps a provider failure with the prompt for context", async () => {
    stubHappyPath();
    const provider = vi.fn<ImageProvider>().mockRejectedValue(new Error("rate limited"));

    await expect(
      generateAssetFromPrompt({
        slug: "demo",
        name: "Vase",
        prompt: "a clay vase",
        imageProvider: provider,
      }),
    ).rejects.toThrow(/image provider failed for prompt "a clay vase": rate limited/);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("fails when the provider returns an empty image", async () => {
    stubHappyPath();
    const provider = vi.fn<ImageProvider>().mockResolvedValue("");

    await expect(
      generateAssetFromPrompt({
        slug: "demo",
        name: "Vase",
        prompt: "a clay vase",
        imageProvider: provider,
      }),
    ).rejects.toThrow(/returned no image/);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects a blank prompt without calling the provider", async () => {
    const provider = vi.fn<ImageProvider>();

    await expect(
      generateAssetFromPrompt({ slug: "demo", name: "Vase", prompt: "  ", imageProvider: provider }),
    ).rejects.toThrow(/prompt is required/);
    expect(provider).not.toHaveBeenCalled();
  });
});
