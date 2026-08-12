import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDesktopShell } from "./desktop";
import { rpc } from "./rpc";
import { NATIVE_WORKSPACE_OPEN_TIMEOUT_MS, openWorkspace } from "./workspace";

vi.mock("./desktop", () => ({ isDesktopShell: vi.fn() }));
vi.mock("./rpc", () => ({ rpc: vi.fn() }));

const mockIsDesktopShell = vi.mocked(isDesktopShell);
const mockRpc = vi.mocked(rpc);

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("openWorkspace", () => {
  beforeEach(() => {
    mockIsDesktopShell.mockReturnValue(false);
  });

  it("keeps browser workspace opens on the regular RPC path", async () => {
    const info = { id: "ws-1", name: "Game", root: "/tmp/game", hasPackageJson: true, hasGit: false, scripts: {}, entries: [] };
    mockRpc.mockResolvedValue(info);

    await expect(openWorkspace("/tmp/game")).resolves.toEqual(info);
    expect(mockRpc).toHaveBeenCalledWith("workspace_open", { path: "/tmp/game", name: undefined });
  });

  it("fails fast with recovery guidance when the desktop sidecar cannot access a folder", async () => {
    vi.useFakeTimers();
    mockIsDesktopShell.mockReturnValue(true);
    mockRpc.mockReturnValue(new Promise(() => undefined));

    const pending = openWorkspace("/Users/dev/Protected Game");
    const rejection = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(NATIVE_WORKSPACE_OPEN_TIMEOUT_MS);

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      new RegExp(
        `could not access "/Users/dev/Protected Game" within ${NATIVE_WORKSPACE_OPEN_TIMEOUT_MS}ms.*Privacy & Security`,
      ),
    );
  });

  it("returns a fast core error without replacing it with the timeout guidance", async () => {
    mockIsDesktopShell.mockReturnValue(true);
    mockRpc.mockRejectedValue(new Error("workspace is not a project"));

    await expect(openWorkspace("/tmp/not-a-project")).rejects.toThrow("workspace is not a project");
  });
});
