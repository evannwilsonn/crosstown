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

  it("gives one light per intersection the green at a time, and walls off the rest", () => {
    const w = sampleWorld(); // three lights share the east intersection
    const lights = w.markings.filter((m): m is Light => m instanceof Light);
    for (let t = 0; t < 9; t++) {
      w.updateLights(t);
      const open = lights.filter((l) => l.state === "green" || l.state === "yellow");
      expect(open).toHaveLength(1);
      const walls = w.obstacles().length - w.roadBorders.length;
      expect(walls).toBe(lights.length - (open[0].state === "green" ? 1 : 0));
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
