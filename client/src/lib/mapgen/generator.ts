import type {
  Block,
  Bounds,
  Building,
  BuildingType,
  CardinalDirection,
  CityMap,
  GenerateCityMapOptions,
  Intersection,
  IntersectionControl,
  MapStats,
  Neighborhood,
  Point2,
  Polygon,
  SignalPhase,
  Sidewalk,
  StreetClassification,
  StreetSegment,
  Zoning,
} from "./types";

const DEFAULT_COLUMNS = 12;
const DEFAULT_ROWS = 10;
const DEFAULT_BLOCK_METERS = 120;
/** SF's downtown grid sits about 21 degrees off true north. */
const GRID_ROTATION_RADIANS = 0.3665;
const BLOCK_SIZE_JITTER = 0.34;
/** Blocks were platted tighter downtown, so they shrink toward the core. */
const DOWNTOWN_COMPRESSION = 0.3;
const CORE_SPREAD = 0.16;
const CORE_U = 0.62;
const CORE_V = 0.72;
const FLOOR_HEIGHT_METERS = 3.2;
const CORE_FALLOFF_METERS = 320;
const LOT_FRONTAGE_METERS = 30;
const MIN_LOTS_PER_SIDE = 2;
const MAX_LOTS_PER_SIDE = 7;
const LOT_EDGE_INSET = 0.06;
const LOT_DEPTH_GAP = 0.06;
const SIDEWALK_WIDTH_METERS = 3.5;
const SIDEWALK_OFFSET_METERS = 6;
/** Every 4th street is an arterial, every 2nd of the rest a collector. */
const ARTERIAL_EVERY = 4;
const COLLECTOR_EVERY = 2;
const EARLIEST_YEAR_BUILT = 1868;
const YEAR_BUILT_SPAN = 155;
const UNDATED_BUILDING_CHANCE = 0.12;
const PARK_BLOCK_CHANCE = 0.07;
const DOMINANT_ZONING_CHANCE = 0.72;

const SPEED_LIMITS_MPH: Record<StreetClassification, number> = {
  highway: 65,
  arterial: 35,
  collector: 30,
  local: 25,
};

const LANE_COUNTS: Record<StreetClassification, number> = {
  highway: 6,
  arterial: 4,
  collector: 2,
  local: 2,
};

const THROUGH_PHASE_SECONDS = 34;
const CROSS_PHASE_SECONDS = 22;
const LEFT_PHASE_SECONDS = 12;

/** East-west running streets, south to north. Index 0 is the waterfront. */
const RUNNING_STREET_NAMES = [
  "Embarcadero Freeway",
  "Bryant Street",
  "Folsom Street",
  "Howard Street",
  "Mission Street",
  "Bush Street",
  "Sacramento Street",
  "Broadway",
  "Union Street",
  "Chestnut Street",
  "Bay Street",
  "Beach Street",
  "Jefferson Street",
];

/** The diagonal arterial that breaks the grid, as Market Street does. */
const DIAGONAL_STREET_NAME = "Market Street";

interface Hill {
  u: number;
  v: number;
  heightMeters: number;
  radiusMeters: number;
}

/**
 * Named summits, roughly Nob, Russian, Telegraph and Twin Peaks. A Gaussian's
 * steepest slope is ~0.61 * height / radius, so these radii keep every flank
 * under the ~35% grade past which nothing drives up.
 */
const HILLS: Hill[] = [
  { u: 0.38, v: 0.66, heightMeters: 103, radiusMeters: 320 },
  { u: 0.3, v: 0.86, heightMeters: 90, radiusMeters: 300 },
  { u: 0.62, v: 0.92, heightMeters: 84, radiusMeters: 240 },
  { u: 0.08, v: 0.3, heightMeters: 280, radiusMeters: 720 },
];

