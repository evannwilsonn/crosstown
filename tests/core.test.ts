import { describe, expect, it } from "vitest";
import { getIntersection, mulberry32, polysIntersect } from "../src/utils";
import { NeuralNetwork } from "../src/network";
import { LAYOUTS_PER_GENERATION, levelSpec, Simulation } from "../src/simulation";
import { Genome, Innovations, Neat } from "../src/neat";

describe("geometry", () => {
  it("finds where two crossing segments meet", () => {
    const hit = getIntersection({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 });
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(5);
    expect(hit!.offset).toBeCloseTo(0.5);
  });

  it("returns null for parallel or separate segments", () => {
    expect(getIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 })).toBeNull();
    expect(getIntersection({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 0 }, { x: 6, y: -1 })).toBeNull();
  });

  it("ignores nearly parallel segments (the course's epsilon fix)", () => {
    expect(getIntersection({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 1e-6 }, { x: 100, y: 2e-6 })).toBeNull();
  });

  it("detects overlapping squares but not distant ones", () => {
    const sq = (x: number) => [{ x, y: 0 }, { x: x + 2, y: 0 }, { x: x + 2, y: 2 }, { x, y: 2 }];
    expect(polysIntersect(sq(0), sq(1))).toBe(true);
    expect(polysIntersect(sq(0), sq(5))).toBe(false);
  });
});

describe("neural network", () => {
  it("produces one binary output per output neuron", () => {
    const net = new NeuralNetwork([5, 6, 4]);
    const out = NeuralNetwork.feedForward([0, 0.5, 1, 0.2, 0], net);
    expect(out).toHaveLength(4);
    out.forEach((v) => expect([0, 1]).toContain(v));
  });

  it("leaves the brain unchanged at mutation 0", () => {
    const net = new NeuralNetwork([3, 2]);
    const before = JSON.stringify(net.toJSON());
    NeuralNetwork.mutate(net, 0);
    expect(JSON.stringify(net.toJSON())).toBe(before);
  });

  it("clones deeply", () => {
    const net = new NeuralNetwork([3, 2]);
    const copy = NeuralNetwork.clone(net);
    copy.levels[0].weights[0][0] = 42;
    expect(net.levels[0].weights[0][0]).not.toBe(42);
  });
});

