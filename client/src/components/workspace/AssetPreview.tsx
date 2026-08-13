import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  frameAtTime,
  isBlenderAsset,
  timeAtFrame,
  versionedUrl,
  type BlenderAssetStatus,
} from "../../lib/blender";
import { disposeTree } from "../../lib/pie";
import { assetObject, gltfAssetUrl } from "../../lib/procedural";
import { rpc } from "../../lib/rpc";
import type { Asset, Vec3 } from "../../lib/types";

interface AssetPreviewProps {
  asset: Asset;
  slug: string;
  theme: "dark" | "light";
  onClose?: () => void;
}

const CAMERA_START: Vec3 = [3.2, 2.4, 4.2];
const TARGET_START: Vec3 = [0, 0.6, 0];
const ORIGIN: Vec3 = [0, 0, 0];
const GRID_SIZE = 12;
const GRID_CELLS = 12;
const FIT_SPAN = 1.6;
const TIMELINE_FPS = 30;
const BUTTON_BASE =
  "inline-flex min-h-[26px] items-center justify-center rounded border border-line-strong bg-surface-1/90 px-2 py-1 text-[10px] tracking-[0.08em] text-ink-subtle transition-colors hover:bg-surface-2 hover:text-ink-strong active:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40";
const TOGGLE_ON = "bg-surface-3 text-ink-strong";

/**
 * Animation-aware asset viewer. glTF is loaded directly here instead of via
 * assetObject so clips remain available to the mixer and Blender exports can
 * be cache-busted in place without rebuilding the rest of the editor.
 */