const NEIGHBORHOOD_SEEDS: ReadonlyArray<{ name: string; u: number; v: number; zoning: Zoning }> = [
  { name: "Financial District", u: 0.66, v: 0.74, zoning: "commercial" },
  { name: "North Beach", u: 0.4, v: 0.92, zoning: "mixed" },
  { name: "Nob Hill", u: 0.34, v: 0.66, zoning: "residential" },
  { name: "South of Market", u: 0.74, v: 0.36, zoning: "industrial" },
  { name: "Mission", u: 0.42, v: 0.14, zoning: "mixed" },
  { name: "Sunset", u: 0.1, v: 0.44, zoning: "residential" },
];

/** Zoning that plausibly bleeds into a neighborhood's dominant kind. */
const ZONING_NEIGHBORS: Record<Zoning, Zoning[]> = {
  residential: ["mixed", "commercial"],
  commercial: ["mixed", "residential"],
  industrial: ["commercial", "mixed"],
  mixed: ["residential", "commercial"],
  park: ["park", "park"],
};

const BUILDING_TYPES_BY_ZONING: Record<Zoning, BuildingType[]> = {
  residential: ["house", "house", "apartment"],
  commercial: ["shop", "office", "office"],
  industrial: ["warehouse", "warehouse", "office"],
  mixed: ["shop", "apartment", "civic"],
  park: ["civic"],
};

/** Away from downtown the city is low-rise, as most of SF is. */
const BASE_HEIGHT_METERS: Record<BuildingType, number> = {
  house: 8,
  apartment: 14,
  shop: 9,
  office: 16,
  warehouse: 11,
  civic: 12,
};

/** Extra height a type gets at the downtown core, decaying with distance. */
const CORE_HEIGHT_BONUS_METERS: Record<BuildingType, number> = {
  house: 0,
  apartment: 70,
  shop: 12,
  office: 165,
  warehouse: 6,
  civic: 40,
};

/**
 * mulberry32: a 32-bit seeded PRNG. Generators in this codebase must be
 * reproducible, so `Math.random` is never used — the returned closure owns the
 * only mutable state in the module.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface NodeDraft {
  id: string;
  row: number;
  column: number;
  position: Point2;
  elevation: number;
}

interface StreetPlan {
  name: string;
  classification: StreetClassification;
  nodeIds: string[];
  oneWay: boolean;
  hasBikeLane: boolean;
}

export function generateCityMap(options: GenerateCityMapOptions): CityMap {
  const random = mulberry32(options.seed);
  const columns = Math.max(2, options.columns ?? DEFAULT_COLUMNS);
  const rows = Math.max(2, options.rows ?? DEFAULT_ROWS);
  const blockSize = options.blockSizeMeters ?? DEFAULT_BLOCK_METERS;

  const phases = [random(), random(), random(), random()];
  const xs = axisOffsets(columns, blockSize, CORE_U, random);
  const ys = axisOffsets(rows, blockSize, CORE_V, random);
  const extent = { x: xs[columns], y: ys[rows] };

  const nodes = buildNodes(xs, ys, extent, phases);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const plans = planStreets(rows, columns, random);
  const segments = plans.flatMap((plan, index) => planToSegments(plan, index, nodesById));
  const segmentsById = new Map(segments.map((segment) => [segment.id, segment]));
  const intersections = finalizeIntersections(nodes, segments, segmentsById);
  const neighborhoods = buildNeighborhoods(extent);
  const core = rotate({ x: extent.x * CORE_U, y: extent.y * CORE_V });

  const blocks = buildBlocks(rows, columns, nodesById, edgeIndexOf(segments), neighborhoods, random);
  const buildings = blocks.flatMap((block, index) =>
    buildBuildings(block, index, segmentsById, core, random),
  );
  const intersectionsById = new Map(intersections.map((intersection) => [intersection.id, intersection]));
  const sidewalks = segments.flatMap((segment) => buildSidewalks(segment, nodesById, intersectionsById));

  return {
    name: options.name ?? `Bay City ${options.seed}`,
    seed: options.seed,
    bounds: boundsOf(nodes.map((node) => node.position)),
    intersections,
    segments,
    blocks,
    buildings,
    sidewalks,
    neighborhoods,
  };
}

/**
 * Undirected node-pair -> segment id, used to fence blocks in. Grid streets are
 * planned before the diagonal and the first writer wins, so a block always
 * cites its own four grid edges.
 */
