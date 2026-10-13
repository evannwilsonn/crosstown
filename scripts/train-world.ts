// Headless trainer for the virtual world: runs NEAT on the sample town and prints each
// generation's level, best score, arrival time and brain size.
// Usage: npx tsx scripts/train-world.ts [generations] [cars] [mutation] [start level]
import { generateMap } from "../src/world/mapgen";
import { sampleWorld } from "../src/world/sample";
import { WorldSim } from "../src/world/sim";

const gens = Number(process.argv[2] ?? 40);
const pop = Number(process.argv[3] ?? 100);
const mutation = Number(process.argv[4] ?? 0.1);

let world = sampleWorld();
const sim = new WorldSim(() => world);
sim.onMapChange = (map) => {
  world = generateMap(map, sim.seed);
  console.log(`-- map ${map + 1}: ${world.theme ?? "sample town"}, ${world.graph.segments.length} streets`);
};
sim.population = pop;
sim.mutation = mutation;
sim.level = Number(process.argv[5] ?? 1);
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
      `, in time ${s.inTime}/${s.trips}` +
      `, brain ${s.neurons} hidden / ${s.connections} links, ${s.species} species${s.grew ? ", GREW" : ""}, ${frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`,
  );
}
