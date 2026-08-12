import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsDialog } from "./SettingsDialog";
import type { ModelList } from "../../lib/types";

vi.mock("../../lib/rpc", () => ({ rpc: vi.fn() }));

import { rpc } from "../../lib/rpc";

const mockRpc = vi.mocked(rpc);

const modelList: ModelList = {
  active: { provider: "anthropic", model: "claude-fable-5", baseUrl: "https://api.anthropic.com" },
  providers: [
    {
      id: "anthropic",
      label: "Anthropic",
      base_url: "https://api.anthropic.com",
      api_key_env: "ANTHROPIC_API_KEY",
      models: ["claude-fable-5"],
    },
  ],
};

const skills = [
  {
    name: "level-design",
    description: "Layout guidance",
    scope: "global",
    path: "/home/user/.cali/skills/level-design.md",
    enabled: true,
    error: null,
  },
  {
    name: "shader-tricks",
    description: "GLSL patterns",
    scope: "project",
    path: "/games/demo/.cali/skills/shader-tricks.md",
    enabled: false,
    error: null,
  },
];

const servers = [
  {
    id: "blender",
    command: "uvx blender-mcp",
    trust: false,
    status: "running",
    error: null,
    tools: [{ remoteName: "render", namespaced: "mcp__blender__render", description: "Render the scene" }],
  },
];

beforeEach(() => {
  mockRpc.mockImplementation(async (method: string) => {
    switch (method) {
      case "skill_list":
        return { skills };
      case "skill_set_enabled":
        return {};
      case "mcp_list":
      case "mcp_set_enabled":
        return { servers };
      default:
        throw new Error(`unexpected rpc: ${method}`);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog() {
  render(
    <SettingsDialog
      open
      onOpenChange={() => undefined}
      modelList={modelList}
      onChanged={() => undefined}
      projectSlug="demo"
    />,
  );
}

describe("SettingsDialog", () => {
  it("preserves the provider form state across tab switches", async () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText(/Model id/), { target: { value: "gpt-4.1-mini" } });
    fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: "https://api.example.com/v1" } });

    fireEvent.click(screen.getByRole("tab", { name: "SKILLS" }));
    await screen.findByText("level-design");
    expect(screen.queryByLabelText(/Model id/)).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "PROVIDERS" }));
    expect((screen.getByLabelText(/Model id/) as HTMLInputElement).value).toBe("gpt-4.1-mini");
    expect((screen.getByLabelText(/Base URL/) as HTMLInputElement).value).toBe("https://api.example.com/v1");
  });

  it("renders skill rows from rpc and toggles via skill_set_enabled", async () => {
    renderDialog();

    fireEvent.click(screen.getByRole("tab", { name: "SKILLS" }));
    expect(await screen.findByText("level-design")).toBeTruthy();
    expect(screen.getByText("shader-tricks")).toBeTruthy();
    expect(mockRpc).toHaveBeenCalledWith("skill_list", { projectSlug: "demo" });

    fireEvent.click(screen.getByRole("checkbox", { name: "Enable skill shader-tricks" }));
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith("skill_set_enabled", {
        scope: "project",
        name: "shader-tricks",
        enabled: true,
      }),
    );
  });

  it("renders MCP server rows from rpc and toggles via mcp_set_enabled", async () => {
    renderDialog();

    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    expect(await screen.findByText("blender")).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 tool" })).toBeTruthy();
    expect(mockRpc).toHaveBeenCalledWith("mcp_list");

    fireEvent.click(screen.getByRole("checkbox", { name: "Enable MCP server blender" }));
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith("mcp_set_enabled", { id: "blender", enabled: false }),
    );
  });
});
