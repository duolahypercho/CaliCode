import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTree } from "./FileTree";
import * as workspace from "../../lib/workspace";

/**
 * Guards the CODE tab against the failure that produced ~197 /rpc calls in
 * 10.6s: a rejected workspace RPC fed an onError whose identity changed on
 * every render, which re-ran the loading effect, which failed again.
 */
describe("FileTree", () => {
  afterEach(() => {
    // vitest.config.ts does not set `globals`, so testing-library never
    // registers its own afterEach and each render would otherwise stack up.
    cleanup();
    vi.restoreAllMocks();
  });

  const rejectTree = (message = "workspace ws-1 is not open") =>
    vi.spyOn(workspace, "readTree").mockRejectedValue(new Error(message));

  it("shows the failure with a retry instead of loading forever", async () => {
    const readTree = rejectTree();

    render(
      <FileTree workspaceId="ws-1" activePath={null} onOpenFile={() => {}} onError={() => {}} />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("workspace ws-1 is not open");
    expect(screen.getByRole("button", { name: "RETRY" })).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(readTree).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one request when the load fails", async () => {
    const readTree = rejectTree();

    render(
      <FileTree workspaceId="ws-1" activePath={null} onOpenFile={() => {}} onError={() => {}} />,
    );

    await screen.findByRole("alert");
    // Long enough for a retry storm to show up if the effect were re-arming.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(readTree).toHaveBeenCalledTimes(1);
  });

  it("does not re-request when onError logging re-renders the parent", async () => {
    const readTree = rejectTree();

    // Mirrors App: the error handler updates parent state, and the prop is a
    // fresh arrow on every render. That combination used to be the loop.
    function Host() {
      const [errors, setErrors] = useState<string[]>([]);
      return (
        <>
          <span data-testid="count">{errors.length}</span>
          <FileTree
            workspaceId="ws-1"
            activePath={null}
            onOpenFile={() => {}}
            onError={(text) => setErrors((current) => [...current, text])}
          />
        </>
      );
    }

    render(<Host />);

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(readTree).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("count").textContent).toBe("1");
  });

  it("retries once per click and recovers", async () => {
    const readTree = vi
      .spyOn(workspace, "readTree")
      .mockRejectedValueOnce(new Error("workspace ws-1 is not open"))
      .mockResolvedValueOnce({
        path: "",
        entries: [{ name: "src", path: "src", kind: "dir", size: 0 }],
      });

    render(
      <FileTree workspaceId="ws-1" activePath={null} onOpenFile={() => {}} onError={() => {}} />,
    );

    const retry = await screen.findByRole("button", { name: "RETRY" });
    retry.click();

    await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(readTree).toHaveBeenCalledTimes(2);
  });
});
