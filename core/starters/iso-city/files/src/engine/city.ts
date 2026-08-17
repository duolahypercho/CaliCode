import * as THREE from "three";
import { TILE, tileCenter, type Tile } from "./grid";

/**
 * Every building in one `InstancedMesh`.
 *
 * A separate `Mesh` per building is fine for a hundred and collapses well
 * before a city: each one is its own draw call. Instancing draws the whole
 * skyline in one, at the cost of having to write the transform into a matrix
 * buffer by hand. `raycast` on an `InstancedMesh` reports `instanceId`, which
 * is how a click still resolves back to a single building.
 */

/**
 * Grows this much closer to its target height per simulation tick. At the
 * loop's 20Hz that tops a building out in roughly two seconds — slow enough to
 * see, fast enough that a screenshot is not of a half-built city.
 */
const GROWTH_PER_TICK = 0.12;

export interface Building {
  tile: Tile;
  height: number;
  target: number;
}

const PALETTE = [0xe8e2d9, 0xd6cfc4, 0xc2bcb2, 0xf0ebe3, 0xcfd6d3];

export class City {
  readonly mesh: THREE.InstancedMesh;
  private readonly buildings: Building[] = [];
  /** Tile key -> index into `buildings`, so a lookup is not a linear scan. */
  private readonly index = new Map<string, number>();
  private readonly scratch = new THREE.Matrix4();
  private readonly colour = new THREE.Color();

  constructor(readonly capacity: number) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    // Anchor the box at its base so scaling grows it upward instead of
    // sinking half of it through the ground.
    geometry.translate(0, 0.5, 0);
    const material = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.05 });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  get size(): number {
    return this.buildings.length;
  }

  has(tile: Tile): boolean {
    return this.index.has(key(tile));
  }

  place(tile: Tile, target: number): boolean {
    if (this.buildings.length >= this.capacity || this.has(tile)) return false;
    const slot = this.buildings.length;
    this.buildings.push({ tile, height: 0.4, target });
    this.index.set(key(tile), slot);
    this.mesh.count = this.buildings.length;
    this.mesh.setColorAt(slot, this.colour.setHex(PALETTE[slot % PALETTE.length]));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.writeMatrix(slot);
    return true;
  }

  remove(tile: Tile): boolean {
    const slot = this.index.get(key(tile));
    if (slot === undefined) return false;
    const last = this.buildings.length - 1;
    // Swap-remove: the tail moves into the hole so the instance buffer stays
    // densely packed and `count` alone bounds what is drawn.
    if (slot !== last) {
      this.buildings[slot] = this.buildings[last];
      this.index.set(key(this.buildings[slot].tile), slot);
      this.writeMatrix(slot);
    }
    this.buildings.pop();
    this.index.delete(key(tile));
    this.mesh.count = this.buildings.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    return true;
  }

  /** One simulation step. Returns true when anything actually moved. */
  tick(): boolean {
    let changed = false;
    for (let slot = 0; slot < this.buildings.length; slot += 1) {
      const building = this.buildings[slot];
      const delta = building.target - building.height;
      if (Math.abs(delta) < 0.01) continue;
      building.height += Math.sign(delta) * Math.min(GROWTH_PER_TICK, Math.abs(delta));
      this.writeMatrix(slot);
      changed = true;
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
    return changed;
  }

  buildingAt(instanceId: number): Building | undefined {
    return this.buildings[instanceId];
  }

  private writeMatrix(slot: number): void {
    const { tile, height } = this.buildings[slot];
    this.scratch.makeScale(TILE * 0.88, height, TILE * 0.88);
    this.scratch.setPosition(tileCenter(tile.x), 0, tileCenter(tile.z));
    this.mesh.setMatrixAt(slot, this.scratch);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

function key(tile: Tile): string {
  return `${tile.x},${tile.z}`;
}