function edgeIndexOf(segments: StreetSegment[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const segment of segments) {
    const key = edgeKey(segment.fromIntersectionId, segment.toIntersectionId);
    if (!index.has(key)) index.set(key, segment.id);
  }
  return index;
}

/** Cumulative offsets along one axis, tighter near the core and jittered. */
function axisOffsets(count: number, blockSize: number, coreFraction: number, random: () => number): number[] {
  const offsets = [0];
  for (let index = 0; index < count; index += 1) {
    const fraction = (index + 0.5) / count;
    const toCore = (fraction - coreFraction) / CORE_SPREAD;
    const compression = 1 - DOWNTOWN_COMPRESSION * Math.exp(-0.5 * toCore * toCore);
    const jitter = 1 - BLOCK_SIZE_JITTER / 2 + BLOCK_SIZE_JITTER * random();
    offsets.push(round(offsets[index] + blockSize * compression * jitter, 3));
  }
  return offsets;
}

/** Nodes carry sea-level-relative elevation, so the lowest corner reads zero. */
function buildNodes(xs: number[], ys: number[], extent: Point2, phases: number[]): NodeDraft[] {
  const raw = ys.flatMap((y, row) =>
    xs.map((x, column) => ({
      id: intersectionId(column, row),
      row,
      column,
      position: rotate({ x, y }),
      elevation: elevationAt(x / extent.x, y / extent.y, extent, phases),
    })),
  );
  const seaLevel = Math.min(...raw.map((node) => node.elevation));
  return raw.map((node) => ({ ...node, elevation: round(node.elevation - seaLevel, 2) }));
}

/**
 * Gaussian hills plus low rolling noise; the phases keep it seed-dependent.
 *
 * Hills combine by max, not by sum. Summing let four overlapping tails pile up
 * into a single 400 m massif whose flank ran downhill across the whole east
 * side at 50%+, which no street can climb. Taking the tallest keeps each summit
 * distinct with saddles between them, and bounds the grade at the steepest
 * single flank.
 */
function elevationAt(u: number, v: number, extent: Point2, phases: number[]): number {
  const hills = HILLS.reduce((tallest, hill) => {
    const dx = (u - hill.u) * extent.x;
    const dy = (v - hill.v) * extent.y;
    const falloff = Math.exp(-(dx * dx + dy * dy) / (2 * hill.radiusMeters * hill.radiusMeters));
    return Math.max(tallest, hill.heightMeters * falloff);
  }, 0);
  const rolling =
    5 * Math.sin(u * 7 + phases[0] * Math.PI * 2) +
    4 * Math.sin(v * 5 + phases[1] * Math.PI * 2) +
    3 * Math.sin((u + v) * 9 + phases[2] * Math.PI * 2);
  return hills + rolling + phases[3] * 4;
}

function planStreets(rows: number, columns: number, random: () => number): StreetPlan[] {
  const running = range(rows + 1).map((row) => {
    const classification = classify(row, row === 0);
    const nodeIds = range(columns + 1).map((column) => intersectionId(column, row));
    return orientPlan({
      name: runningStreetName(row),
      classification,
      nodeIds,
      oneWay: isOneWay(classification, row),
      hasBikeLane: bikeLane(classification, random),
    }, row);
  });

  const crossing = range(columns + 1).map((column) => {
    const classification = classify(column, false);
    const nodeIds = range(rows + 1).map((row) => intersectionId(column, row));
    return orientPlan({
      name: `${ordinal(column + 1)} Street`,
      classification,
      nodeIds,
      oneWay: isOneWay(classification, column),
      hasBikeLane: bikeLane(classification, random),
    }, column);
  });

  return [...running, ...crossing, planDiagonal(rows, columns, random)];
}

/**
 * The Market Street analogue: a chord from the south-east corner to the
 * north-west one. It steps `min(rows, columns)` times so every step changes
 * both row and column — a step that changed only one would land exactly on a
 * grid edge and duplicate an existing segment.
 */
