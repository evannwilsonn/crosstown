import { distance, type Point } from "./geom";

const lerpPoint = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
import type { Graph } from "./graph";

/**
 * Navigation for the world's levels: like a phone's GPS, it knows how far a car is from its
 * destination by road and which way the next turn is, routing only the legal way down one-way
 * streets. It never steers; the brain gets the direction as one input and has to learn to follow it.
 */
export class Navigator {
  /** Road distance from each graph point to the destination. */
  private dist: number[];
  /** The next point toward the destination from each graph point; -1 means the destination itself. */
  private next: number[];
  private destSegment: number;
  private index: Map<string, number>;

  /**
   * `closed` lists segments shut for road works: the route never uses them, and a car is never
   * matched to one.
   */
  constructor(private graph: Graph, public destination: Point, private closed: ReadonlySet<number> = new Set()) {
    const n = graph.points.length;
    this.dist = new Array(n).fill(Infinity);
    this.next = new Array(n).fill(-2);
    this.destSegment = this.nearestSegment(destination);
    this.index = new Map(graph.points.map((p, i) => [`${p.x},${p.y}`, i]));
    const adj: { to: number; len: number }[][] = graph.points.map(() => []);
    for (const [si, s] of graph.segments.entries()) {
      if (closed.has(si)) continue;
      const a = this.index.get(`${s.p1.x},${s.p1.y}`);
      const b = this.index.get(`${s.p2.x},${s.p2.y}`);
      if (a === undefined || b === undefined) continue;
      const len = distance(s.p1, s.p2);
      // Searching backward from the destination: an entry v -> u means a car may drive u -> v.
      // One-way streets only run from p1 to p2.
      adj[b].push({ to: a, len });
      if (!s.oneWay) adj[a].push({ to: b, len });
    }
    // Dijkstra outward from the destination's road.
    const seg = graph.segments[this.destSegment];
    const done = new Array(n).fill(false);
    if (seg) {
      // On a one-way destination street, only its start leads to the destination.
      for (const p of seg.oneWay ? [seg.p1] : [seg.p1, seg.p2]) {
        const i = this.index.get(`${p.x},${p.y}`);
        if (i !== undefined) {
          this.dist[i] = distance(p, destination);
          this.next[i] = -1;
        }
      }
    }
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && this.dist[i] < Infinity && (u < 0 || this.dist[i] < this.dist[u])) u = i;
      if (u < 0) break;
      done[u] = true;
      for (const e of adj[u]) {
        if (this.dist[u] + e.len < this.dist[e.to]) {
          this.dist[e.to] = this.dist[u] + e.len;
          this.next[e.to] = u;
        }
      }
    }
  }

  nearestSegment(p: Point): number {
    let best = -1;
    let bestD = Infinity;
    this.graph.segments.forEach((s, i) => {
      if (this.closed.has(i)) return;
      const d = s.distanceToPoint(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /**
   * Which end of the car's street the route leaves by, and the road distance from there. With a
   * `heading`, only an end ahead of the car counts: these cars can't turn round in a two-lane
   * street, so like a real GPS the route carries on to the next junction and turns there.
   * (Routing straight back the way the car faced sent most trips into an impossible U-turn,
   * and the brains learned to ignore the GPS.) Returns first = -1 when the destination is
   * straight ahead on this street.
   */
  private leave(p: Point, segment: number, heading?: Point): { first: number; remaining: number } {
    const s = this.graph.segments[segment];
    if (!s) return { first: -2, remaining: Infinity };
    const ahead = (q: Point) => !heading || (q.x - p.x) * heading.x + (q.y - p.y) * heading.y > 0;
    if (segment === this.destSegment && ahead(this.destination)) return { first: -1, remaining: distance(p, this.destination) };
    const ends = s.oneWay ? [s.p2] : [s.p1, s.p2];
    const forward = ends.filter(ahead);
    let first = -2;
    let remaining = Infinity;
    for (const end of forward.length ? forward : ends) {
      const i = this.index.get(`${end.x},${end.y}`);
      if (i === undefined || this.dist[i] === Infinity) continue;
      const r = distance(p, end) + this.dist[i];
      if (r < remaining) {
        remaining = r;
        first = i;
      }
    }
    // Nothing reachable ahead: fall back to any end (a dead end the car must turn round in).
    if (first === -2 && forward.length && heading) return this.leave(p, segment);
    return { first, remaining };
  }

  /**
   * Road distance left to the destination and the point to head for: a spot `lookahead` px
   * further along the route, the way a phone's GPS calls a turn as you approach it. (Pointing at
   * the next junction instead kept the arrow nearly still until the car was in the junction,
   * then flipped it, which is hard for a brain to learn to follow.) Pass the result of
   * nearestSegment for `segment`, cached by the caller, and the car's heading.
   */
  guide(p: Point, segment: number, heading?: Point, lookahead = 150): { remaining: number; waypoint: Point } {
    const { first, remaining } = this.leave(p, segment, heading);
    if (first === -2) return { remaining: Infinity, waypoint: this.destination };
    // Walk the route from the car until `lookahead` px have been covered.
    let from = p;
    let left = lookahead;
    for (let i = first, guard = 0; guard <= this.graph.points.length; guard++) {
      const to = i === -1 ? this.destination : this.graph.points[i];
      const d = distance(from, to);
      if (d >= left || i === -1) return { remaining, waypoint: d > 0 && d >= left ? lerpPoint(from, to, left / d) : to };
      left -= d;
      from = to;
      i = this.next[i];
      if (i === -2) break;
    }
    return { remaining, waypoint: this.destination };
  }

  /** The road route from `p` (facing `heading`, if given) to the destination, as the points to drive through. */
  path(p: Point, heading?: Point): Point[] {
    const { first } = this.leave(p, this.nearestSegment(p), heading);
    const out = [p];
    for (let i = first, guard = 0; i >= 0 && guard < this.graph.points.length; i = this.next[i], guard++) {
      out.push(this.graph.points[i]);
    }
    out.push(this.destination);
    return out;
  }

  /**
   * The whole streets (graph segments) the route from `p` drives along, in order. The partial
   * streets at either end, where the car starts and where the destination is, are left out.
   */
  routeSegments(p: Point, heading?: Point): number[] {
    const pts = this.path(p, heading).slice(1, -1);
    const bySpan = new Map<string, number>();
    this.graph.segments.forEach((s, i) => {
      bySpan.set(`${s.p1.x},${s.p1.y}|${s.p2.x},${s.p2.y}`, i);
      bySpan.set(`${s.p2.x},${s.p2.y}|${s.p1.x},${s.p1.y}`, i);
    });
    const out: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      const si = bySpan.get(`${pts[i - 1].x},${pts[i - 1].y}|${pts[i].x},${pts[i].y}`);
      if (si !== undefined) out.push(si);
    }
    return out;
  }

  /** Road distance from `p` (facing `heading`, if given) to the destination. */
  remaining(p: Point, heading?: Point): number {
    return this.leave(p, this.nearestSegment(p), heading).remaining;
  }

  /** Road distance from a graph point to the destination (Infinity if unreachable). */
  distanceFrom(point: number): number {
    return this.dist[point];
  }
}
