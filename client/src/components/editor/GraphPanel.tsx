import { useMemo, useState } from "react";
import {
  DEFAULT_JUDGE_THRESHOLD,
  layoutLayers,
  type GraphNode,
  type GraphStatus,
  type NodeStatus,
  type TaskGraph,
} from "../../lib/graph";

const CARD_W = 200;
const CARD_H = 118;
const COL_GAP = 64;
const ROW_GAP = 24;
const PAD = 24;

// Blueprint color map (graph-engineer.md §6): pending gray, ready slate,
// running pulse-blue, monitoring amber, passed green, rejected orange,
// failed red, skipped dim.
const STATUS_STYLES: Record<NodeStatus, string> = {
  pending: "border-line bg-surface-2 text-ink-faint",
  ready: "border-line bg-surface-2 text-slate-400",
  running: "animate-pulse border-sky-500/40 bg-sky-500/15 text-sky-400",
  monitoring: "border-amber-500/40 bg-amber-500/15 text-amber-400",
  passed: "border-emerald-500/40 bg-emerald-500/15 text-emerald-400",
  rejected: "border-orange-500/40 bg-orange-500/15 text-orange-400",
  failed: "border-red-500/40 bg-red-500/15 text-red-400",
  skipped: "border-line bg-surface-1 text-ink-faint opacity-60",
};

const GRAPH_STATUS_STYLES: Record<GraphStatus, string> = {
  planning: "border-line bg-surface-2 text-ink-subtle",
  running: "animate-pulse border-sky-500/40 bg-sky-500/15 text-sky-400",
  complete: "border-emerald-500/40 bg-emerald-500/15 text-emerald-400",
  blocked: "border-red-500/40 bg-red-500/15 text-red-400",
  cancelled: "border-line bg-surface-2 text-ink-faint",
};

export interface GraphPanelProps {
  graph: TaskGraph;
  onCancel: (graphId: string) => void;
  /** `graph_run` again — offered on blocked graphs. */
  onRerun: (graphId: string) => void;
  onSelectNode?: (node: GraphNode) => void;
  /** Optional per-node live output ticker (last ~200 chars), keyed by node id. */
  tickers?: Record<string, string>;
}

/**
 * Layered DAG view of a running TaskGraph: columns from `layoutLayers`,
 * bezier edges dep→node (same path math as SceneGraphCanvas), a status pill
 * and score badge per card, and a punch-list drawer for the selected node.
 * Purely presentational — the graph snapshot arrives via props from the
 * `graph.updated` SSE events.
 */
