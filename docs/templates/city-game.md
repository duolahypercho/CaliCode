# Template: stylized low-poly city

A worked template for building a stylized open-world city block in CaliCode.
It is concrete on purpose — palette hex values, metre dimensions, entity
budgets, naming scheme, and a ready-to-paste `/loop` prompt per phase.

Read `docs/game-harness.md` first: it defines the loop, the tool surface, the
script/test contracts, and the critic rubric this template scores against.

Target: **three.js `0.170` + WebGL2**, `MeshStandardMaterial`, PIE fixed step at
60 Hz.

---

## 1. Target look

Stylized 3D cartoon. Low-poly silhouettes, *polished* shading — the poly count
is low because the forms are simple, not because the scene is unfinished.

| Property | Target |
|---|---|
| Form language | Chamfer-free boxes and cylinders; readable primary shapes; no greebles |
| Lighting | One warm key at a low angle, strong hemisphere fill, soft contact darkening. Never a single hard light against black |
| Shadows | Enabled, soft, present under every ground-contacting form. A city without contact shadows floats |
| Materials | Matte-dominant. Roughness 0.75–0.95 for masonry/asphalt, 0.3–0.45 for painted metal, 0.05–0.15 for glass |
| Colour | Desaturated warm/cool neighbours; two saturated accents only, under 10 % of surface area |
| Scale | 1 unit = 1 metre, enforced everywhere |
| Framerate | ≥ 55 fps at 1440×900, ≤ 200 draw calls |

### Palette

Six hues, bounded. Everything else is a value shift of one of these.

| Role | Hex | Roughness | Metalness |
|---|---|---|---|
| Asphalt | `#3a3f45` | 0.92 | 0.0 |
| Lane paint | `#e8e2cf` | 0.80 | 0.0 |
| Sidewalk | `#c9c3b4` | 0.88 | 0.0 |
| Curb | `#a89f8e` | 0.85 | 0.0 |
| Facade — cream | `#d9cbb4` | 0.85 | 0.0 |
| Facade — cool | `#b8c3c9` | 0.82 | 0.0 |
| Facade — terracotta | `#c98f7a` | 0.86 | 0.0 |
| Roof | `#6d6a74` | 0.78 | 0.05 |
| Glass | `#7fb0c4` | 0.10 | 0.15 |
| Foliage (light / dark) | `#6f9e5c` / `#4f7a45` | 0.90 | 0.0 |
| **Accent — signal amber** | `#f2a03d` | 0.35 | 0.20 |
| **Accent — vehicle red** | `#d94f45` | 0.32 | 0.25 |

The two accent rows are the only saturated colours in the scene. If a critic
reports "rainbow", the fix is almost always that a facade drifted toward an
accent.

### Scale reference

Every measurement is derived from these. Check new geometry against them before
placing.

| Object | Dimensions (m) |
|---|---|
| Pedestrian | 0.5 × 1.8 × 0.5 |
| Car | 4.4 L × 1.8 W × 1.5 H |
| Traffic-signal pole | 0.12 ⌀ × 4.5 H |
| Floor height | 3.2 |
| Door | 1.0 W × 2.2 H |
| Traffic lane | 3.5 W |
| Street (2 lanes) | 8.0 W |
| Sidewalk | 2.5 W, curb 0.15 H |
| Block (nominal) | 24 × 24 — the generator jitters ±17 % and compresses downtown, so read `block.polygon` |
| Block pitch (nominal block + street) | 32 |

---

## 2. Prerequisites (human-owned, phase 0)

Three renderer settings live in `client/src/components/editor/Viewport.tsx`,
outside the agent's tool surface. A city cannot be built without them — the
default camera clips at 100 m and the world fogs to black between 18 and 42 m.

