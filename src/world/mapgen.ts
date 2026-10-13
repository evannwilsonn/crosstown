import { mulberry32 } from "../utils";
import { add, distance, normalize, rightOf, scale, Segment, subtract, type Point } from "./geom";
import { Graph } from "./graph";
import { createMarking, type MarkingType } from "./markings";
import { sampleWorld } from "./sample";
import { World } from "./world";
import type { WorldThemeName } from "./worldThemes";

/**
 * Towns for the world's levels. Map 1 is the sample town. Every map after it is generated
 * fresh each session from a recipe that gets bigger and messier: more blocks, streets that
 * bend and run at angles, dead ends, diagonal shortcuts, one-way streets. Each map has a theme
 * (downtown, desert, snowy, coastal, then mixed) that changes how it looks, never how it drives.
 */
interface Recipe {
  cols: number;
  rows: number;
  spacing: number;
  /** How far intersections wander from a neat grid. */
  jitter: number;
  /** Share of streets removed (leaving dead ends and odd blocks). */
  remove: number;
  /** Diagonal shortcuts across blocks. */
  diagonals: number;
  /** Share of streets that bend in the middle. */
  bends: number;
  /** Share of streets that are one-way. */
  oneWay: number;
  theme: WorldThemeName;
}

const THEMES: WorldThemeName[] = ["downtown", "desert", "snowy", "coastal"];

export function recipeFor(map: number, seed: number): Recipe {
  const named: Omit<Recipe, "theme">[] = [
    { cols: 4, rows: 4, spacing: 480, jitter: 15, remove: 0, diagonals: 0, bends: 0, oneWay: 0 },
    { cols: 4, rows: 5, spacing: 480, jitter: 55, remove: 0.1, diagonals: 1, bends: 0.25, oneWay: 0 },
    { cols: 5, rows: 5, spacing: 470, jitter: 60, remove: 0.14, diagonals: 2, bends: 0.3, oneWay: 0.12 },
    { cols: 5, rows: 6, spacing: 470, jitter: 65, remove: 0.15, diagonals: 2, bends: 0.35, oneWay: 0.18 },
  ];
  if (map >= 1 && map <= named.length) return { ...named[map - 1], theme: THEMES[map - 1] };
  // Past the named maps: towns keep growing, up to what stays smooth to simulate.
  const k = map - named.length - 1;
  const size = Math.min(8, 5 + Math.floor(k / 2));
  const rand = mulberry32((seed ^ Math.imul(map, 0x2545f491)) >>> 0);
  return {
    cols: size,
    rows: Math.min(8, size + 1),
    spacing: 460,
    jitter: 70,
    remove: 0.18,
    diagonals: 3,
    bends: 0.4,
    oneWay: 0.2,
    theme: THEMES[Math.floor(rand() * THEMES.length)],
  };
}

type Edge = [number, number];

/** True when every intersection can reach every other along the streets, obeying one-way streets. */
export function stronglyConnected(n: number, edges: Edge[], oneWay: boolean[]): boolean {
  if (n === 0) return true;
  const fwd: number[][] = Array.from({ length: n }, () => []);
  const back: number[][] = Array.from({ length: n }, () => []);
  edges.forEach(([a, b], i) => {
    fwd[a].push(b);
    back[b].push(a);
    if (!oneWay[i]) {
      fwd[b].push(a);
      back[a].push(b);
    }
  });
  const reachesAll = (adj: number[][]) => {
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) {
      for (const v of adj[stack.pop()!]) {
        if (!seen.has(v)) {
          seen.add(v);
          stack.push(v);
        }
      }
    }
    return seen.size === n;
  };
  return reachesAll(fwd) && reachesAll(back);
}

/** Builds the town for a level map. Map 0 is the sample town; the rest are generated and checked drivable. */
export function generateMap(map: number, seed: number): World {
  if (map <= 0) return sampleWorld();
  for (let attempt = 0; attempt < 30; attempt++) {
    const world = tryGenerate(map, (seed + attempt * 7777) >>> 0);
    if (world) return world;
  }
  return sampleWorld();
}

