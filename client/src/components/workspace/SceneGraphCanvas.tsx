import { useCallback, useMemo, useRef, useState } from "react";
import { EntityProperties } from "./EntityProperties";
import type { Entity, Project } from "../../lib/types";

interface SceneGraphCanvasProps {
  project: Project;
  selectedEntityId: string | null;
  onSelect: (id: string | null) => void;
  onAddEntity: () => void;
  onPatchEntity: (id: string, patch: Partial<Entity>) => void;
  onRemoveEntity: (id: string) => void;
}

interface GraphNode {
  id: string;
  kind: "entity" | "script" | "asset";
  title: string;
  body: string;
  x: number;
  y: number;
}

const NODE_WIDTH = 150;
const COLUMN_X = { entity: 60, script: 300, asset: 540 } as const;
const ROW_GAP = 96;

/**
 * The design's SCENE surface: a node palette beside a dot-grid canvas with
 * draggable nodes and bezier edges.
 *
 * The graph is derived from the real project — entities on the left, the
 * scripts they run in the middle, the assets they use on the right — so an
 * edge means an actual `scriptIds` or `assetId` relationship rather than
 * decoration. Selecting an entity node selects it everywhere else too.
 */
export function SceneGraphCanvas({
  project,
  selectedEntityId,
  onSelect,
  onAddEntity,
  onPatchEntity,
  onRemoveEntity,
}: SceneGraphCanvasProps) {
  const [offsets, setOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const { nodes, edges } = useMemo(() => {
    const nodes: GraphNode[] = [];
    const edges: Array<{ id: string; from: string; to: string }> = [];
    const placed = { entity: 0, script: 0, asset: 0 };

    const push = (node: Omit<GraphNode, "x" | "y">): GraphNode => {
      const row = placed[node.kind];
      placed[node.kind] += 1;
      const full = { ...node, x: COLUMN_X[node.kind], y: 40 + row * ROW_GAP };
      nodes.push(full);
      return full;
    };

    for (const entity of project.entities) {
      const [x, y, z] = entity.transform.position;
      push({
        id: `entity:${entity.id}`,
        kind: "entity",
        title: entity.name,
        body: `${entity.kind}\n${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`,
      });
    }
    for (const script of project.scripts) {
      const users = project.entities.filter((entity) => entity.scriptIds.includes(script.id));
      push({
        id: `script:${script.id}`,
        kind: "script",
        title: script.name,
        body: `${script.code.split("\n").length} lines\n${users.length} user${users.length === 1 ? "" : "s"}`,
      });
      for (const entity of users) {
        edges.push({ id: `${entity.id}->${script.id}`, from: `entity:${entity.id}`, to: `script:${script.id}` });
      }
    }
    for (const asset of project.assets) {
      const users = project.entities.filter((entity) => entity.assetId === asset.id);
      if (users.length === 0) continue;
      push({
        id: `asset:${asset.id}`,
        kind: "asset",
        title: asset.name,
        body: `${asset.type}\n${users.length} instance${users.length === 1 ? "" : "s"}`,
      });
      for (const entity of users) {
        edges.push({ id: `${entity.id}=>${asset.id}`, from: `entity:${entity.id}`, to: `asset:${asset.id}` });
      }
    }
    return { nodes, edges };
  }, [project]);

  const positioned = nodes.map((node) => {
    const offset = offsets[node.id] ?? { dx: 0, dy: 0 };
    return { ...node, x: node.x + offset.dx, y: node.y + offset.dy };
  });
  const byId = new Map(positioned.map((node) => [node.id, node]));

  const onPointerDown = useCallback(
    (event: React.PointerEvent, node: GraphNode) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      const offset = offsets[node.id] ?? { dx: 0, dy: 0 };
      dragRef.current = {
        id: node.id,
        startX: event.clientX,
        startY: event.clientY,
        baseX: offset.dx,
        baseY: offset.dy,
        moved: false,
      };
      suppressClickRef.current = false;
    },
    [offsets],
  );

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3) {
      drag.moved = true;
      suppressClickRef.current = true;
    }
    setOffsets((current) => ({
      ...current,
      [drag.id]: { dx: drag.baseX + (event.clientX - drag.startX), dy: drag.baseY + (event.clientY - drag.startY) },
    }));
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <div className="flex min-h-0 w-full shrink-0 flex-col border-b border-line bg-surface-0 p-2.5 md:h-full md:w-[186px] md:border-b-0 md:border-r">
        <div className="calicode-label px-1.5 pb-2.5">Nodes</div>
        {(
          [
            ["entity", "Entities", project.entities.length],
            ["script", "Scripts", project.scripts.length],
            ["asset", "Assets", project.assets.filter((a) => project.entities.some((e) => e.assetId === a.id)).length],
          ] as const
        ).map(([kind, label, count]) => (
          <div
            key={kind}
            className="mb-1.5 flex items-center gap-2.5 rounded-[7px] border border-line px-2.5 py-2 text-xs text-ink-subtle"
          >
            <span aria-hidden className="h-2 w-2 shrink-0 border border-ink-faint" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <span className="shrink-0 text-[10px] text-ink-subtle">{count}</span>
          </div>
        ))}
        <button
          type="button"
          onClick={onAddEntity}
          className="mt-1.5 rounded-md border border-line py-2 text-[11px] tracking-[0.14em] text-ink-subtle transition-colors hover:text-ink-strong active:border-ink-subtle active:bg-surface-2"
        >
          ADD ENTITY
        </button>
        <p className="mt-3.5 rounded-lg border border-line p-2.5 text-[11px] leading-[1.55] text-ink-subtle">
          Edges follow the project: an entity links to every script it runs and the asset it draws from. Drag a node
          to rearrange.
        </p>
      </div>

      <div
        className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-[radial-gradient(var(--line-strong)_1px,transparent_1px)] [background-size:22px_22px] md:overflow-hidden"
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <svg aria-hidden data-scene-edges className="pointer-events-none absolute inset-0 h-full w-full">
          {edges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + NODE_WIDTH;
            const y1 = from.y + 22;
            const x2 = to.x;
            const y2 = to.y + 22;
            const mid = (x1 + x2) / 2;
            return (
              <path
                key={edge.id}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="var(--ink-faint)"
                strokeWidth={1.5}
              />
            );
          })}
        </svg>

        {positioned.map((node) => {
          const entityId = node.kind === "entity" ? node.id.slice("entity:".length) : null;
          const selected = entityId !== null && entityId === selectedEntityId;
          return (
            <div
              key={node.id}
              style={{ left: node.x, top: node.y, width: NODE_WIDTH }}
              onPointerDown={(event) => onPointerDown(event, node)}
              className={`absolute cursor-grab rounded-[9px] border bg-surface-1 transition-colors active:cursor-grabbing ${
                selected ? "border-ink-subtle bg-surface-2" : "border-line-strong"
              }`}
            >
              <button
                type="button"
                // Keep the title row out of the drag: the container's
                // pointerdown captures the pointer, which retargets the click
                // to the container and the selection handler never fires.
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => entityId && onSelect(selected ? null : entityId)}
                disabled={!entityId}
                className="flex w-full items-center gap-2 border-b border-line px-2.5 py-2 text-left transition-colors enabled:hover:bg-surface-2 enabled:active:bg-surface-3 disabled:cursor-grab"
              >
                <span aria-hidden className="h-[7px] w-[7px] shrink-0 border border-ink-subtle" />
                <span className="min-w-0 flex-1 truncate text-xs font-bold text-ink-strong">{node.title}</span>
              </button>
              <div
                className="whitespace-pre px-2.5 py-2 text-[11px] leading-[1.6] text-ink-subtle"
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  if (entityId) onSelect(selected ? null : entityId);
                }}
              >
                {node.body}
              </div>
            </div>
          );
        })}

        {positioned.length === 0 ? (
          <p className="absolute inset-0 flex items-center justify-center text-xs text-ink-subtle">
            Nothing in this scene yet.
          </p>
        ) : null}
      </div>

      <div className="flex min-h-[220px] max-h-[40%] w-full shrink-0 flex-col border-t border-line bg-surface-0 md:min-h-0 md:max-h-none md:w-[248px] md:border-l md:border-t-0">
        <EntityProperties
          entity={project.entities.find((entity) => entity.id === selectedEntityId) ?? null}
          onChange={(patch) => selectedEntityId && onPatchEntity(selectedEntityId, patch)}
          onRemove={onRemoveEntity}
        />
      </div>
    </div>
  );
}