| Setting | Current | City value | Why |
|---|---|---|---|
| Camera far plane | `100` | `2000` | A 3×3 block grid spans 96 m corner to corner before any skyline |
| Fog | `Fog(0x080808, 18, 42)` | `Fog(0xcfe0e8, 120, 420)` | Daylight aerial perspective instead of a black void at 42 m |
| Scene background | `0x080808` | `0xcfe0e8` | Fog colour and background must match or the horizon shows a seam |

Optionally also `renderer.toneMapping = THREE.ACESFilmicToneMapping` and
`renderer.shadowMap.type = THREE.PCFSoftShadowMap` for the soft look. Ask the
human to make these edits and confirm before starting phase 1; the agent should
not be asked to work around them.

---

## 3. Scene structure

```
scene
├─ ground_asphalt              1 plane over map.bounds + 12m, y = 0  — streets ARE the gaps
├─ walk_<blockId>              9 boxes, block bbox × 0.15, y = 0.075 — sidewalk plinths
├─ lane_<segmentId>            ~8 planes, 0.16 × segment length, y = 0.02 — centre lines
├─ bldg_<buildingId>[_cap]     ~80 boxes                        — bases + roof caps
├─ sig_<intId>_<corner>_pole   cylinders                        — signal poles
├─ sig_<intId>_<corner>_head   boxes                            — signal heads
├─ sig_<intId>_<corner>_lamp_{red,amber,green}  small boxes     — lamps (see §7)
├─ veh_<route>_<n>_body / _cab boxes                            — vehicles
├─ ped_<n>                     cylinders                        — pedestrians
├─ tree_<blockId>_<n>          cone + cylinder                  — foliage (polish phase)
└─ light_key                   directional light                — scene key
```

Entity names carry map ids, so `editor_scene_inspect` output can be joined back
to the `CityMap` without a side table.

The **plinth trick** is the load-bearing idea: lay one large asphalt plane, then
raise sidewalk plinths on top of it. Roads are the space between plinths, so
there is no road geometry, no z-fighting between coplanar road and sidewalk, and
24 street segments cost zero entities.

### Entity budget

One mesh per entity means one draw call per entity. Budget to ~200 total.

| Group | Count | Running total |
|---|---|---|
| Ground | 1 | 1 |
| Sidewalk plinths | 9 | 10 |
| Lane markings | 8 | 18 |
| Buildings (base + optional cap) | ~80 | 98 |
| Signal poles + heads + lamps | 4 int. × 2 corners × 5 | 138 |
| Vehicles (body + cab) | 8 × 2 | 154 |
| Pedestrians | 12 | 166 |
| Key light | 1 | 167 |
| Trees (polish phase, budget permitting) | ≤ 18 | ≤ 185 |

If a phase would blow the budget, merge — larger buildings instead of more
buildings, one tree per corner instead of three.

---

## 4. Asset list

Generate these with `editor_asset_generate` once, preview each with
`editor_asset_preview`, then instance with `editor_promote_asset`. An asset that
looks wrong at preview time is cheap to fix; 80 copies of it are not.

| Asset | Kind | Colour | Rough | Metal | Instanced as |
|---|---|---|---|---|---|
| `mat_asphalt` | `plane` | `#3a3f45` | 0.92 | 0.0 | ground |
| `mat_sidewalk` | `box` | `#c9c3b4` | 0.88 | 0.0 | plinths |
| `mat_lane` | `plane` | `#e8e2cf` | 0.80 | 0.0 | centre lines |
| `facade_cream` | `box` | `#d9cbb4` | 0.85 | 0.0 | buildings |
| `facade_cool` | `box` | `#b8c3c9` | 0.82 | 0.0 | buildings |
| `facade_terracotta` | `box` | `#c98f7a` | 0.86 | 0.0 | buildings |
| `roof_cap` | `box` | `#6d6a74` | 0.78 | 0.05 | building caps |
| `glass_band` | `box` | `#7fb0c4` | 0.10 | 0.15 | ground-floor bands |
| `tree_canopy` | `cone` | `#6f9e5c` | 0.90 | 0.0 | trees |
| `tree_trunk` | `cylinder` | `#4f7a45` | 0.90 | 0.0 | trees |
| `signal_pole` | `cylinder` | `#4a4d52` | 0.45 | 0.35 | poles |
| `signal_head` | `box` | `#33363a` | 0.50 | 0.30 | heads |
| `lamp_red` | `box` | `#d94f45` | 0.30 | 0.10 | lamps |
| `lamp_amber` | `box` | `#f2a03d` | 0.30 | 0.10 | lamps |
| `lamp_green` | `box` | `#5fbf6a` | 0.30 | 0.10 | lamps |
| `veh_body_a/b/c` | `box` | `#d94f45` / `#b8c3c9` / `#d9cbb4` | 0.32 | 0.25 | vehicles |
| `ped_body` | `cylinder` | `#8a7f9c` | 0.80 | 0.0 | pedestrians |

