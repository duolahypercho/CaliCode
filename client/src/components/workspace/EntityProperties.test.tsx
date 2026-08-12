import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Entity } from "../../lib/types";
import { EntityProperties } from "./EntityProperties";

afterEach(cleanup);

const entity: Entity = {
  id: "hero",
  name: "Hero",
  kind: "box",
  transform: {
    position: [1, 0.5, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  },
  material: { color: "#6b7280", metalness: 0.1, roughness: 0.7 },
  light: {},
  scriptIds: [],
  assetId: null,
};

describe("EntityProperties", () => {
  it("keeps negative and decimal intermediate values editable", () => {
    const onChange = vi.fn();
    render(<EntityProperties entity={entity} onChange={onChange} onRemove={() => {}} />);
    const positionX = screen.getByLabelText("Position X");

    fireEvent.focus(positionX);
    fireEvent.change(positionX, { target: { value: "-" } });
    expect((positionX as HTMLInputElement).value).toBe("-");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(positionX, { target: { value: "-1." } });
    expect((positionX as HTMLInputElement).value).toBe("-1.");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(positionX, { target: { value: "-1.25" } });
    expect((positionX as HTMLInputElement).value).toBe("-1.25");
    expect(onChange).toHaveBeenCalledWith({
      transform: {
        ...entity.transform,
        position: [-1.25, 0.5, 0],
      },
    });

    fireEvent.blur(positionX);
    expect((positionX as HTMLInputElement).value).toBe("-1.25");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("clamps bounded material fields and supports arrow-key stepping", () => {
    const onChange = vi.fn();
    render(<EntityProperties entity={entity} onChange={onChange} onRemove={() => {}} />);
    const metalness = screen.getByLabelText("Metalness");

    fireEvent.change(metalness, { target: { value: "2" } });
    expect(onChange).toHaveBeenLastCalledWith({
      material: { ...entity.material, metalness: 1 },
    });
    expect((metalness as HTMLInputElement).value).toBe("2");

    fireEvent.keyDown(metalness, { key: "ArrowDown" });
    expect((metalness as HTMLInputElement).value).toBe("0.95");
    expect(onChange).toHaveBeenLastCalledWith({
      material: { ...entity.material, metalness: 0.95 },
    });
  });
});
