import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../lib/extensions", () => ({
  listMcpServers: vi.fn(),
  reloadMcp: vi.fn(),
  setMcpEnabled: vi.fn(),
}));

vi.mock("../../lib/coreConfig", () => ({
  readCoreConfig: vi.fn(),
}));

import { listMcpServers, reloadMcp, setMcpEnabled, type McpServerReport } from "../../lib/extensions";
import { readCoreConfig } from "../../lib/coreConfig";
import { McpSection } from "./McpSection";

const mockList = vi.mocked(listMcpServers);
const mockReload = vi.mocked(reloadMcp);
const mockSet = vi.mocked(setMcpEnabled);
const mockConfig = vi.mocked(readCoreConfig);

const server = (patch: Partial<McpServerReport>): McpServerReport => ({
  id: "blender",
  transport: "stdio",
  command: "uvx blender-mcp",
  url: "",
  trust: false,
  status: "running",
  tools: [{ remoteName: "get_scene_info", namespaced: "mcp__blender__get_scene_info", description: "Scene info" }],
  ...patch,
});

afterEach(cleanup);
beforeEach(() => {
  mockList.mockReset();
  mockReload.mockReset();
  mockSet.mockReset();
  mockConfig.mockReset();
  mockConfig.mockResolvedValue({ mcp_servers: [{ id: "blender" }] });
});

describe("McpSection", () => {
  it("renders server rows and expands the namespaced tool list", async () => {
    mockList.mockResolvedValue([server({}), server({ id: "broken", status: "failed", error: "spawn failed", tools: [] })]);
    render(<McpSection />);

    expect(await screen.findByText("blender")).toBeTruthy();
    expect(screen.getByText("spawn failed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "1 tool" }));
    expect(screen.getByText("mcp__blender__get_scene_info")).toBeTruthy();
  });

  it("toggles a server through mcp_set_enabled and shows the fresh reports", async () => {
    mockList.mockResolvedValue([server({})]);
    mockSet.mockResolvedValue([server({ status: "disabled", tools: [] })]);
    render(<McpSection />);

    const toggle = (await screen.findByLabelText("Enable MCP server blender")) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(mockSet).toHaveBeenCalledWith("blender", false);
    expect(((await screen.findByLabelText("Enable MCP server blender")) as HTMLInputElement).checked).toBe(false);
  });

  it("reloads all servers from the header button", async () => {
    mockList.mockResolvedValue([]);
    mockReload.mockResolvedValue([server({})]);
    render(<McpSection />);

    expect(await screen.findByText(/No MCP servers configured/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "RELOAD" }));
    expect(mockReload).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("blender")).toBeTruthy();
  });

  it("shows transport, scope badges and the read-only tool filter", async () => {
    mockConfig.mockResolvedValue({
      mcp_servers: [{ id: "blender", tools: { include: ["get_*"], exclude: ["render_*"] } }],
    });
    mockList.mockResolvedValue([
      server({}),
      server({ id: "issues", transport: "http", command: "", url: "http://127.0.0.1:9000/mcp", tools: [] }),
    ]);
    render(<McpSection />);

    expect(await screen.findByText("blender")).toBeTruthy();
    // blender is declared in the global config → global scope + its filter.
    expect((await screen.findAllByText("global")).length).toBe(1);
    expect(screen.getByText("get_*")).toBeTruthy();
    expect(screen.getByText("render_*")).toBeTruthy();
    // issues is absent from the global config → project scope, http transport
    // with the endpoint shown instead of a command.
    expect(screen.getByText("project")).toBeTruthy();
    expect(screen.getByText("http")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:9000/mcp")).toBeTruthy();
  });

  it("surfaces failures from the toggle", async () => {
    mockList.mockResolvedValue([server({})]);
    mockSet.mockRejectedValue(new Error("core offline"));
    render(<McpSection />);

    fireEvent.click(await screen.findByLabelText("Enable MCP server blender"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "core offline");
  });
});
