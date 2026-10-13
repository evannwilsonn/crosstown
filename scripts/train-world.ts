// Headless world trainer: evolves route-following brains on the sample town.
// Usage: npx tsx scripts/train-world.ts [gens] [population] [mutation] [outPath] [route]
// route "town" (default) drives the sample town's own trip; "lights" moves the target south of the
// signalized junction so the route also crosses a traffic light; "mixed" alternates the two.
import { writeFileSync } from "node:fs";
import { sampleWorld } from "../src/world/sample";
import { WorldSim } from "../src/world/sim";

const gens = Number(process.argv[2] ?? 30);
const pop = Number(process.argv[3] ?? 100);
const mutation = Number(process.argv[4] ?? 0.15);
const out = process.argv[5];
const routeName = process.argv[6] ?? "town";
const world = sampleWorld();
const target = world.markings.find((m) => m.type === "target")!;
const targets = { town: { ...target.center }, lights: { x: 480, y: 300 } };
const useRoute = (g: number) => {
  const name = routeName === "mixed" ? (g % 2 ? "town" : "lights") : routeName;
  target.center = { ...targets[name as keyof typeof targets] };
};
useRoute(1);
const sim = new WorldSim(() => world, null);
sim.population = pop;
sim.mutation = mutation;
if (!sim.begin("AI")) throw new Error("sample town has no start marking");
const r = sim.route!;
console.log(`route ${Math.round(r.length)} px, arrives=${r.arrives}, stops on route: ${(sim as unknown as { stops: unknown[] }).stops.length}, lights: ${(sim as unknown as { lights: unknown[] }).lights.length}`);
const t0 = Date.now();
while (sim.generation <= gens) {
  const g = sim.generation;
  let frames = 0;
  let v = { stop: 0, lane: 0 };
  while (sim.generation === g) { v = { ...sim.violations }; sim.step(); frames++; }
  const p = sim.parent;
  console.log(`gen ${g}: best ${Math.round((p?.progress ?? 0))}, arrived ${sim.lastArrived}${p?.arrivedIn ? ` in ${p.arrivedIn.toFixed(1)} s` : ""}, ran stops ${v.stop}, left lane ${v.lane}, ${frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (out && sim.lastArrived && p) writeFileSync(out, JSON.stringify(p));
  if (routeName === "mixed") { sim.stop(); useRoute(sim.generation); sim.begin("AI"); }
}
