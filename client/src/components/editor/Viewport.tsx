import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PieRuntime, type PieState } from "../../lib/pie";
import { themeToken } from "../../lib/theme";
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const runtimeRef = useRef<PieRuntime | null>(null);
  const selectedRef = useRef(selectedEntityId);
  selectedRef.current = selectedEntityId;
  const handlersRef = useRef({ onSelect, onCapture, onLog, onStateChange, onRuntimeReady });
  handlersRef.current = { onSelect, onCapture, onLog, onStateChange, onRuntimeReady };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // three.js owns the canvas rather than reusing a React-rendered one.
    // Under StrictMode the effect mounts twice; the first renderer's
    // dispose() releases the WebGL context, and constructing a second
    // renderer over that same dead canvas threw during passive-effect flush.
    // A fresh canvas per mount removes the shared mutable resource.
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.domElement.className = "block h-full w-full";
    container.appendChild(renderer.domElement);
    canvasRef.current = renderer.domElement;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // updateStyle=false: the canvas is sized by CSS (h-full w-full). Letting
    // three.js write inline width/height pins the canvas to whatever the
    // container measured on the first layout pass — which is 0x0 inside a
    // flex-1 parent, and inline styles then beat the classes permanently.
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1), false);
    renderer.shadowMap.enabled = true;
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    // The stage is painted from --viewport-*, which is defined once in :root
    // and never overridden under .dark — this surface holds the same art
    // direction in both themes. It is a game viewport, not a UI panel, and
    // editor_capture_frame photographs it as the agent's visual evidence, so
    // a human toggling the app theme must not change what the agent sees.
    // Following --surface-0 (as this file briefly did) rendered a white scene
    // under white fog in the light theme and captures came back blank.
    // Whatever this is, background and fog must agree: fog blends geometry
    // toward its own colour, so a mismatch fades the scene to a colour the
    // backdrop never shows.
    const backdrop = themeToken("--viewport-backdrop", "#0a0a0a");
    scene.background = new THREE.Color(backdrop);
    scene.fog = new THREE.Fog(backdrop, 18, 42);
    sceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 100);
    // Closer than the old (5, 4, 6) framing so a default-sized project
    // fills more of the viewport on first paint. The target is raised
    // slightly to (0, 0.6, 0) because most scene origins sit on the
    // grid plane; looking at 0.5 put the horizon a touch low.
    camera.position.set(3.5, 2.6, 4.2);
    camera.lookAt(0, 0.6, 0);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0.6, 0);
    controlsRef.current = controls;

    // 3-light studio rig: hemi fill + warm key + cool back-rim. Matches the
    // AssetBuilder / AssetPreview rigs (procedural preview surfaces had the
    // better lighting all along; the main PIE viewport was the hold-out).
    const hemi = new THREE.HemisphereLight(0xffffff, 0x2a2a2a, 0.85);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(5, 8, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xc8d4ff, 0.6);
    fill.position.set(-5, 2, -3);
    scene.add(fill);
    // Grid tones come off the same stage palette as the backdrop, for the
    // same reason: tying them to the light/dark ramp would have drawn the
    // light theme's pale lines over this dark stage. They are brighter than
    // the old fixed (0x3a3a3a, 0x1c1c1c) pair, which was nearly invisible,
    // but still subdued so the project reads first.
    const grid = new THREE.GridHelper(
      20,
      20,
      themeToken("--viewport-grid-axis", "#6a6a6a"),
      themeToken("--viewport-grid-line", "#2e2e2e"),
    );
    grid.position.y = -0.01;
    const disposeGrid = (helper: THREE.GridHelper) => {
      helper.geometry.dispose();
      const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
      materials.forEach((material) => material.dispose());
    };
    scene.add(grid);

    // PieRuntime exclusively owns the project group. Building it here as well
    // allocated and immediately disposed a duplicate scene on every mount.
    const runtime = new PieRuntime(project, renderer, scene, camera, {
      onFrame: () => undefined,
      onCapture: (frame) => handlersRef.current.onCapture(frame),
      onLog: (message) => handlersRef.current.onLog(message),
      onStateChange: (state) => handlersRef.current.onStateChange(state),
      onFrameCamera: (center) => {
        // frameProject computed a new look-at; mirror it onto OrbitControls
        // so the user's next drag does not snap the view back to the
        // (0, 0.5, 0) target the editor was set up with on first mount.
        const controls = controlsRef.current;
        if (!controls) return;
        controls.target.copy(center);
        controls.update();
      },
    });
    runtimeRef.current = runtime;
    handlersRef.current.onRuntimeReady(runtime);

    // No theme observer here, unlike AssetBuilder and AssetPreview: every
    // token this scene reads is theme-independent by construction, so a class
    // swap on <html> has nothing to repaint. An observer would only spend a
    // grid rebuild and a redraw to arrive at the identical picture, while
    // implying this surface tracks the theme when the point is that it does
    // not.
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
      // Resize the composer's offscreen targets to match. RenderPass and
      // UnrealBloomPass allocate render textures sized to the canvas; if
      // they fall out of sync the viewport goes fuzzy at the next resize.
      runtime.setPostprocessSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(container);

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      // Damping keeps easing the camera after pointer-up, so update() runs
      // every tick whether or not we draw. It reports whether the camera
      // actually moved, which is one of the things that dirties the frame.
      if (controls.update()) runtime.invalidate();
      // While PIE is running the runtime drives its own rAF loop and draws
      // every simulated frame; drawing again here was a second full pass
      // through the composer for the identical picture.
      if (runtime.state === "running") return;
      // Otherwise draw only what changed. Rendering unconditionally at 60Hz
      // was cheap while this was a bare `renderer.render`, and stopped being
      // cheap once every draw became an ACES + bloom composite: profiling
      // the starter project's scripted `step(30)` found 128 redundant
      // composites costing 1.28s of the run's 1.51s, against 0.13s for the
      // 10 frames the test actually captures. That is what pushed the suite
      // past its per-test timeout on CI's software rasteriser.
      //
      // renderIfNeeded routes through the runtime's render path, so a frame
      // that is drawn shares the ACES + bloom curve the captured PNGs go
      // through — falling back to a direct render when the postprocess
      // factory failed to build (jsdom stubs, headless contexts).
      runtime.renderIfNeeded();
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      disposeGrid(grid);
      runtime.dispose();
      handlersRef.current.onRuntimeReady(null);
      controls.dispose();
      // forceContextLoss releases the GPU context immediately; without it
      // Chrome's ~16-context cap is reached after enough remounts and the
      // live viewport's context gets evicted.
      renderer.forceContextLoss();
      renderer.dispose();
      renderer.domElement.remove();
      if (canvasRef.current === renderer.domElement) canvasRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!runtimeRef.current) return;
    // Rebuilding while running used to be skipped outright, which made
    // "TWEAK LIVE" not tweak live: every slider was inert during PLAY and you
    // had to pause to see any change.
    runtimeRef.current.setProject(project);
  }, [project]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden" aria-label="3D viewport">
      {selectedEntityId && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-border bg-background/90 px-2 py-1 text-xs">
          {project.entities.find((entity) => entity.id === selectedEntityId)?.name ?? selectedEntityId}
        </div>
      )}
    </div>
  );
}
