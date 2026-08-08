import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { disposeTree } from "../../lib/pie";
import { assetObject } from "../../lib/procedural";
import type { Asset, Vec3 } from "../../lib/types";

interface AssetPreviewProps {
  asset: Asset;
  onClose?: () => void;
}

const CAMERA_START: Vec3 = [3.2, 2.4, 4.2];
const TARGET_START: Vec3 = [0, 0.6, 0];
const GRID_SIZE = 12;
const GRID_CELLS = 12;
/** Longest axis every asset is normalised to, so tiny and huge specs frame alike. */
const FIT_SPAN = 1.6;
const ORIGIN: Vec3 = [0, 0, 0];
const TOGGLE_ON = "border-white/40 text-[#e6e6e6]";
const TOGGLE_OFF = "border-white/10 text-[#9c9c9c]";
/** shrink-0: the ART tab is a scrolling flex column, which collapses a fixed-height panel to nothing without it. */
const PANEL_CLASS =
  "relative mb-3.5 h-[300px] shrink-0 overflow-hidden rounded-[10px] border border-white/[0.07] bg-[#0b0b0b]";
const BUTTON_BASE =
  "inline-flex min-h-[26px] items-center rounded border px-2 py-1 text-[10px] tracking-[0.1em] transition-colors hover:border-white/30 hover:text-[#dcdcdc] active:border-white/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Live three.js preview for one asset: orbit/pan/zoom, plus drag-to-reposition
 * on the ground plane. Mirrors the editor Viewport's renderer lifecycle — a
 * fresh canvas per mount and forceContextLoss on teardown — because the same
 * StrictMode double-mount and browser WebGL context cap apply here.
 */
export function AssetPreview({ asset, onClose }: AssetPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  /** Drag moves this group; the asset sits inside it, normalised and grounded. */
  const rootRef = useRef<THREE.Group | null>(null);
  const [position, setPosition] = useState<Vec3>(ORIGIN);
  const [showGrid, setShowGrid] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const positionRef = useRef(position);
  positionRef.current = position;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      // WebGL is unavailable headless and after the browser's context cap is
      // hit; a dead preview must not take the whole ART tab down with it.
      setUnavailable(true);
      return;
    }
    renderer.domElement.className = "block h-full w-full cursor-grab active:cursor-grabbing";
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1), false);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0b0b);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight || 1, 0.1, 100);
    camera.position.set(...CAMERA_START);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = true;
    controls.target.set(...TARGET_START);
    controlsRef.current = controls;

    // Soft studio rig: broad hemisphere fill keeps the stylized-lowpoly faces
    // readable, the key defines silhouette, the low fill lifts the shadow side.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x2a2a2a, 0.85);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 6, 4);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-5, 2, -3);
    scene.add(hemi, key, fill);

    const grid = new THREE.GridHelper(GRID_SIZE, GRID_CELLS, 0x3a3a3a, 0x1c1c1c);
    gridRef.current = grid;
    scene.add(grid);

    const root = new THREE.Group();
    rootRef.current = root;
    scene.add(root);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hitPoint = new THREE.Vector3();
    // Offset between the grab point and the group origin, so the asset does not
    // snap its centre to the cursor on the first move.
    const grabOffset = new THREE.Vector3();
    let dragPointer: number | null = null;

    const castFromEvent = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      castFromEvent(event);
      if (raycaster.intersectObject(root, true).length === 0) return;
      if (!raycaster.ray.intersectPlane(ground, hitPoint)) return;
      dragPointer = event.pointerId;
      grabOffset.set(hitPoint.x - root.position.x, 0, hitPoint.z - root.position.z);
      // Orbit and drag both own the left button; the drag wins while it lasts.
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
      // A collapsed container reports 0, which makes camera.aspect NaN and
      // blanks the render target until a remount.
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(container);

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
      controls.dispose();
      disposeTree(root);
      grid.geometry.dispose();
      grid.material.dispose();
      sceneRef.current = null;
      rootRef.current = null;
      gridRef.current = null;
      controlsRef.current = null;
      cameraRef.current = null;
      renderer.forceContextLoss();
      renderer.dispose();
      canvas.remove();
    };
  }, []);

  // Rebuild on asset change rather than remounting the component: a new
  // renderer per selection would burn through the browser's context budget.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const object = assetObject(asset);
    const box = new THREE.Box3().setFromObject(object);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const span = Math.max(size.x, size.y, size.z) || 1;
    const scale = FIT_SPAN / span;
    object.scale.multiplyScalar(scale);
    // Centre on X/Z and rest on the grid, so every asset lands the same way.
    object.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    root.add(object);
    return () => {
      root.remove(object);
      disposeTree(object);
    };
  }, [asset]);

  useEffect(() => {
    rootRef.current?.position.set(...position);
  }, [position]);

  useEffect(() => {
    if (gridRef.current) gridRef.current.visible = showGrid;
  }, [showGrid]);

  useEffect(() => {
    rootRef.current?.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if ("wireframe" in material) material.wireframe = wireframe;
      }
    });
  }, [wireframe, asset]);

  const resetView = useCallback(() => {
    setPosition(ORIGIN);
    cameraRef.current?.position.set(...CAMERA_START);
    controlsRef.current?.target.set(...TARGET_START);
    controlsRef.current?.update();
  }, []);

  return (
    <section
      aria-label={`Preview of ${asset.name}`}
      className={PANEL_CLASS}
    >
      <div ref={containerRef} className="h-full w-full" />

      {unavailable ? (
        <p className="absolute inset-0 flex items-center justify-center text-[11px] tracking-[0.1em] text-[#8f8f8f]">
          WEBGL UNAVAILABLE
        </p>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
        <div className="pointer-events-auto flex flex-wrap gap-1.5 rounded-md border border-white/[0.07] bg-[#0e0e0e]/90 p-1.5">
          <button type="button" onClick={resetView} disabled={unavailable} className={`${BUTTON_BASE} ${TOGGLE_OFF}`}>
            RESET VIEW
          </button>
          <button
            type="button"
            onClick={() => setShowGrid((current) => !current)}
            aria-pressed={showGrid}
            disabled={unavailable}
            className={`${BUTTON_BASE} ${showGrid ? TOGGLE_ON : TOGGLE_OFF}`}
          >
            GRID
          </button>
          <button
            type="button"
            onClick={() => setWireframe((current) => !current)}
            aria-pressed={wireframe}
            disabled={unavailable}
            className={`${BUTTON_BASE} ${wireframe ? TOGGLE_ON : TOGGLE_OFF}`}
          >
            WIREFRAME
          </button>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close preview of ${asset.name}`}
            className={`pointer-events-auto bg-[#0e0e0e]/90 ${BUTTON_BASE} ${TOGGLE_OFF}`}
          >
            ✕
          </button>
        ) : null}
      </div>

      <p className="pointer-events-none absolute bottom-2.5 left-2.5 rounded border border-white/[0.07] bg-[#0e0e0e]/90 px-2 py-1 text-[10px] tracking-[0.08em] text-[#8f8f8f]">
        {asset.name} · DRAG TO MOVE · X {position[0].toFixed(2)} Z {position[2].toFixed(2)}
      </p>
    </section>
  );
}
