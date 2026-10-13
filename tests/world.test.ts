import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Envelope, Polygon, Segment, rightOf } from "../src/world/geom";
import { Graph } from "../src/world/graph";
import { createMarking, Light } from "../src/world/markings";
import { parseOsm } from "../src/world/osm";
import { sampleWorld } from "../src/world/sample";
import { World, type CourseSave } from "../src/world/world";
import { WorldSim } from "../src/world/sim";

const square = (x: number, y: number, s: number) =>
  new Polygon([{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }]);

describe("polygons", () => {
  it("knows what is inside", () => {
    const sq = square(0, 0, 10);
    expect(sq.containsPoint({ x: 5, y: 5 })).toBe(true);
    expect(sq.containsPoint({ x: 15, y: 5 })).toBe(false);
  });

  it("unions two overlapping squares into one outline", () => {
    const outline = Polygon.union([square(0, 0, 10), square(5, 5, 10)]);
    const perimeter = outline.reduce((sum, s) => sum + s.length(), 0);
    expect(perimeter).toBeCloseTo(60);
  });

  it("builds a road envelope as wide as asked", () => {
    const env = new Envelope(new Segment({ x: 0, y: 0 }, { x: 100, y: 0 }), 40, 4);
    const ys = env.poly.points.map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40);
  });
});

describe("graph", () => {
  it("drops segments when a point is removed", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    const g = new Graph([a, b], [new Segment(a, b)]);
    g.removePoint(a);
    expect(g.points).toHaveLength(1);
    expect(g.segments).toHaveLength(0);
  });

  it("refuses duplicate and zero-length segments", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    const g = new Graph([a, b]);
    expect(g.tryAddSegment(new Segment(a, b))).toBe(true);
    expect(g.tryAddSegment(new Segment(b, a))).toBe(false);
    expect(g.tryAddSegment(new Segment(a, a))).toBe(false);
  });

  it("round-trips through JSON", () => {
    const g = sampleWorld().graph;
    const copy = Graph.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
    expect(copy.points).toHaveLength(g.points.length);
    expect(copy.segments).toHaveLength(g.segments.length);
  });
});

describe("world", () => {
  it("puts each lane on the right-hand side of its direction of travel", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: -400 }; // driving up the screen
    const w = new World(new Graph([a, b], [new Segment(a, b)]));
    w.generateRoads();
    const [up, down] = w.laneGuides;
    expect(up.p1.x).toBeGreaterThan(0);
    expect(down.p1.x).toBeLessThan(0);
    expect(rightOf(up.directionVector()).x).toBeCloseTo(1);
  });

  it("generates scenery and keeps buildings off the roads", () => {
    const w = sampleWorld();
    w.generateItems();
    expect(w.buildings.length).toBeGreaterThan(10);
    expect(w.trees.length).toBeGreaterThan(0);
    for (const b of w.buildings) {
      for (const env of w.envelopes) expect(b.base.intersectsPoly(env.poly)).toBe(false);
    }
  });

  it("round-trips markings through JSON", () => {
    const w = sampleWorld();
    const copy = World.fromJSON(JSON.parse(JSON.stringify(w.toJSON())));
    expect(copy.markings.map((m) => m.type)).toEqual(w.markings.map((m) => m.type));
  });

  it("gives one light per intersection the green at a time, and walls off the red ones", () => {
    const w = sampleWorld(); // three lights share the east intersection
    const lights = w.markings.filter((m): m is Light => m instanceof Light);
    for (let t = 0; t < 9; t++) {
      w.updateLights(t);
      const open = lights.filter((l) => l.state === "green" || l.state === "yellow");
      expect(open).toHaveLength(1);
      const walls = w.obstacles().length - w.roadBorders.length;
      // Yellow is not a wall: a car already over the line clears the junction.
      expect(walls).toBe(lights.length - 1);
    }
  });

  it("sizes markings like the course: one lane square, crossings span the road", () => {
    expect(createMarking("stop", { x: 0, y: 0 }, { x: 0, y: -1 }, 100).width).toBe(50);
    expect(createMarking("crossing", { x: 0, y: 0 }, { x: 0, y: -1 }, 100).width).toBe(100);
    expect(createMarking("light", { x: 0, y: 0 }, { x: 0, y: -1 }, 100).height).toBe(18);
  });
});

describe("course save", () => {
  it("opens the course city with its prebuilt roads and scenery", () => {
    const save = JSON.parse(readFileSync("public/samples/course-city.json", "utf8")) as CourseSave;
    const w = World.fromCourseSave(save);
    expect(w.graph.segments.length).toBeGreaterThan(400);
    expect(w.roadBorders.length).toBeGreaterThan(0);
    expect(w.buildings.length).toBeGreaterThan(100);
    expect(w.roadsVersion).toBe(w.graph.version); // nothing to regenerate
    expect(w.markings.some((m) => m.type === "start")).toBe(true);
  });
});

