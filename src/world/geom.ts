import { getIntersection, lerp, type Point } from "../utils";

export type { Point };

export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (p: Point, s: number): Point => ({ x: p.x * s, y: p.y * s });
export const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
export const magnitude = (p: Point): number => Math.hypot(p.x, p.y);
export const normalize = (p: Point): Point => scale(p, 1 / (magnitude(p) || 1));
export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const average = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const angle = (p: Point): number => Math.atan2(p.y, p.x);
export const translate = (loc: Point, a: number, offset: number): Point => ({
  x: loc.x + Math.cos(a) * offset,
  y: loc.y + Math.sin(a) * offset,
});
/** Right-hand normal in screen coordinates (y points down). */
export const rightOf = (dir: Point): Point => ({ x: -dir.y, y: dir.x });
export const lerp2D = (a: Point, b: Point, t: number): Point => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
export const invLerp = (a: number, b: number, v: number): number => (v - a) / (b - a);
export const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

export function getNearestPoint(loc: Point, points: Point[], threshold = Infinity): Point | null {
  let best: Point | null = null;
  let min = threshold;
  for (const p of points) {
    const d = distance(p, loc);
    if (d < min) {
      min = d;
      best = p;
    }
  }
  return best;
}

export class Segment {
  constructor(public p1: Point, public p2: Point) {}

  length(): number {
    return distance(this.p1, this.p2);
  }

  directionVector(): Point {
    return normalize(subtract(this.p2, this.p1));
  }

  includes(p: Point): boolean {
    return samePoint(this.p1, p) || samePoint(this.p2, p);
  }

  equals(s: Segment): boolean {
    return this.includes(s.p1) && this.includes(s.p2);
  }

  /** Projection of p onto the infinite line, with offset 0 at p1 and 1 at p2. */
  projectPoint(p: Point): { point: Point; offset: number } {
    const a = subtract(p, this.p1);
    const b = subtract(this.p2, this.p1);
    const len = magnitude(b) || 1;
    const along = dot(a, scale(b, 1 / len));
    return { point: add(this.p1, scale(b, along / len)), offset: along / len };
  }

  distanceToPoint(p: Point): number {
    const proj = this.projectPoint(p);
    if (proj.offset > 0 && proj.offset < 1) return distance(p, proj.point);
    return Math.min(distance(p, this.p1), distance(p, this.p2));
  }
}

export function getNearestSegment(loc: Point, segments: Segment[], threshold = Infinity): Segment | null {
  let best: Segment | null = null;
  let min = threshold;
  for (const s of segments) {
    const d = s.distanceToPoint(loc);
    if (d < min) {
      min = d;
      best = s;
    }
  }
  return best;
}

const FAR_AWAY: Point = { x: -1e7, y: -1.3e7 };

export class Polygon {
  segments: Segment[];

  constructor(public points: Point[]) {
    this.segments = points.map((p, i) => new Segment(p, points[(i + 1) % points.length]));
  }

  /** Outline of the union of polygons: break edges at every crossing, then keep edges outside all others. */
  static union(polys: Polygon[]): Segment[] {
    Polygon.multiBreak(polys);
    const kept: Segment[] = [];
    for (let i = 0; i < polys.length; i++) {
      for (const seg of polys[i].segments) {
        let keep = true;
        for (let j = 0; j < polys.length; j++) {
          if (i !== j && polys[j].containsSegment(seg)) {
            keep = false;
            break;
          }
        }
        if (keep) kept.push(seg);
      }
    }
    return kept;
  }

  static multiBreak(polys: Polygon[]): void {
    for (let i = 0; i < polys.length - 1; i++) {
      for (let j = i + 1; j < polys.length; j++) Polygon.break(polys[i], polys[j]);
    }
  }

  static break(a: Polygon, b: Polygon): void {
    const sa = a.segments;
    const sb = b.segments;
    for (let i = 0; i < sa.length; i++) {
      for (let j = 0; j < sb.length; j++) {
        const hit = getIntersection(sa[i].p1, sa[i].p2, sb[j].p1, sb[j].p2);
        if (hit && hit.offset !== 1 && hit.offset !== 0) {
          const point = { x: hit.x, y: hit.y };
          let aux = sa[i].p2;
          sa[i].p2 = point;
          sa.splice(i + 1, 0, new Segment(point, aux));
          aux = sb[j].p2;
          sb[j].p2 = point;
          sb.splice(j + 1, 0, new Segment(point, aux));
        }
      }
    }
  }

  containsSegment(seg: Segment): boolean {
    return this.containsPoint(average(seg.p1, seg.p2));
  }

  /** Ray casting: an odd number of edge crossings means the point is inside. */
  containsPoint(p: Point): boolean {
    let crossings = 0;
    for (const s of this.segments) if (getIntersection(FAR_AWAY, p, s.p1, s.p2)) crossings++;
    return crossings % 2 === 1;
  }

  intersectsPoly(other: Polygon): boolean {
    for (const s1 of this.segments) {
      for (const s2 of other.segments) if (getIntersection(s1.p1, s1.p2, s2.p1, s2.p2)) return true;
    }
    return false;
  }

  distanceToPoint(p: Point): number {
    let min = Infinity;
    for (const s of this.segments) min = Math.min(min, s.distanceToPoint(p));
    return min;
  }

  distanceToPoly(other: Polygon): number {
    let min = Infinity;
    for (const p of this.points) min = Math.min(min, other.distanceToPoint(p));
    return min;
  }

  path(ctx: CanvasRenderingContext2D, points: Point[] = this.points): void {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
  }
}

/** A capsule-shaped polygon around a segment: the footprint of a road or building. */
export class Envelope {
  poly: Polygon;

  constructor(public skeleton: Segment, public width: number, roundness = 1) {
    this.poly = this.generate(roundness);
  }

  private generate(roundness: number): Polygon {
    const { p1, p2 } = this.skeleton;
    const radius = this.width / 2;
    const alpha = angle(subtract(p1, p2));
    const cw = alpha + Math.PI / 2;
    const ccw = alpha - Math.PI / 2;
    const step = Math.PI / Math.max(1, roundness);
    const eps = step / 2;
    const points: Point[] = [];
    for (let a = ccw; a <= cw + eps; a += step) points.push(translate(p1, a, radius));
    for (let a = ccw; a <= cw + eps; a += step) points.push(translate(p2, Math.PI + a, radius));
    return new Polygon(points);
  }
}

/** Fake 3D: lift a ground point away from the camera, more for points far from it. */
export function fake3d(p: Point, viewPoint: Point, height: number): Point {
  const dir = normalize(subtract(p, viewPoint));
  const scaler = Math.atan(distance(p, viewPoint) / 300) / (Math.PI / 2);
  return add(p, scale(dir, height * scaler));
}
