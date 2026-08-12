import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./rpc", () => ({ rpc: vi.fn() }));

import { rpc } from "./rpc";
import {
  cancelGraph,
  graphStatus,
  layoutLayers,
  listGraphs,
  listTemplates,
  planGraph,
  unwrapGraph,
  type GraphNode,
  type TaskGraph,
} from "./graph";

const mockRpc = vi.mocked(rpc);

function node(id: string, deps: string[] = [], patch: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    title: id,
    kind: "build",
    role: "coder",
    instructions: "",
    acceptance: [],
    maxTurns: 8,
    deps,
    status: "pending",
    attempts: 0,
    punchList: [],
    ...patch,
  };
}

function graph(nodes: GraphNode[]): TaskGraph {
  return {
    schemaVersion: 1,
    graphId: "graph-test",
    goal: "test goal",
    nodes,
    status: "planning",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("layoutLayers", () => {
  it("places a linear chain into one node per layer", () => {
    const layers = layoutLayers(graph([node("a"), node("b", ["a"]), node("c", ["b"])]));
    expect(layers).toEqual([["a"], ["b"], ["c"]]);
  });

  it("layers a diamond by depth and keeps declaration order within a layer", () => {
    const layers = layoutLayers(
      graph([node("root"), node("left", ["root"]), node("right", ["root"]), node("join", ["left", "right"])]),
    );
    expect(layers).toEqual([["root"], ["left", "right"], ["join"]]);
  });

  it("puts independent roots in the first layer", () => {
    const layers = layoutLayers(graph([node("a"), node("b"), node("c", ["a", "b"])]));
    expect(layers).toEqual([["a", "b"], ["c"]]);
  });

  it("ignores unknown deps and self deps", () => {
    const layers = layoutLayers(graph([node("a", ["ghost", "a"]), node("b", ["a"])]));
    expect(layers).toEqual([["a"], ["b"]]);
  });

  it("does not loop on a cycle and lists every node exactly once", () => {
    const layers = layoutLayers(graph([node("a", ["b"]), node("b", ["a"])]));
    const flat = layers.flat().sort();
    expect(flat).toEqual(["a", "b"]);
  });

  it("returns no layers for an empty graph", () => {
    expect(layoutLayers(graph([]))).toEqual([]);
  });

  it("matches the aaa-fps template shape (deep pipeline ends at the judge)", () => {
    const layers = layoutLayers(
      graph([
        node("design"),
        node("blockout", ["design"]),
        node("player", ["design", "blockout"]),
        node("combat", ["player"]),
        node("polish", ["blockout", "combat"]),
        node("judge", ["player", "combat", "polish"], { kind: "judge" }),
      ]),
    );
    expect(layers).toEqual([["design"], ["blockout"], ["player"], ["combat"], ["polish"], ["judge"]]);
  });
});

describe("unwrapGraph", () => {
  it("passes a bare TaskGraph through", () => {
    const g = graph([node("a")]);
    expect(unwrapGraph(g)).toBe(g);
  });

  it("unwraps a { graph } envelope", () => {
    const g = graph([node("a")]);
    expect(unwrapGraph({ graph: g })).toBe(g);
  });
});

describe("rpc wrappers", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("planGraph sends only the provided params and unwraps the result", async () => {
    const g = graph([node("a")]);
    mockRpc.mockResolvedValueOnce({ graph: g });
    const result = await planGraph({ goal: "build it", slug: "demo" });
    expect(mockRpc).toHaveBeenCalledWith("graph_plan", { goal: "build it", slug: "demo" });
    expect(result).toBe(g);
  });

  it("planGraph forwards the editor session and workspace binding", async () => {
    const g = graph([node("a")]);
    mockRpc.mockResolvedValueOnce(g);
    await planGraph({
      goal: "build it",
      slug: "demo",
      ownerSession: "session-owner",
      workspaceRoot: "/tmp/demo-worktree",
    });
    expect(mockRpc).toHaveBeenCalledWith("graph_plan", {
      goal: "build it",
      slug: "demo",
      ownerSession: "session-owner",
      workspaceRoot: "/tmp/demo-worktree",
    });
  });

  it("graphStatus accepts a bare graph result", async () => {
    const g = graph([node("a")]);
    mockRpc.mockResolvedValueOnce(g);
    expect(await graphStatus("graph-test")).toBe(g);
    expect(mockRpc).toHaveBeenCalledWith("graph_status", { graphId: "graph-test" });
  });

  it("listGraphs unwraps { graphs } and passes the slug filter", async () => {
    mockRpc.mockResolvedValueOnce({ graphs: [{ graphId: "g1" }] });
    const rows = await listGraphs("demo");
    expect(mockRpc).toHaveBeenCalledWith("graph_list", { slug: "demo" });
    expect(rows).toEqual([{ graphId: "g1" }]);
  });

  it("listGraphs omits the slug when absent and tolerates a bare array", async () => {
    mockRpc.mockResolvedValueOnce([{ graphId: "g1" }]);
    const rows = await listGraphs();
    expect(mockRpc).toHaveBeenCalledWith("graph_list", {});
    expect(rows).toEqual([{ graphId: "g1" }]);
  });

  it("cancelGraph posts the graphId", async () => {
    mockRpc.mockResolvedValueOnce({});
    await cancelGraph("graph-test");
    expect(mockRpc).toHaveBeenCalledWith("graph_cancel", { graphId: "graph-test" });
  });

  it("listTemplates unwraps { templates }", async () => {
    mockRpc.mockResolvedValueOnce({ templates: [{ id: "aaa-fps", name: "AAA FPS", description: "d" }] });
    expect(await listTemplates()).toEqual([{ id: "aaa-fps", name: "AAA FPS", description: "d" }]);
  });
});
