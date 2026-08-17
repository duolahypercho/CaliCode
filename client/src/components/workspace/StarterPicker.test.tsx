import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StarterPicker } from "./StarterPicker";
import * as starters from "../../lib/starters";
import type { Starter } from "../../lib/starters";

describe("StarterPicker", () => {
  afterEach(() => {
    // vitest.config.ts does not set `globals`, so testing-library never
    // registers its own afterEach and each render would otherwise stack up.
    cleanup();
    vi.restoreAllMocks();
  });

  const starter = (overrides: Partial<Starter> = {}): Starter => ({
    id: "iso-city",
    name: "Isometric City",
    description: "An orthographic city builder.",
    tags: ["three.js"],
    devScript: "dev",
    install: "npm install",
    scope: "builtin",
    ...overrides,
  });

  const offer = (list: Starter[]) => vi.spyOn(starters, "listStarters").mockResolvedValue(list);

  function Harness() {
    const [value, setValue] = useState<string | null>(null);
    const [path, setPath] = useState("~/CaliCode/my-game");
    return <StarterPicker value={value} onChange={setValue} path={path} onPathChange={setPath} />;
  }

  const checked = () => screen.getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true");

  it("lists what starter_list returned", async () => {
    offer([starter(), starter({ id: "roguelike", name: "Roguelike" })]);
    render(<Harness />);
    expect(await screen.findByText("Isometric City")).toBeTruthy();
    expect(screen.getByText("Roguelike")).toBeTruthy();
  });

  /** One starter behind a required choice is a click that carries no information. */
  it("preselects a lone starter", async () => {
    offer([starter()]);
    render(<Harness />);
    await waitFor(() => expect(checked()).toHaveLength(1));
  });

  it("preselects nothing when there is a real choice", async () => {
    offer([starter(), starter({ id: "roguelike", name: "Roguelike" })]);
    render(<Harness />);
    await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(2));
    expect(checked()).toHaveLength(0);
  });

  it("selects on click", async () => {
    offer([starter(), starter({ id: "roguelike", name: "Roguelike" })]);
    render(<Harness />);
    fireEvent.click(await screen.findByText("Roguelike"));
    await waitFor(() => expect(checked()).toHaveLength(1));
  });

  /** A user starter is the user's own file, and saying so is the whole cue. */
  it("marks a user starter as theirs", async () => {
    offer([starter({ scope: "user" })]);
    render(<Harness />);
    expect(await screen.findByText("yours")).toBeTruthy();
  });

  it("edits the destination path", async () => {
    offer([starter()]);
    render(<Harness />);
    const input = (await screen.findByLabelText("New folder path")) as HTMLInputElement;
    expect(input.value).toBe("~/CaliCode/my-game");
    fireEvent.change(input, { target: { value: "~/games/city" } });
    await waitFor(() =>
      expect((screen.getByLabelText("New folder path") as HTMLInputElement).value).toBe("~/games/city"),
    );
  });

  /** A failed list must not look like "there are no starters". */
  it("surfaces a failing starter_list", async () => {
    vi.spyOn(starters, "listStarters").mockRejectedValue(new Error("core is down"));
    render(<Harness />);
    expect((await screen.findByRole("alert")).textContent).toContain("core is down");
  });

  it("says so when there are genuinely no starters", async () => {
    offer([]);
    render(<Harness />);
    expect(await screen.findByText("No starters are available.")).toBeTruthy();
  });
});
