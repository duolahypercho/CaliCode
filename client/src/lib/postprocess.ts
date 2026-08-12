import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

/**
 * Shared ACES Filmic tone-mapping + Unreal bloom pipeline used by the PIE
 * runtime and the editor viewport. Captures go through this pipeline so the
 * judge sees the same picture as the live screen; without it, bright
 * emissive surfaces clip to white instead of blooming.
 *
 * The pipeline owns the EffectComposer; callers render through `render()`
 * and resize with `setSize()` alongside `renderer.setSize()`. When the
 * pipeline is created, it also sets `renderer.toneMapping`,
 * `renderer.toneMappingExposure`, and `renderer.outputColorSpace` — the
 * OutputPass reads these back at draw time, so the on-screen curve and the
 * captured PNG stay in sync with whatever the host configured.
 */
export interface PostprocessOptions {
  /** Bloom intensity. Pass 0 to disable the bloom pass entirely. */
  bloomStrength?: number;
  /** Bloom blur radius (controls how far glow spreads). */
  bloomRadius?: number;
  /** Luminance threshold above which pixels contribute to bloom. */
  bloomThreshold?: number;
  /** Tone mapping function; defaults to ACES Filmic. */
  toneMapping?: THREE.ToneMapping;
  /** Tone mapping exposure multiplier. */
  exposure?: number;
}

export interface PostprocessPipeline {
  /** Render the scene through the configured pipeline. */
  render(): void;
  /** Resize the underlying render targets to match the canvas. */
  setSize(width: number, height: number): void;
  /** Tear down the composer and its render targets. */
  dispose(): void;
  /** Exposed for inspection (tests, debug overlays, runtime knobs). */
  readonly composer: EffectComposer;
  /** The bloom pass when `bloomStrength > 0`; null when bloom is disabled. */
  readonly bloomPass: UnrealBloomPass | null;
  /** Resolved options used to build the pipeline. */
  readonly options: Readonly<Required<PostprocessOptions>>;
}

const DEFAULT_OPTIONS: Required<PostprocessOptions> = {
  bloomStrength: 0.55,
  bloomRadius: 0.6,
  bloomThreshold: 0.85,
  toneMapping: THREE.ACESFilmicToneMapping,
  exposure: 1.0,
};

/**
 * Build a postprocess pipeline bound to a renderer. The renderer's tone
 * mapping, exposure, and output color space are set to match the options;
 * hosts should treat those as pipeline-owned and not mutate them afterwards.
 *
 * Composers require a WebGL context, so the call may throw when the host
 * renderer is in a context-less test environment. The factory does not
 * silently fall back: callers that need that guard (AssetBuilder does)
 * wrap the renderer construction themselves.
 */
export function createPostprocessPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  overrides: PostprocessOptions = {},
): PostprocessPipeline {
  const options: Required<PostprocessOptions> = { ...DEFAULT_OPTIONS, ...overrides };

  renderer.toneMapping = options.toneMapping;
  renderer.toneMappingExposure = options.exposure;
  // OutputPass emits sRGB when the renderer's outputColorSpace is SRGB;
  // keep the explicit assignment so a host that flipped it to Linear
  // (rare) does not silently break the captured curve.
  if (renderer.outputColorSpace !== THREE.SRGBColorSpace) {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  let bloomPass: UnrealBloomPass | null = null;
  if (options.bloomStrength > 0) {
    const size = renderer.getSize(new THREE.Vector2());
    bloomPass = new UnrealBloomPass(
      size,
      options.bloomStrength,
      options.bloomRadius,
      options.bloomThreshold,
    );
    composer.addPass(bloomPass);
  }

  composer.addPass(new OutputPass());

  return {
    composer,
    bloomPass,
    options,
    render: () => composer.render(),
    setSize: (width, height) => composer.setSize(width, height),
    dispose: () => composer.dispose(),
  };
}

/**
 * Synchronously render the scene through the renderer without any
 * postprocessing. Useful as a fallback when WebGL postprocessing support is
 * missing (older browsers, headless contexts) or as a baseline comparison.
 */
export function renderDirect(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): void {
  renderer.render(scene, camera);
}
