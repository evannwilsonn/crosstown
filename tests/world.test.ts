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
    // The GPS points 150 px ahead along the route: straight on, then round the corner as it nears.
    expect(nav.guide(from, nav.nearestSegment(from)).waypoint).toEqual({ x: 250, y: 0 });
    const nearCorner = { x: 350, y: 0 };
    expect(nav.guide(nearCorner, nav.nearestSegment(nearCorner)).waypoint).toEqual({ x: 400, y: 100 });
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

  it("level 1 isn't cleared by a car circling at the start for 45 s", () => {
    const w = sampleWorld();
    const sim = new WorldSim(() => w);
    sim.population = 1;
    sim.begin("AI");
    const car = sim.cars[0];
    car.brain = undefined;
    while (sim.generation === 1) {
      car.speed = 0.5;
      car.angle += 0.02;
      sim.step();
    }
    expect(sim.last!.levelUp).toBe(false);
    expect(sim.level).toBe(1);
  });

  it("follows the best car still driving once the best one crashes", () => {
    const w = sampleWorld();
    const sim = new WorldSim(() => w);
    sim.population = 3;
    sim.begin("AI");
    for (let i = 0; i < 30; i++) sim.step();
    const [a, b] = sim.cars;
    a.progress = 500;
    a.damaged = true;
    b.progress = 100;
    b.damaged = false;
    sim.step();
    expect(sim.leader).toBe(a);
    expect(sim.followed).not.toBe(a);
    expect(sim.followed!.damaged).toBe(false);
  });

  it("doesn't follow a car that has stopped in place while another is moving", () => {
    const w = sampleWorld();
    const sim = new WorldSim(() => w);
    sim.population = 2;
    sim.begin("AI");
    const [stopped, mover] = sim.cars;
    stopped.brain = mover.brain = undefined;
    stopped.progress = 760;
    mover.progress = 0;
    for (let i = 0; i < 90; i++) {
      stopped.speed = 0;
      mover.speed = 1;
      sim.step();
    }
    expect(stopped.damaged).toBe(false);
    expect(sim.followed).toBe(mover);
  });

  it("a level keeps one target for all three trips and every generation, from the same start", async () => {
    const { TRIPS_PER_GENERATION } = await import("../src/world/sim");
    const w = sampleWorld();
    const sim = new WorldSim(() => w);
    sim.population = 5;
    sim.level = 3;
    sim.begin("AI");
    expect(sim.tripsPerGeneration).toBe(TRIPS_PER_GENERATION);
    const targets = new Set<string>();
    const starts = new Set<string>();
    while (sim.generation <= 2) {
      if (sim.destination) targets.add(`${Math.round(sim.destination.x)},${Math.round(sim.destination.y)}`);
      starts.add(`${Math.round(sim.origin!.center.x)},${Math.round(sim.origin!.center.y)}`);
      sim.step();
    }
    expect(targets.size).toBe(1);
    expect(starts.size).toBe(1);
    expect(sim.history[0].trips).toBe(TRIPS_PER_GENERATION);
  });

  it("Reset learning picks new targets; a refresh keeps them", () => {
    const w = sampleWorld();
    const sim = new WorldSim(() => w);
    sim.level = 3;
    const target = sim.levelPlan().target;
    const again = new WorldSim(() => w, sim.toJSON());
    expect(again.levelPlan().target).toEqual(target);
    const seeds = new Set<number>();
    for (let i = 0; i < 5; i++) {
      sim.forget();
      sim.level = 3;
      seeds.add(sim.targetSeed);
    }
    expect(seeds.size).toBe(5);
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
  it("never run out, add one challenge per level, then stack them before the town changes", async () => {
    const { worldLevelSpec, firstLevelOf } = await import("../src/world/sim");
    expect([1, 2, 3, 4, 5].map((n) => worldLevelSpec(n).stage)).toEqual(["survive", "easy", "far", "tight", "stack"]);
    expect([6, 7, 8, 9, 10, 11].map((n) => worldLevelSpec(n).stage)).toEqual(["easy", "far", "tight", "detour", "hazard", "stack"]);
    expect([firstLevelOf(0), firstLevelOf(1), firstLevelOf(2)]).toEqual([1, 6, 12]);
    for (let n = 1; n < 200; n++) {
      const s = worldLevelSpec(n);
      expect(firstLevelOf(s.map)).toBeLessThanOrEqual(n);
      expect(firstLevelOf(s.map + 1)).toBeGreaterThan(n);
      expect(s.timeFactor).toBeGreaterThanOrEqual(1.3);
      if (n === 1) continue;
      const easy = worldLevelSpec(firstLevelOf(s.map) + (s.map === 0 ? 1 : 0));
      // Each challenge level changes exactly one thing from the town's easy level.
      const same = (a: boolean, b: boolean, c: boolean, d: boolean) => [a, b, c, d];
      if (s.stage === "far") expect(same(s.minTrip > easy.minTrip, s.timeFactor === easy.timeFactor, s.closures === 0, s.hazards.length === 0)).toEqual([true, true, true, true]);
      if (s.stage === "tight") expect(same(s.minTrip === easy.minTrip, s.timeFactor < easy.timeFactor, s.closures === 0, s.hazards.length === 0)).toEqual([true, true, true, true]);
      if (s.stage === "detour") expect(same(s.minTrip === easy.minTrip, s.timeFactor === easy.timeFactor, s.closures > 0, s.hazards.length === 0)).toEqual([true, true, true, true]);
      if (s.stage === "hazard") expect(same(s.minTrip === easy.minTrip, s.timeFactor === easy.timeFactor, s.closures === 0, s.hazards.length >= 1)).toEqual([true, true, true, true]);
      if (s.stage === "stack") {
        const alone = worldLevelSpec(n - 1).hazards;
        expect([s.minTrip > easy.minTrip, s.timeFactor < easy.timeFactor, s.map === 0 || alone.every((h) => s.hazards.includes(h))]).toEqual([true, true, true]);
      }
      // Dusk and night towns are dark on every level.
      expect(s.light).toBe(worldLevelSpec(firstLevelOf(s.map)).light);
    }
    // No detours or hazards in the sample town; they start in the second town.
    expect([1, 2, 3, 4, 5].every((n) => worldLevelSpec(n).closures === 0 && worldLevelSpec(n).hazards.length === 0)).toBe(true);
    expect(worldLevelSpec(9).closures).toBe(1);
    expect(worldLevelSpec(10).hazards).toEqual(["pedestrians"]);
    // Night towns introduce traffic on its own, then stack it with the town's own hazard.
    const night = firstLevelOf(11);
    expect(worldLevelSpec(night + 4).hazards).toEqual(["traffic"]);
    expect(worldLevelSpec(night + 5).hazards).toEqual(["pedestrians", "traffic"]);
    expect(worldLevelSpec(60).minTrip).toBeGreaterThan(worldLevelSpec(7).minTrip);
  });

  it("hazards: pedestrians are obstacles, fog and night shorten the sensors, rain and ice cut grip", async () => {
    const { visibility, Pedestrian, onIce } = await import("../src/world/hazards");
    const { Car } = await import("../src/car");
    const car = new Car(0, 0, 30, 50, "AI");
    const angles = [Math.PI / 2, 0, -Math.PI / 2];
    expect(visibility(car, angles, [], "day", [])).toBeNull();
    expect(visibility(car, angles, ["fog"], "day", [])!.every((v) => v < 0.5)).toBe(true);
    const night = visibility(car, angles, [], "night", [{ x: 5000, y: 5000 }])!;
    expect(night[1]).toBe(1); // straight ahead: headlights
    expect(night[0]).toBeLessThan(0.5);
    expect(visibility(car, angles, [], "night", [{ x: 10, y: 10 }])!.every((v) => v === 1)).toBe(true); // under a lamp
    const crossing = createMarking("crossing", { x: 0, y: 0 }, { x: 0, y: -1 }, 100);
    const p = new Pedestrian(crossing, 100, 1, 1);
    const seen = new Set<string>();
    for (let t = 0; t < 2000; t += 50) {
      p.update(t);
      seen.add(`${Math.round(p.x)},${Math.round(p.y)}`);
    }
    expect(seen.size).toBeGreaterThan(5); // they walk back and forth
    expect(onIce({ x: 0, y: 0 }, [{ a: { x: -50, y: 0 }, b: { x: 50, y: 0 }, halfWidth: 50 }])).toBe(true);
    // Low grip: the same steering input turns the path less.
    const path = (grip: number) => {
      const c = new Car(0, 0, 30, 50, "AI");
      c.brain = undefined;
      c.grip = grip;
      c.speed = 3;
      for (let i = 0; i < 40; i++) {
        c.controls.forward = true;
        c.controls.left = true;
        c.update([], []);
      }
      c.dispose();
      return c.x;
    };
    expect(Math.abs(path(0.15))).toBeLessThan(Math.abs(path(1)));
  });

  it("detour levels close a street on each later trip's route, keep earlier closures, and stay reachable", async () => {
    const { generateMap } = await import("../src/world/mapgen");
    const { Navigator } = await import("../src/world/nav");
    for (const seed of [3, 4, 5]) {
      const w = generateMap(1, seed);
      const sim = new WorldSim(() => w);
      sim.level = 9;
      expect(sim.levelSpec.stage).toBe("detour");
      const plan = sim.levelPlan();
      const startMark = w.markings.find((m) => m.type === "start")!;
      const start = startMark.center;
      const facing = startMark.direction;
      expect(plan.closed[0].size).toBe(0);
      for (let t = 1; t < plan.closed.length; t++) {
        expect(plan.closed[t].size).toBeGreaterThan(plan.closed[t - 1].size);
        for (const si of plan.closed[t - 1]) expect(plan.closed[t].has(si)).toBe(true);
        const before = new Navigator(w.graph, plan.target!, plan.closed[t - 1]).routeSegments(start, facing);
        // Something on the previous trip's route is now closed: the route has to change.
        expect(before.some((si) => plan.closed[t].has(si))).toBe(true);
        expect(new Navigator(w.graph, plan.target!, plan.closed[t]).remaining(start, facing)).toBeLessThan(Infinity);
      }
      // Barricades are walls the sensors see.
      sim.population = 2;
      sim.begin("AI");
      sim.nextGeneration();
      expect(sim.barriers.length).toBe(0);
    }
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
  it("traffic keeps to the streets, keeps moving, and never drives into another traffic car", async () => {
    const { generateMap } = await import("../src/world/mapgen");
    const { CityTraffic } = await import("../src/world/citytraffic");
    const { polysIntersect } = await import("../src/utils");
    const w = generateMap(1, 9);
    const t = new CityTraffic(w.graph, w.markings, w.settings.roadWidth, 5, 10, new Set(), { x: 99999, y: 99999 });
    expect(t.cars.length).toBe(10);
    const start = t.cars.map((c) => ({ x: c.x, y: c.y }));
    for (let f = 0; f < 1500; f++) {
      w.updateLights(f / 60);
      t.update();
      for (const c of t.cars) {
        const off = Math.min(...w.graph.segments.map((s) => s.distanceToPoint(c)));
        expect(off).toBeLessThan(w.settings.roadWidth / 2);
      }
    }
    const moved = t.cars.filter((c, i) => Math.hypot(c.x - start[i].x, c.y - start[i].y) > 200).length;
    expect(moved).toBeGreaterThan(5);
    for (let i = 0; i < t.cars.length; i++) for (let j = i + 1; j < t.cars.length; j++) {
      expect(polysIntersect(t.cars[i].polygon, t.cars[j].polygon)).toBe(false);
    }
  });

  it("the GPS never asks for a U-turn mid-street: routes leave ahead of the car", async () => {
    const { Navigator } = await import("../src/world/nav");
    // A straight street a-b-c; the car is between a and b facing c, the target is behind it at a's side.
    const a = { x: 0, y: 0 }, b = { x: 400, y: 0 }, c = { x: 800, y: 0 }, d = { x: 800, y: 400 }, e = { x: 0, y: 400 };
    const g = new Graph([a, b, c, d, e], [new Segment(a, b), new Segment(b, c), new Segment(c, d), new Segment(d, e), new Segment(e, a)]);
    const nav = new Navigator(g, { x: 0, y: 200 });
    const car = { x: 300, y: 0 };
    const facingEast = { x: 1, y: 0 };
    // Without a heading it would turn straight back; facing east it carries on and goes round.
    expect(nav.path(car).map((p) => p.x)).toContain(0);
    expect(nav.path(car, facingEast)[1]).toEqual(b);
  });

  it("never look alike two towns in a row, and the first five are all different", async () => {
    const { townLook } = await import("../src/world/worldThemes");
    const looks = Array.from({ length: 40 }, (_, i) => townLook(i + 1));
    expect(new Set(looks.slice(0, 5).map((l) => l.theme)).size).toBe(5);
    for (let i = 1; i < looks.length; i++) {
      expect(looks[i].theme === looks[i - 1].theme && looks[i].time === looks[i - 1].time).toBe(false);
    }
    expect(looks[5].time).toBe("dusk");
    expect(looks[10].time).toBe("night");
  });

  it("are connected both ways (one-way streets included), themed, and marked", async () => {
    const { generateMap, stronglyConnected } = await import("../src/world/mapgen");
    for (const seed of [11, 22]) {
      for (let m = 1; m <= 8; m++) {
        const w = generateMap(m, seed);
        expect(w.theme).toBeDefined();
        const pts = w.graph.points;
        const index = (p: { x: number; y: number }) => pts.findIndex((q) => q.x === p.x && q.y === p.y);
        const edges = w.graph.segments.map((s) => [index(s.p1), index(s.p2)] as [number, number]);
        expect(stronglyConnected(pts.length, edges, w.graph.segments.map((s) => s.oneWay))).toBe(true);
        expect(w.markings.filter((k) => k.type === "start")).toHaveLength(1);
      }
    }
  }, 60_000);

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