function planDiagonal(rows: number, columns: number, random: () => number): StreetPlan {
  const steps = Math.min(rows, columns);
  return {
    name: DIAGONAL_STREET_NAME,
    classification: "arterial",
    nodeIds: range(steps + 1).map((step) =>
      intersectionId(Math.round((step * columns) / steps), rows - Math.round((step * rows) / steps)),
    ),
    oneWay: false,
    hasBikeLane: bikeLane("arterial", random),
  };
}

/**
 * One-way streets alternate flow so consecutive one-ways run opposite ways;
 * reversing the node chain keeps `direction` equal to the legal travel heading.
 */
function orientPlan(plan: StreetPlan, index: number): StreetPlan {
  if (!plan.oneWay || index % 4 === 1) return plan;
  return { ...plan, nodeIds: [...plan.nodeIds].reverse() };
}

function classify(index: number, isHighway: boolean): StreetClassification {
  if (isHighway) return "highway";
  if (index % ARTERIAL_EVERY === 0) return "arterial";
  if (index % COLLECTOR_EVERY === 0) return "collector";
  return "local";
}

function isOneWay(classification: StreetClassification, index: number): boolean {
  if (classification === "arterial" || classification === "highway") return false;
  return index % 2 === 1;
}

function bikeLane(classification: StreetClassification, random: () => number): boolean {
  const roll = random();
  if (classification === "highway") return false;
  if (classification === "collector") return true;
  if (classification === "arterial") return roll < 0.4;
  return roll < 0.15;
}

function runningStreetName(row: number): string {
  return RUNNING_STREET_NAMES[row] ?? `${ordinal(row - RUNNING_STREET_NAMES.length + 1)} Avenue`;
}

function planToSegments(plan: StreetPlan, planIndex: number, nodes: Map<string, NodeDraft>): StreetSegment[] {
  return plan.nodeIds.slice(0, -1).map((fromId, index) => {
    const toId = plan.nodeIds[index + 1];
    const from = nodes.get(fromId);
    const to = nodes.get(toId);
    if (!from || !to) {
      throw new Error(`street "${plan.name}" references missing intersection ${fromId} -> ${toId}`);
    }
    const lengthMeters = distance(from.position, to.position);
    return {
      id: `seg-${planIndex}-${index}`,
      name: plan.name,
      fromIntersectionId: fromId,
      toIntersectionId: toId,
      oneWay: plan.oneWay,
      direction: headingOf(from.position, to.position),
      laneCount: LANE_COUNTS[plan.classification],
      speedLimit: SPEED_LIMITS_MPH[plan.classification],
      hasSidewalk: plan.classification !== "highway",
      hasBikeLane: plan.hasBikeLane,
      classification: plan.classification,
      lengthMeters: round(lengthMeters, 2),
      gradePercent: round(((to.elevation - from.elevation) / lengthMeters) * 100, 2),
    };
  });
}

function finalizeIntersections(
  nodes: NodeDraft[],
  segments: StreetSegment[],
  segmentsById: Map<string, StreetSegment>,
): Intersection[] {
  const connections = new Map<string, string[]>();
  for (const segment of segments) {
    for (const nodeId of [segment.fromIntersectionId, segment.toIntersectionId]) {
      connections.set(nodeId, [...(connections.get(nodeId) ?? []), segment.id]);
    }
  }
  return nodes.map((node) => {
    const connectedSegmentIds = connections.get(node.id) ?? [];
    const connected = connectedSegmentIds.map((id) => segmentsById.get(id)!);
    const control = controlFor(connected);
    const base: Intersection = {
      id: node.id,
      position: node.position,
      elevation: node.elevation,
      connectedSegmentIds,
      control,
    };
    return control === "traffic-light" ? { ...base, signalPhases: signalPhasesFor(connected) } : base;
  });
}

