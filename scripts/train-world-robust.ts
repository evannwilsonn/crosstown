// Offline trainer for the world's pre-trained brain. Every brain drives several scenarios (the
// sample town trip, and a trip through the signalized junction at four light phases) and is
// scored on the total, so a brain only wins by handling lights, not by catching a lucky green.
// Usage: npx tsx scripts/train-world-robust.ts [gens] [population] [mutation] [outPath]
import { writeFileSync } from "node:fs";
import { NeuralNetwork } from "../src/network";
import type { Parent } from "../src/simulation";
import { sampleWorld } from "../src/world/sample";
import { WORLD_COUNTS, WorldSim } from "../src/world/sim";

const gens = Number(process.argv[2] ?? 40);
const pop = Number(process.argv[3] ?? 60);
const mutation = Number(process.argv[4] ?? 0.15);
const out = process.argv[5];

const scenarios: { target: { x: number; y: number } | null; clock: number }[] = [
  { target: null, clock: 0 },
  ...[0, 135, 270, 405].map((clock) => ({ target: { x: 480, y: 300 }, clock })),
];

/** Score of each brain in one scenario, plus how many arrived. */
function run(brains: NeuralNetwork[], sc: (typeof scenarios)[number]): { scores: number[]; arrived: boolean[] } {
  const world = sampleWorld();
  if (sc.target) world.markings.find((m) => m.type === "target")!.center = { ...sc.target };
  const sim = new WorldSim(() => world, null);
  sim.population = brains.length;
  sim.clock = sc.clock;
  sim.begin("AI");
  const cars = sim.cars.slice();
  cars.forEach((c, i) => (c.brain = NeuralNetwork.fromJSON(brains[i].toJSON())));
  while (sim.generation === 1) sim.step();
  const byCar = new Map(sim.results.map((r) => [r.car, r]));
  const scores = cars.map((c) => byCar.get(c)?.score ?? 0);
  const arrived = cars.map((c) => byCar.get(c)?.arrived ?? false);
  return { scores, arrived };
}

let parent: NeuralNetwork | null = null;
const t0 = Date.now();
for (let g = 1; g <= gens; g++) {
  const brains = Array.from({ length: pop }, (_, i) => {
    if (!parent) return new NeuralNetwork(WORLD_COUNTS);
    const b = NeuralNetwork.fromJSON(parent.toJSON());
    if (i > 0) NeuralNetwork.mutate(b, i < pop * 0.9 ? mutation : 1);
    return b;
  });
  const total = brains.map(() => 0);
  const arrivals = brains.map(() => 0);
  for (const sc of scenarios) {
    const r = run(brains, sc);
    r.scores.forEach((s, i) => (total[i] += s));
    r.arrived.forEach((a, i) => (arrivals[i] += a ? 1 : 0));
  }
  const best = total.indexOf(Math.max(...total));
  parent = brains[best];
  console.log(`gen ${g}: best ${Math.round(total[best])}, arrived ${arrivals[best]}/${scenarios.length}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (out) writeFileSync(out, JSON.stringify({ brain: parent.toJSON(), progress: 0 } satisfies Parent));
  if (arrivals[best] === scenarios.length && g > 5) break;
}