export function GraphPanel({ graph, onCancel, onRerun, onSelectNode, tickers }: GraphPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { positions, width, height, edges } = useMemo(() => {
    const layers = layoutLayers(graph);
    const positions = new Map<string, { x: number; y: number }>();
    layers.forEach((layer, col) => {
      layer.forEach((id, row) => {
        positions.set(id, { x: PAD + col * (CARD_W + COL_GAP), y: PAD + row * (CARD_H + ROW_GAP) });
      });
    });
    const cols = Math.max(1, layers.length);
    const maxRows = layers.reduce((most, layer) => Math.max(most, layer.length), 1);
    const width = PAD * 2 + cols * CARD_W + (cols - 1) * COL_GAP;
    const height = PAD * 2 + maxRows * CARD_H + (maxRows - 1) * ROW_GAP;

    const edges: Array<{ id: string; x1: number; y1: number; x2: number; y2: number }> = [];
    for (const node of graph.nodes) {
      const to = positions.get(node.id);
      if (!to) continue;
      for (const dep of node.deps) {
        const from = positions.get(dep);
        if (!from) continue;
        edges.push({
          id: `${dep}->${node.id}`,
          x1: from.x + CARD_W,
          y1: from.y + CARD_H / 2,
          x2: to.x,
          y2: to.y + CARD_H / 2,
        });
      }
    }
    return { positions, width, height, edges };
  }, [graph]);

  const selected = graph.nodes.find((node) => node.id === selectedId) ?? null;

  return (
    <div className="flex min-h-0 flex-col border-b border-line bg-surface-0">
      <div className="flex items-center gap-2.5 border-b border-line px-3 py-2">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-subtle">Graph</span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink" title={graph.goal}>
          {graph.goal}
        </span>
        <span
          className={`shrink-0 rounded border px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em] ${GRAPH_STATUS_STYLES[graph.status]}`}
        >
          {graph.status}
        </span>
        {graph.status === "running" ? (
          <button
            type="button"
            onClick={() => onCancel(graph.graphId)}
            className="shrink-0 rounded border border-red-500/40 px-2 py-[3px] text-[10px] tracking-[0.14em] text-red-400 transition-colors hover:bg-red-500/10 focus-visible:outline-none"
          >
            STOP
          </button>
        ) : null}
        {graph.status === "blocked" ? (
          <button
            type="button"
            onClick={() => onRerun(graph.graphId)}
            className="shrink-0 rounded border border-line px-2 py-[3px] text-[10px] tracking-[0.14em] text-ink-subtle transition-colors hover:text-ink-strong focus-visible:outline-none"
          >
            RE-RUN
          </button>
        ) : null}
      </div>

      <div className="relative min-w-0 overflow-x-auto">
        <div
          className="relative bg-[radial-gradient(var(--line-strong)_1px,transparent_1px)] [background-size:22px_22px]"
          style={{ width, height, minWidth: width }}
        >
          <svg aria-hidden data-graph-edges className="pointer-events-none absolute inset-0 h-full w-full">
            {edges.map((edge) => {
              const mid = (edge.x1 + edge.x2) / 2;
              return (
                <path
                  key={edge.id}
                  d={`M ${edge.x1} ${edge.y1} C ${mid} ${edge.y1}, ${mid} ${edge.y2}, ${edge.x2} ${edge.y2}`}
                  fill="none"
                  stroke="#5a5a5a"
                  strokeWidth={1.5}
                />
              );
            })}
          </svg>

          {graph.nodes.map((node) => {
            const pos = positions.get(node.id);
            if (!pos) return null;
            const threshold = node.threshold ?? DEFAULT_JUDGE_THRESHOLD;
            const scorePassing = node.score != null && node.score >= threshold;
            const ticker = tickers?.[node.id];
            return (
              <button
                key={node.id}
                type="button"
                style={{ left: pos.x, top: pos.y, width: CARD_W, height: CARD_H }}
                onClick={() => {
                  setSelectedId((current) => (current === node.id ? null : node.id));
                  onSelectNode?.(node);
                }}
                className={`absolute flex flex-col overflow-hidden rounded-[9px] border bg-surface-1 text-left transition-colors focus-visible:outline-none ${
                  selectedId === node.id ? "border-ink-subtle bg-surface-2" : "border-line-strong hover:bg-surface-2"
                }`}
              >
                <span className="flex w-full items-center gap-2 border-b border-line px-2.5 py-2">
                  <span aria-hidden className="h-[7px] w-[7px] shrink-0 border border-ink-subtle" />
                  <span className="min-w-0 flex-1 truncate text-xs font-bold text-ink-strong">{node.title}</span>
                  {node.attempts > 1 ? (
                    <span className="shrink-0 text-[10px] text-ink-faint" title={`${node.attempts} attempts`}>
                      ×{node.attempts}
                    </span>
                  ) : null}
                </span>
                <span className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2">
                  <span className="rounded border border-line bg-surface-0 px-1.5 py-[2px] text-[10px] text-ink-subtle">
                    {node.role}
                  </span>
                  <span
                    className={`rounded border px-1.5 py-[2px] text-[10px] uppercase tracking-[0.08em] ${STATUS_STYLES[node.status]}`}
                  >
                    {node.status}
                  </span>
                </span>
                {node.kind === "judge" ? (
                  <span className="flex min-w-0 items-baseline gap-1.5 px-2.5 pt-1.5 text-[11px]">
                    <span className={`shrink-0 font-bold ${scorePassing ? "text-emerald-400" : "text-orange-400"}`}>
                      {node.score ?? "—"}/{threshold}
                    </span>
                    {node.reference ? (
                      <span className="min-w-0 truncate text-[10px] text-ink-faint" title={node.reference}>
                        {node.reference}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {ticker && node.status === "running" ? (
                  <span className="mt-auto block truncate px-2.5 pb-2 font-mono text-[10px] text-ink-faint">
                    {ticker}
                  </span>
                ) : null}
              </button>
            );
          })}

          {graph.nodes.length === 0 ? (
            <p className="absolute inset-0 flex items-center justify-center text-xs text-ink-subtle">
              This graph has no nodes.
            </p>
          ) : null}
        </div>
      </div>

      {selected ? (
        <div className="border-t border-line bg-surface-0 px-3 py-2.5 text-xs" data-graph-drawer>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-bold text-ink-strong">{selected.title}</span>
            <span className="shrink-0 text-[10px] text-ink-faint">
              {selected.role} · attempt {selected.attempts}
            </span>
            <button
              type="button"
              aria-label="Close node details"
              onClick={() => setSelectedId(null)}
              className="shrink-0 rounded border border-line px-1.5 py-[2px] text-[10px] text-ink-subtle transition-colors hover:text-ink-strong focus-visible:outline-none"
            >
              CLOSE
            </button>
          </div>

          <div className="mt-2 grid gap-2.5 md:grid-cols-2">
            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Acceptance criteria</div>
              {selected.acceptance.length === 0 ? (
                <p className="mt-1 text-ink-faint">None recorded.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {selected.acceptance.map((item) => (
                    <li key={item} className="text-ink-subtle">
                      · {item}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Punch list</div>
              {selected.punchList.length === 0 ? (
                <p className="mt-1 text-ink-faint">Nothing outstanding.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {selected.punchList.map((item) => (
                    <li key={item} className="text-orange-400">
                      · {item}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {selected.lastReport ? (
            <div className="mt-2.5">
              <div className="text-[10px] uppercase tracking-[0.14em] text-ink-subtle">Last report</div>
              <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface-1 px-2.5 py-2 text-[11px] leading-[1.55] text-ink-subtle">
                {selected.lastReport}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