function controlFor(connected: StreetSegment[]): IntersectionControl {
  // Freeway crossings are grade separated, so nothing controls them at street level.
  if (connected.some((segment) => segment.classification === "highway")) return "uncontrolled";
  if (connected.some((segment) => segment.classification === "arterial")) return "traffic-light";
  // A collector carries enough traffic that a four-way gets an all-way stop,
  // while a T-junction only needs the minor approach to yield.
  if (connected.some((segment) => segment.classification === "collector")) {
    if (connected.length >= 4) return "stop-sign";
    return connected.length === 3 ? "yield" : "uncontrolled";
  }
  return connected.length >= 3 ? "stop-sign" : "uncontrolled";
}

function signalPhasesFor(connected: StreetSegment[]): SignalPhase[] {
  const arterial = connected.find((segment) => segment.classification === "arterial");
  const arterialIsVertical = arterial?.direction === "north" || arterial?.direction === "south";
  return [
    {
      movement: "north-south",
      durationSeconds: arterialIsVertical ? THROUGH_PHASE_SECONDS : CROSS_PHASE_SECONDS,
    },
    {
      movement: "east-west",
      durationSeconds: arterialIsVertical ? CROSS_PHASE_SECONDS : THROUGH_PHASE_SECONDS,
    },
    { movement: "left-turn", durationSeconds: LEFT_PHASE_SECONDS },
  ];
}

function buildNeighborhoods(extent: Point2): Neighborhood[] {
  return NEIGHBORHOOD_SEEDS.map((seed) => ({
    id: `nbh-${slug(seed.name)}`,
    name: seed.name,
    center: rotate({ x: extent.x * seed.u, y: extent.y * seed.v }),
    dominantZoning: seed.zoning,
  }));
}

function buildBlocks(
  rows: number,
  columns: number,
  nodes: Map<string, NodeDraft>,
  edgeIndex: Map<string, string>,
  neighborhoods: Neighborhood[],
  random: () => number,
): Block[] {
  return range(rows).flatMap((row) =>
    range(columns).map((column) => {
      const corners = [
        intersectionId(column, row),
        intersectionId(column + 1, row),
        intersectionId(column + 1, row + 1),
        intersectionId(column, row + 1),
      ];
      const polygon = corners.map((id) => nodes.get(id)!.position);
      const neighborhood = nearestNeighborhood(centroid(polygon), neighborhoods);
      return {
        id: `blk-${column}-${row}`,
        boundingSegmentIds: corners.map((id, index) => edgeIndex.get(edgeKey(id, corners[(index + 1) % 4]))!),
        polygon,
        neighborhood: neighborhood.name,
        zoning: pickZoning(neighborhood.dominantZoning, random),
        areaSquareMeters: round(polygonArea(polygon), 2),
      };
    }),
  );
}

function pickZoning(dominant: Zoning, random: () => number): Zoning {
  const roll = random();
  if (roll < PARK_BLOCK_CHANCE) return "park";
  if (roll < DOMINANT_ZONING_CHANCE) return dominant;
  const alternates = ZONING_NEIGHBORS[dominant];
  return alternates[roll < (DOMINANT_ZONING_CHANCE + 1) / 2 ? 0 : 1];
}

function nearestNeighborhood(point: Point2, neighborhoods: Neighborhood[]): Neighborhood {
  return neighborhoods.reduce((closest, candidate) =>
    distance(point, candidate.center) < distance(point, closest.center) ? candidate : closest,
  );
}

/**
 * Lots face the two long edges of the block, odd numbers on the south side and
 * even on the north, the way US addressing runs. Parks stay empty: open space
 * is the point, and a renderer fills it with planting instead.
 */
