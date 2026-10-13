import { samePoint, Segment, type Point } from "./geom";

export interface GraphJSON {
  points: Point[];
  segments: { p1: Point; p2: Point; oneWay?: boolean }[];
}

/** Road network: intersections are points, roads are segments between them. */
export class Graph {
  /** Bumped on every change so the world knows when to regenerate. */
  version = 0;

  constructor(public points: Point[] = [], public segments: Segment[] = []) {}

  static fromJSON(data: GraphJSON): Graph {
    const points = data.points.map((p) => ({ x: p.x, y: p.y }));
    const find = (q: Point) => points.find((p) => samePoint(p, q));
    const segments: Segment[] = [];
    for (const s of data.segments) {
      const a = find(s.p1);
      const b = find(s.p2);
      if (a && b && a !== b) segments.push(new Segment(a, b, s.oneWay ?? false));
    }
    return new Graph(points, segments);
  }

  toJSON(): GraphJSON {
    return {
      points: this.points.map((p) => ({ x: p.x, y: p.y })),
      segments: this.segments.map((s) => ({
        p1: { x: s.p1.x, y: s.p1.y },
        p2: { x: s.p2.x, y: s.p2.y },
        ...(s.oneWay ? { oneWay: true } : {}),
      })),
    };
  }

  touch(): void {
    this.version++;
  }

  addPoint(p: Point): void {
    this.points.push(p);
    this.touch();
  }

  containsPoint(p: Point): boolean {
    return this.points.some((q) => samePoint(q, p));
  }

  tryAddPoint(p: Point): boolean {
    if (this.containsPoint(p)) return false;
    this.addPoint(p);
    return true;
  }

  removePoint(p: Point): void {
    this.segments = this.segments.filter((s) => s.p1 !== p && s.p2 !== p);
    this.points = this.points.filter((q) => q !== p);
    this.touch();
  }

  containsSegment(seg: Segment): boolean {
    return this.segments.some((s) => s.equals(seg));
  }

  tryAddSegment(seg: Segment): boolean {
    if (this.containsSegment(seg) || samePoint(seg.p1, seg.p2)) return false;
    this.segments.push(seg);
    this.touch();
    return true;
  }

  removeSegment(seg: Segment): void {
    this.segments = this.segments.filter((s) => s !== seg);
    this.touch();
  }

  getSegmentsWithPoint(p: Point): Segment[] {
    return this.segments.filter((s) => s.p1 === p || s.p2 === p);
  }

  dispose(): void {
    this.points = [];
    this.segments = [];
    this.touch();
  }
}
