import { describe, expect, it } from "vitest";
import { getIntersection, mulberry32, polysIntersect } from "../src/utils";
import { NeuralNetwork } from "../src/network";
import { LEVELS, Simulation } from "../src/simulation";
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
    expect(first.conns).toHaveLength(32); // 7 rays + speed, x 4 controls
    for (let i = 0; i < 200; i++) sim.step();
    sim.nextGeneration();
    expect(sim.generation).toBe(2);
    expect(sim.cars).toHaveLength(20);
    expect(sim.last).not.toBeNull();
    // The best brain rides unchanged in slot 0.
    expect(JSON.stringify((sim.cars[0].brain as Genome).toJSON())).toBe(JSON.stringify(sim.neat.champion!.toJSON()));
  });

  it("unlocks the next level when the leader reaches the goal", () => {
    const sim = new Simulation(0, 210, { population: 1, mutation: 0, seed: 1 });
    const car = sim.cars[0];
    car.brain = undefined;
    // Teleport past the seven course cars: reaching the goal ends the generation and levels up.
    car.y = -2000;
    let ended = false;
    for (let i = 0; i < 5 && !ended; i++) ended = sim.step();
    expect(ended).toBe(true);
    expect(sim.last!.levelUp).toBe(true);
    expect(sim.level).toBe(2);
    expect(sim.course.layout).toBe("endless");
  });

  it("levels get denser and faster, and the last one never ends", () => {
    for (let i = 2; i < LEVELS.length; i++) {
      expect(LEVELS[i].rowGap).toBeLessThan(LEVELS[i - 1].rowGap);
      expect(LEVELS[i].trafficSpeed).toBeGreaterThanOrEqual(LEVELS[i - 1].trafficSpeed);
    }
    expect(LEVELS[LEVELS.length - 1].goal).toBeNull();
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
