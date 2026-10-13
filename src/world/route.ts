import { add, distance, dot, normalize, rightOf, samePoint, scale, subtract, type Point } from "./geom";
import type { Graph } from "./graph";

/**
 * Route planning for the world's cars. Dijkstra finds the shortest legal path over the road
 * graph (one-way streets only one way), and the path is turned into a polyline down the middle
 * of the right-hand lane, which the lane-following controller tracks.
 */

interface Edge {
  to: number;
  cost: number;
}

/** Directed adjacency over the graph's points: two-way roads both ways, one-way roads p1 to p2. */
function adjacency(graph: Graph): Edge[][] {
  const index = (p: Point) => graph.points.findIndex((q) => samePoint(q, p));
  const adj: Edge[][] = graph.points.map(() => []);
  for (const s of graph.segments) {
    const a = index(s.p1);
    const b = index(s.p2);
    if (a < 0 || b < 0) continue;
    const cost = distance(s.p1, s.p2);
    adj[a].push({ to: b, cost });
    if (!s.oneWay) adj[b].push({ to: a, cost });
  }
  return adj;
}

/** Shortest distances and predecessors from one point. */
function dijkstra(adj: Edge[][], from: number): { dist: number[]; prev: number[] } {
  const dist = adj.map(() => Infinity);
  const prev = adj.map(() => -1);
  const done = adj.map(() => false);
  dist[from] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0) break;
    done[u] = true;
    for (const e of adj[u]) {
      if (dist[u] + e.cost < dist[e.to]) {
        dist[e.to] = dist[u] + e.cost;
        prev[e.to] = u;
      }
    }
  }
  return { dist, prev };
}

function pathTo(prev: number[], to: number): number[] {
  const out: number[] = [];
  for (let v = to; v >= 0; v = prev[v]) out.unshift(v);
  return out;
}

/** The graph segment closest to `p`, with its endpoints as point indices. */
function nearestEdge(graph: Graph, p: Point): { a: number; b: number; oneWay: boolean } | null {
  let best: { a: number; b: number; oneWay: boolean } | null = null;
  let bestD = Infinity;
  for (const s of graph.segments) {
    const d = s.distanceToPoint(p);
    if (d < bestD) {
      bestD = d;
      best = {
        a: graph.points.findIndex((q) => samePoint(q, s.p1)),
        b: graph.points.findIndex((q) => samePoint(q, s.p2)),
        oneWay: s.oneWay,
      };
    }
  }
  return best && best.a >= 0 && best.b >= 0 ? best : null;
}

/**
 * Turn radii in lane offsets (a quarter road width). Each arc is centered on the corner of the
 * road it turns around: a right turn hugs the near kerb, a left turn sweeps across the junction.
 */
const RIGHT_TURN_RADIUS = 1;
const LEFT_TURN_RADIUS = 3;

/**
 * The lane path around a corner at `b`: an arc tangent to both right-hand lane lines, so the
 * car has a curve it can actually drive. Sharp hairpins fall back to the two lane ends.
 */
function corner(a: Point, b: Point, c: Point, offset: number): Point[] {
  const d1 = normalize(subtract(b, a));
  const d2 = normalize(subtract(c, b));
  const p1 = add(b, scale(rightOf(d1), offset));
  const p2 = add(b, scale(rightOf(d2), offset));
  const cross = d1.x * d2.y - d1.y * d2.x;
  const turn = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2))));
  if (Math.abs(cross) < 0.05 || turn < 0.05) return [p1];
  if (turn > 2.6) return [p1, p2];
  // Intersection of line p1 + t*d1 with line p2 + u*d2.
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / cross;
  const miter = add(p1, scale(d1, t));
  // Screen y points down, so a positive cross product is a right turn.
  const right = cross > 0;
  const room = 0.45 * Math.min(distance(a, b), distance(b, c));
  const radius = Math.min((right ? RIGHT_TURN_RADIUS : LEFT_TURN_RADIUS) * offset, room / Math.tan(turn / 2));
  const tangent = radius * Math.tan(turn / 2);
  const from = add(miter, scale(d1, -tangent));
  const side = right ? rightOf(d1) : scale(rightOf(d1), -1);
  const center = add(from, scale(side, radius));
  const a0 = Math.atan2(from.y - center.y, from.x - center.x);
  const steps = Math.max(2, Math.ceil(turn / 0.2));
  const sweep = right ? turn : -turn;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const ang = a0 + (sweep * i) / steps;
    return { x: center.x + Math.cos(ang) * radius, y: center.y + Math.sin(ang) * radius };
  });
}

export class Route {
  /** Cumulative distance at each polyline point. */
  readonly lengths: number[];

  constructor(public points: Point[], public arrives: boolean) {
    this.lengths = [0];
    for (let i = 1; i < points.length; i++) this.lengths.push(this.lengths[i - 1] + distance(points[i - 1], points[i]));
  }

  get length(): number {
    return this.lengths[this.lengths.length - 1] ?? 0;
  }

