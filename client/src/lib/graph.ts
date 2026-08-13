// Client surface for the GRAPH ENGINEER (docs/plans/graph-engineer.md §5):
// typed mirrors of core/src/graph.rs, thin rpc wrappers over the graph_* RPC
// methods, and the pure `layoutLayers` used by GraphPanel to place nodes.

import { rpc } from "./rpc";

export type NodeKind = "build" | "judge";

export type NodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "monitoring"
  | "passed"
  | "rejected"
  | "failed"
  | "skipped";

export type GraphStatus = "planning" | "running" | "complete" | "blocked" | "cancelled";

/** Core's default judge pass bar (graph.rs DEFAULT_JUDGE_THRESHOLD). */
export const DEFAULT_JUDGE_THRESHOLD = 90;

export interface GraphNode {
  id: string;
  title: string;
  kind: NodeKind;
  role: string;
  instructions: string;
  acceptance: string[];
  reference?: string | null;
  threshold?: number | null;
  maxTurns: number;
  deps: string[];
  status: NodeStatus;
  attempts: number;
  score?: number | null;
  punchList: string[];
  lastReport?: string | null;
  sessionId?: string | null;
  /** Project-relative paths for persisted visual evidence from the attempt. */
  evidencePaths?: string[];
  /** Number of valid visual frames represented by the persisted evidence. */
  evidenceCount?: number;
  /** Attempt number that produced the current evidence metadata. */
  evidenceAttempt?: number | null;
}

export interface TaskGraph {
  schemaVersion: number;
  graphId: string;
  goal: string;
  template?: string | null;
  projectSlug?: string | null;
  ownerSession?: string | null;
  workspaceRoot?: string | null;
  nodes: GraphNode[];
  status: GraphStatus;
  createdAt: string;
  updatedAt: string;
}

/** Payload of a `type === "graph.updated"` SSE event (full snapshot). */
export interface GraphEvent {
  graphId: string;
  phase: string;
  nodeId?: string;
  extra?: Record<string, unknown>;
  graph: TaskGraph;
}

/** Summary row from `graph_list`. */
export interface GraphSummary {
  graphId: string;
  goal: string;
  template?: string | null;
  projectSlug?: string | null;
  status: GraphStatus;
  nodeCounts: { passed: number; running: number; failed: number; total: number };
  updatedAt: string;
}

/** Terminal rollup returned by `graph_run`. */
export interface GraphRollup {
  graphId: string;
  status: GraphStatus;
  passed: number;
  failed: number;
  totalAttempts: number;
  nodes: unknown[];
}

export interface GraphTemplateInfo {
  id: string;
  name: string;
  description: string;
  nodeCount?: number;
}

/**
 * Core handlers may return the TaskGraph bare or wrapped as `{ graph }` —
 * accept both so the client survives either shape.
 */
export function unwrapGraph(value: unknown): TaskGraph {
  if (value && typeof value === "object" && "graph" in value) {
    const inner = (value as { graph?: unknown }).graph;
    if (inner && typeof inner === "object") return inner as TaskGraph;
  }
  return value as TaskGraph;
}

export async function planGraph(args: {
  goal: string;
  slug?: string;
  template?: string;
  nodes?: unknown[];
  ownerSession?: string;
  workspaceRoot?: string;
}): Promise<TaskGraph> {
  const params: Record<string, unknown> = { goal: args.goal };
  if (args.slug) params.slug = args.slug;
  if (args.template) params.template = args.template;
  if (args.nodes) params.nodes = args.nodes;
  if (args.ownerSession) params.ownerSession = args.ownerSession;
  if (args.workspaceRoot) params.workspaceRoot = args.workspaceRoot;
  return unwrapGraph(await rpc<unknown>("graph_plan", params));
}

/**
 * Resolves only when the graph reaches a terminal state — long-running.
 *
 * `ownerSession` is the calling panel's own session, and core moves the graph
 * onto it (`core/src/graph.rs::run`). Graphs are listed globally, so this call
 * is reachable for a graph another window planned; the run's approval prompts
 * are addressed to the graph's owner, and they have to reach the window that
 * asked for the run rather than one that is not expecting them. Core refuses
 * the move — and the run — when that session is bound to a different project
 * or workspace.
 */
export async function runGraph(
  graphId: string,
  options: { ownerSession?: string | null } = {},
): Promise<GraphRollup> {
  const params: Record<string, unknown> = { graphId };
  if (options.ownerSession) params.ownerSession = options.ownerSession;
  return rpc<GraphRollup>("graph_run", params);
}

export async function graphStatus(graphId: string): Promise<TaskGraph> {
  return unwrapGraph(await rpc<unknown>("graph_status", { graphId }));
}

export async function listGraphs(slug?: string): Promise<GraphSummary[]> {
  const result = await rpc<unknown>("graph_list", slug ? { slug } : {});
  if (Array.isArray(result)) return result as GraphSummary[];
  return (result as { graphs?: GraphSummary[] })?.graphs ?? [];
}

export async function cancelGraph(graphId: string): Promise<void> {
  await rpc("graph_cancel", { graphId });
}

export async function listTemplates(): Promise<GraphTemplateInfo[]> {
  const result = await rpc<{ templates?: GraphTemplateInfo[] }>("template_list");
  return result?.templates ?? [];
}

/**
 * Topological layering for render: node ids grouped by dependency depth
 * (layer 0 = roots, layer n = 1 + deepest dep). Declaration order is kept
 * within a layer. Defensive against bad input: unknown deps and self-deps
 * are ignored, cycles are broken at the back edge instead of looping, and
 * every node appears exactly once. Empty layers are compacted out.
 */
export function layoutLayers(graph: TaskGraph): string[][] {
  const ids = graph.nodes.map((node) => node.id);
  const idSet = new Set(ids);
  const depsOf = new Map(
    graph.nodes.map((node) => [node.id, node.deps.filter((dep) => dep !== node.id && idSet.has(dep))]),
  );

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const compute = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // cycle: break at the back edge
    visiting.add(id);
    const deps = depsOf.get(id) ?? [];
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(compute));
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };

  const layers: string[][] = [];
  for (const id of ids) {
    const d = compute(id);
    (layers[d] ??= []).push(id);
  }
  return layers.filter((layer) => layer !== undefined && layer.length > 0);
}
