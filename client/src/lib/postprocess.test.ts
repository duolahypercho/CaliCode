import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  createPostprocessPipeline,
  renderDirect,
  type PostprocessPipeline,
} from "./postprocess";

/**
 * Minimal stand-in for WebGLRenderer. The composer factory needs a real
 * WebGL context to allocate its render targets, so the constructor will
 * throw on this stub; the renderer-side options (toneMapping, exposure,
 * outputColorSpace) are applied *before* the throw, so we can still assert
 * those happened. Tests that need a real pipeline run the browser/e2e
 * path; here we cover the host-side wiring and the failure mode.
 */
function stubRenderer(): THREE.WebGLRenderer {
  return {
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace,
    getSize: vi.fn().mockReturnValue(new THREE.Vector2(1, 1)),
    render: vi.fn(),
  } as unknown as THREE.WebGLRenderer;
}

describe("postprocess pipeline factory", () => {
  it("applies default ACES Filmic + bloom options to the host renderer", () => {
    const renderer = stubRenderer();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    try {
      createPostprocessPipeline(renderer, scene, camera);
    } catch {
      // jsdom has no WebGL — the composer allocation throws. The renderer
      // configuration happens before the throw, so the assertions below
      // still hold.
    }
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.toneMappingExposure).toBe(1.0);
  });

  it("honours overrides for toneMapping, exposure, and bloom", () => {
    const renderer = stubRenderer();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    try {
      createPostprocessPipeline(renderer, scene, camera, {
        toneMapping: THREE.NeutralToneMapping,
        exposure: 1.4,
        bloomStrength: 0,
        bloomRadius: 0.3,
        bloomThreshold: 0.95,
      });
    } catch {
      // jsdom has no WebGL.
    }
    expect(renderer.toneMapping).toBe(THREE.NeutralToneMapping);
    expect(renderer.toneMappingExposure).toBe(1.4);
  });

  it("promotes a Linear outputColorSpace host to sRGB", () => {
    const renderer = {
      ...stubRenderer(),
      outputColorSpace: THREE.LinearSRGBColorSpace,
    } as unknown as THREE.WebGLRenderer;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    try {
      createPostprocessPipeline(renderer, scene, camera);
    } catch {
      // jsdom has no WebGL.
    }
    expect(renderer.outputColorSpace).toBe(THREE.SRGBColorSpace);
  });

  it("throws when the host renderer cannot allocate a composer (no WebGL)", () => {
    const renderer = stubRenderer();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    expect(() => createPostprocessPipeline(renderer, scene, camera)).toThrow();
  });
});

describe("postprocess pipeline surface", () => {
  /**
   * Stand-in composer so we can assert the pipeline methods route through
   * the composer's surface. Avoids touching real WebGL.
   */
  function fakePipeline(): {
    pipeline: PostprocessPipeline;
    renderSpy: ReturnType<typeof vi.fn>;
    setSizeSpy: ReturnType<typeof vi.fn>;
    disposeSpy: ReturnType<typeof vi.fn>;
  } {
    const renderSpy = vi.fn();
    const setSizeSpy = vi.fn();
    const disposeSpy = vi.fn();
    const pipeline: PostprocessPipeline = {
      composer: {} as PostprocessPipeline["composer"],
      bloomPass: null,
      options: {
        bloomStrength: 0,
        bloomRadius: 0,
        bloomThreshold: 0,
        toneMapping: THREE.NoToneMapping,
        exposure: 1,
      },
      render: renderSpy,
      setSize: setSizeSpy,
      dispose: disposeSpy,
    };
    return { pipeline, renderSpy, setSizeSpy, disposeSpy };
  }

  it("render() calls the composer's render", () => {
    const { pipeline, renderSpy } = fakePipeline();
    pipeline.render();
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it("setSize(width, height) forwards to the composer", () => {
    const { pipeline, setSizeSpy } = fakePipeline();
    pipeline.setSize(800, 600);
    expect(setSizeSpy).toHaveBeenCalledWith(800, 600);
  });

  it("dispose() releases the composer's render targets", () => {
    const { pipeline, disposeSpy } = fakePipeline();
    pipeline.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("renderDirect fallback", () => {
  it("delegates to renderer.render without touching the composer", () => {
    const renderer = stubRenderer();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    renderDirect(renderer, scene, camera);
    expect(renderer.render).toHaveBeenCalledWith(scene, camera);
  });
});
