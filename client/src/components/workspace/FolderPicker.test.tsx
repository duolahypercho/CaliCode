import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FolderPicker } from "./FolderPicker";

vi.mock("../../lib/desktop", () => ({ isDesktopShell: vi.fn() }));
vi.mock("../../lib/workspace", () => ({
  browseFolders: vi.fn(),
  chooseNativeWorkspace: vi.fn(),
}));

import { isDesktopShell } from "../../lib/desktop";
import { browseFolders, chooseNativeWorkspace } from "../../lib/workspace";

const mockIsDesktopShell = vi.mocked(isDesktopShell);
const mockBrowseFolders = vi.mocked(browseFolders);
const mockChooseNativeWorkspace = vi.mocked(chooseNativeWorkspace);

beforeEach(() => {
  mockIsDesktopShell.mockReturnValue(false);
  mockBrowseFolders.mockResolvedValue({
    path: "/Users/dev",
    parent: "/Users",
    dirs: [{ name: "code", path: "/Users/dev/code", isProject: true }],
  });
  mockChooseNativeWorkspace.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FolderPicker", () => {
  it("uses the native directory grant in the desktop shell", async () => {
    mockIsDesktopShell.mockReturnValue(true);
    mockChooseNativeWorkspace.mockResolvedValue("/Users/dev/protected-game");
    const onChange = vi.fn();

    render(<FolderPicker value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Add a folder/ }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("/Users/dev/protected-game"));
    expect(mockChooseNativeWorkspace).toHaveBeenCalledOnce();
    expect(mockBrowseFolders).not.toHaveBeenCalled();
  });

  it("keeps the RPC folder browser for the web client", async () => {
    const onChange = vi.fn();

    render(<FolderPicker value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Add a folder/ }));

    expect(await screen.findByRole("button", { name: "code" })).toBeTruthy();
    expect(mockBrowseFolders).toHaveBeenCalledWith(undefined);
    expect(mockChooseNativeWorkspace).not.toHaveBeenCalled();
  });

  it("surfaces native picker failures without changing the folder", async () => {
    mockIsDesktopShell.mockReturnValue(true);
    mockChooseNativeWorkspace.mockRejectedValue(new Error("folder access denied"));
    const onChange = vi.fn();

    render(<FolderPicker value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Add a folder/ }));

    expect((await screen.findByRole("alert")).textContent).toContain("folder access denied");
    expect(onChange).not.toHaveBeenCalled();
  });
});
