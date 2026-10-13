// Headless trainer: prints the best distance after each generation.
import { writeFileSync } from "node:fs";
import { Simulation } from "../src/simulation";

const gens = Number(process.argv[2] ?? 15);
const pop = Number(process.argv[3] ?? 100);
const mutation = Number(process.argv[4] ?? 0.1);
const cap = Number(process.argv[5] ?? 4000); // frames per generation, ~67 s of driving
const layout = (process.argv[6] ?? "endless") as "course" | "endless";
/** Optional path: writes the parent brain there as soon as a generation clears the course. */
const out = process.argv[7];
const sim = new Simulation(0, 210, { population: pop, mutation, seed: 2026, layout }, null);
const t0 = Date.now();
while (sim.generation <= gens) {
  const g = sim.generation;
  let frames = 0;
  while (sim.generation === g && frames < cap) { sim.step(); frames++; }
  const cleared = sim.generation !== g && sim.lastCleared;
  if (sim.generation === g) sim.nextGeneration();
  if (out && cleared && sim.parent) {
    writeFileSync(out, JSON.stringify(sim.parent));
    console.log(`saved brain to ${out}`);
    break;
  }
  console.log(`gen ${g}: passed ${sim.parent?.passed ?? 0}, in lane ${Math.round((sim.parent?.inLane ?? 0) * 100)}%, ahead ${Math.round((sim.parent?.progress ?? 0) / 10)} m, ${frames} frames${cleared ? ", CLEARED" : ""}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