describe("traffic", () => {
  it("paints traffic with the course's random hues, the same every run", async () => {
    const { Road } = await import("../src/road");
    const { TrafficCourse } = await import("../src/traffic");
    const make = () => {
      const t = new TrafficCourse(new Road(0, 210), 9);
      t.extend(0, 1000);
      return t.cars.map((c) => c.color);
    };
    const colors = make();
    expect(colors[0]).toMatch(/^hsl\(/);
    expect(make()).toEqual(colors);
  });
});

describe("simulation", () => {
  it("replays the same course from the same seed", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("gives a tailgater no credit: fitness is distance gained on the traffic", () => {
    const sim = new Simulation(0, 210, { population: 1, mutation: 0, seed: 1 });
    const car = sim.cars[0];
    car.brain = undefined; // drive it by hand at traffic speed
    for (let i = 0; i < 300; i++) {
      car.controls.forward = car.speed < 1.95;
      sim.step();
    }
    expect(car.progress).toBeGreaterThan(400); // it moved a long way...
    expect(sim.score(car)).toBeLessThan(40); // ...but gained almost nothing on traffic
  });

  it("starts on level 1 with minimal brains and breeds a new generation through NEAT", () => {
    const sim = new Simulation(0, 210, { population: 20, mutation: 0.1, seed: 1 });
    expect(sim.level).toBe(1);
    expect(sim.course.cars).toHaveLength(7);
    const first = sim.neat.genomes[0];
    expect(first.hiddenCount).toBe(0);
    expect(first.conns).toHaveLength(40); // 7 rays + speed + road ahead + road condition, x 4 controls
    for (let i = 0; i < 200; i++) sim.step();
    sim.nextGeneration();
    expect(sim.generation).toBe(2);
    expect(sim.cars).toHaveLength(20);
    expect(sim.last).not.toBeNull();
    // The best brain rides unchanged in slot 0.
    expect(JSON.stringify((sim.cars[0].brain as Genome).toJSON())).toBe(JSON.stringify(sim.neat.champion!.toJSON()));
  });

  it("unlocks the next level once the goal is reached on three different layouts", () => {
    const sim = new Simulation(0, 210, { population: 1, mutation: 0, seed: 1 });
    expect(LAYOUTS_PER_GENERATION).toBe(2);
    // Each generation drives two layouts; every cleared layout counts.
    const clearLayout = () => {
      const c = sim.cars[0];
      c.brain = undefined;
      c.y = -2000;
      const trip = sim.trip;
      const gen = sim.generation;
      for (let i = 0; i < 5 && sim.trip === trip && sim.generation === gen; i++) sim.step();
    };
    clearLayout();
    expect(sim.trip).toBe(1); // on to the second layout of the same generation
    clearLayout();
    expect(sim.last!.cleared).toBe(true);
    expect(sim.last!.clears).toBe(2);
    expect(sim.last!.levelUp).toBe(false);
    clearLayout();
    clearLayout();
    expect(sim.last!.levelUp).toBe(true);
    expect(sim.level).toBe(2);
    expect(sim.course.layout).toBe("endless");
  });

  it("levels never run out: traffic ramps within each road, and each road starts harder than the last", () => {
    const tier = (n: number) => [-levelSpec(n).rowGap, levelSpec(n).trafficSpeed, levelSpec(n).goal];
    for (let n = 2; n <= 90; n++) {
      const s = levelSpec(n);
      expect(s.rowGap).toBeGreaterThanOrEqual(150); // never denser than the passable limit
      if ((n - 1) % 3 !== 0 && n > 2) {
        // Within a road, every level is at least as hard as the one before.
        const [g0, v0, goal0] = tier(n - 1);
        const [g1, v1, goal1] = tier(n);
        expect(g1).toBeGreaterThanOrEqual(g0);
        expect(v1).toBeGreaterThanOrEqual(v0);
        expect(goal1).toBeGreaterThanOrEqual(goal0);
      }
    }
    // Each road's first level is harder than the previous road's first level (once past road 1).
    for (let road = 2; road < 25; road++) expect(levelSpec(road * 3 + 1).goal).toBeGreaterThanOrEqual(levelSpec(road * 3 - 2).goal);
    expect(levelSpec(4).road).toBe(1); // a new road every three levels
    // New behaviors arrive in later roads and stay.
    const firstWith = (f: (n: number) => boolean) => { for (let n = 2; n < 200; n++) if (f(n)) return n; return -1; };
    const speeds = firstWith((n) => levelSpec(n).laneSpread > 0);
    const changers = firstWith((n) => levelSpec(n).changeRate > 0);
    expect(speeds).toBeGreaterThan(9);
    expect(changers).toBeGreaterThan(speeds);
    expect(levelSpec(changers + 30).changeRate).toBeGreaterThan(0);
  });

  it("lane-changing traffic moves to the next lane and takes its speed", async () => {
    const { Road } = await import("../src/road");
    const { TrafficCourse } = await import("../src/traffic");
    const road = new Road(0, 210);
    const t = new TrafficCourse(road, 5, "endless", { rowGap: 230, speed: 2, laneSpread: 0.3, changeRate: 0.05 });
    t.extend(0, 2000);
    const startX = t.cars.map((c) => c.x);
    for (let i = 0; i < 400; i++) t.update();
    const moved = t.cars.filter((c, i) => Math.abs(c.x - startX[i]) > 60);
    expect(moved.length).toBeGreaterThan(0);
    // Cars that have finished their change sit on a lane center and cruise at that lane's speed.
    const settled = moved.filter((c) => c.angle === 0);
    expect(settled.length).toBeGreaterThan(0);
    for (const c of settled) {
      const lane = [0, 1, 2].find((l) => Math.abs(c.x - road.getLaneCenter(l)) < 0.01)!;
      expect(lane).toBeDefined();
      expect(c.maxSpeed).toBeCloseTo(t.laneSpeed(lane));
    }
  });

  it("saves and restores the population, level and generation", () => {
    const sim = new Simulation(0, 210, { population: 10, mutation: 0.1, seed: 1 });
    sim.nextGeneration();
    const copy = new Simulation(0, 210, { population: 10, mutation: 0.1, seed: 1 }, JSON.parse(JSON.stringify(sim.toJSON())));
    expect(copy.generation).toBe(2);
    expect(copy.neat.genomes).toHaveLength(10);
    expect(JSON.stringify(copy.neat.genomes[0].toJSON())).toBe(JSON.stringify(sim.neat.genomes[0].toJSON()));
  });
});

describe("NEAT", () => {
  const rand = mulberry32(3);
  const setup = () => {
    const inno = new Innovations(9);
    return { inno, g: Genome.minimal(5, 4, inno, rand) };
  };

  it("gives the same change the same innovation number in different genomes", () => {
    const inno = new Innovations(9);
    const a = Genome.minimal(5, 4, inno, rand);
    const b = Genome.minimal(5, 4, inno, rand);
    expect(a.conns.map((c) => c.inn)).toEqual(b.conns.map((c) => c.inn));
  });

  it("adding a neuron splits a link: old one off, two new ones on", () => {
    const { inno, g } = setup();
    expect(g.addNode(inno, rand)).toBe(true);
    expect(g.hiddenCount).toBe(1);
    expect(g.conns.filter((c) => !c.enabled)).toHaveLength(1);
    expect(g.enabledCount).toBe(21);
    expect(g.activate([1, 0, 0.5, 0, 1])).toHaveLength(4);
  });

  it("never wires a loop, so every brain can be evaluated in one pass", () => {
    const { inno, g } = setup();
    for (let i = 0; i < 40; i++) {
      g.addNode(inno, rand);
      g.addConnection(inno, rand);
    }
    const out = g.activate([0.2, 0.4, 0, 1, 0.7]);
    expect(out).toHaveLength(4);
    out.forEach((v) => expect([0, 1]).toContain(v));
    // Every enabled neuron got a value: none were stuck waiting on a loop.
    for (const n of g.nodes) expect(g.values.has(n.id)).toBe(true);
  });

  it("crossover keeps the fitter parent's shape", () => {
    const { inno, g } = setup();
    const fitter = g.clone();
    fitter.addNode(inno, rand);
    const child = Genome.crossover(fitter, g, rand);
    expect(child.conns.map((c) => c.inn)).toEqual(fitter.conns.map((c) => c.inn));
    expect(child.hiddenCount).toBe(1);
  });

  it("measures identical brains as distance 0 and grown ones as further apart", () => {
    const { inno, g } = setup();
    const grown = g.clone();
    grown.addNode(inno, rand);
    expect(Genome.distance(g, g.clone())).toBe(0);
    expect(Genome.distance(g, grown)).toBeGreaterThan(0);
  });

  it("keeps the population size and the champion through evolution", () => {
    const neat = new Neat(5, 4, 30, mulberry32(9));
    const scores = neat.genomes.map((_, i) => i);
    const best = neat.genomes[29].toJSON();
    neat.evolve(scores);
    expect(neat.genomes).toHaveLength(30);
    expect(JSON.stringify(neat.genomes[0].toJSON())).toBe(JSON.stringify(best));
  });
});

describe("traffic layouts", () => {
  it("course layout is the video's seven cars", async () => {
    const { Road } = await import("../src/road");
    const { TrafficCourse } = await import("../src/traffic");
    const t = new TrafficCourse(new Road(0, 210), 1, "course");
    t.extend(-5000);
    expect(t.cars.map((c) => c.y)).toEqual([-100, -300, -300, -500, -500, -700, -700]);
  });

  it("endless rows are always passable: no back-to-back double blocks, gap moves at most one lane", async () => {
    const { Road } = await import("../src/road");
    const { TrafficCourse } = await import("../src/traffic");
    const road = new Road(0, 210);
    for (const seed of [1, 2, 3, 2026]) {
      const t = new TrafficCourse(road, seed);
      t.extend(0, 40000);
      const rows = new Map<number, number[]>();
      for (const c of t.cars) {
        const key = Math.round(c.y / 210);
        const lane = Math.round((c.x - road.left - 35) / 70);
        rows.set(key, [...(rows.get(key) ?? []), lane]);
      }
      const ordered = [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, lanes]) => lanes);
      let prevDouble = false;
      let prevGap = -1;
      for (const lanes of ordered) {
        const isDouble = lanes.length === 2;
        if (isDouble) {
          expect(prevDouble).toBe(false);
          const gap = [0, 1, 2].find((l) => !lanes.includes(l))!;
          if (prevGap >= 0) expect(Math.abs(gap - prevGap)).toBeLessThanOrEqual(1);
          prevGap = gap;
        }
        expect(lanes.length).toBeLessThan(3);
        prevDouble = isDouble;
      }
    }
  });
});

