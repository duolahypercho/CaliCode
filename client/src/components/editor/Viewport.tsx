import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildScene } from "../../lib/procedural";
import { PieRuntime, type PieState } from "../../lib/pie";
import type { CapturedFrame, Project } from "../../lib/types";

interface ViewportProps {
  project: Project;
  selectedEntityId: string | null;
  onSelect: (id: string | null) => void;
  onRuntimeReady: (runtime: PieRuntime | null) => void;
  onCapture: (frame: CapturedFrame) => void;
  onLog: (message: string) => void;
  onStateChange: (state: PieState) => void;
}

export function Viewport({
  project,
  selectedEntityId,
  onSelect,
  onRuntimeReady,
  onCapture,
  onLog,
  onStateChange,
}: ViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const runtimeRef = useRef<PieRuntime | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const selectedRef = useRef(selectedEntityId);
  selectedRef.current = selectedEntityId;
  const handlersRef = useRef({ onSelect, onCapture, onLog, onStateChange, onRuntimeReady });
  handlersRef.current = { onSelect, onCapture, onLog, onStateChange, onRuntimeReady };
  const rebuildRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current ?? undefined,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // updateStyle=false: the canvas is sized by CSS (h-full w-full). Letting
    // three.js write inline width/height pins the canvas to whatever the
    // container measured on the first layout pass — which is 0x0 inside a
    // flex-1 parent, and inline styles then beat the classes permanently.
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1), false);
    renderer.shadowMap.enabled = true;
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080808);
    scene.fog = new THREE.Fog(0x080808, 18, 42);
    sceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 100);
    camera.position.set(5, 4, 6);
    camera.lookAt(0, 0.5, 0);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0.5, 0);
    controlsRef.current = controls;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.9);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(5, 8, 5);
    scene.add(key);
    const grid = new THREE.GridHelper(16, 16, 0x3a3a3a, 0x1c1c1c);
    grid.position.y = -0.01;
    scene.add(grid);

    const rebuild = () => {
      const old = scene.getObjectByName("__project__");
      if (old) scene.remove(old);
      const group = new THREE.Group();
      group.name = "__project__";
      const built = buildScene(projectRef.current);
      while (built.children.length > 0) group.add(built.children[0]);
      scene.add(group);
    };
    rebuildRef.current = rebuild;
    rebuild();

    const runtime = new PieRuntime(projectRef.current, renderer, scene, camera, {
      onFrame: () => undefined,
      onCapture: (frame) => handlersRef.current.onCapture(frame),
      onLog: (message) => handlersRef.current.onLog(message),
      onStateChange: (state) => handlersRef.current.onStateChange(state),
    });
    runtimeRef.current = runtime;
    handlersRef.current.onRuntimeReady(runtime);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onPointerDown = (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(scene.children, true);
      const hit = hits.find((item) => item.object.userData.entityId);
      handlersRef.current.onSelect(hit ? (hit.object.userData.entityId as string) : null);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);

    const onResize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      // A hidden or not-yet-laid-out container reports 0, which would make
      // camera.aspect NaN and blank the render target until a full remount.
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
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      runtime.dispose();
      handlersRef.current.onRuntimeReady(null);
      controls.dispose();
      renderer.dispose();
    };
  }, []);

  useEffect(() => {
    if (!runtimeRef.current || runtimeRef.current.state === "running") return;
    runtimeRef.current.setProject(project);
    rebuildRef.current();
  }, [project]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden" aria-label="3D viewport">
      <canvas ref={canvasRef} className="block h-full w-full" />
      {selectedEntityId && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-border bg-background/90 px-2 py-1 text-xs">
          {project.entities.find((entity) => entity.id === selectedEntityId)?.name ?? selectedEntityId}
        </div>
      )}
    </div>
  );
}
