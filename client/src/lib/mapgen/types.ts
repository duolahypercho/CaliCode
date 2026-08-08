/**
 * Data model for a generated city map.
 *
 * Deliberately free of three.js and DOM references: the map is plain data so it
 * can be generated in a worker, snapshotted in tests, diffed, and serialised to
 * the core. Rendering consumes these types, it does not live in them.
 *
 * All distances are metres and all coordinates share one world space whose +x
 * axis points east and +y axis points north.
 */

export interface Point2 {
  x: number;
  y: number;
}

/** Ring of points, implicitly closed (the last point connects to the first). */
export type Polygon = Point2[];

/** Open polyline; used for paths that are not areas, such as sidewalks. */
export type Polyline = Point2[];

export type CardinalDirection = "north" | "south" | "east" | "west";

export type StreetClassification = "arterial" | "collector" | "local" | "highway";

export type IntersectionControl = "traffic-light" | "stop-sign" | "yield" | "uncontrolled";

export type Zoning = "residential" | "commercial" | "industrial" | "mixed" | "park";

export type BuildingType = "house" | "apartment" | "shop" | "office" | "warehouse" | "civic";

export type SidewalkSide = "left" | "right";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * One block-length piece of street between two intersections. A named street is
 * the ordered set of segments that share a `name`.
 */
export interface StreetSegment {
  id: string;
  name: string;
  fromIntersectionId: string;
  toIntersectionId: string;
  /** When true, traffic may only travel from `from` to `to`, i.e. `direction`. */
  oneWay: boolean;
  /** Heading of from -> to, snapped to the dominant axis of the segment. */
  direction: CardinalDirection;
  laneCount: number;
  /** Posted limit in miles per hour, matching US signage. */
  speedLimit: number;
  hasSidewalk: boolean;
  hasBikeLane: boolean;
  classification: StreetClassification;
  lengthMeters: number;
  /** Signed rise over run as a percentage, from -> to. SF hills get steep. */
  gradePercent: number;
}

export interface SignalPhase {
  movement: "north-south" | "east-west" | "left-turn";
  durationSeconds: number;
}

export interface Intersection {
  id: string;
  position: Point2;
  elevation: number;
  connectedSegmentIds: string[];
  control: IntersectionControl;
  /** Present only when `control` is "traffic-light". */
  signalPhases?: SignalPhase[];
}

export interface Neighborhood {
  id: string;
  name: string;
  center: Point2;
  dominantZoning: Zoning;
}

export interface Block {
  id: string;
  /** The segments that fence this block in, in south/east/north/west order. */
  boundingSegmentIds: string[];
  polygon: Polygon;
  neighborhood: string;
  zoning: Zoning;
  areaSquareMeters: number;
}

export interface Address {
  number: number;
  street: string;
}

export interface Building {
  id: string;
  blockId: string;
  footprint: Polygon;
  /** Roof height above the block, in metres. */
  height: number;
  floors: number;
  type: BuildingType;
  address: Address;
  yearBuilt?: number;
}

export interface Sidewalk {
  id: string;
  segmentId: string;
  side: SidewalkSide;
  widthMeters: number;
  path: Polyline;
  hasStreetTrees: boolean;
  hasCurbRamps: boolean;
}

export interface CityMap {
  name: string;
  seed: number;
  bounds: Bounds;
  intersections: Intersection[];
  segments: StreetSegment[];
  blocks: Block[];
  buildings: Building[];
  sidewalks: Sidewalk[];
  neighborhoods: Neighborhood[];
}

export interface GenerateCityMapOptions {
  /** The only source of randomness. Same seed in, byte-identical map out. */
  seed: number;
  name?: string;
  /** Number of block columns; there are `columns + 1` cross streets. */
  columns?: number;
  /** Number of block rows; there are `rows + 1` running streets. */
  rows?: number;
  /** Nominal block edge before per-block jitter and downtown compression. */
  blockSizeMeters?: number;
}

export interface MapStats {
  intersectionCount: number;
  segmentCount: number;
  blockCount: number;
  buildingCount: number;
  sidewalkCount: number;
  totalStreetLengthMeters: number;
  averageBlockAreaSquareMeters: number;
  oneWaySegmentRatio: number;
  averageFloors: number;
  tallestBuildingMeters: number;
  steepestGradePercent: number;
  elevationRange: { min: number; max: number };
  buildingsByType: Record<BuildingType, number>;
  blocksByZoning: Record<Zoning, number>;
  intersectionsByControl: Record<IntersectionControl, number>;
}