`editor_asset_generate` exposes only `kind`, `color`, `metalness`, `roughness` —
dimensions come from the transform at placement time. Scale, do not re-generate.

---

## 5. Map-generator data model (contract)

The map is **plain data, owned by `client/src/lib/mapgen/`** — `types.ts` for the
contract, `generator.ts` for `generateCityMap` and the query helpers. It contains
no three.js and no DOM, so it can be generated in a worker, snapshotted in tests,
and diffed. Placement consumes it; it knows nothing about entities.

Read the file before generating placements — **the file is the contract, this
section is a summary of it.**

| Type | Fields that drive placement |
|---|---|
| `Point2` | `{x, y}` — metres, one world plane, `+x` east and `+y` **north** |
| `Bounds` | `minX / minY / maxX / maxY` |
| `CityMap` | `name`, `seed`, `bounds`, `intersections`, `segments`, `blocks`, `buildings`, `sidewalks`, `neighborhoods` |
| `Intersection` | `position`, `elevation`, `connectedSegmentIds`, `control`, `signalPhases?` |
| `StreetSegment` | `name`, `fromIntersectionId`, `toIntersectionId`, `direction`, `laneCount`, `oneWay`, `hasSidewalk`, `hasBikeLane`, `classification`, `lengthMeters`, `gradePercent` |
| `Sidewalk` | `segmentId`, `side`, `widthMeters`, `path` (polyline), `hasStreetTrees`, `hasCurbRamps` |
| `Block` | `polygon`, `boundingSegmentIds` (south/east/north/west order), `neighborhood`, `zoning`, `areaSquareMeters` |
| `Building` | `blockId`, `footprint` (polygon), `height`, `floors`, `type`, `address` |
| `Neighborhood` | `name`, `center`, `dominantZoning` |

Enums worth binding to in placement code: `StreetClassification`
(`arterial | collector | local | highway`), `IntersectionControl`
(`traffic-light | stop-sign | yield | uncontrolled`), `Zoning`
(`residential | commercial | industrial | mixed | park`), `BuildingType`
(`house | apartment | shop | office | warehouse | civic`).

### Generating the template's instance

```ts
import { generateCityMap, mapStats } from "../lib/mapgen/generator";

// Defaults are 12 x 10 blocks at 120 m — a 1.4 km city, far past the
// 200-entity budget. Override all three for the template scene.
const map = generateCityMap({ seed: 1337, columns: 3, rows: 3, blockSizeMeters: 24 });
const stats = mapStats(map);
```

Query helpers: `getBuildingsInBlock(map, blockId)`,
`getSegmentsAtIntersection(map, intersectionId)`, `findStreetByName(map, name)`,
`mapStats(map)`.

### What the generator gives you that a naive grid does not

Placement code that assumes a clean axis-aligned lattice will be wrong. The
generator models a San Francisco-shaped city:

- **The grid is rotated ~21°** (`GRID_ROTATION_RADIANS = 0.3665`). Nothing is
  axis-aligned. Derive every orientation from segment endpoints.