describe("OpenStreetMap import", () => {
  it("projects nodes and links consecutive way nodes", () => {
    const g = parseOsm({
      elements: [
        { type: "node", id: 1, lat: 30.44, lon: -84.29 },
        { type: "node", id: 2, lat: 30.441, lon: -84.29 },
        { type: "node", id: 3, lat: 30.441, lon: -84.289 },
        { type: "way", id: 9, nodes: [1, 2, 3], tags: { highway: "residential" } },
      ],
    });
    expect(g.points).toHaveLength(3);
    expect(g.segments).toHaveLength(2);
    expect(g.segments[0].length()).toBeGreaterThan(1000); // ~111 m at 10 px per meter
  });

  it("marks one-way and single-lane ways as one-way, like the course", () => {
    const g = parseOsm({
      elements: [
        { type: "node", id: 1, lat: 30.44, lon: -84.29 },
        { type: "node", id: 2, lat: 30.441, lon: -84.29 },
        { type: "node", id: 3, lat: 30.442, lon: -84.29 },
        { type: "way", id: 7, nodes: [1, 2], tags: { highway: "residential", oneway: "yes" } },
        { type: "way", id: 8, nodes: [2, 3], tags: { highway: "residential" } },
      ],
    });
    expect(g.segments.map((s) => s.oneWay)).toEqual([true, false]);
    expect(Graph.fromJSON(g.toJSON()).segments[0].oneWay).toBe(true);
  });
});

describe("driving in the world", () => {
  it("spawns at the start marking and keeps every car", () => {
    const w = sampleWorld();
    const sim = new WorldSim(() => w, null);
    sim.population = 5;
    expect(sim.begin("AI")).toBe(true);
    const start = w.markings.find((m) => m.type === "start")!;
    expect(sim.cars[0].x).toBeCloseTo(start.center.x);
    for (let i = 0; i < 120; i++) sim.step();
    expect(sim.cars.length).toBe(5);
  });

  it("refuses to start without a start marking", () => {
    const sim = new WorldSim(() => new World(new Graph()), null);
    expect(sim.begin("AI")).toBe(false);
  });
});

describe("world levels and navigation", () => {
  it("measures road distance to the destination and points the GPS along the road", async () => {
    const { Navigator } = await import("../src/world/nav");
    // An L-shaped road: (0,0) to (400,0) to (400,400).
    const a = { x: 0, y: 0 };
    const b = { x: 400, y: 0 };
    const c = { x: 400, y: 400 };
    const nav = new Navigator(new Graph([a, b, c], [new Segment(a, b), new Segment(b, c)]), { x: 400, y: 300 });
    const from = { x: 100, y: 0 };
    expect(nav.remaining(from)).toBeCloseTo(300 + 300, 0); // along the road, not the 361 px straight line
    expect(nav.guide(from, nav.nearestSegment(from)).waypoint).toEqual(b); // head for the corner first
  });

  it("starts at level 1 with minimal brains and moves up when a car survives the time limit", async () => {
    const { WORLD_INPUTS } = await import("../src/world/sim");
    const w = sampleWorld();
    const sim = new WorldSim(() => w);
    sim.population = 1;
    sim.begin("AI");
    expect(sim.level).toBe(1);
    expect(sim.neat.genomes[0].inputIds).toHaveLength(WORLD_INPUTS);
    const car = sim.cars[0];
    car.brain = undefined; // a parked car never crashes, but stalls: drive it gently in place
    let frames = 0;
    while (sim.generation === 1 && frames < 4000) {
      car.speed = 0.5;
      car.angle += 0.02; // small circles in the start lane
      sim.step();
      frames++;
    }
    expect(sim.generation).toBe(2);
  });

  it("random-trip levels score every brain on several trips before breeding", async () => {
    const { TRIPS_PER_GENERATION } = await import("../src/world/sim");
    const w = sampleWorld();
    const sim = new WorldSim(() => w);
    sim.population = 5;
    sim.level = 3;
    sim.begin("AI");
    expect(sim.tripsPerGeneration).toBe(TRIPS_PER_GENERATION);
    const destinations = new Set<string>();
    while (sim.generation === 1) {
      if (sim.destination) destinations.add(`${Math.round(sim.destination.x)},${Math.round(sim.destination.y)}`);
      sim.step();
    }
    expect(destinations.size).toBe(TRIPS_PER_GENERATION);
    expect(sim.last!.trips).toBe(TRIPS_PER_GENERATION);
  });
});

