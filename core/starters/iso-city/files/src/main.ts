import * as THREE from "three";
import { createView } from "./engine/view";
import { createGrid, type Tile } from "./engine/grid";
import { City } from "./engine/city";
import { startLoop } from "./engine/loop";

const GRID_SIZE = 40;

const canvas = document.getElementById("app") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;

const view = createView(canvas);
const grid = createGrid(GRID_SIZE);
const city = new City(GRID_SIZE * GRID_SIZE);

view.scene.add(grid.group);
view.scene.add(city.mesh);

const pointer = new THREE.Vector2();
let hovered: Tile | null = null;

/**
 * MapControls pans on left-drag, which is the same button that places a
 * building. Comparing pointerdown to pointerup is what separates the two: a
 * press that moved is a camera move, a press that did not is a click.
 */
const DRAG_SLOP_PX = 4;
let pressedAt: { x: number; y: number } | null = null;

function toPointer(event: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

/**
 * Downtown is tall and the outskirts are low, with enough jitter to not read as
 * a formula. The ceiling is deliberately low relative to a tile: much past ~5x
 * the footprint the massing stops reading as buildings and starts reading as
 * pencils, which is the usual way a first isometric city looks wrong.
 */
function targetHeight(tile: Tile): number {
  const distance = Math.hypot(tile.x, tile.z);
  const falloff = Math.max(0, 1 - distance / (GRID_SIZE * 0.55));
  return 1.1 + falloff * falloff * 5.5 * (0.5 + Math.random() * 0.9);
}

/**
 * Open on a small downtown rather than bare ground. An empty board is
 * indistinguishable from a renderer that failed, and the first thing anyone
 * does with a scaffold is look at it before reading how to use it.
 */
function seedDowntown(): void {
  for (let x = -6; x <= 6; x += 1) {
    for (let z = -6; z <= 6; z += 1) {
      // Leave a loose street grid, so the massing has gaps to read against.
      if (x % 3 === 0 || z % 4 === 0) continue;
      const tile = { x, z };
      if (Math.random() < 0.22) continue;
      city.place(tile, targetHeight(tile));
    }
  }
}
seedDowntown();

canvas.addEventListener("pointermove", (event) => {
  toPointer(event);
  hovered = grid.pick(pointer, view.camera);
  grid.setCursor(hovered);
});

canvas.addEventListener("pointerdown", (event) => {
  pressedAt = { x: event.clientX, y: event.clientY };
});

canvas.addEventListener("pointerup", (event) => {
  const start = pressedAt;
  pressedAt = null;
  if (!start) return;
  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > DRAG_SLOP_PX) return;

  toPointer(event);
  const tile = grid.pick(pointer, view.camera);
  if (!tile) return;
  if (event.shiftKey) city.remove(tile);
  else city.place(tile, targetHeight(tile));
});

canvas.addEventListener("pointerleave", () => {
  hovered = null;
  grid.setCursor(null);
});

startLoop(
  () => {
    city.tick();
  },
  () => {
    view.controls.update();
    view.renderer.render(view.scene, view.camera);
    hud.textContent = [
      `buildings  ${city.size}`,
      `tile       ${hovered ? `${hovered.x}, ${hovered.z}` : "—"}`,
      "",
      "click        place",
      "shift-click  remove",
      "drag         pan",
      "wheel        zoom",
    ].join("\n");
  },
);