- **Blocks are not uniform.** Size jitters ±17 % and compresses toward the
  downtown core. Read `block.polygon`; never assume `blockSizeMeters`.
- **There is a diagonal arterial** (a Market Street analogue) crossing the grid
  from the south-east to the north-west corner. It creates non-rectangular
  blocks and 5-way intersections.
- **Terrain has relief.** `intersection.elevation` and `segment.gradePercent`
  are populated from Gaussian hills plus rolling noise.
- **Streets have identity**: names, one-way alternation, classification, bike
  lanes, per-side sidewalks, and `signalPhases` on light-controlled nodes.

### Placement conventions

| Map value | World value |
|---|---|
| `point.x` | `x` |
| `point.y` (north) | `z = -point.y` — three.js is right-handed, `-z` is north |
| `intersection.elevation` | `y`. **V1 flattens to 0** (see below) |
| `segment.laneCount` | street width = `laneCount * 3.5` |
| `sidewalk.widthMeters` | plinth inset from the street centre line |
| `block.polygon` | plinth footprint |
| `building.footprint` / `.height` | box footprint; centre `y = height / 2` |
| `building.floors` | facade banding, and the height sanity check (`floors * 3.2 ≈ height`) |
| `intersection.control === "traffic-light"` | where signals go; `signalPhases` drives the cycle |

**V1 flattens elevation to `y = 0`.** `elevationAt` normalizes over the map
extent, so a 3 × 3 block city inherits the same hill amplitude as a 1.4 km one
and reads as a cliff, not a hill. Terrain is a later phase: scale relief by
extent first, then re-enable. `gradePercent` stays available for vehicle speed
tuning either way.

Two properties everything downstream depends on:

- **Deterministic.** `mulberry32` is the only randomness. Same seed → identical
  map. Never call `Math.random` in placement — frame baselines and scripted
  tests are worthless against a shuffling world.
- **Counts come from `mapStats`, not from arithmetic.** With the diagonal and
  the jitter, hand-derived segment counts are wrong. A 3 × 3 request yields 16
  intersections and 9 blocks; everything else, read from `stats`.

---

## 6. Phased build plan

Each phase states inputs, DONE, and a critic check. Checkpoint before each one
(`editor_project_checkpoint`), save after each one (`editor_project_save`).

| # | Phase | Inputs | DONE | Critic check |
|---|---|---|---|---|
| 0 | Renderer prerequisites | — | Far plane 2000, fog `0xcfe0e8` 120→420, background matches | Horizon has no seam; distant blocks fade, not clip |
| 1 | Placement adapter | `mapgen/types.ts`, `mapgen/generator.ts` | Pure `CityMap → placement descriptors` module, deterministic, vitest green | — (data phase, tests are the gate) |
| 2 | Ground, roads, sidewalks | Phase 1 | 1 ground + 9 plinths + 12 lane lines, all named; no overlap | Grid reads as a grid; scale consistency ≥ 8 |
| 3 | Buildings | Phase 2 | 40–60 building entities, ≥ 3 distinct heights per block, none overlapping a street | Silhouette readability ≥ 7; skyline is not one flat bar |
| 4 | Signals | Phase 3 | Every `control === "traffic-light"` node (capped at 4) × 2 corners, each pole + head + 3 lamps, cycle script running | Signals read at a glance; scale vs. ped is right |
| 5 | Vehicles + pedestrians | Phase 4 | 8 vehicles on lane centres, 12 peds on sidewalks, all moving under PIE | Nothing clips through a plinth or a facade |
| 6 | Lighting + atmosphere | Phase 5 | Key light at a low warm angle; contact shadows visible | Lighting ≥ 7; material variety ≥ 7 |
| 7 | Polish | Phase 6 | Every rubric row ≥ 7; ≤ 200 entities; ≥ 55 fps | Full gauntlet, 3 rounds max |

---

## 7. Behaviour under the script sandbox