describe("roads", () => {
  it("curves start straight, then bend, with borders that follow the road", async () => {
    const { Road } = await import("../src/road");
    const road = new Road(0, 210, 3, { laneCount: 3, bends: [{ amplitude: 70, wavelength: 1700, phase: 1 }] });
    expect(road.centerX(0)).toBe(0); // the start line is straight
    const xs = [-1500, -2000, -2500, -3000].map((y) => road.centerX(y));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(20); // further on it bends
    for (const [a, b] of road.bordersNear(-2000)) {
      const mid = (a.y + b.y) / 2;
      const [l, r] = road.edgesAt(mid);
      const x = (a.x + b.x) / 2;
      expect(Math.min(Math.abs(x - l), Math.abs(x - r))).toBeLessThan(2);
    }
  });

  it("construction zones close an outside lane, and traffic merges out of it", async () => {
    const { Road } = await import("../src/road");
    const { TrafficCourse } = await import("../src/traffic");
    const road = new Road(0, 210, 3, { laneCount: 3, bends: [], closures: { start: 600, period: 1600, length: 500 } });
    const [l, r] = road.edgesAt(-900);
    expect(r - l).toBeCloseTo(140, 0); // one 70 px lane closed in the middle of the zone
    const t = new TrafficCourse(road, 3, "endless", { rowGap: 200, speed: 2 });
    t.extend(0, 3000);
    for (let i = 0; i < 600; i++) {
      t.update();
      // No traffic car sits fully inside a closed lane.
      for (const c of t.cars) {
        const z = road.closure(c.y);
        if (z && z.amount >= 1) expect(Math.abs(t.laneAt(c) - z.lane)).toBeGreaterThan(0.5);
      }
    }
  });

  it("every road number gives a drivable shape: two or three lanes, gentle bends", async () => {
    const { roadShape } = await import("../src/simulation");
    for (let r = 0; r < 30; r++) {
      const s = roadShape(r, 99);
      expect([2, 3]).toContain(s.laneCount);
      // Steepest sideways slope of all bends together stays gentle (under about 30 degrees).
      const slope = s.bends.reduce((sum, b) => sum + (2 * Math.PI * b.amplitude) / b.wavelength, 0);
      expect(slope).toBeLessThan(0.6);
    }
  });
});
