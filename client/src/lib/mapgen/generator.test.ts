import { describe, expect, it } from "vitest";
import {
  findStreetByName,
  generateCityMap,
  getBuildingsInBlock,
  getSegmentsAtIntersection,
  mapStats,
  mulberry32,
} from "./generator";
import type { CityMap } from "./types";

const SEED = 1987;

function makeMap(seed = SEED): CityMap {
  return generateCityMap({ seed });
}

describe("mulberry32", () => {
  it("produces the same stream for the same seed", () => {
    // Arrange
    const first = mulberry32(42);
    const second = mulberry32(42);

    // Act
    const a = [first(), first(), first()];
    const b = [second(), second(), second()];

    // Assert
    expect(a).toEqual(b);
  });

  it("produces values inside the unit interval", () => {
    const random = mulberry32(7);
    const values = Array.from({ length: 500 }, () => random());
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("diverges for different seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("generateCityMap determinism", () => {
  it("returns an identical map for the same seed", () => {
    // Arrange / Act
    const first = generateCityMap({ seed: SEED });
    const second = generateCityMap({ seed: SEED });

    // Assert
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("returns a different map for a different seed", () => {
    const first = generateCityMap({ seed: SEED });
    const second = generateCityMap({ seed: SEED + 1 });
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
  });

  it("keeps street topology stable across seeds while geometry moves", () => {
    const first = generateCityMap({ seed: 3 });
    const second = generateCityMap({ seed: 4 });
    expect(second.segments.length).toBe(first.segments.length);
    expect(second.intersections.map((node) => node.id)).toEqual(first.intersections.map((node) => node.id));
    expect(second.intersections[5].position).not.toEqual(first.intersections[5].position);
  });

  it("honours the requested grid size", () => {
    const map = generateCityMap({ seed: SEED, rows: 4, columns: 5 });
    expect(map.intersections.length).toBe(5 * 6);
    expect(map.blocks.length).toBe(4 * 5);
  });

  it("uses the supplied name and records the seed", () => {
    const map = generateCityMap({ seed: 99, name: "Baghdad by the Bay" });
    expect(map.name).toBe("Baghdad by the Bay");
    expect(map.seed).toBe(99);
  });
});

describe("referential integrity", () => {
  const map = makeMap();

  it("points every segment at real intersections", () => {
    const ids = new Set(map.intersections.map((intersection) => intersection.id));
    for (const segment of map.segments) {
      expect(ids.has(segment.fromIntersectionId)).toBe(true);
      expect(ids.has(segment.toIntersectionId)).toBe(true);
      expect(segment.fromIntersectionId).not.toBe(segment.toIntersectionId);
    }
  });

  it("points every intersection at real segments", () => {
    const ids = new Set(map.segments.map((segment) => segment.id));
    for (const intersection of map.intersections) {
      expect(intersection.connectedSegmentIds.length).toBeGreaterThan(0);
      for (const segmentId of intersection.connectedSegmentIds) {
        expect(ids.has(segmentId)).toBe(true);
      }
    }
  });

  it("keeps the intersection and segment references symmetric", () => {
    const byId = new Map(map.intersections.map((intersection) => [intersection.id, intersection]));
    for (const segment of map.segments) {
      for (const nodeId of [segment.fromIntersectionId, segment.toIntersectionId]) {
        expect(byId.get(nodeId)?.connectedSegmentIds).toContain(segment.id);
      }
    }
  });

  it("assigns every building to a real block", () => {
    const blockIds = new Set(map.blocks.map((block) => block.id));
    expect(map.buildings.length).toBeGreaterThan(0);
    for (const building of map.buildings) {
      expect(blockIds.has(building.blockId)).toBe(true);
    }
  });

  it("fences every block with four real segments", () => {
    const segmentIds = new Set(map.segments.map((segment) => segment.id));
    for (const block of map.blocks) {
      expect(block.boundingSegmentIds).toHaveLength(4);
      expect(new Set(block.boundingSegmentIds).size).toBe(4);
      for (const segmentId of block.boundingSegmentIds) {
        expect(segmentIds.has(segmentId)).toBe(true);
      }
    }
  });

  it("attaches every sidewalk to a segment that has one", () => {
    const withSidewalk = new Set(
      map.segments.filter((segment) => segment.hasSidewalk).map((segment) => segment.id),
    );
    for (const sidewalk of map.sidewalks) {
      expect(withSidewalk.has(sidewalk.segmentId)).toBe(true);
      expect(sidewalk.path).toHaveLength(2);
    }
    expect(map.sidewalks.length).toBe(withSidewalk.size * 2);
  });

  it("gives every entity a unique id", () => {
    const ids = [
      ...map.intersections.map((item) => item.id),
      ...map.segments.map((item) => item.id),
      ...map.blocks.map((item) => item.id),
      ...map.buildings.map((item) => item.id),
      ...map.sidewalks.map((item) => item.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("street metadata", () => {
  const map = makeMap();

  it("keeps one-way flags and headings consistent along a street", () => {
    const streets = new Map<string, typeof map.segments>();
    for (const segment of map.segments) {
      streets.set(segment.name, [...(streets.get(segment.name) ?? []), segment]);
    }
    for (const segments of streets.values()) {
      const oneWayFlags = new Set(segments.map((segment) => segment.oneWay));
      expect(oneWayFlags.size).toBe(1);
      if (segments[0].oneWay) {
        // A one-way street must not double back on itself mid-street.
        expect(new Set(segments.map((segment) => segment.direction)).size).toBe(1);
      }
    }
  });

  it("records the direction that matches the segment geometry", () => {
    const byId = new Map(map.intersections.map((intersection) => [intersection.id, intersection]));
    for (const segment of map.segments) {
      const from = byId.get(segment.fromIntersectionId)!.position;
      const to = byId.get(segment.toIntersectionId)!.position;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const expected =
        Math.abs(dy) >= Math.abs(dx) ? (dy >= 0 ? "north" : "south") : dx >= 0 ? "east" : "west";
      expect(segment.direction).toBe(expected);
    }
  });

  it("never marks an arterial or highway as one-way", () => {
    const majors = map.segments.filter(
      (segment) => segment.classification === "arterial" || segment.classification === "highway",
    );
    expect(majors.length).toBeGreaterThan(0);
    expect(majors.every((segment) => !segment.oneWay)).toBe(true);
  });

  it("produces both one-way and two-way streets", () => {
    const oneWayCount = map.segments.filter((segment) => segment.oneWay).length;
    expect(oneWayCount).toBeGreaterThan(0);
    expect(oneWayCount).toBeLessThan(map.segments.length);
  });

  it("scales speed limits and lanes with classification", () => {
    for (const segment of map.segments) {
      if (segment.classification === "local") {
        expect(segment.speedLimit).toBe(25);
        expect(segment.laneCount).toBe(2);
      }
      if (segment.classification === "highway") {
        expect(segment.speedLimit).toBe(65);
        expect(segment.hasSidewalk).toBe(false);
        expect(segment.hasBikeLane).toBe(false);
      }
      expect(segment.lengthMeters).toBeGreaterThan(0);
    }
  });

  it("lays out a diagonal Market Street across the grid", () => {
    const market = findStreetByName(map, "Market Street");
    expect(market.length).toBeGreaterThan(3);
    expect(market.every((segment) => segment.classification === "arterial")).toBe(true);
    // A true diagonal shares no node pair with the orthogonal grid.
    const gridEdges = new Set(
      map.segments
        .filter((segment) => segment.name !== "Market Street")
        .map((segment) => [segment.fromIntersectionId, segment.toIntersectionId].sort().join("|")),
    );
    for (const segment of market) {
      expect(gridEdges.has([segment.fromIntersectionId, segment.toIntersectionId].sort().join("|"))).toBe(
        false,
      );
    }
  });

  it("names numbered cross streets with correct ordinals", () => {
    const names = new Set(map.segments.map((segment) => segment.name));
    expect(names.has("1st Street")).toBe(true);
    expect(names.has("2nd Street")).toBe(true);
    expect(names.has("3rd Street")).toBe(true);
    expect(names.has("11th Street")).toBe(true);
    expect(names.has("Broadway")).toBe(true);
  });
});

describe("intersection control", () => {
  const map = makeMap();

  it("puts traffic lights on arterials and stop signs on local corners", () => {
    const byId = new Map(map.segments.map((segment) => [segment.id, segment]));
    for (const intersection of map.intersections) {
      const connected = intersection.connectedSegmentIds.map((id) => byId.get(id)!);
      const kinds = new Set(connected.map((segment) => segment.classification));
      if (kinds.has("highway")) {
        expect(intersection.control).toBe("uncontrolled");
      } else if (kinds.has("arterial")) {
        expect(intersection.control).toBe("traffic-light");
      } else if (kinds.has("collector")) {
        expect(intersection.control).toBe(connected.length >= 4 ? "stop-sign" : "yield");
      } else if (connected.length >= 3) {
        expect(intersection.control).toBe("stop-sign");
      }
    }
  });

  it("uses every control kind somewhere in the city", () => {
    const controls = new Set(map.intersections.map((intersection) => intersection.control));
    expect(controls).toEqual(new Set(["traffic-light", "stop-sign", "yield", "uncontrolled"]));
  });

  it("attaches signal phases only to traffic lights", () => {
    const lights = map.intersections.filter((node) => node.control === "traffic-light");
    expect(lights.length).toBeGreaterThan(0);
    for (const intersection of map.intersections) {
      if (intersection.control === "traffic-light") {
        expect(intersection.signalPhases).toHaveLength(3);
        expect(intersection.signalPhases!.every((phase) => phase.durationSeconds > 0)).toBe(true);
      } else {
        expect(intersection.signalPhases).toBeUndefined();
      }
    }
  });
});

describe("terrain and neighborhoods", () => {
  const map = makeMap();

  it("varies elevation like a hilly city, measured from sea level", () => {
    const elevations = map.intersections.map((intersection) => intersection.elevation);
    expect(Math.min(...elevations)).toBe(0);
    expect(Math.max(...elevations)).toBeGreaterThan(50);
  });

  it("keeps every street drivable, however steep", () => {
    // SF's steepest drivable street is about 31.5%; past ~35% nothing climbs it.
    for (const seed of [1, 2, 3, 1987, 65535]) {
      const steepest = mapStats(generateCityMap({ seed })).steepestGradePercent;
      expect(steepest).toBeGreaterThan(5);
      expect(steepest).toBeLessThan(35);
    }
  });

  it("derives segment grade from the elevation of its endpoints", () => {
    const byId = new Map(map.intersections.map((intersection) => [intersection.id, intersection]));
    for (const segment of map.segments) {
      const rise = byId.get(segment.toIntersectionId)!.elevation - byId.get(segment.fromIntersectionId)!.elevation;
      expect(segment.gradePercent).toBeCloseTo((rise / segment.lengthMeters) * 100, 1);
    }
  });

  it("assigns every block to a named neighborhood and a zoning kind", () => {
    const names = new Set(map.neighborhoods.map((neighborhood) => neighborhood.name));
    expect(names.size).toBeGreaterThan(1);
    for (const block of map.blocks) {
      expect(names.has(block.neighborhood)).toBe(true);
      expect(block.areaSquareMeters).toBeGreaterThan(0);
      expect(block.polygon).toHaveLength(4);
    }
    expect(new Set(map.blocks.map((block) => block.zoning)).size).toBeGreaterThan(1);
  });

  it("clusters zoning so a neighborhood keeps a dominant character", () => {
    const commercial = map.blocks.filter((block) => block.neighborhood === "Financial District");
    const share = commercial.filter((block) => block.zoning === "commercial").length / commercial.length;
    expect(commercial.length).toBeGreaterThan(0);
    expect(share).toBeGreaterThan(0.5);
  });
});

describe("buildings", () => {
  const map = makeMap();

  it("leaves park blocks unbuilt and builds on every other block", () => {
    for (const block of map.blocks) {
      const built = getBuildingsInBlock(map, block.id);
      if (block.zoning === "park") {
        expect(built).toHaveLength(0);
      } else {
        expect(built.length).toBeGreaterThan(0);
      }
    }
  });

  it("gives every building a footprint, floors, and an address on a real street", () => {
    const streetNames = new Set(map.segments.map((segment) => segment.name));
    for (const building of map.buildings) {
      expect(building.footprint).toHaveLength(4);
      expect(building.height).toBeGreaterThan(0);
      expect(building.floors).toBeGreaterThanOrEqual(1);
      expect(building.address.number).toBeGreaterThan(0);
      expect(streetNames.has(building.address.street)).toBe(true);
      if (building.yearBuilt !== undefined) {
        expect(building.yearBuilt).toBeGreaterThanOrEqual(1868);
        expect(building.yearBuilt).toBeLessThanOrEqual(2023);
      }
    }
  });

  it("builds tallest at the downtown core and shorter at the edges", () => {
    const downtown = map.blocks.filter((block) => block.neighborhood === "Financial District");
    const outskirts = map.blocks.filter((block) => block.neighborhood === "Sunset");
    const tallest = (blockIds: string[]): number =>
      blockIds
        .flatMap((id) => getBuildingsInBlock(map, id))
        .reduce((max, building) => Math.max(max, building.height), 0);

    expect(tallest(downtown.map((block) => block.id))).toBeGreaterThan(
      tallest(outskirts.map((block) => block.id)),
    );
  });

  it("keeps the city low-rise outside a compact tall core", () => {
    const floors = map.buildings.map((building) => building.floors).sort((a, b) => a - b);
    const median = floors[Math.floor(floors.length / 2)];
    const towers = floors.filter((count) => count > 20).length;

    expect(median).toBeLessThanOrEqual(8);
    expect(towers).toBeGreaterThan(0);
    expect(towers / floors.length).toBeLessThan(0.25);
  });

  it("keeps building footprints inside their block", () => {
    const block = map.blocks.find((candidate) => getBuildingsInBlock(map, candidate.id).length > 0)!;
    const xs = block.polygon.map((point) => point.x);
    const ys = block.polygon.map((point) => point.y);
    for (const building of getBuildingsInBlock(map, block.id)) {
      for (const point of building.footprint) {
        expect(point.x).toBeGreaterThanOrEqual(Math.min(...xs) - 1);
        expect(point.x).toBeLessThanOrEqual(Math.max(...xs) + 1);
        expect(point.y).toBeGreaterThanOrEqual(Math.min(...ys) - 1);
        expect(point.y).toBeLessThanOrEqual(Math.max(...ys) + 1);
      }
    }
  });
});

describe("query helpers", () => {
  const map = makeMap();

  it("returns only the buildings of the requested block", () => {
    const block = map.blocks.find((candidate) => candidate.zoning !== "park")!;
    const built = getBuildingsInBlock(map, block.id);
    expect(built.length).toBeGreaterThan(0);
    expect(built.every((building) => building.blockId === block.id)).toBe(true);
  });

  it("returns an empty list for an unknown block", () => {
    expect(getBuildingsInBlock(map, "blk-does-not-exist")).toEqual([]);
  });

  it("returns the segments meeting at an intersection", () => {
    const intersection = map.intersections.find((node) => node.connectedSegmentIds.length === 4)!;
    const segments = getSegmentsAtIntersection(map, intersection.id);
    expect(segments).toHaveLength(4);
    for (const segment of segments) {
      expect([segment.fromIntersectionId, segment.toIntersectionId]).toContain(intersection.id);
    }
  });

  it("returns an empty list for an unknown intersection", () => {
    expect(getSegmentsAtIntersection(map, "int-999-999")).toEqual([]);
  });

  it("finds a street by name regardless of case or padding", () => {
    const exact = findStreetByName(map, "Broadway");
    expect(exact.length).toBeGreaterThan(0);
    expect(findStreetByName(map, "  broadway  ")).toEqual(exact);
    expect(findStreetByName(map, "Nonexistent Way")).toEqual([]);
  });
});

describe("mapStats", () => {
  const map = makeMap();
  const stats = mapStats(map);

  it("counts what the map actually holds", () => {
    expect(stats.intersectionCount).toBe(map.intersections.length);
    expect(stats.segmentCount).toBe(map.segments.length);
    expect(stats.blockCount).toBe(map.blocks.length);
    expect(stats.buildingCount).toBe(map.buildings.length);
    expect(stats.sidewalkCount).toBe(map.sidewalks.length);
  });

  it("reports sane aggregates", () => {
    expect(stats.totalStreetLengthMeters).toBeGreaterThan(0);
    expect(stats.averageBlockAreaSquareMeters).toBeGreaterThan(0);
    expect(stats.oneWaySegmentRatio).toBeGreaterThan(0);
    expect(stats.oneWaySegmentRatio).toBeLessThan(1);
    expect(stats.averageFloors).toBeGreaterThanOrEqual(1);
    expect(stats.tallestBuildingMeters).toBeGreaterThan(stats.averageFloors);
    expect(stats.steepestGradePercent).toBeGreaterThan(0);
    expect(stats.elevationRange.max).toBeGreaterThan(stats.elevationRange.min);
  });

  it("tallies categories exhaustively", () => {
    const sum = (counts: Record<string, number>): number =>
      Object.values(counts).reduce((total, value) => total + value, 0);
    expect(sum(stats.buildingsByType)).toBe(map.buildings.length);
    expect(sum(stats.blocksByZoning)).toBe(map.blocks.length);
    expect(sum(stats.intersectionsByControl)).toBe(map.intersections.length);
    expect(Object.keys(stats.buildingsByType)).toHaveLength(6);
    expect(Object.keys(stats.blocksByZoning)).toHaveLength(5);
    expect(Object.keys(stats.intersectionsByControl)).toHaveLength(4);
  });

  it("is stable for a stable seed", () => {
    expect(mapStats(generateCityMap({ seed: SEED }))).toEqual(stats);
  });
});