The sandbox patches back **transforms only** — no colour, no spawn, no delete
(`docs/game-harness.md` §2). Two consequences shape phases 4 and 5.

**Signals change state geometrically, not chromatically.** All three lamps exist
with their own colours; the active one scales to `1.0` and the others to `0.35`.
The eye reads size + colour together, and the change is visible in a captured
frame, which makes it critic-checkable.

**Prefer deterministic motion from `state.time` (seconds).** `state.self`
persists per script/entity and `state.world` is shared across scripts, but a
pure time-based path makes frame N repeatable for baselines.

```js
// Signal cycle: 8s green, 2s amber, 8s red, per approach. Lamp identity is in
// the entity name, so one script drives every lamp in the scene.
const CYCLE_SECONDS = 18;
const ON = 1.0;
const OFF = 0.35;

function phaseFor(timeSeconds) {
  const t = timeSeconds % CYCLE_SECONDS;
  if (t < 8) return "green";
  if (t < 10) return "amber";
  return "red";
}

function update(entity, state) {
  const lamp = entity.name.split("_lamp_")[1];
  if (!lamp) return state;
  const scale = phaseFor(state.time) === lamp ? ON : OFF;
  entity.scale.x = scale;
  entity.scale.y = scale;
  entity.scale.z = scale;
  return state;
}
```

The lamp script above hardcodes its cycle. The real durations live on
`intersection.signalPhases`, which the sandbox cannot read — the phase-1 adapter
bakes them into the generated script text at `editor_script_write` time. Same
pattern for routes below.

```js
// Vehicle following a closed route around the block grid. The waypoint ring is
// emitted by the placement adapter from segment endpoints, so it inherits the
// map's ~21-degree rotation instead of assuming an axis-aligned lattice.
// Pure in state.time -> deterministic -> baselineable.
const ROUTE = [/* [x, z] pairs, closed, emitted by the adapter */];
const SPEED_M_S = 8;
const VEHICLE_COUNT = 8;
const RIDE_HEIGHT = 0.75;

const LEGS = ROUTE.map((point, index) => {
  const next = ROUTE[(index + 1) % ROUTE.length];
  return { x: point[0], z: point[1], dx: next[0] - point[0], dz: next[1] - point[1] };
});
const LENGTHS = LEGS.map((leg) => Math.hypot(leg.dx, leg.dz));
const TOTAL = LENGTHS.reduce((sum, length) => sum + length, 0);

function update(entity, state) {
  const index = Number(entity.name.split("_")[2]) || 0;
  // Phase-offset per vehicle so the eight cars do not travel as one clump.
  let s = (state.time * SPEED_M_S + (index * TOTAL) / VEHICLE_COUNT) % TOTAL;

  for (let i = 0; i < LEGS.length; i += 1) {
    if (s > LENGTHS[i]) {
      s -= LENGTHS[i];
      continue;
    }
    const t = LENGTHS[i] === 0 ? 0 : s / LENGTHS[i];
    entity.position.x = LEGS[i].x + LEGS[i].dx * t;
    entity.position.z = LEGS[i].z + LEGS[i].dz * t;
    entity.position.y = RIDE_HEIGHT;
    entity.rotation.y = Math.atan2(LEGS[i].dx, LEGS[i].dz);
    break;
  }
  return state;
}
```

Keep each script under the **2000 ms per-frame** sandbox budget. Both are O(1)
in entity count and O(waypoints) per entity, which is the shape to hold to;
anything that iterates the whole city per frame belongs in a tool call at build
time, not in `update`.

---

## 8. Ready-to-paste `/loop` prompts

Set the permission mode named in each block's first line. Checkpoint first.

### Phase 1 — placement adapter

