import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Asset, Entity } from "../../lib/types";
import { ArtTab } from "./ArtTab";

afterEach(cleanup);

const asset: Asset = {
  id: "asset-drone",
  name: "drone-1",
  type: "procedural",
  source: "procedural:box",
  tags: ["generated", "box"],
  usage: [],
  thumbnail: null,
  metadata: {},
};

function entity(id: string, name: string, assetId: string | null): Entity {
  return {
    id,
    name,
    kind: "box",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material: {},
    light: {},
    scriptIds: [],
    assetId,
  };
}

function renderArtTab(entities: Entity[], onRemove = vi.fn()) {
  render(
    <ArtTab
      slug="starter"
      assets={[asset]}
      entities={entities}
      onGenerate={() => {}}
      onPromote={() => {}}
      onRemove={onRemove}
      onImportImage={async () => null}
      onLog={() => {}}
    />,
  );
  return onRemove;
}

describe("ArtTab asset removal", () => {
  it("names the entities that lose their mesh before removing an in-use asset", async () => {
    const onRemove = renderArtTab([
      entity("hero", "Hero", asset.id),
      entity("turret", "Turret", asset.id),
      entity("floor", "Floor", null),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Remove drone-1" }));
    expect(onRemove).not.toHaveBeenCalled();

    expect(await screen.findByText("Remove drone-1?")).toBeTruthy();
    expect(screen.getByText(/2 entities in the scene use it and will lose their mesh: Hero, Turret/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove asset" }));
    expect(onRemove).toHaveBeenCalledWith(asset.id);
  });

  it("keeps the asset when the confirmation is cancelled", async () => {
    const onRemove = renderArtTab([entity("hero", "Hero", asset.id)]);

    fireEvent.click(screen.getByRole("button", { name: "Remove drone-1" }));
    expect(await screen.findByText("Remove drone-1?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.queryByText("Remove drone-1?")).toBeNull();
  });

  it("still confirms an unused asset, and says nothing depends on it", async () => {
    renderArtTab([entity("floor", "Floor", null)]);

    fireEvent.click(screen.getByRole("button", { name: "Remove drone-1" }));
    expect(await screen.findByText("Nothing in the scene uses it. This cannot be undone.")).toBeTruthy();
  });

  it("returns focus to the panel when confirming removes the card that opened it", async () => {
    function Harness() {
      const [assets, setAssets] = useState([asset]);
      return (
        <ArtTab
          slug="starter"
          assets={assets}
          entities={[]}
          onGenerate={() => {}}
          onPromote={() => {}}
          onRemove={() => setAssets([])}
          onImportImage={async () => null}
          onLog={() => {}}
        />
      );
    }
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: "Remove drone-1" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Remove asset" }));

    // The ✕ is gone with its card, so Radix has nothing to restore to and
    // focus would sit on <body>.
    expect(trigger.isConnected).toBe(false);
    const panel = screen.getByLabelText("Search assets").closest('[tabindex="-1"]');
    expect(panel).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(panel));
  });
});
