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
    const leaderProgress = sim.leader.progress;
    sim.nextGeneration();
    expect(sim.generation).toBe(2);
    expect(sim.parent!.progress).toBe(leaderProgress);
    expect(sim.parent).not.toBeNull();
    // The unmutated parent copy is car 0 in the new generation.
    expect(JSON.stringify(sim.cars[0].brain!.toJSON())).toBe(JSON.stringify(sim.parent!.brain));
  });
});
