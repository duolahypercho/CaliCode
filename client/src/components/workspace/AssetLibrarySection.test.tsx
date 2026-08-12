import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssetLibrarySection } from "./AssetLibrarySection";

afterEach(cleanup);

describe("AssetLibrarySection", () => {
  it("lists library repos and attaches one to the game", () => {
    const onToggleRepo = vi.fn();
    render(<AssetLibrarySection attached={{}} onToggleRepo={onToggleRepo} onRepoSetting={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /^Linear Ability Casting/ }));
    expect(screen.getByRole("link", { name: /View on GitHub/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "ADD TO GAME" }));
    expect(onToggleRepo).toHaveBeenCalledWith("linear-ability-casting", true);
  });

  it("shows settings for an attached repo and commits a change", () => {
    const onRepoSetting = vi.fn();
    render(
      <AssetLibrarySection
        attached={{ "linear-ability-casting": { settings: { trailColor: "#7dd3fc", projectileSpeed: 18, impactGlow: true } } }}
        onToggleRepo={() => {}}
        onRepoSetting={onRepoSetting}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Linear Ability Casting/ }));

    const speed = screen.getByLabelText("Projectile speed");
    fireEvent.change(speed, { target: { value: "30" } });
    fireEvent.blur(speed);
    expect(onRepoSetting).toHaveBeenCalledWith("linear-ability-casting", "projectileSpeed", 30);

    fireEvent.click(screen.getByLabelText("Impact glow"));
    expect(onRepoSetting).toHaveBeenCalledWith("linear-ability-casting", "impactGlow", false);
  });

  it("detaches an attached repo from the row action", () => {
    const onToggleRepo = vi.fn();
    render(
      <AssetLibrarySection
        attached={{ "linear-ability-casting": { settings: {} } }}
        onToggleRepo={onToggleRepo}
        onRepoSetting={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Linear Ability Casting from game" }));
    expect(onToggleRepo).toHaveBeenCalledWith("linear-ability-casting", false);
  });
});
