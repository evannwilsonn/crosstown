// Headless trainer: prints the best distance after each generation.
import { Simulation } from "../src/simulation";

const gens = Number(process.argv[2] ?? 15);
const pop = Number(process.argv[3] ?? 100);
const mutation = Number(process.argv[4] ?? 0.1);
const cap = Number(process.argv[5] ?? 4000); // frames per generation, ~67 s of driving
const layout = (process.argv[6] ?? "endless") as "course" | "endless";
const sim = new Simulation(0, 210, { population: pop, mutation, seed: 2026, layout }, null);
const t0 = Date.now();
while (sim.generation <= gens) {
  const g = sim.generation;
  let frames = 0;
  let cleared = false;
  while (sim.generation === g && frames < cap) { cleared = sim.clearedCourse(); sim.step(); frames++; }
  if (sim.generation === g) sim.nextGeneration();
  console.log(`gen ${g}: passed ${sim.parent?.passed ?? 0}, ahead ${Math.round((sim.parent?.progress ?? 0) / 10)} m, ${frames} frames${cleared ? ", CLEARED" : ""}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
