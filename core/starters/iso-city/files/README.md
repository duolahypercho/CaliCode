# Isometric City

A three.js isometric city builder, scaffolded by CaliCode.

```bash
npm install
npm run dev
```

## Why it is built this way

**Orthographic camera, not a hand-written 2D renderer.** A canvas-2D isometric
renderer has to sort its sprites back-to-front itself, and the naive `x + y`
ordering breaks the moment a building covers more than one tile — correct
ordering there needs a topological sort over occluder pairs. An orthographic
camera gets the same look and lets the depth buffer do that work exactly.

**The camera's polar angle is locked** (`engine/view.ts`). Free orbit turns an
isometric view into an ordinary 3D one, and every alignment the art relies on
stops holding. Azimuth is left free so the city can be turned.

**Buildings are one `InstancedMesh`** (`engine/city.ts`). A `Mesh` per building
is a draw call per building; instancing draws the skyline in one. Removal is a
swap-remove so the instance buffer stays densely packed and `count` alone bounds
what is drawn.

**The simulation is fixed-timestep** (`engine/loop.ts`), decoupled from render.
Advancing the sim by the last frame's duration would make the city jump on a
dropped frame and produce different results on different machines. The
step budget per frame is capped so a backgrounded tab does not return and try
to catch up in one go.

**Picking raycasts the ground, not the buildings** (`engine/grid.ts`). The user
is choosing a tile, and a ray that hits a tower would report the tile the tower
occupies rather than the one under the pointer.

## Where to take it

- Zoning and land value, replacing `targetHeight` in `main.ts`.
- Roads as a separate instanced layer, with buildings requiring adjacency.
- Ambient occlusion (`GTAOPass`) and cascaded shadows — the biggest single jump
  in how finished it looks, and worth doing only once the city is real.
- Save/load, by serialising the tile list rather than the scene.

`three` is pinned to the version CaliCode's own editor uses, so the two agree
on the API surface. Bump it deliberately, not by accident.
