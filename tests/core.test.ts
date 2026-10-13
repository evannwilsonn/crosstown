import { describe, expect, it } from "vitest";
import { getIntersection, mulberry32, polysIntersect } from "../src/utils";
import { NeuralNetwork } from "../src/network";
import { Simulation } from "../src/simulation";

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

  it("keeps the better brain and advances the generation", () => {
    const sim = new Simulation(0, 210, { population: 20, mutation: 0.1, seed: 1 }, null);
    for (let i = 0; i < 200; i++) sim.step();
    const leaderScore = sim.score(sim.leader);
    sim.nextGeneration();
    expect(sim.generation).toBe(2);
    expect(sim.parent!.progress).toBe(leaderScore);
    expect(sim.parent).not.toBeNull();
    // The unmutated parent copy is car 0 in the new generation.
    expect(JSON.stringify(sim.cars[0].brain!.toJSON())).toBe(JSON.stringify(sim.parent!.brain));
  });

  it("gives a tailgater no credit: fitness is distance gained on the traffic", () => {
    const sim = new Simulation(0, 210, { population: 1, mutation: 0, seed: 1, layout: "course" }, null);
    const car = sim.cars[0];
    car.brain = undefined; // drive it by hand at traffic speed
    for (let i = 0; i < 300; i++) {
      car.controls.forward = car.speed < 1.95;
      sim.step();
    }
    expect(car.progress).toBeGreaterThan(400); // it moved a long way...
    expect(sim.score(car)).toBeLessThan(40); // ...but gained almost nothing on traffic
  });

  it("raises mutation after generations without improvement", () => {
    const sim = new Simulation(0, 210, { population: 5, mutation: 0.1, seed: 1 }, null);
    sim.nextGeneration(); // first parent
    sim.nextGeneration(); // replays the same brains: no improvement
    expect(sim.stagnant).toBeGreaterThan(0);
    expect(sim.mutationNow()).toBeGreaterThan(0.1);
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

describe("lane discipline and the trained brain", () => {
  it("rejects brains of the wrong shape", async () => {
    const { isParent } = await import("../src/simulation");
    const { NeuralNetwork } = await import("../src/network");
    expect(isParent({ brain: new NeuralNetwork([8, 8, 4]).toJSON(), progress: 0 })).toBe(true);
    expect(isParent({ brain: new NeuralNetwork([5, 6, 4]).toJSON(), progress: 0 })).toBe(false);
    expect(isParent({ progress: 0 })).toBe(false);
    expect(isParent(null)).toBe(false);
  });

  it("the shipped brain clears the course alone, without crashing, mostly inside a lane", async () => {
    const { Simulation, isParent } = await import("../src/simulation");
    const brain = (await import("../src/pretrained/highway.json")).default;
    expect(isParent(brain)).toBe(true);
    const sim = new Simulation(0, 210, { population: 1, mutation: 0, seed: 2026, layout: "course" }, brain as never);
    let crashed = false;
    let lane = 0;
    for (let f = 0; f < 3000 && sim.generation === 1; f++) {
      crashed ||= sim.cars[0].damaged;
      lane = sim.inLaneShare(sim.cars[0]);
      sim.step();
    }
    expect(crashed).toBe(false);
    expect(sim.lastCleared).toBe(true);
    expect(lane).toBeGreaterThan(0.6);
    expect(sim.history[0].cleared).toBe(true);
  });
});