  /** Distance along the route of the closest point to `p`, searching a few legs around a hint index. */
  project(p: Point, hint = 0): { along: number; index: number; offset: number } {
    let best = { along: 0, index: 0, offset: Infinity };
    const from = Math.max(0, hint - 2);
    const to = Math.min(this.points.length - 1, hint + 6);
    for (let i = from; i < to; i++) {
      const a = this.points[i];
      const ab = subtract(this.points[i + 1], a);
      const len2 = dot(ab, ab) || 1;
      const t = Math.max(0, Math.min(1, dot(subtract(p, a), ab) / len2));
      const d = distance(p, add(a, scale(ab, t)));
      if (d < best.offset) best = { along: this.lengths[i] + t * Math.sqrt(len2), index: i, offset: d };
    }
    return best;
  }

  /** The point `along` px from the route's start. */
  pointAt(along: number): Point {
    if (along <= 0) return this.points[0];
    for (let i = 1; i < this.points.length; i++) {
      if (this.lengths[i] >= along) {
        const t = (along - this.lengths[i - 1]) / (this.lengths[i] - this.lengths[i - 1] || 1);
        const a = this.points[i - 1];
        const b = this.points[i];
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
    }
    return this.points[this.points.length - 1];
  }

  /** Unit direction of travel at `along`. */
  tangent(along: number): Point {
    return normalize(subtract(this.pointAt(along + 4), this.pointAt(along - 4)));
  }

  /** Signed heading change over the next `span` px, in radians (positive turns left). */
  turnAhead(along: number, span: number): number {
    const a = this.pointAt(along);
    const b = this.pointAt(along + span / 2);
    const c = this.pointAt(along + span);
    if (distance(a, b) < 1 || distance(b, c) < 1) return 0; // the route ends here
    const h1 = Math.atan2(b.y - a.y, b.x - a.x);
    const h2 = Math.atan2(c.y - b.y, c.x - b.x);
    // Screen y points down, so a left turn is a negative canvas angle change.
    return -Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1));
  }

  /** Dotted line from `from` px along the route to its end. */
  draw(ctx: CanvasRenderingContext2D, color: string, from = 0): void {
    if (this.points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([2, 12]);
    ctx.beginPath();
    const start = this.pointAt(from);
    ctx.moveTo(start.x, start.y);
    for (let i = 0; i < this.points.length; i++) if (this.lengths[i] > from) ctx.lineTo(this.points[i].x, this.points[i].y);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Plans a route from a start marking (position plus driving direction) to a target point. With
 * no target, or no legal way there, it heads for the farthest reachable point instead.
 */
export function planRoute(graph: Graph, start: Point, direction: Point, target: Point | null, roadWidth: number): Route | null {
  const startEdge = nearestEdge(graph, start);
  if (!startEdge) return null;
  const pa = graph.points[startEdge.a];
  const pb = graph.points[startEdge.b];
  // Leave along the direction the start marking faces.
  const forward = dot(subtract(pb, pa), direction) >= 0;
  const first = forward ? startEdge.b : startEdge.a;
  // The road behind the start, so the first corner is measured along the real road, not from the car.
  const behind = graph.points[forward ? startEdge.a : startEdge.b];
  const { dist, prev } = dijkstra(adjacency(graph), first);

  let nodes: number[] = [];
  let end: Point | null = null;
  /** The far end of the target's road, so the last corner is measured along the real road too. */
  let beyond: Point | null = null;
  const targetEdge = target ? nearestEdge(graph, target) : null;
  if (target && targetEdge) {
    // Enter the target's road from whichever end is legal and shortest.
    const ends = targetEdge.oneWay ? [targetEdge.a] : [targetEdge.a, targetEdge.b];
    let best = Infinity;
    for (const e of ends) {
      const cost = dist[e] + distance(graph.points[e], target);
      if (cost < best) {
        best = cost;
        nodes = pathTo(prev, e);
        end = target;
        beyond = graph.points[e === targetEdge.a ? targetEdge.b : targetEdge.a];
      }
    }
  }
  if (!end) {
    let far = first;
    for (let i = 0; i < dist.length; i++) if (dist[i] < Infinity && dist[i] > dist[far]) far = i;
    nodes = pathTo(prev, far);
  }

  const offset = roadWidth / 4;
  const legs = [start, ...nodes.map((i) => graph.points[i]), ...(end ? [end] : [])];
  // Drop repeated points (the start can sit on a node).
  const way = legs.filter((p, i) => i === 0 || distance(p, legs[i - 1]) > 1);
  const oneWay = (x: Point, y: Point) =>
    graph.segments.find((g) => (samePoint(g.p1, x) && samePoint(g.p2, y)) || (samePoint(g.p1, y) && samePoint(g.p2, x)))?.oneWay ?? false;
  // One-way roads are driven down the middle; two-way roads in the right-hand lane.
  const inLane = (a: Point, b: Point, p: Point) =>
    oneWay(a, b) ? p : add(p, scale(rightOf(normalize(subtract(b, a))), offset));

  const out: Point[] = [start];
  for (let i = 1; i < way.length - 1; i++) {
    const [a, b, c] = [i === 1 ? behind : way[i - 1], way[i], i === way.length - 2 && beyond ? beyond : way[i + 1]];
    if (oneWay(a, b) || oneWay(b, c)) out.push(inLane(a, b, b), inLane(b, c, b));
    else out.push(...corner(a, b, c, offset));
  }
  const last = way[way.length - 1];
  out.push(end || way.length < 2 ? last : inLane(way[way.length - 2], last, last));
  return new Route(out.filter((p, i) => i === 0 || distance(p, out[i - 1]) > 0.5), !!end);
}