```text
/loop Build the pure placement adapter that turns a CityMap into scene placement descriptors.

Read client/src/lib/mapgen/types.ts and generator.ts first — they are the
contract and they already exist. Do not modify them.

Constraints:
- New module only. Pure functions, explicit types on every export, no three.js,
  no DOM, no tool calls, no Math.random.
- Input: generateCityMap({ seed: 1337, columns: 3, rows: 3, blockSizeMeters: 24 }).
- Output: readonly arrays of { name, kind, position: [x,y,z], scale: [x,y,z],
  rotationY, color, roughness, metalness } for plinths, lane lines, buildings,
  signals, and spawn points.
- Coordinate mapping: world x = point.x, world z = -point.y, world y = 0 (V1
  flattens elevation). Orientation comes from segment endpoints — the grid is
  rotated ~21 degrees, so nothing is axis-aligned.
- Read block.polygon for plinth footprints; never assume blockSizeMeters. Street
  width is laneCount * 3.5. Palette and dimensions come from
  docs/templates/city-game.md sections 1 and 4.
- Total descriptors must stay at or below 200.

DONE when all of these hold:
- vitest covers: determinism (two runs deep-equal), descriptor count <= 200,
  every plinth polygon inside map bounds, no building descriptor overlapping a
  street centre line, and world-z sign correctness against a known intersection.
- The test asserts counts against mapStats(map), not hardcoded arithmetic.
- pnpm test passes with zero failures.
- Reply DONE only after the tests have actually been run and reported green.
```

### Phase 2 — ground, roads, sidewalks

```text
/loop Place the ground plane, sidewalk plinths, and lane markings for the seed-1337 city map.

Constraints:
- 1 unit = 1 metre. Only plane/box primitives.
- Every position, scale, and rotation comes from the phase-1 adapter. Do not
  re-derive geometry in the prompt or hardcode a lattice — the grid is rotated
  ~21 degrees and the blocks are jittered.
- ground_asphalt: one plane covering map.bounds plus a 12m margin, at y=0,
  colour #3a3f45, roughness 0.92.
- walk_<blockId>: one box per block, footprint = the block polygon's oriented
  bounding box inset by the sidewalk width, 0.15m tall, top at y=0.15, colour
  #c9c3b4, roughness 0.88. Streets are the gaps between plinths — do not create
  road geometry.
- lane_<segmentId>: one thin plane 0.16m wide at y=0.02 down each segment's
  centre line, rotated to the segment heading, colour #e8e2cf. Skip segments
  whose laneCount is 1.
- Checkpoint before you start. Save when finished.

DONE when all of these hold:
- editor_scene_inspect reports 1 ground_, 9 walk_, and one lane_ per multi-lane
  segment, with no other entities present.
- No two plinths overlap, and every plinth is inside map bounds.
- editor_run_pie(12) completes with zero script errors in the console.
- editor_capture_frame returns a frame where the grid reads as a continuous
  street network: no gaps at intersections, no z-fighting stripes, plinth edges
  crisp against the asphalt.

Before replying DONE: capture a frame and score silhouette readability, scale
consistency, and colour harmony out of 10. If any is below 7, fix the highest-
leverage issue and re-capture. Do not reply DONE with a score below 7.
```

### Phase 3 — buildings

```text
/loop Place the map's buildings as stylized low-poly massing.

Constraints:
- Facade palette only: #d9cbb4, #b8c3c9, #c98f7a (roughness 0.82-0.86,
  metalness 0). Roof caps #6d6a74. Ground-floor glass bands #7fb0c4,
  roughness 0.10, metalness 0.15.
- Footprint, height, and floors come from map.buildings via the phase-1 adapter.
  Facade colour is chosen from building.type and block.zoning — commercial and
  office lean cool, residential leans cream, shop leans terracotta.
- Every block needs at least three distinct heights; if the map hands you a
  uniform block, add a roof cap or a setback rather than inventing a height.
- Buildings sit on the plinth: centre y = 0.15 + height/2. Set back at least 1m
  from the plinth edge; nothing crosses a street centre line.
- Name bldg_<buildingId> and bldg_<buildingId>_cap. 40-60 buildings total, at
  most 2 entities each. Do not exceed 120 entities scene-wide.
- Checkpoint before you start. Save when finished.

DONE when all of these hold:
- editor_scene_inspect reports 40-60 bldg_* base entities and total entities <= 120.
- No building overlaps a street: every footprint is inside its block bounds.
- Per block, at least 3 distinct heights and at least 2 distinct facade colours.
- editor_capture_frame returns a frame with a varied skyline.

Before replying DONE: capture a frame and score silhouette readability, material
variety, colour harmony, and scale consistency out of 10, with one sentence of
evidence each. If any row is below 7, apply the single highest-leverage fix and
re-capture. Maximum 3 rounds; do not reply DONE below 7 on every row.
```