describe("training on the visitor's own map", () => {
  it("drives one timed trip to the Target marking and never changes level", () => {
    const w = sampleWorld();
    w.markings = w.markings.filter((m) => m.type !== "target");
    const lane = w.laneGuides[w.laneGuides.length - 1];
    const target = { x: (lane.p1.x + lane.p2.x) / 2, y: (lane.p1.y + lane.p2.y) / 2 };
    const marking = createMarking("target", target, lane.directionVector(), w.settings.roadWidth);
    w.markings.push(marking);
    const sim = new WorldSim(() => w);
    sim.population = 4;
    sim.level = 5;
    sim.startCustom();
    expect(sim.begin("AI")).toBe(true);
    expect(sim.tripsPerGeneration).toBe(1);
    expect(sim.destination).toEqual(marking.center);
    expect(sim.timeLimit).toBeGreaterThan(0);
    while (sim.generation === 1) sim.step();
    expect(sim.level).toBe(5);
    expect(sim.last!.level).toBe(0);
  });

  it("heads for the farthest road without a Target, and restores the level brains afterwards", () => {
    const w = sampleWorld();
    w.markings = w.markings.filter((m) => m.type !== "target");
    const sim = new WorldSim(() => w);
    sim.population = 4;
    sim.level = 4;
    const levels = sim.toJSON();
    const champion = JSON.stringify(levels.neat);
    sim.startCustom();
    sim.begin("AI");
    expect(sim.destination).not.toBeNull();
    for (let g = 0; g < 3; g++) sim.nextGeneration();
    expect(JSON.stringify(sim.neat.toJSON())).not.toBe(champion);
    sim.stop();
    sim.custom = false;
    sim.restore(levels);
    expect(sim.level).toBe(4);
    expect(JSON.stringify(sim.neat.toJSON())).toBe(champion);
  });
});

describe("timed world levels", () => {
  it("never run out, never tighten the clock past what is drivable, and change map every three levels", async () => {
    const { worldLevelSpec } = await import("../src/world/sim");
    expect(worldLevelSpec(1).goal).toBe("survive");
    for (let n = 2; n < 120; n++) {
      const s = worldLevelSpec(n);
      expect(s.goal).toBe("every");
      expect(s.timeFactor).toBeGreaterThanOrEqual(1.3);
      expect(s.map).toBe(Math.floor((n - 1) / 3));
    }
    expect(worldLevelSpec(60).minTrip).toBeGreaterThan(worldLevelSpec(5).minTrip);
  });

  it("gives every trip a time limit longer than driving its route flat out", async () => {
    const w = sampleWorld();
    const sim = new WorldSim(() => w);
    sim.population = 3;
    sim.level = 2;
    sim.begin("AI");
    expect(sim.destination).not.toBeNull();
    const { Navigator } = await import("../src/world/nav");
    const nav = new Navigator(w.graph, sim.destination!);
    const flatOut = nav.remaining(sim.origin!.center) / 3; // frames at top speed, no turns or lights
    expect(sim.timeLimit!).toBeGreaterThan(flatOut * 1.3);
  });
});

describe("generated level maps", () => {
  it("are connected both ways (one-way streets included), themed, and marked", async () => {
    const { generateMap, stronglyConnected } = await import("../src/world/mapgen");
    for (const seed of [11, 22]) {
      for (let m = 1; m <= 6; m++) {
        const w = generateMap(m, seed);
        expect(w.theme).toBeDefined();
        const pts = w.graph.points;
        const index = (p: { x: number; y: number }) => pts.findIndex((q) => q.x === p.x && q.y === p.y);
        const edges = w.graph.segments.map((s) => [index(s.p1), index(s.p2)] as [number, number]);
        expect(stronglyConnected(pts.length, edges, w.graph.segments.map((s) => s.oneWay))).toBe(true);
        expect(w.markings.filter((k) => k.type === "start")).toHaveLength(1);
      }
    }
  });

  it("GPS never routes the wrong way down a one-way street", async () => {
    const { Navigator } = await import("../src/world/nav");
    // A one-way street from a to b; the destination is near a, so the car at b must go around.
    const a = { x: 0, y: 0 }, b = { x: 400, y: 0 }, c = { x: 400, y: 400 }, d = { x: 0, y: 400 };
    const g = new Graph([a, b, c, d], [new Segment(a, b, true), new Segment(b, c), new Segment(c, d), new Segment(d, a)]);
    const nav = new Navigator(g, { x: 0, y: 200 }); // on the d-a street
    const path = nav.path({ x: 390, y: 0 });
    expect(path.map((p) => `${p.x},${p.y}`)).toContain("400,400"); // around via c, not back along a-b
  });
});
