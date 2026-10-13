// Headless trainer: runs NEAT on the highway and prints each generation's level, best car and brain size.
// Usage: npx tsx scripts/train.ts [generations] [cars] [mutation] [frame cap per generation] [start level]
import { Simulation } from "../src/simulation";

const gens = Number(process.argv[2] ?? 30);
const pop = Number(process.argv[3] ?? 100);
const mutation = Number(process.argv[4] ?? 0.1);
const cap = Number(process.argv[5] ?? 8000);
const startLevel = Number(process.argv[6] ?? 1);
const sim = new Simulation(0, 210, { population: pop, mutation, seed: 2026 });
if (startLevel > 1) {
  sim.level = startLevel;
  sim.reset();
}
const t0 = Date.now();
while (sim.generation <= gens) {
  const g = sim.generation;
  let frames = 0;
  while (sim.generation === g && frames < cap) { sim.step(); frames++; }
  if (sim.generation === g) sim.nextGeneration();
  const s = sim.last!;
  console.log(
    `gen ${g}: level ${s.level}${s.levelUp ? " CLEARED" : s.cleared ? ` clear ${s.clears}/3` : ""}, passed ${s.passed}, ahead ${Math.round(s.best / 10)} m, ` +
      `brain ${s.neurons} hidden / ${s.connections} links, ${s.species} species${s.grew ? ", GREW" : ""}, ${frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`,
  );
}
