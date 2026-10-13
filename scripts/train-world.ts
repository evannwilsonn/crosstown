// Headless trainer for the virtual world: runs NEAT on the sample town and prints each
// generation's level, best score, arrival time and brain size.
// Usage: npx tsx scripts/train-world.ts [generations] [cars] [mutation]
import { sampleWorld } from "../src/world/sample";
import { WorldSim } from "../src/world/sim";

const gens = Number(process.argv[2] ?? 40);
const pop = Number(process.argv[3] ?? 100);
const mutation = Number(process.argv[4] ?? 0.1);

const world = sampleWorld();
const sim = new WorldSim(() => world);
sim.population = pop;
sim.mutation = mutation;
if (!sim.begin("AI")) throw new Error("the sample town has no start marking");
const t0 = Date.now();
while (sim.generation <= gens) {
  const g = sim.generation;
  let frames = 0;
  while (sim.generation === g) {
    sim.step();
    frames++;
  }
  const s = sim.last!;
  console.log(
    `gen ${g}: level ${s.level}${s.levelUp ? " CLEARED" : ""}, best ${Math.round(s.best)}` +
      `, arrived ${s.arrivedTrips}/${s.trips}${s.arrivedIn !== null ? ` (last in ${s.arrivedIn.toFixed(1)} s)` : ""}` +
      `, brain ${s.neurons} hidden / ${s.connections} links, ${s.species} species${s.grew ? ", GREW" : ""}, ${frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`,
  );
}
