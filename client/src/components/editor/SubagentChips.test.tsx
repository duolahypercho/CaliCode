import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentChips } from "./SubagentChips";

afterEach(cleanup);

describe("SubagentChips", () => {
  it("renders nothing when no worker has been spawned", () => {
    const { container } = render(<SubagentChips items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows one chip per worker and a trailing status from the newest", () => {
    render(
      <SubagentChips
        items={[
          { id: "node-a", title: "Graph acceptance guard", status: "done" },
          { id: "node-b", title: "Starter test contract", status: "running" },
        ]}
      />,
    );
    expect(screen.getByText("Graph acceptance guard")).toBeTruthy();
    expect(screen.getByText("Starter test contract")).toBeTruthy();
    expect(screen.getByText("started working")).toBeTruthy();
  });

  it("keeps a failed worker visible and marks it", () => {
    render(<SubagentChips items={[{ id: "node-c", title: "Judge", status: "failed" }]} />);
    expect(screen.getByText("failed")).toBeTruthy();
    const chip = document.querySelector("[data-subagent-chip='node-c']");
    expect(chip?.className).toContain("danger");
  });

  it("gives the same worker the same colour across renders", () => {
    const { unmount } = render(<SubagentChips items={[{ id: "stable", title: "A", status: "done" }]} />);
    const first = document.querySelector("[data-subagent-chip='stable'] span[aria-hidden]") as HTMLElement;
    const firstBackground = first.style.background;
    unmount();
    render(<SubagentChips items={[{ id: "stable", title: "A", status: "done" }]} />);
    const second = document.querySelector("[data-subagent-chip='stable'] span[aria-hidden]") as HTMLElement;
    expect(second.style.background).toBe(firstBackground);
  });

  it("prefers an explicit note over the derived status", () => {
    render(<SubagentChips items={[{ id: "n", title: "T", status: "done" }]} note="3 workers finished" />);
    expect(screen.getByText("3 workers finished")).toBeTruthy();
    expect(screen.queryByText("updated")).toBeNull();
  });
});