### Phase 4 — traffic signals

```text
/loop Add traffic signals to every light-controlled intersection and drive them with one script.

Constraints:
- Signals go only where intersection.control === "traffic-light". Cycle timings
  come from that intersection's signalPhases — the sandbox cannot read the map,
  so bake the durations into the generated script text.
- Two diagonal corners per signalled intersection, capped at 4 intersections to
  stay inside the entity budget. Per corner: signal_pole (cylinder 0.12
  diameter, 4.5m tall, base on the plinth), signal_head (box 0.32 x 0.9 x 0.28
  at y=4.2), and three lamps 0.18^3 at 0.28m spacing.
- Names: sig_<intId>_<corner>_pole / _head / _lamp_red / _lamp_amber / _lamp_green.
- Lamp colours #d94f45 / #f2a03d / #5fbf6a, roughness 0.30, metalness 0.10.
- The sandbox cannot change material colour. Cycle the signal by SCALE: the
  active lamp scales to 1.0, the other two to 0.35, derived purely from
  state.time so PIE stays deterministic.
- Poles face the street: rotate each head to its approach heading, taken from
  the segment endpoints, not from an assumed axis.
- One script named "signal_cycle" attached to every lamp entity. O(1) per entity.

DONE when all of these hold:
- editor_scene_inspect shows 5 entities per corner, 2 corners per signalled
  intersection, and at most 40 sig_* entities in total.
- editor_run_pie(120) completes with zero script errors.
- Two frames captured 60 frames apart show a different lamp at full scale.
- editor_test_add records a test asserting the green lamp's scale changes
  between t=0 and t=+9s, and editor_run_tests reports it passing.

Before replying DONE: capture a frame and confirm the signals read at a glance
against the pedestrian scale reference (1.8m). Score silhouette readability and
scale consistency; below 7 on either means keep working.
```

### Phase 5 — vehicles and pedestrians

```text
/loop Add moving vehicles and pedestrians.

Constraints:
- 8 vehicles: veh_route_<n>_body (box 4.4 x 1.1 x 1.8) plus veh_route_<n>_cab
  (box 2.0 x 0.7 x 1.6, offset back and up). Colours #d94f45, #b8c3c9, #d9cbb4,
  roughness 0.32, metalness 0.25.
- 12 pedestrians: ped_<n>, cylinder 0.5 diameter x 1.8 tall, colour #8a7f9c,
  standing on the plinth (y = 0.15 + 0.9).
- Motion is a pure function of `state.time` in seconds. Vehicles follow a closed route
  whose waypoints the phase-1 adapter emits from segment endpoints (so the route
  inherits the map's ~21-degree rotation) at 8 m/s, evenly phase-offset.
  Pedestrians walk plinth perimeters at 1.4 m/s.
- Respect segment.oneWay: a route leg that runs against a one-way segment's
  direction is a defect.
- Two scripts total: "vehicle_route" and "ped_walk". Keep each O(1) in entity
  count; the waypoint array is baked into the script text.
- Checkpoint before you start. Save when finished.

DONE when all of these hold:
- editor_scene_inspect shows 16 veh_* and 12 ped_* entities; scene total <= 190.
- editor_run_pie(180) completes with zero script errors and no
  "scripts exceeded 2000ms" line in the console.
- Positions sampled 60 frames apart differ for every vehicle and pedestrian.
- No vehicle sits on a plinth and no pedestrian sits on asphalt at any sampled
  frame.

Before replying DONE: capture a frame mid-motion and confirm nothing clips
through a facade or plinth. Report the PIE FPS and DRAW readouts. If FPS is
below 55 or draw calls exceed 200, reduce entity count before replying DONE.
```

