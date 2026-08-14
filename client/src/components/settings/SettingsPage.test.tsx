import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsPage, type SettingsPageProps } from "./SettingsPage";
import type { ModelList } from "../../lib/types";

vi.mock("../../lib/rpc", () => ({ rpc: vi.fn() }));

import { rpc } from "../../lib/rpc";

const mockRpc = vi.mocked(rpc);
const originalTauriInternals = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
const originalNavigatorPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");

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
    {
      id: "codex-router",
      label: "Codex Router",
      base_url: "http://127.0.0.1:4317/v1",
      api_key_env: "CALI_CODEX_ROUTER_API_KEY",
      models: ["gpt-5"],
    },
  ],
};

let archivedSessions: {
  id: string;
  title: string;
  projectSlug: string;
  provider: null;
  model: null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number;
  messageCount: number;
}[] = [];

const defaultProps = (): SettingsPageProps => ({
  open: true,
  onClose: vi.fn(),
  modelList,
  onChanged: vi.fn(),
  projectSlug: "starter",
  theme: "dark",
  onThemeChange: vi.fn(),
});

beforeEach(() => {
  archivedSessions = [
    {
      id: "sess-archived",
      title: "Tune jump physics",
      projectSlug: "starter",
      provider: null,
      model: null,
      createdAt: Math.floor(Date.now() / 1000) - 900,
      updatedAt: Math.floor(Date.now() / 1000) - 600,
      archivedAt: Math.floor(Date.now() / 1000) - 120,
      messageCount: 4,
    },
  ];
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  mockRpc.mockImplementation(async (method: string) => {
    switch (method) {
      case "ping":
        return { pong: true, version: "0.1.0" };
      case "skill_list":
        return { skills: [] };
      case "mcp_list":
        return { servers: [] };
      case "usage_stats":
        return { since: 0, models: [], totals: {} };
      case "config.read":
        return { mcp_servers: [] };
      case "session_list":
        return archivedSessions;
      case "session_restore":
        return archivedSessions[0];
      case "session_delete":
        return { id: archivedSessions[0]?.id, deleted: true };
      case "model_provider_upsert":
        return { ...modelList, apiKeyEnv: "CALI_MY_ROUTER_API_KEY", keyApplied: true };
      default:
        throw new Error(`unexpected rpc: ${method}`);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (originalTauriInternals) Object.defineProperty(window, "__TAURI_INTERNALS__", originalTauriInternals);
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  if (originalNavigatorPlatform) Object.defineProperty(navigator, "platform", originalNavigatorPlatform);
});

describe("SettingsPage", () => {
  it("renders a full-page settings surface with all seven accessible sections", async () => {
    const props = defaultProps();
    const { container } = render(<SettingsPage {...props} />);

    expect(container.querySelector("[data-settings-page]")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("main", { name: "General" })).toBeTruthy();
    const workspaceBack = screen.getByRole("button", { name: "Back to workspace" });
    expect(workspaceBack.className).toContain("h-7");
    expect(workspaceBack.className).toContain("translate-y-px");
    expect(workspaceBack.className).toContain("text-[13px]");
    expect(workspaceBack.className).toContain("font-semibold");
    const titlebar = workspaceBack.closest("[data-tauri-drag-region]");
    expect(titlebar?.className).toContain("h-10");
    expect(titlebar?.className).toContain("pl-[80px]");
    expect(container.querySelector("[data-settings-page]")?.className).toContain("overflow-hidden");
    const settingsMain = screen.getByRole("main", { name: "General" });
    expect(settingsMain.className).toContain("overflow-x-hidden");
    expect(settingsMain.className).toContain("[scrollbar-width:none]");

    const tabs = screen.getByRole("tablist", { name: "Settings sections" });
    expect(within(tabs).getAllByRole("tab")).toHaveLength(7);

    for (const section of ["General", "Status", "Providers", "Skills", "MCP", "Archive", "Theme"]) {
      const tab = within(tabs).getByRole("tab", { name: section });
      expect(tab.getAttribute("id")).toBe(`settings-tab-${section.toLowerCase()}`);
      expect(tab.getAttribute("aria-controls")).toBe(`settings-panel-${section.toLowerCase()}`);
      expect((tab as HTMLButtonElement).disabled).toBe(false);
    }
    expect(within(tabs).getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");

    expect(await screen.findByText("0.1.0")).toBeTruthy();
    expect(screen.getByText("starter")).toBeTruthy();
    expect(screen.getByText("No in-app updater is available")).toBeTruthy();
    expect(screen.getByText(/delivered with the desktop release/)).toBeTruthy();
  });

  it("switches sections through the tab contract and keeps game-specific skills scoped", async () => {
    const props = defaultProps();
    render(<SettingsPage {...props} />);

    for (const section of ["Status", "Providers", "Skills", "MCP", "Archive", "Theme", "General"]) {
      fireEvent.click(screen.getByRole("tab", { name: section }));
      const id = section.toLowerCase();
      const panel = screen.getByRole("tabpanel");
      expect(panel.getAttribute("id")).toBe(`settings-panel-${id}`);
      expect(panel.getAttribute("aria-labelledby")).toBe(`settings-tab-${id}`);
      expect(screen.getByRole("tab", { name: section }).getAttribute("aria-selected")).toBe("true");
    }

    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("skill_list", { projectSlug: "starter" }));
    expect(screen.getByRole("region", { name: "Skills" })).toBeTruthy();
  });

  it("keeps provider credentials transient, password-protected, and honest about OAuth", async () => {
    const props = defaultProps();
    const onChanged = vi.fn();
    props.onChanged = onChanged;
    render(<SettingsPage {...props} />);

    fireEvent.click(screen.getByRole("tab", { name: "Providers" }));
    expect(screen.getByText(/OAuth and account-login flows are not wired|managed by Codex Router outside CaliCode/)).toBeTruthy();

    const apiKey = screen.getByLabelText("API key (optional)") as HTMLInputElement;
    expect(apiKey.getAttribute("type")).toBe("password");
    expect(apiKey.getAttribute("autocomplete")).toBe("off");
    fireEvent.change(screen.getByLabelText("Provider id"), { target: { value: "my-router" } });
    fireEvent.change(screen.getByLabelText("Label (optional)"), { target: { value: "My Router" } });
    fireEvent.change(screen.getByLabelText(/Model id/), { target: { value: "router-model" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.example.com/v1" } });
    fireEvent.change(apiKey, { target: { value: "secret-provider-key" } });

    fireEvent.submit(screen.getByRole("form", { name: "Add or extend a provider" }));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith("model_provider_upsert", {
        id: "my-router",
        label: "My Router",
        baseUrl: "https://api.example.com/v1",
        apiKey: "secret-provider-key",
        models: ["router-model"],
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(apiKey.value).toBe("");
    expect(screen.getByRole("status").textContent ?? "").not.toContain("secret-provider-key");
    expect(screen.getByText(/was not written to disk/)).toBeTruthy();
  });

  it("preserves an unfinished provider form while visiting another section", () => {
    render(<SettingsPage {...defaultProps()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Providers" }));
    fireEvent.change(screen.getByLabelText("Provider id"), { target: { value: "game-model-host" } });
    fireEvent.change(screen.getByLabelText(/Model id/), { target: { value: "level-design-v2" } });

    fireEvent.click(screen.getByRole("tab", { name: "Theme" }));
    fireEvent.click(screen.getByRole("tab", { name: "Providers" }));

    expect((screen.getByLabelText("Provider id") as HTMLInputElement).value).toBe("game-model-host");
    expect((screen.getByLabelText(/Model id/) as HTMLInputElement).value).toBe("level-design-v2");
  });

  it("supports Escape, explicit back/close controls, and unmounts when closed", () => {
    const props = defaultProps();
    const onClose = vi.fn();
    props.onClose = onClose;
    const { container, rerender } = render(<SettingsPage {...props} />);
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalledTimes(3);

    rerender(<SettingsPage {...props} open={false} />);
    expect(container.querySelector("[data-settings-page]")).toBeNull();
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.body.style.overflow).toBe("");
  });

  it("reports theme choices through pressed buttons", () => {
    const props = defaultProps();
    const onThemeChange = vi.fn();
    props.onThemeChange = onThemeChange;
    const { rerender } = render(<SettingsPage {...props} />);

    fireEvent.click(screen.getByRole("tab", { name: "Theme" }));
    const themeGroup = screen.getByRole("group", { name: "Theme" });
    const light = within(themeGroup).getByRole("button", { name: /Light/ });
    const dark = within(themeGroup).getByRole("button", { name: /Dark/ });
    expect(dark.getAttribute("aria-pressed")).toBe("true");
    expect(light.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(light);
    expect(onThemeChange).toHaveBeenCalledWith("light");
    rerender(<SettingsPage {...props} theme="light" onThemeChange={onThemeChange} />);
    expect(
      within(screen.getByRole("group", { name: "Theme" })).getByRole("button", { name: /Light/ }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  /* The archive is the only home for an archived chat: the sidebar hides it,
     so if these two actions are missing it is unreachable and undeletable. */
  it("lists archived chats and restores one back into the sidebar", async () => {
    const props = defaultProps();
    const onSessionsChanged = vi.fn();
    props.onSessionsChanged = onSessionsChanged;
    render(<SettingsPage {...props} />);

    fireEvent.click(screen.getByRole("tab", { name: "Archive" }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("session_list", { archived: true }));
    expect(await screen.findByText("Tune jump physics")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Restore Tune jump physics" }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("session_restore", { id: "sess-archived" }));
    await waitFor(() => expect(onSessionsChanged).toHaveBeenCalled());
    expect(screen.queryByText("Tune jump physics")).toBeNull();
  });

  it("deletes an archived chat for good only after the confirmation", async () => {
    render(<SettingsPage {...defaultProps()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Archive" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Tune jump physics" }));
    expect(mockRpc).not.toHaveBeenCalledWith("session_delete", expect.anything());

    // Cancelling leaves the chat archived rather than half-deleted.
    fireEvent.click(screen.getByRole("button", { name: "Keep Tune jump physics archived" }));
    expect(mockRpc).not.toHaveBeenCalledWith("session_delete", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "Delete Tune jump physics" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Tune jump physics permanently" }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("session_delete", { id: "sess-archived" }));
    await waitFor(() => expect(screen.queryByText("Tune jump physics")).toBeNull());
  });

  it("says the archive is empty rather than showing a bare panel", async () => {
    archivedSessions = [];
    render(<SettingsPage {...defaultProps()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Archive" }));
    expect(await screen.findByText("Nothing archived")).toBeTruthy();
  });
});
