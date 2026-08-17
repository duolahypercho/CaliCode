import * as THREE from "three";

/**
 * The ground plane, the tile lines, and the hover cursor.
 *
 * Picking is a raycast against an invisible ground plane rather than against
 * the buildings: the user is choosing a *tile*, and a ray that hits a tower
 * would report the tile the tower occupies instead of the one under the
 * pointer.
 */

export const TILE = 2;

export interface Tile {
  x: number;
  z: number;
}

export interface Grid {
  group: THREE.Group;
  /** Tile under the pointer, or null when the pointer is off the board. */
  pick(pointer: THREE.Vector2, camera: THREE.Camera): Tile | null;
  setCursor(tile: Tile | null): void;
  inBounds(tile: Tile): boolean;
}

export function createGrid(size: number): Grid {
  const group = new THREE.Group();
  const extent = size * TILE;

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(extent, extent),
    new THREE.MeshStandardMaterial({ color: 0x9fb4a3, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  const lines = new THREE.GridHelper(extent, size, 0x7d9384, 0x8ea595);
  // Coplanar with the ground, so without a lift the two z-fight into a moire.
  lines.position.y = 0.01;
  group.add(lines);

  const cursor = new THREE.Mesh(
    new THREE.BoxGeometry(TILE, 0.12, TILE),
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.85 }),
  );
  cursor.position.y = 0.06;
  cursor.visible = false;
  group.add(cursor);

  const raycaster = new THREE.Raycaster();
  const half = size / 2;

  const inBounds = (tile: Tile) =>
    tile.x >= -half && tile.x < half && tile.z >= -half && tile.z < half;

  return {
    group,
    pick(pointer, camera) {
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(ground, false)[0];
      if (!hit) return null;
      const tile = {
        x: Math.floor(hit.point.x / TILE),
        z: Math.floor(hit.point.z / TILE),
      };
      return inBounds(tile) ? tile : null;
    },
    setCursor(tile) {
      cursor.visible = tile !== null;
      if (tile) cursor.position.set(tileCenter(tile.x), 0.06, tileCenter(tile.z));
    },
    inBounds,
  };
}

/** World-space centre of a tile index along one axis. */
export function tileCenter(index: number): number {
  return index * TILE + TILE / 2;
}