function tryGenerate(map: number, seed: number): World | null {
  const r = recipeFor(map, seed);
  const rand = mulberry32((seed ^ Math.imul(map + 1, 0x9e3779b1)) >>> 0);
  const id = (c: number, row: number) => row * r.cols + c;
  const points: Point[] = [];
  for (let row = 0; row < r.rows; row++) {
    for (let c = 0; c < r.cols; c++) {
      points.push({
        x: Math.round(c * r.spacing + (rand() - 0.5) * 2 * r.jitter),
        y: Math.round(row * r.spacing + (rand() - 0.5) * 2 * r.jitter),
      });
    }
  }
  let edges: Edge[] = [];
  for (let row = 0; row < r.rows; row++) {
    for (let c = 0; c < r.cols; c++) {
      if (c + 1 < r.cols) edges.push([id(c, row), id(c + 1, row)]);
      if (row + 1 < r.rows) edges.push([id(c, row), id(c, row + 1)]);
    }
  }

  // Remove streets while the town stays connected; some intersections become dead ends.
  const removeCount = Math.round(edges.length * r.remove);
  for (let tries = 0, removed = 0; removed < removeCount && tries < removeCount * 10; tries++) {
    const i = Math.floor(rand() * edges.length);
    const trial = edges.filter((_, k) => k !== i);
    if (stronglyConnected(points.length, trial, trial.map(() => false))) {
      edges = trial;
      removed++;
    }
  }

  // Diagonal shortcuts across blocks whose four sides all still exist (so nothing crosses them).
  const has = (a: number, b: number) => edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const used = new Set<string>();
  for (let tries = 0, added = 0; added < r.diagonals && tries < 60; tries++) {
    const c = Math.floor(rand() * (r.cols - 1));
    const row = Math.floor(rand() * (r.rows - 1));
    if (used.has(`${c},${row}`)) continue;
    const [tl, tr, bl, br] = [id(c, row), id(c + 1, row), id(c, row + 1), id(c + 1, row + 1)];
    if (!has(tl, tr) || !has(bl, br) || !has(tl, bl) || !has(tr, br)) continue;
    edges.push(rand() < 0.5 ? [tl, br] : [tr, bl]);
    used.add(`${c},${row}`);
    added++;
  }

  // Bend some streets: a middle point pushed sideways, so turns aren't all right angles.
  const finalPoints = points.slice();
  const finalEdges: Edge[] = [];
  const diagonal = (a: number, b: number) => a % r.cols !== b % r.cols && Math.floor(a / r.cols) !== Math.floor(b / r.cols);
  for (const [a, b] of edges) {
    if (!diagonal(a, b) && rand() < r.bends) {
      const pa = finalPoints[a];
      const pb = finalPoints[b];
      const side = scale(rightOf(normalize(subtract(pb, pa))), (rand() < 0.5 ? -1 : 1) * (45 + rand() * 40));
      finalPoints.push({ x: Math.round((pa.x + pb.x) / 2 + side.x), y: Math.round((pa.y + pb.y) / 2 + side.y) });
      const m = finalPoints.length - 1;
      finalEdges.push([a, m], [m, b]);
    } else finalEdges.push([a, b]);
  }

  // One-way streets, each kept only if every street can still be reached and left legally.
  const oneWay = finalEdges.map(() => false);
  const wantOneWay = Math.round(finalEdges.length * r.oneWay);
  for (let tries = 0, made = 0; made < wantOneWay && tries < wantOneWay * 15; tries++) {
    const i = Math.floor(rand() * finalEdges.length);
    if (oneWay[i]) continue;
    const before = finalEdges[i];
    if (rand() < 0.5) finalEdges[i] = [before[1], before[0]];
    oneWay[i] = true;
    if (stronglyConnected(finalPoints.length, finalEdges, oneWay)) made++;
    else {
      oneWay[i] = false;
      finalEdges[i] = before;
    }
  }
  if (!stronglyConnected(finalPoints.length, finalEdges, oneWay)) return null;
  // Streets must not pass close to intersections they don't join, or the roads would merge.
  for (const [a, b] of finalEdges) {
    const seg = new Segment(finalPoints[a], finalPoints[b]);
    if (finalPoints.some((p, i) => i !== a && i !== b && seg.distanceToPoint(p) < 140)) return null;
  }

  const segments = finalEdges.map(([a, b], i) => new Segment(finalPoints[a], finalPoints[b], oneWay[i]));
  const world = new World(new Graph(finalPoints, segments));
  world.theme = r.theme;
  world.generateRoads();
  placeMarkings(world, finalEdges, oneWay, rand, map);
  world.generateItems();
  return world;
}

/**
 * Lights on the approaches to four-way intersections, stop signs on some approaches to
 * three-way ones, and the Start marking on a street near the middle of town.
 */
function placeMarkings(world: World, edges: Edge[], oneWay: boolean[], rand: () => number, map: number): void {
  // Traffic lights ramp in: a few junctions on the first new maps, more on later ones, so the
  // brains learn to stop for red without every junction being a wall from the start.
  const lightChance = Math.min(0.55, 0.15 + 0.1 * (map - 1));
  const pts = world.graph.points;
  // Marking on the lane of edge `i` that drives toward its second point (`towardEnd`) or its first.
  const place = (type: MarkingType, i: number, towardEnd: boolean, t: number) => {
    if (oneWay[i] && !towardEnd) return;
    const lane = world.laneGuides[i * 2 + (towardEnd ? 0 : 1)];
    if (!lane) return;
    const center = { x: lane.p1.x + (lane.p2.x - lane.p1.x) * t, y: lane.p1.y + (lane.p2.y - lane.p1.y) * t };
    world.markings.push(createMarking(type, center, lane.directionVector(), world.settings.roadWidth));
  };
  pts.forEach((_, node) => {
    const approaches = edges.map((e, i) => ({ e, i })).filter(({ e }) => e[0] === node || e[1] === node);
    // Approaches shorter than a few car lengths have no room for a sign.
    const long = approaches.filter(({ e }) => distance(pts[e[0]], pts[e[1]]) > 260);
    if (approaches.length >= 4 && rand() < lightChance) {
      for (const { e, i } of long) place("light", i, e[1] === node, 0.86);
    } else if (approaches.length === 3 && rand() < 0.6) {
      const pick = long[Math.floor(rand() * long.length)];
      if (pick) place("stop", pick.i, pick.e[1] === node, 0.86);
    }
  });
  // Start near the middle of town, on a long two-way street.
  const middle = pts.reduce((m, p) => add(m, scale(p, 1 / pts.length)), { x: 0, y: 0 });
  const candidates = edges
    .map((e, i) => ({ e, i, d: distance(middle, scale(add(pts[e[0]], pts[e[1]]), 0.5)) }))
    .filter(({ e, i }) => !oneWay[i] && distance(pts[e[0]], pts[e[1]]) > 300)
    .sort((a, b) => a.d - b.d);
  place("start", (candidates[0] ?? { i: 0 }).i, true, 0.35);
}
