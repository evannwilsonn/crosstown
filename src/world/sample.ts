import { Segment, type Point } from "./geom";
import { Graph } from "./graph";
import { createMarking, type MarkingType } from "./markings";
import { World } from "./world";

/** A small town: a 3 × 3 grid with a loop road east, plus one of each marking. */
export function sampleWorld(): World {
  const P = (x: number, y: number): Point => ({ x, y });
  const grid = [
    [P(-520, -420), P(0, -440), P(500, -400)],
    [P(-500, 0), P(0, 0), P(520, 20)],
    [P(-480, 420), P(20, 440), P(500, 400)],
  ];
  const east = P(940, 0);
  const points = [...grid.flat(), east];
  const segments: Segment[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (c < 2) segments.push(new Segment(grid[r][c], grid[r][c + 1]));
      if (r < 2) segments.push(new Segment(grid[r][c], grid[r + 1][c]));
    }
  }
  segments.push(new Segment(grid[0][2], east), new Segment(east, grid[2][2]));

  const world = new World(new Graph(points, segments));
  world.generateRoads();

  /** Places a marking on the lane that drives from `a` toward `b`, `t` of the way along. */
  const place = (type: MarkingType, a: Point, b: Point, t: number) => {
    const i = segments.findIndex((s) => (s.p1 === a && s.p2 === b) || (s.p1 === b && s.p2 === a));
    const forward = segments[i].p1 === a;
    const pool = type === "crossing" ? [segments[i]] : [world.laneGuides[i * 2 + (forward ? 0 : 1)]];
    const lane = pool[0];
    const from = type === "crossing" && !forward ? lane.p2 : lane.p1;
    const to = type === "crossing" && !forward ? lane.p1 : lane.p2;
    const center = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    const dir = new Segment(from, to).directionVector();
    world.markings.push(createMarking(type, center, dir, world.settings.roadWidth));
  };

  const [n, m, s] = grid;
  place("start", s[0], m[0], 0.35);
  place("stop", m[0], m[1], 0.86);
  place("stop", s[1], m[1], 0.86);
  place("light", m[1], m[2], 0.86);
  place("light", n[2], m[2], 0.86);
  place("light", s[2], m[2], 0.86);
  place("crossing", n[1], m[1], 0.5);
  place("parking", n[0], n[1], 0.5);
  place("yield", east, s[2], 0.88);
  place("target", n[1], n[2], 0.6);
  return world;
}