function buildBuildings(
  block: Block,
  blockIndex: number,
  segmentsById: Map<string, StreetSegment>,
  core: Point2,
  random: () => number,
): Building[] {
  if (block.zoning === "park") return [];
  const [south, , north] = block.boundingSegmentIds.map((id) => segmentsById.get(id)!);
  const frontage = distance(block.polygon[0], block.polygon[1]);
  const lots = clamp(Math.round(frontage / LOT_FRONTAGE_METERS), MIN_LOTS_PER_SIDE, MAX_LOTS_PER_SIDE);
  const sides = [
    { key: "s", street: south.name, v0: LOT_EDGE_INSET, v1: 0.5 - LOT_DEPTH_GAP, parity: 1 },
    { key: "n", street: north.name, v0: 0.5 + LOT_DEPTH_GAP, v1: 1 - LOT_EDGE_INSET, parity: 2 },
  ];

  return sides.flatMap((side) =>
    range(lots).map((lot) => {
      const u0 = (lot + LOT_EDGE_INSET) / lots;
      const u1 = (lot + 1 - LOT_EDGE_INSET) / lots;
      const footprint = [
        quadPoint(block.polygon, u0, side.v0),
        quadPoint(block.polygon, u1, side.v0),
        quadPoint(block.polygon, u1, side.v1),
        quadPoint(block.polygon, u0, side.v1),
      ];
      const type = pick(BUILDING_TYPES_BY_ZONING[block.zoning], random);
      // Squared falloff: a plain exponential kept a long tail of towers halfway
      // across the map, where a real skyline drops off within a few blocks.
      const toCore = distance(centroid(footprint), core) / CORE_FALLOFF_METERS;
      const coreFactor = Math.exp(-toCore * toCore);
      const height = round(
        (BASE_HEIGHT_METERS[type] + CORE_HEIGHT_BONUS_METERS[type] * coreFactor) * (0.85 + 0.3 * random()),
        2,
      );
      const yearRoll = random();
      const building: Building = {
        id: `bld-${block.id}-${side.key}${lot}`,
        blockId: block.id,
        footprint,
        height,
        floors: Math.max(1, Math.round(height / FLOOR_HEIGHT_METERS)),
        type,
        address: { number: (blockIndex + 1) * 100 + lot * 4 + side.parity, street: side.street },
      };
      if (yearRoll >= UNDATED_BUILDING_CHANCE) {
        return { ...building, yearBuilt: EARLIEST_YEAR_BUILT + Math.floor(yearRoll * YEAR_BUILT_SPAN) };
      }
      return building;
    }),
  );
}

function buildSidewalks(
  segment: StreetSegment,
  nodes: Map<string, NodeDraft>,
  intersections: Map<string, Intersection>,
): Sidewalk[] {
  if (!segment.hasSidewalk) return [];
  const from = nodes.get(segment.fromIntersectionId)!.position;
  const to = nodes.get(segment.toIntersectionId)!.position;
  const length = Math.max(distance(from, to), Number.EPSILON);
  const normal = { x: -(to.y - from.y) / length, y: (to.x - from.x) / length };
  // Curb ramps are built where pedestrians are expected to cross, i.e. where
  // both ends of the block face a controlled crossing.
  const controlled = [segment.fromIntersectionId, segment.toIntersectionId].every((id) => {
    const control = intersections.get(id)?.control;
    return control === "traffic-light" || control === "stop-sign";
  });

  return ([-1, 1] as const).map((sign) => ({
    id: `sw-${segment.id}-${sign < 0 ? "left" : "right"}`,
    segmentId: segment.id,
    side: sign < 0 ? ("left" as const) : ("right" as const),
    widthMeters: SIDEWALK_WIDTH_METERS,
    path: [offset(from, normal, sign * SIDEWALK_OFFSET_METERS), offset(to, normal, sign * SIDEWALK_OFFSET_METERS)],
    hasStreetTrees: segment.classification === "arterial" || segment.classification === "collector",
    hasCurbRamps: controlled,
  }));
}

export function getBuildingsInBlock(map: CityMap, blockId: string): Building[] {
  return map.buildings.filter((building) => building.blockId === blockId);
}

export function getSegmentsAtIntersection(map: CityMap, intersectionId: string): StreetSegment[] {
  const intersection = map.intersections.find((candidate) => candidate.id === intersectionId);
  if (!intersection) return [];
  const ids = new Set(intersection.connectedSegmentIds);
  return map.segments.filter((segment) => ids.has(segment.id));
}

/** All segments of a named street, in the order they were laid out. */
export function findStreetByName(map: CityMap, name: string): StreetSegment[] {
  const wanted = name.trim().toLowerCase();
  return map.segments.filter((segment) => segment.name.toLowerCase() === wanted);
}

