import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./rpc", () => ({ rpc: vi.fn() }));

import { rpc } from "./rpc";
import {
  listMcpServers,
  listSkills,
  readSkill,
  reloadMcp,
  setMcpEnabled,
  setSkillEnabled,
} from "./extensions";

const mockRpc = vi.mocked(rpc);

describe("skills rpc wrappers", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it("listSkills passes the project slug and unwraps { skills }", async () => {
    const skills = [{ name: "blockout", description: "d", scope: "project", path: "/p", enabled: true }];
    mockRpc.mockResolvedValueOnce({ skills });
    expect(await listSkills("demo")).toEqual(skills);
    expect(mockRpc).toHaveBeenCalledWith("skill_list", { projectSlug: "demo" });
  });

  it("listSkills omits the slug when absent and tolerates a missing list", async () => {
    mockRpc.mockResolvedValueOnce({});
    expect(await listSkills()).toEqual([]);
    expect(mockRpc).toHaveBeenCalledWith("skill_list", {});
  });

  it("setSkillEnabled posts scope, name and enabled", async () => {
    mockRpc.mockResolvedValueOnce({ disabled: [] });
    await setSkillEnabled("global", "unreal-naming", false);
    expect(mockRpc).toHaveBeenCalledWith("skill_set_enabled", {
      scope: "global",
      name: "unreal-naming",
      enabled: false,
    });
  });

  it("readSkill sends the name plus optional slug", async () => {
    mockRpc.mockResolvedValueOnce({ name: "x", scope: "global", path: "/p", instructions: "body" });
    expect(await readSkill("x")).toEqual({ name: "x", scope: "global", path: "/p", instructions: "body" });
    expect(mockRpc).toHaveBeenCalledWith("skill_read", { name: "x" });

    mockRpc.mockResolvedValueOnce({ name: "x", scope: "project", path: "/p", instructions: "body" });
    await readSkill("x", "demo");
    expect(mockRpc).toHaveBeenLastCalledWith("skill_read", { name: "x", projectSlug: "demo" });
  });
});

describe("mcp rpc wrappers", () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  const servers = [{ id: "blender", command: "uvx", trust: false, status: "running", tools: [] }];

  it("listMcpServers unwraps { servers }", async () => {
    mockRpc.mockResolvedValueOnce({ servers });
    expect(await listMcpServers()).toEqual(servers);
    expect(mockRpc).toHaveBeenCalledWith("mcp_list");
  });

  it("setMcpEnabled posts id + enabled and returns the fresh reports", async () => {
    mockRpc.mockResolvedValueOnce({ servers });
    expect(await setMcpEnabled("blender", false)).toEqual(servers);
    expect(mockRpc).toHaveBeenCalledWith("mcp_set_enabled", { id: "blender", enabled: false });
  });

  it("reloadMcp returns the fresh reports and tolerates a missing list", async () => {
    mockRpc.mockResolvedValueOnce({ servers });
    expect(await reloadMcp()).toEqual(servers);
    expect(mockRpc).toHaveBeenCalledWith("mcp_reload");

    mockRpc.mockResolvedValueOnce(undefined);
    expect(await reloadMcp()).toEqual([]);
  });
});
