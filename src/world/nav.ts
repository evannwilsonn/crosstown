import { distance, type Point } from "./geom";
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

  constructor(private graph: Graph, public destination: Point) {
    const n = graph.points.length;
    this.dist = new Array(n).fill(Infinity);
    this.next = new Array(n).fill(-2);
    this.destSegment = this.nearestSegment(destination);
    this.index = new Map(graph.points.map((p, i) => [`${p.x},${p.y}`, i]));
    const adj: { to: number; len: number }[][] = graph.points.map(() => []);
    for (const s of graph.segments) {
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
      const d = s.distanceToPoint(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /**
   * Road distance left to the destination and the point to head for next, from `p` on the
   * segment `segment` (pass the result of nearestSegment, cached by the caller).
   */
  guide(p: Point, segment: number): { remaining: number; waypoint: Point } {
    const s = this.graph.segments[segment];
    if (!s) return { remaining: Infinity, waypoint: this.destination };
    if (segment === this.destSegment) return { remaining: distance(p, this.destination), waypoint: this.destination };
    let best = { remaining: Infinity, waypoint: this.destination };
    for (const end of s.oneWay ? [s.p2] : [s.p1, s.p2]) {
      const i = this.index.get(`${end.x},${end.y}`);
      if (i === undefined || this.dist[i] === Infinity) continue;
      const remaining = distance(p, end) + this.dist[i];
      if (remaining < best.remaining) {
        // Close to the junction: point at the road after it, the way a GPS calls the next turn early.
        const after = this.next[i] === -1 ? this.destination : this.graph.points[this.next[i]];
        best = { remaining, waypoint: distance(p, end) < 40 && after ? after : end };
      }
    }
    return best;
  }

  /** The road route from `p` to the destination, as the points to drive through. */
  path(p: Point): Point[] {
    const seg = this.nearestSegment(p);
    const s = this.graph.segments[seg];
    if (!s) return [p, this.destination];
    if (seg === this.destSegment) return [p, this.destination];
    let first = -1;
    let best = Infinity;
    for (const end of s.oneWay ? [s.p2] : [s.p1, s.p2]) {
      const i = this.index.get(`${end.x},${end.y}`);
      if (i === undefined || this.dist[i] === Infinity) continue;
      const d = distance(p, end) + this.dist[i];
      if (d < best) {
        best = d;
        first = i;
      }
    }
    const out = [p];
    for (let i = first, guard = 0; i >= 0 && guard < this.graph.points.length; i = this.next[i], guard++) {
      out.push(this.graph.points[i]);
    }
    out.push(this.destination);
    return out;
  }

  /** Road distance from `p` to the destination. */
  remaining(p: Point): number {
    return this.guide(p, this.nearestSegment(p)).remaining;
  }

  /** Road distance from a graph point to the destination (Infinity if unreachable). */
  distanceFrom(point: number): number {
    return this.dist[point];
  }
}
