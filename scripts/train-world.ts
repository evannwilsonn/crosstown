// Headless trainer for the virtual world's trained brain: evolves cars on the sample town
// with the lights cycling, and saves the parent brain after the last generation.
// Usage: npx tsx scripts/train-world.ts [generations] [cars] [mutation] [outPath]
import { writeFileSync } from "node:fs";
import { sampleWorld } from "../src/world/sample";
import { WorldSim } from "../src/world/sim";

const gens = Number(process.argv[2] ?? 30);
const pop = Number(process.argv[3] ?? 100);
const mutation = Number(process.argv[4] ?? 0.15);
const out = process.argv[5];

const world = sampleWorld();
const sim = new WorldSim(() => world, null);
sim.population = pop;
sim.mutation = mutation;
if (!sim.begin("AI")) throw new Error("the sample town has no start marking");

let clock = 0;
const t0 = Date.now();
while (sim.generation <= gens) {
  const g = sim.generation;
  let frames = 0;
  while (sim.generation === g) {
    world.updateLights(clock++ / 60); // the page drives the lights from the frame clock too
    sim.step();
    frames++;
  }
  console.log(`gen ${g}: best ${Math.round((sim.parent?.progress ?? 0) / 10)} m, ${frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
if (out && sim.parent) {
  writeFileSync(out, JSON.stringify(sim.parent));
  console.log(`saved brain to ${out}`);
}