export function AssetPreview({ asset, slug, theme, onClose }: AssetPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const rootRef = useRef<THREE.Group | null>(null);
  const objectRef = useRef<THREE.Object3D | null>(null);
  const skeletonRef = useRef<THREE.SkeletonHelper | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const clipsRef = useRef<THREE.AnimationClip[]>([]);
  const timeRef = useRef(0);
  const durationRef = useRef(0);
  const playingRef = useRef(false);
  const wireframeRef = useRef(false);
  const skeletonVisibleRef = useRef(false);
  const positionRef = useRef<Vec3>(ORIGIN);

  const [position, setPosition] = useState<Vec3>(ORIGIN);
  const [showGrid, setShowGrid] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [hasSkeleton, setHasSkeleton] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "waiting" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [clipNames, setClipNames] = useState<string[]>([]);
  const [clipIndex, setClipIndex] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [liveVersion, setLiveVersion] = useState<string | null>(null);
  const [liveReady, setLiveReady] = useState(!isBlenderAsset(asset));

  positionRef.current = position;
  playingRef.current = playing;
  wireframeRef.current = wireframe;
  skeletonVisibleRef.current = showSkeleton;

  useEffect(() => {
    if (!isBlenderAsset(asset)) {
      setLiveReady(true);
      setLiveVersion(null);
      return;
    }
    let cancelled = false;
    let previousVersion: string | null = null;
    const poll = async () => {
      try {
        const status = await rpc<BlenderAssetStatus>("blender_asset_status", {
          slug,
          assetId: asset.id,
        });
        if (cancelled) return;
        setLiveReady(status.ready);
        if (status.version && status.version !== previousVersion) {
          previousVersion = status.version;
          setLiveVersion(status.version);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadState("error");
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    setLiveReady(false);
    setLoadState("waiting");
    void poll();
    const timer = window.setInterval(() => void poll(), 800);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [asset, slug]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch {
      setUnavailable(true);
      return;
    }
    renderer.domElement.className = "block h-full w-full cursor-grab active:cursor-grabbing";
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1), false);
    container.appendChild(renderer.domElement);

    const styles = getComputedStyle(document.documentElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(styles.getPropertyValue("--surface-0").trim() || "#0a0a0a");
    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight || 1, 0.1, 100);
    camera.position.set(...CAMERA_START);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = true;
    controls.target.set(...TARGET_START);
    controlsRef.current = controls;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x2a2a2a, 0.85);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 6, 4);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-5, 2, -3);
    scene.add(hemi, key, fill);

    const grid = new THREE.GridHelper(
      GRID_SIZE,
      GRID_CELLS,
      styles.getPropertyValue("--line-strong").trim() || "#2e2e2e",
      styles.getPropertyValue("--line").trim() || "#1e1e1e",
    );
    gridRef.current = grid;
    scene.add(grid);
    const root = new THREE.Group();
    rootRef.current = root;
    scene.add(root);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hitPoint = new THREE.Vector3();
    const grabOffset = new THREE.Vector3();
    let dragPointer: number | null = null;
    const castFromEvent = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !objectRef.current) return;
      castFromEvent(event);
      if (raycaster.intersectObject(objectRef.current, true).length === 0) return;
      if (!raycaster.ray.intersectPlane(ground, hitPoint)) return;
      dragPointer = event.pointerId;
      grabOffset.set(hitPoint.x - root.position.x, 0, hitPoint.z - root.position.z);
      controls.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragPointer !== event.pointerId) return;
      castFromEvent(event);
      if (!raycaster.ray.intersectPlane(ground, hitPoint)) return;
      const [, y] = positionRef.current;
      setPosition([hitPoint.x - grabOffset.x, y, hitPoint.z - grabOffset.z]);
    };
    const endDrag = (event: PointerEvent) => {
      if (dragPointer !== event.pointerId) return;
      dragPointer = null;
      controls.enabled = true;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
    };
    const canvas = renderer.domElement;
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    const onResize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(container);

    let animationFrame = 0;
    let previous = performance.now();
    let lastUiUpdate = previous;
    const render = (now: number) => {
      animationFrame = requestAnimationFrame(render);
      const delta = Math.min((now - previous) / 1000, 0.1);
      previous = now;
      const mixer = mixerRef.current;
      const clipDuration = durationRef.current;
      if (playingRef.current && mixer && clipDuration > 0) {
        const next = (timeRef.current + delta) % clipDuration;
        timeRef.current = next;
        mixer.setTime(next);
        if (now - lastUiUpdate > 50) {
          lastUiUpdate = now;
          setCurrentTime(next);
        }
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animationFrame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
      controls.dispose();
      mixerRef.current?.stopAllAction();
      mixerRef.current = null;
      clipsRef.current = [];
      disposeTree(root);
      grid.geometry.dispose();
      const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
      gridMaterials.forEach((material) => material.dispose());
      rootRef.current = null;
      objectRef.current = null;
      skeletonRef.current = null;
      gridRef.current = null;
      controlsRef.current = null;
      cameraRef.current = null;
      renderer.forceContextLoss();
      renderer.dispose();
      canvas.remove();
    };
  }, [theme]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || (isBlenderAsset(asset) && !liveReady)) {
      if (isBlenderAsset(asset)) setLoadState("waiting");
      return;
    }
    let cancelled = false;
    setLoadState("loading");
    setLoadError("");
    setPlaying(false);
    const load = async () => {
      let object: THREE.Object3D;
      let clips: THREE.AnimationClip[] = [];
      if (asset.type === "gltf") {
        const baseUrl = gltfAssetUrl(asset, slug);
        if (!baseUrl) throw new Error("This glTF asset has no loadable URL");
        const gltf = await new GLTFLoader().loadAsync(versionedUrl(baseUrl, liveVersion));
        object = gltf.scene;
        clips = gltf.animations;
      } else {
        object = assetObject(asset, slug);
      }
      if (cancelled) {
        disposeTree(object);
        return;
      }
      const box = new THREE.Box3().setFromObject(object);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      const span = Math.max(size.x, size.y, size.z) || 1;
      const scale = FIT_SPAN / span;
      object.scale.multiplyScalar(scale);
      object.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
      applyWireframe(object, wireframeRef.current);
      root.add(object);
      objectRef.current = object;

      const bones = countBones(object);
      setHasSkeleton(bones > 0);
      if (bones > 0) {
        const helper = new THREE.SkeletonHelper(object);
        helper.visible = skeletonVisibleRef.current;
        root.add(helper);
        skeletonRef.current = helper;
      }
      clipsRef.current = clips;
      setClipNames(clips.map((clip, index) => clip.name || `Animation ${index + 1}`));
      setClipIndex(0);
      activateClip(object, clips, 0);
      setLoadState("ready");
    };
    void load().catch((error) => {
      if (!cancelled) {
        setLoadState("error");
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    });
    return () => {
      cancelled = true;
      mixerRef.current?.stopAllAction();
      mixerRef.current = null;
      clipsRef.current = [];
      if (skeletonRef.current) {
        root.remove(skeletonRef.current);
        skeletonRef.current.geometry.dispose();
        const skeletonMaterials = Array.isArray(skeletonRef.current.material)
          ? skeletonRef.current.material
          : [skeletonRef.current.material];
        skeletonMaterials.forEach((material) => material.dispose());
        skeletonRef.current = null;
      }
      if (objectRef.current) {
        root.remove(objectRef.current);
        disposeTree(objectRef.current);
        objectRef.current = null;
      }
      setClipNames([]);
      setHasSkeleton(false);
    };
  }, [asset, liveReady, liveVersion, slug, theme]);

  const activateClip = useCallback((object: THREE.Object3D, clips: THREE.AnimationClip[], index: number) => {
    mixerRef.current?.stopAllAction();
    if (!clips[index]) {
      mixerRef.current = null;
      durationRef.current = 0;
      timeRef.current = 0;
      setDuration(0);
      setCurrentTime(0);
      return;
    }
    const mixer = new THREE.AnimationMixer(object);
    mixer.clipAction(clips[index]).reset().play();
    mixer.setTime(0);
    mixerRef.current = mixer;
    durationRef.current = clips[index].duration;
    timeRef.current = 0;
    setDuration(clips[index].duration);
    setCurrentTime(0);
  }, []);

  useEffect(() => {
    const object = objectRef.current;
    if (!object || clipIndex === 0 || !clipsRef.current[clipIndex]) return;
    setPlaying(false);
    activateClip(object, clipsRef.current, clipIndex);
  }, [activateClip, clipIndex]);

  useEffect(() => {
    rootRef.current?.position.set(...position);
  }, [position]);

  useEffect(() => {
    if (gridRef.current) gridRef.current.visible = showGrid;
  }, [showGrid]);

  useEffect(() => {
    if (objectRef.current) applyWireframe(objectRef.current, wireframe);
  }, [wireframe]);

  useEffect(() => {
    if (skeletonRef.current) skeletonRef.current.visible = showSkeleton;
  }, [showSkeleton]);

  const seek = useCallback((next: number) => {
    const bounded = Math.max(0, Math.min(durationRef.current, next));
    timeRef.current = bounded;
    mixerRef.current?.setTime(bounded);
    setCurrentTime(bounded);
  }, []);

  const resetView = useCallback(() => {
    setPosition(ORIGIN);
    seek(0);
    cameraRef.current?.position.set(...CAMERA_START);
    controlsRef.current?.target.set(...TARGET_START);
    controlsRef.current?.update();
  }, [seek]);

  const currentFrame = frameAtTime(currentTime, TIMELINE_FPS, duration);
  const totalFrames = frameAtTime(duration, TIMELINE_FPS, duration);

  return (
    <section
      aria-label={`Preview of ${asset.name}`}
      className="relative mb-3.5 h-[380px] shrink-0 overflow-hidden rounded-[10px] border border-line bg-surface-0"
    >
      <div ref={containerRef} className="h-full w-full" />

      {unavailable ? <ViewerMessage title="WebGL unavailable" detail="The 3D preview could not start." /> : null}
      {!unavailable && loadState === "waiting" ? (
        <ViewerMessage title="Waiting for Blender" detail="Open the source, then save once to export the first GLB." />
      ) : null}
      {!unavailable && loadState === "loading" ? (
        <ViewerMessage title="Loading model" detail="Reading meshes, materials, rigs, and animation clips." />
      ) : null}
      {!unavailable && loadState === "error" ? (
        <ViewerMessage title="Model unavailable" detail={loadError || "The glTF file could not be loaded."} />
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
        <div className="pointer-events-auto flex flex-wrap gap-1.5 rounded-md border border-line bg-surface-0/90 p-1.5 shadow-sm">
          <button type="button" onClick={resetView} disabled={unavailable} className={BUTTON_BASE}>
            RESET
          </button>
          <button
            type="button"
            onClick={() => setShowGrid((value) => !value)}
            aria-pressed={showGrid}
            disabled={unavailable}
            className={`${BUTTON_BASE} ${showGrid ? TOGGLE_ON : ""}`}
          >
            GRID
          </button>
          <button
            type="button"
            onClick={() => setWireframe((value) => !value)}
            aria-pressed={wireframe}
            disabled={unavailable || loadState !== "ready"}
            className={`${BUTTON_BASE} ${wireframe ? TOGGLE_ON : ""}`}
          >
            WIRE
          </button>
          <button
            type="button"
            onClick={() => setShowSkeleton((value) => !value)}
            aria-pressed={showSkeleton}
            disabled={unavailable || !hasSkeleton}
            className={`${BUTTON_BASE} ${showSkeleton ? TOGGLE_ON : ""}`}
          >
            BONES
          </button>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close preview of ${asset.name}`}
            className={`${BUTTON_BASE} pointer-events-auto w-[28px] bg-surface-0/90 px-0`}
          >
            ×
          </button>
        ) : null}
      </div>

      <div className="absolute inset-x-2 bottom-2 rounded-lg border border-line bg-surface-0/95 p-2 shadow-sm">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            aria-label="Previous animation frame"
            className={`${BUTTON_BASE} h-7 w-7 px-0`}
            disabled={duration <= 0}
            onClick={() => {
              setPlaying(false);
              seek(timeAtFrame(currentFrame - 1, TIMELINE_FPS, duration));
            }}
          >
            <ChevronLeft aria-hidden className="h-3.5 w-3.5" strokeWidth={1.7} />
          </button>
          <button
            type="button"
            aria-label={playing ? "Pause animation" : "Play animation"}
            className={`${BUTTON_BASE} h-7 w-7 px-0`}
            disabled={duration <= 0}
            onClick={() => setPlaying((value) => !value)}
          >
            {playing ? (
              <Pause aria-hidden className="h-3.5 w-3.5" strokeWidth={1.7} />
            ) : (
              <Play aria-hidden className="h-3.5 w-3.5" strokeWidth={1.7} />
            )}
          </button>
          <button
            type="button"
            aria-label="Next animation frame"
            className={`${BUTTON_BASE} h-7 w-7 px-0`}
            disabled={duration <= 0}
            onClick={() => {
              setPlaying(false);
              seek(timeAtFrame(currentFrame + 1, TIMELINE_FPS, duration));
            }}
          >
            <ChevronRight aria-hidden className="h-3.5 w-3.5" strokeWidth={1.7} />
          </button>

          <input
            type="range"
            aria-label="Animation timeline"
            min={0}
            max={Math.max(duration, 0.001)}
            step={1 / TIMELINE_FPS}
            value={Math.min(currentTime, Math.max(duration, 0.001))}
            disabled={duration <= 0}
            onChange={(event) => {
              setPlaying(false);
              seek(Number(event.target.value));
            }}
            className="min-w-[80px] flex-1 accent-ink-strong disabled:opacity-30"
          />
          <span className="w-[92px] shrink-0 text-right font-mono text-[9px] text-ink-subtle">
            {duration > 0 ? `${String(currentFrame).padStart(3, "0")} / ${String(totalFrames).padStart(3, "0")}` : "NO ANIMATION"}
          </span>
        </div>
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[10px] text-ink-subtle" title={asset.name}>
            {asset.name}
          </span>
          {clipNames.length > 1 ? (
            <select
              aria-label="Animation clip"
              value={clipIndex}
              onChange={(event) => setClipIndex(Number(event.target.value))}
              className="max-w-[180px] rounded border border-line-strong bg-surface-1 px-2 py-1 text-[10px] text-ink"
            >
              {clipNames.map((name, index) => (
                <option key={`${name}-${index}`} value={index}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            <span className="max-w-[180px] truncate text-[10px] text-ink-faint">
              {clipNames[0] ?? "Static model"}
            </span>
          )}
          {isBlenderAsset(asset) && liveReady ? (
            <span className="shrink-0 text-[9px] tracking-[0.08em] text-ink-subtle">LIVE</span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ViewerMessage({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-surface-0/80 px-8 text-center">
      <div className="max-w-[280px]">
        <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink">{title}</p>
        <p className="mt-1 text-[10px] leading-relaxed text-ink-subtle">{detail}</p>
      </div>
    </div>
  );
}

function applyWireframe(object: THREE.Object3D, wireframe: boolean) {
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if ("wireframe" in material) material.wireframe = wireframe;
    }
  });
}

function countBones(object: THREE.Object3D): number {
  let count = 0;
  object.traverse((node) => {
    if (node instanceof THREE.Bone) count += 1;
  });
  return count;
}
