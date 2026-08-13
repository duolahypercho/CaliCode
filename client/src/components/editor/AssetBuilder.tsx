import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  applyOps,
  fullTransform,
  BUILDER_PRIMITIVES,
  type ApplyResult,
  type BuilderComponent,
  type BuilderMaterial,
  type BuilderOp,
  type BuilderPrimitive,
  type CaliPbr,
} from "../../lib/assetBuilderOps";
import type { CaliSpec } from "../../lib/assetPipeline";
import { caliObjectFromSpec } from "../../lib/procedural";
import { disposeTree } from "../../lib/pie";
import { rpc } from "../../lib/rpc";
import type { Asset, Entity, Vec3 } from "../../lib/types";

/**
 * Local wrapper for the `project_asset_write` core RPC (see the asset-tools
 * blueprint §3.6): writes `assets/<file>` under the CaliCode project dir even
 * when a workspace folder is attached, unlike `file_write` which rebases into
 * `workspaceRoot`. The save-back path uses it to keep the on-disk `.cali.json`
 * in sync with `asset.metadata.cali`.
 */
export async function projectAssetWrite(slug: string, assetId: string, content: string): Promise<unknown> {
  return rpc("project_asset_write", { slug, assetId, content });
}

/** Hook for editor_capture-style tooling to grab the builder viewport. */
export interface BuilderViewportApi {
  /** PNG data URL of the current frame, or null when WebGL is unavailable. */
  captureFrame(): string | null;
}

export interface AssetBuilderProps {
  /** The asset being edited; must carry a spec at `metadata.cali`. */
  asset: Asset;
  /** All scene entities, for the IN USE badge. */
  entities: Entity[];
  /** Project slug, needed by the default save-back path. */
  slug: string;
  /** App-owned single mutation path: applyOps + updateAsset + setProject. */
  onApply(assetId: string, ops: BuilderOp[]): ApplyResult;
  /** Used only by undo/redo: replace the spec wholesale, no reducer. */
  onReplaceSpec(assetId: string, spec: CaliSpec): void;
  /** Persist project + `.cali.json`. Defaults to projectAssetWrite when omitted. */
  onSave?(assetId: string): Promise<void>;
  onClose(): void;
  registerViewportApi?(api: BuilderViewportApi | null): void;
}

/**
 * Reads a design token off the document root so the WebGL scene follows the
 * same light/dark palette as the DOM chrome around it. Same trick as
 * AssetPreview; the fallback covers jsdom, where the stylesheet is absent.
 */