### Phase 6 — lighting and atmosphere

```text
/loop Light the city for a warm late-afternoon stylized look.

Constraints:
- One scene key light named light_key (kind "light"), warm, positioned low —
  roughly [60, 35, 40] — so buildings cast long directional shadows across the
  streets. The viewport already provides a hemisphere fill at 0.9 and its own
  key at 2.4; your light adds to those, it does not replace them.
- Shadow side of a form must stay readable: dark, never crushed to black.
- Do not touch the palette in this phase. Lighting problems get lit fixes.

DONE when all of these hold:
- editor_capture_frame shows a visible contact shadow under every building and
  every vehicle — nothing floats.
- The frame has a clear light side and shade side; the shade side is still
  legible.
- FPS stays at or above 55.

Before replying DONE: run the harsh-critic pass from docs/game-harness.md §6 on
the captured frame. Lighting and material variety must both score 7 or higher
with evidence. Maximum 3 rounds.
```

### Phase 7 — polish gauntlet

```text
/loop Run the polish gauntlet until the city passes every rubric row.

Constraints:
- No new phases and no scope growth. Fix what is there. The one permitted
  addition is street trees (tree_<blockId>_<n>, cone canopy #6f9e5c over a
  cylinder trunk #4f7a45) on sidewalks whose hasStreetTrees is true, up to 18
  entities, only if the budget allows.
- Budget ceiling: 200 entities, 200 draw calls, 55 fps.
- Palette stays bounded: 6 hues plus the two accents, accents under 10% of
  surface area.

Procedure, repeated until pass or 3 rounds:
1. editor_run_pie(120), then editor_capture_frame.
2. Score the frame as a harsh art director on silhouette readability, lighting,
   material variety, colour harmony, scale consistency, and framerate — 0-10
   with one sentence of evidence each. 7 is shippable; do not award 7+ without
   evidence visible in the frame.
3. Apply the single highest-leverage fix. Exactly one.
4. editor_run_tests must stay green. editor_project_save.

DONE when every rubric row scores 7 or higher with stated evidence, the scene
has at most 200 entities, PIE reports at least 55 fps, and the test suite is
green. Report the final scores in the DONE message... on the line before DONE,
since DONE must be alone on its own line.
```

---

## 9. Known limits of this template

| Limit | Consequence | Way out |
|---|---|---|
| One draw call per entity | ~200-entity ceiling; no dense crowds | Merge repeated geometry into fewer, larger entities |
| No texture maps from the tool surface | Variety must come from hue + roughness + form | Import textured `.cali`/glTF assets via `editor_asset_import_file` |
| Scripts patch transforms only | No colour animation, no runtime spawning | Geometric state changes (the lamp-scale trick in §7) |
| `baseline()` is a no-op under `editor_run_tests` | Agent-run visual regression does not actually compare | Judge with capture + critic; have the human press RUN TESTS |
| Renderer settings are outside the tool surface | Phase 0 needs a human | Land the `Viewport.tsx` edits before phase 1 |
| No streaming/LOD | The whole city is resident every frame | Keep the grid at 3×3; a real open world needs chunk streaming first |
| Elevation flattened to `y = 0` | The map's hills and `gradePercent` are unused | Scale relief by map extent, then re-enable in a terrain phase |
| Map ids are carried in entity names | Renaming an entity breaks the join back to `CityMap` | Treat names as keys; rename only through the adapter |