export function mapStats(map: CityMap): MapStats {
  const elevations = map.intersections.map((intersection) => intersection.elevation);
  const totalLength = map.segments.reduce((total, segment) => total + segment.lengthMeters, 0);
  const totalArea = map.blocks.reduce((total, block) => total + block.areaSquareMeters, 0);
  const totalFloors = map.buildings.reduce((total, building) => total + building.floors, 0);
  return {
    intersectionCount: map.intersections.length,
    segmentCount: map.segments.length,
    blockCount: map.blocks.length,
    buildingCount: map.buildings.length,
    sidewalkCount: map.sidewalks.length,
    totalStreetLengthMeters: round(totalLength, 2),
    averageBlockAreaSquareMeters: map.blocks.length === 0 ? 0 : round(totalArea / map.blocks.length, 2),
    oneWaySegmentRatio:
      map.segments.length === 0
        ? 0
        : round(map.segments.filter((segment) => segment.oneWay).length / map.segments.length, 4),
    averageFloors: map.buildings.length === 0 ? 0 : round(totalFloors / map.buildings.length, 2),
    tallestBuildingMeters: map.buildings.reduce((tallest, building) => Math.max(tallest, building.height), 0),
    steepestGradePercent: map.segments.reduce(
      (steepest, segment) => Math.max(steepest, Math.abs(segment.gradePercent)),
      0,
    ),
    elevationRange: { min: Math.min(...elevations), max: Math.max(...elevations) },
    buildingsByType: tally(
      map.buildings.map((building) => building.type),
      ["house", "apartment", "shop", "office", "warehouse", "civic"],
    ),
    blocksByZoning: tally(
      map.blocks.map((block) => block.zoning),
      ["residential", "commercial", "industrial", "mixed", "park"],
    ),
    intersectionsByControl: tally(
      map.intersections.map((intersection) => intersection.control),
      ["traffic-light", "stop-sign", "yield", "uncontrolled"],
    ),
  };
}

function tally<K extends string>(values: K[], keys: readonly K[]): Record<K, number> {
  return values.reduce(
    (counts, value) => ({ ...counts, [value]: counts[value] + 1 }),
    Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>,
  );
}

function rotate(point: Point2): Point2 {
  const cos = Math.cos(GRID_ROTATION_RADIANS);
  const sin = Math.sin(GRID_ROTATION_RADIANS);
  return { x: round(point.x * cos - point.y * sin, 3), y: round(point.x * sin + point.y * cos, 3) };
}

function headingOf(from: Point2, to: Point2): CardinalDirection {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? "north" : "south";
  return dx >= 0 ? "east" : "west";
}

function quadPoint(corners: Polygon, u: number, v: number): Point2 {
  const [sw, se, ne, nw] = corners;
  return lerpPoint(lerpPoint(sw, se, u), lerpPoint(nw, ne, u), v);
}

function lerpPoint(a: Point2, b: Point2, t: number): Point2 {
  return { x: round(a.x + (b.x - a.x) * t, 3), y: round(a.y + (b.y - a.y) * t, 3) };
}

function offset(point: Point2, normal: Point2, amount: number): Point2 {
  return { x: round(point.x + normal.x * amount, 3), y: round(point.y + normal.y * amount, 3) };
}

function centroid(polygon: Polygon): Point2 {
  const sum = polygon.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / polygon.length, y: sum.y / polygon.length };
}

function polygonArea(polygon: Polygon): number {
  const twiceArea = polygon.reduce((total, point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return total + (point.x * next.y - next.x * point.y);
  }, 0);
  return Math.abs(twiceArea) / 2;
}

function boundsOf(points: Point2[]): Bounds {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function distance(a: Point2, b: Point2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function intersectionId(column: number, row: number): string {
  return `int-${column}-${row}`;
}

function pick<T>(values: T[], random: () => number): T {
  return values[Math.min(values.length - 1, Math.floor(random() * values.length))];
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function ordinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  const suffixes = ["th", "st", "nd", "rd"];
  return `${value}${suffixes[value % 10] ?? "th"}`;
}