function themeToken(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

const ASSET_GROUP = "__builder_asset__";
const HISTORY_CAP = 100;
type GizmoMode = "translate" | "rotate" | "scale";

const BUTTON_BASE =
  "inline-flex min-h-[26px] items-center justify-center rounded border px-2 py-1 text-[10px] tracking-[0.1em] transition-colors hover:text-ink-strong active:border-ink-subtle disabled:cursor-not-allowed disabled:opacity-40";
const TOGGLE_ON = "border-line-strong bg-surface-3 text-ink-strong";
const TOGGLE_OFF = "border-line text-ink-subtle";
const FIELD_CLASS =
  "w-full rounded-md border border-line bg-surface-1 px-2 py-1.5 text-xs text-ink-strong outline-none transition-colors";
const LABEL_CLASS = "mb-1 block text-[10.5px] text-ink-subtle";
const DEFAULT_PBR: CaliPbr = { baseColor: "#9ca3af", metalness: 0.1, roughness: 0.7 };

/**
 * Blender-lite panel for `.cali` assets: three.js viewport with a
 * TransformControls gizmo on the left, component tree / primitive toolbar /
 * PBR material editor / transform fields on the right. Every edit — gizmo drag
 * included — is one `BuilderOp` batch through the App-owned `onApply`, the same
 * reducer path the agent's `editor_asset_builder_apply` uses, so the user and
 * a subagent can hand the same session back and forth.
 *
 * Renderer lifecycle mirrors AssetPreview: fresh canvas per mount (StrictMode
 * double-mount safe), 0-size resize guard, forceContextLoss on unmount.
 */
export function AssetBuilder({
  asset,
  entities,
  slug,
  onApply,
  onReplaceSpec,
  onSave,
  onClose,
  registerViewportApi,
}: AssetBuilderProps) {
  const spec = (asset.metadata?.cali ?? null) as CaliSpec | null;
  const components = (spec?.componentTree ?? []) as BuilderComponent[];
  const materials = (spec?.materials ?? []) as BuilderMaterial[];

  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const gizmoRef = useRef<TransformControls | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<GizmoMode>("translate");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  // Snapshot stacks live in refs (no re-render per entry); counters drive the
  // UNDO/REDO disabled states.
  const undoRef = useRef<CaliSpec[]>([]);
  const redoRef = useRef<CaliSpec[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);

  const primaryId = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null;
  const primary = components.find((component) => component.id === primaryId) ?? null;
  const primaryMaterial = primary?.materialId
    ? materials.find((material) => material.id === primary.materialId) ?? null
    : null;
  const uses = entities.filter((entity) => entity.assetId === asset.id).length;

  // Refs so the mount-once viewport effect always sees current values.
  const specRef = useRef(spec);
  specRef.current = spec;
  const handlersRef = useRef({ onApply, onReplaceSpec, onClose });
  handlersRef.current = { onApply, onReplaceSpec, onClose };
  const assetIdRef = useRef(asset.id);
  assetIdRef.current = asset.id;
  const selectRef = useRef<(id: string | null, additive: boolean) => void>(() => undefined);

  /** All UI edits funnel here: snapshot for undo, reduce, surface errors. */
  const apply = useCallback(
    (ops: BuilderOp[]): ApplyResult | null => {
      const current = specRef.current;
      if (!current) return null;
      undoRef.current.push(structuredClone(current));
      if (undoRef.current.length > HISTORY_CAP) undoRef.current.shift();
      redoRef.current = [];
      setHistoryVersion((version) => version + 1);
      const result = handlersRef.current.onApply(assetIdRef.current, ops);
      setStatus(result.errors.length > 0 ? result.errors.join(" · ") : null);
      return result;
    },
    [],
  );
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const undo = useCallback(() => {
    const previous = undoRef.current.pop();
    if (!previous || !specRef.current) return;
    redoRef.current.push(structuredClone(specRef.current));
    setHistoryVersion((version) => version + 1);
    handlersRef.current.onReplaceSpec(assetIdRef.current, previous);
  }, []);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next || !specRef.current) return;
    undoRef.current.push(structuredClone(specRef.current));
    setHistoryVersion((version) => version + 1);
    handlersRef.current.onReplaceSpec(assetIdRef.current, next);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    try {
      if (onSave) {
        await onSave(asset.id);
      } else {
        const current = specRef.current;
        if (!current) throw new Error("no spec to save");
        await projectAssetWrite(slug, asset.id, JSON.stringify(current, null, 2));
      }
      setStatus("saved");
    } catch (error) {
      setStatus(`save failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }, [asset.id, onSave, slug]);

  // ------------------------------------------------------------------ viewport
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch {
      // Headless or context-cap-exhausted browsers must not take the panel down.
      setUnavailable(true);
      return;
    }
    renderer.domElement.className = "block h-full w-full";
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1), false);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(themeToken("--surface-0", "#0a0a0a"));
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight || 1, 0.1, 100);
    camera.position.set(3.2, 2.4, 4.2);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.target.set(0, 0.6, 0);

    // Studio 3-light rig + grid, same recipe as AssetPreview.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x2a2a2a, 0.85);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 6, 4);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-5, 2, -3);
    scene.add(hemi, key, fill);
    const makeGrid = () =>
      new THREE.GridHelper(12, 12, themeToken("--line-strong", "#2e2e2e"), themeToken("--line", "#1e1e1e"));
    const disposeGrid = (helper: THREE.GridHelper) => {
      helper.geometry.dispose();
      const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
      materials.forEach((material) => material.dispose());
    };
    let grid = makeGrid();
    scene.add(grid);

    // Toggling the theme rewrites the tokens on <html>. Repaint the scene
    // chrome in place rather than remounting, which would drop the WebGL
    // context and the gizmo with it. GridHelper bakes its colours into vertex
    // data, so that one has to be rebuilt.
    const repaintForTheme = () => {
      (scene.background as THREE.Color).set(themeToken("--surface-0", "#0a0a0a"));
      scene.remove(grid);
      disposeGrid(grid);
      grid = makeGrid();
      scene.add(grid);
    };
    const themeObserver = new MutationObserver(repaintForTheme);
    themeObserver.observe(document.documentElement, { attributeFilter: ["class"] });

    // Gizmo lives OUTSIDE the asset group so spec rebuilds never dispose it.
    const gizmo = new TransformControls(camera, renderer.domElement);
    scene.add(gizmo.getHelper());
    gizmoRef.current = gizmo;
    gizmo.addEventListener("dragging-changed", (event) => {
      // Orbit and gizmo share the left button; the drag wins while it lasts.
      orbit.enabled = !(event as unknown as { value: boolean }).value;
    });
    // One op per gesture: three.js mutates the live object at 60fps during the
    // drag, and only the release commits a set_transform through the reducer.
    gizmo.addEventListener("mouseUp", () => {
      const object = gizmo.object;
      const componentId = object?.userData.componentId as string | undefined;
      if (!object || !componentId) return;
      applyRef.current([
        {
          op: "set_transform",
          id: componentId,
          position: object.position.toArray() as Vec3,
          rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
          scale: object.scale.toArray() as Vec3,
        },
      ]);
    });

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || gizmo.dragging) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const assetGroup = scene.getObjectByName(ASSET_GROUP);
      if (!assetGroup) return;
      const hits = raycaster.intersectObject(assetGroup, true);
      // The hit may be a child mesh; walk up to the nearest tagged ancestor.
      let componentId: string | null = null;
      for (const hit of hits) {
        let node: THREE.Object3D | null = hit.object;
        while (node && node !== assetGroup) {
          if (typeof node.userData.componentId === "string") {
            componentId = node.userData.componentId;
            break;
          }
          node = node.parent;
        }
        if (componentId) break;
      }
      selectRef.current(componentId, event.shiftKey);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key === "w" || event.key === "W") setMode("translate");
      else if (event.key === "e" || event.key === "E") setMode("rotate");
      else if (event.key === "r" || event.key === "R") setMode("scale");
    };
    window.addEventListener("keydown", onKeyDown);

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

    registerViewportApi?.({
      captureFrame: () => {
        try {
          return renderer.domElement.toDataURL("image/png");
        } catch {
          return null;
        }
      },
    });

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      orbit.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      registerViewportApi?.(null);
      gizmo.detach();
      gizmo.dispose();
      gizmoRef.current = null;
      orbit.dispose();
      const assetGroup = scene.getObjectByName(ASSET_GROUP);
      if (assetGroup) disposeTree(assetGroup);
      disposeGrid(grid);
      sceneRef.current = null;
      rendererRef.current = null;
      renderer.forceContextLoss();
      renderer.dispose();
      renderer.domElement.remove();
    };
    // Mount-once by design; everything mutable flows through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild the asset group whenever the spec changes. Remove + dispose + fresh
  // caliObjectFromSpec, exactly like the editor Viewport's project rebuild.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !spec) return;
    const old = scene.getObjectByName(ASSET_GROUP);
    if (old) {
      // The gizmo target is about to be disposed; detach before the rebuild
      // and let the re-resolve effect below re-attach into the new tree.
      gizmoRef.current?.detach();
      scene.remove(old);
      disposeTree(old);
    }
    const group = caliObjectFromSpec(spec as unknown as Record<string, unknown>);
    group.name = ASSET_GROUP;
    tagComponentIds(group, spec);
    scene.add(group);
  }, [spec]);

  // Re-resolve the gizmo target after every rebuild: rebuilds destroy the old
  // object, so walk the new tree for the mesh carrying the selected id.
  useEffect(() => {
    const scene = sceneRef.current;
    const gizmo = gizmoRef.current;
    if (!scene || !gizmo) return;
    const assetGroup = scene.getObjectByName(ASSET_GROUP);
    let target: THREE.Object3D | null = null;
    if (assetGroup && primaryId) {
      assetGroup.traverse((node) => {
        if (!target && node.userData.componentId === primaryId) target = node;
      });
    }
    if (target) gizmo.attach(target);
    else gizmo.detach();
  }, [spec, primaryId]);

  useEffect(() => {
    gizmoRef.current?.setMode(mode);
  }, [mode]);

  const select = useCallback((id: string | null, additive: boolean) => {
    setSelectedIds((current) => {
      if (id === null) return additive ? current : [];
      if (!additive) return [id];
      return current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
    });
  }, []);
  selectRef.current = select;

  // ------------------------------------------------------------------ actions

  const addPrimitive = (primitive: BuilderPrimitive) => {
    const count = components.filter((component) => component.primitive === primitive).length;
    const result = apply([
      {
        op: "add_component",
        name: `${primitive}-${count + 1}`,
        primitive,
        parent: primaryId,
        materialId: materials[0]?.id,
      },
    ]);
    const created = result?.created[0];
    if (created) setSelectedIds([created]);
  };

  const groupSelection = () => {
    if (selectedIds.length < 2) return;
    const result = apply([{ op: "group", ids: selectedIds, name: `group-${components.length}` }]);
    const created = result?.created[0];
    if (created) setSelectedIds([created]);
  };

  const removeSelected = (id: string) => {
    apply([{ op: "remove_component", id }]);
    setSelectedIds((current) => current.filter((entry) => entry !== id));
  };

  const setTransformField = (key: "position" | "rotation" | "scale", axis: 0 | 1 | 2, value: number) => {
    if (!primary || !Number.isFinite(value)) return;
    const next = fullTransform(primary.transform);
    next[key][axis] = value;
    apply([{ op: "set_transform", id: primary.id, [key]: next[key] } as BuilderOp]);
  };

  const setDimension = (key: string, value: number) => {
    if (!primary || !Number.isFinite(value)) return;
    apply([
      { op: "update_component", id: primary.id, patch: { dimensions: { ...(primary.dimensions ?? {}), [key]: value } } },
    ]);
  };

  const patchMaterial = (patch: Partial<CaliPbr>) => {
    if (!primary) return;
    if (primaryMaterial) {
      apply([{ op: "update_material", id: primaryMaterial.id, pbr: patch }]);
    } else {
      // No material assigned yet: create one for this component and assign it.
      const result = apply([{ op: "add_material", name: `${primary.name ?? primary.id} material`, pbr: { ...DEFAULT_PBR, ...patch } }]);
      const created = result?.created[0];
      if (created) apply([{ op: "assign_material", componentId: primary.id, materialId: created }]);
    }
  };

  const loadMapFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") patchMaterial({ map: reader.result });
    };
    reader.readAsDataURL(file);
  };

  if (!spec) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-ink-subtle">
        {asset.name} has no cali spec — open it through the builder to convert it.
      </div>
    );
  }

  const pbr = (primaryMaterial?.pbr ?? DEFAULT_PBR) as CaliPbr;
  const transform = primary ? fullTransform(primary.transform) : null;

  return (
    <div className="flex h-full min-h-0 w-full" aria-label={`Asset builder for ${asset.name}`}>
      {/* viewport */}
      <div className="relative min-w-0 flex-1 overflow-hidden bg-surface-0">
        <div ref={containerRef} className="h-full w-full" />
        {unavailable ? (
          <p className="absolute inset-0 flex items-center justify-center text-[11px] tracking-[0.1em] text-ink-subtle">
            WEBGL UNAVAILABLE
          </p>
        ) : null}
        <div className="pointer-events-none absolute left-2.5 top-2.5 flex gap-1.5">
          {(
            [
              ["translate", "MOVE · W"],
              ["rotate", "ROTATE · E"],
              ["scale", "SCALE · R"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              aria-pressed={mode === value}
              disabled={unavailable}
              className={`pointer-events-auto ${BUTTON_BASE} ${mode === value ? TOGGLE_ON : `bg-surface-0/90 ${TOGGLE_OFF}`}`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="pointer-events-none absolute bottom-2.5 left-2.5 rounded border border-line bg-surface-0/90 px-2 py-1 text-[10px] tracking-[0.08em] text-ink-subtle">
          {spec.targetName} · {components.length} COMPONENTS · {uses > 0 ? `IN USE ${uses}` : "READY"}
        </p>
        {status ? (
          <p className="pointer-events-none absolute bottom-2.5 right-2.5 max-w-[60%] truncate rounded border border-line bg-surface-0/90 px-2 py-1 text-[10px] text-ink-subtle">
            {status}
          </p>
        ) : null}
      </div>

      {/* right rail */}
      <aside className="flex w-[280px] shrink-0 flex-col overflow-y-auto border-l border-line bg-surface-1/40 p-3">
        <div className="mb-2 flex items-center gap-1.5">
          <input
            aria-label="Asset name"
            defaultValue={spec.targetName}
            key={spec.targetName}
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name && name !== spec.targetName) apply([{ op: "rename_asset", name }]);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className={FIELD_CLASS}
          />
          <button type="button" onClick={onClose} aria-label="Close builder" className={`${BUTTON_BASE} ${TOGGLE_OFF}`}>
            ✕
          </button>
        </div>

        <div className="mb-1 text-[10.5px] text-ink-subtle">Add</div>
        <div className="mb-2.5 grid grid-cols-3 gap-1.5">
          {BUILDER_PRIMITIVES.map((primitive) => (
            <button
              key={primitive}
              type="button"
              onClick={() => addPrimitive(primitive)}
              className={`${BUTTON_BASE} ${TOGGLE_OFF}`}
            >
              {primitive.slice(0, 3).toUpperCase()}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={groupSelection}
          disabled={selectedIds.length < 2}
          className={`mb-3 ${BUTTON_BASE} ${TOGGLE_OFF}`}
        >
          GROUP {selectedIds.length >= 2 ? `(${selectedIds.length})` : ""}
        </button>

        <div className="mb-1 text-[10.5px] text-ink-subtle">Components</div>
        <ul className="mb-3 max-h-[180px] overflow-y-auto rounded-md border border-line" role="listbox" aria-label="Component tree">
          {components.length === 0 ? (
            /* Without this the empty list is a 2px-tall bordered sliver under
               the "Components" heading — every other list in the app says what
               belongs in it. Presentational because a listbox only permits
               option/group children, and this is a message, not a choice. */
            <li role="presentation" className="px-2 py-3 text-[11px] text-ink-subtle">
              No components yet — add a primitive above.
            </li>
          ) : null}
          {flattenTree(components).map(({ component, depth }) => (
            <li key={component.id} className="flex items-center border-b border-line/50 last:border-b-0">
              <button
                type="button"
                role="option"
                aria-selected={selectedIds.includes(component.id)}
                onClick={(event) => select(component.id, event.shiftKey)}
                style={{ paddingLeft: `${8 + depth * 12}px` }}
                className={`min-w-0 flex-1 truncate py-1.5 pr-1 text-left text-[11px] transition-colors ${
                  selectedIds.includes(component.id) ? "bg-surface-2 text-ink-strong" : "text-ink-subtle hover:text-ink"
                }`}
              >
                {component.name ?? component.id}
                <span className="ml-1.5 text-[9px] tracking-[0.08em] text-ink-faint">
                  {component.primitive?.toUpperCase() ?? "GROUP"}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Remove ${component.name ?? component.id}`}
                onClick={() => removeSelected(component.id)}
                /* Was a 10px glyph sitting 6px from the select button, so a
                   near-miss on select deleted the row instead. App-standard
                   hit target, and a border to make the two targets read as
                   separate. */
                className="flex min-h-[28px] shrink-0 items-center border-l border-line px-2 text-[10px] text-ink-faint transition-colors hover:text-danger-soft active:border-danger-soft"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>

        {primary && transform ? (
          <>
            {(
              [
                ["position", "Position", 0.1],
                ["rotation", "Rotation", 0.05],
                ["scale", "Scale", 0.1],
              ] as const
            ).map(([key, label, step]) => (
              <div key={key} className="mb-2.5">
                <div className={LABEL_CLASS}>{label}</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {(["X", "Y", "Z"] as const).map((axisLabel, axis) => (
                    <input
                      key={`${primary.id}-${key}-${axisLabel}`}
                      type="number"
                      step={step}
                      aria-label={`${label} ${axisLabel}`}
                      defaultValue={round3(transform[key][axis as 0 | 1 | 2])}
                      onBlur={(event) => setTransformField(key, axis as 0 | 1 | 2, Number(event.target.value))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      className={FIELD_CLASS}
                    />
                  ))}
                </div>
              </div>
            ))}

            {primary.primitive ? (
              <div className="mb-2.5">
                <div className={LABEL_CLASS}>Dimensions</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {dimensionKeysFor(primary.primitive).map((key) => (
                    <label key={`${primary.id}-${key}`} className="text-[9.5px] text-ink-faint">
                      {key}
                      <input
                        type="number"
                        step={0.1}
                        aria-label={`Dimension ${key}`}
                        defaultValue={primary.dimensions?.[key] ?? ""}
                        onBlur={(event) => {
                          if (event.target.value !== "") setDimension(key, Number(event.target.value));
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                        className={FIELD_CLASS}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            <div className={LABEL_CLASS}>Material {primaryMaterial ? `· ${primaryMaterial.name ?? primaryMaterial.id}` : "· none"}</div>
            <div className="mb-1.5 grid grid-cols-3 gap-1.5">
              <input
                type="color"
                aria-label="Base colour"
                value={pbr.baseColor}
                onChange={(event) => patchMaterial({ baseColor: event.target.value })}
                className="h-[30px] w-full rounded-md border border-line bg-surface-1 p-1 outline-none"
              />
              <input
                type="number"
                step={0.05}
                min={0}
                max={1}
                aria-label="Metalness"
                value={round3(pbr.metalness)}
                onChange={(event) => patchMaterial({ metalness: Number(event.target.value) })}
                className={FIELD_CLASS}
              />
              <input
                type="number"
                step={0.05}
                min={0}
                max={1}
                aria-label="Roughness"
                value={round3(pbr.roughness)}
                onChange={(event) => patchMaterial({ roughness: Number(event.target.value) })}
                className={FIELD_CLASS}
              />
            </div>
            <div className="mb-1.5 grid grid-cols-3 gap-1.5">
              <input
                type="color"
                aria-label="Emissive colour"
                value={pbr.emissive ?? "#000000"}
                onChange={(event) => patchMaterial({ emissive: event.target.value })}
                className="h-[30px] w-full rounded-md border border-line bg-surface-1 p-1 outline-none"
              />
              <input
                type="number"
                step={0.1}
                min={0}
                aria-label="Emissive intensity"
                value={round3(pbr.emissiveIntensity ?? 1)}
                onChange={(event) => patchMaterial({ emissiveIntensity: Number(event.target.value) })}
                className={FIELD_CLASS}
              />
              <label
                className={`${BUTTON_BASE} ${pbr.map ? TOGGLE_ON : TOGGLE_OFF} cursor-pointer`}
                title={pbr.map ? "Replace texture map" : "Add texture map"}
              >
                MAP
                <input
                  type="file"
                  accept="image/*"
                  aria-label="Texture map"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) loadMapFile(file);
                    event.target.value = "";
                  }}
                />
              </label>
            </div>
            {pbr.map ? (
              <button type="button" onClick={() => patchMaterial({ map: null })} className={`mb-1.5 ${BUTTON_BASE} ${TOGGLE_OFF}`}>
                CLEAR MAP
              </button>
            ) : null}

            <div className="mb-3 grid grid-cols-3 gap-1.5">
              <button
                type="button"
                onClick={() => apply([{ op: "set_pivot", node: primary.id, axis: [0, 1, 0] }])}
                className={`${BUTTON_BASE} ${TOGGLE_OFF}`}
                title="Add a Y-axis pivot on this node"
              >
                PIVOT Y
              </button>
              <button
                type="button"
                onClick={() => apply([{ op: "set_collider", node: primary.id, kind: "box" }])}
                className={`${BUTTON_BASE} ${TOGGLE_OFF}`}
              >
                COL BOX
              </button>
              <button
                type="button"
                onClick={() => apply([{ op: "set_collider", node: primary.id, kind: "sphere" }])}
                className={`${BUTTON_BASE} ${TOGGLE_OFF}`}
              >
                COL SPH
              </button>
            </div>
          </>
        ) : (
          <p className="mb-3 text-[11px] text-ink-subtle">Select a component to edit its transform and material.</p>
        )}

        <div className="mt-auto grid grid-cols-2 gap-1.5 pt-2" data-history-version={historyVersion}>
          <button type="button" onClick={undo} disabled={undoRef.current.length === 0} className={`${BUTTON_BASE} ${TOGGLE_OFF}`}>
            UNDO
          </button>
          <button type="button" onClick={redo} disabled={redoRef.current.length === 0} className={`${BUTTON_BASE} ${TOGGLE_OFF}`}>
            REDO
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className={`col-span-2 ${BUTTON_BASE} ${TOGGLE_ON}`}
          >
            {saving ? "SAVING…" : "SAVE"}
          </button>
        </div>
      </aside>
    </div>
  );
}

/**
 * Guarantees every built object carries `userData.componentId` for gizmo
 * picking and post-rebuild re-resolution. Once procedural.ts stamps the id
 * itself (blueprint §2.7) the name-matching fallback below is a no-op.
 */
function tagComponentIds(group: THREE.Object3D, spec: CaliSpec): void {
  const untagged: THREE.Object3D[] = [];
  group.traverse((node) => {
    if (node !== group && node.userData.componentId === undefined && (node as THREE.Mesh).isMesh) {
      untagged.push(node);
    }
  });
  if (untagged.length === 0) return;
  const components = (spec.componentTree ?? []) as BuilderComponent[];
  const claimed = new Set<THREE.Object3D>();
  for (const component of components) {
    const label = component.name ?? component.id;
    const match = untagged.find((node) => !claimed.has(node) && node.name === label);
    if (match) {
      match.userData.componentId = component.id;
      claimed.add(match);
    }
  }
}

interface TreeRow {
  component: BuilderComponent;
  depth: number;
}

/** Parent-indented flattening of the flat componentTree for the list UI. */
function flattenTree(components: BuilderComponent[]): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (parent: string | null, depth: number) => {
    for (const component of components) {
      if ((component.parent ?? null) !== parent) continue;
      rows.push({ component, depth });
      if (depth < 32) visit(component.id, depth + 1);
    }
  };
  visit(null, 0);
  // Orphans (parent id missing from the tree) still need to show up.
  for (const component of components) {
    if (!rows.some((row) => row.component.id === component.id)) rows.push({ component, depth: 0 });
  }
  return rows;
}

function dimensionKeysFor(primitive: string): string[] {
  switch (primitive) {
    case "box":
      return ["width", "height", "depth"];
    case "sphere":
      return ["radius", "segments"];
    case "cylinder":
    case "cone":
      return ["radius", "height", "segments"];
    case "torus":
      return ["radius", "width"];
    case "plane":
      return ["width", "height"];
    default:
      return ["width", "height", "depth", "radius"];
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
