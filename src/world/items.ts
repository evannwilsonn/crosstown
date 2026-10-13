import { average, fake3d, lerp2D, Polygon, translate, type Point } from "./geom";
import { lerp } from "../utils";

export type RGB = [number, number, number];

export interface ItemPaint {
  wall: string;
  wallEdge: string;
  roof: string;
  roofEdge: string;
  shadow: string;
  leafLow: RGB;
  leafHigh: RGB;
  /** Flat roofs (downtown, desert) instead of the course's pitched ones. */
  roofStyle?: "pitched" | "flat";
  /** Taller or shorter buildings than the course's. */
  heightScale?: number;
  /** Smaller or larger trees (desert shrubs are small). */
  treeScale?: number;
  /** Wall and roof colors to vary buildings by; each building keeps its own pick. */
  walls?: string[];
  roofs?: string[];
  /** Window rows on the walls; `litShare` of them glow. */
  windows?: { dark: string; lit: string; litShare: number };
  /** Rooftop detail on flat roofs: air-conditioning units, or a raised edge. */
  roofDetail?: "ac" | "parapet";
  treeStyle?: "round" | "pine" | "cactus";
  /** Several leaf colorings (low, high) to vary trees by, as in an autumn street. */
  leaves?: [RGB, RGB][];
  /** White tips on pine tiers. */
  snowTips?: boolean;
}

/** A stable value in [0, 1) for a point, so each building or tree keeps its look. */
export function hash2(x: number, y: number, salt = 0): number {
  let n = Math.imul(Math.round(x) ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(Math.round(y) + salt * 374761393, 0xc2b2ae35);
  n ^= n >>> 15;
  n = Math.imul(n, 0x27d4eb2f);
  n ^= n >>> 13;
  return (n >>> 0) / 4294967296;
}

const pick = <T,>(list: T[] | undefined, fallback: T, h: number): T => (list?.length ? list[Math.floor(h * list.length)] : fallback);

/** A footprint extruded toward the viewer, with a pitched roof along its long axis (course: Pseudo 3D). */
export class Building {
  constructor(public base: Polygon, public height = 200) {}

  distanceTo(p: Point): number {
    return this.base.distanceToPoint(p);
  }

  private get seed(): Point {
    return this.base.points[0];
  }

  draw(ctx: CanvasRenderingContext2D, viewPoint: Point, paint: ItemPaint): void {
    const pts = this.base.points;
    const flat = paint.roofStyle === "flat";
    const height = this.height * (paint.heightScale ?? 1);
    const wallTop = height * (flat ? 1 : 0.6);
    const top = pts.map((p) => fake3d(p, viewPoint, wallTop));
    const ceiling = new Polygon(top);
    const { x, y } = this.seed;
    const wall = pick(paint.walls, paint.wall, hash2(x, y, 1));
    const roof = pick(paint.roofs, paint.roof, hash2(x, y, 2));

    const sides = pts.map((p, i) => {
      const j = (i + 1) % pts.length;
      return { poly: new Polygon([p, pts[j], top[j], top[i]]), i, j };
    });
    sides.sort((a, b) => b.poly.distanceToPoint(viewPoint) - a.poly.distanceToPoint(viewPoint));

    // Ridge runs between the midpoints of the two short ends.
    const ridge = [average(pts[0], pts[1]), average(pts[2], pts[3])].map((p) => fake3d(p, viewPoint, height));
    const roofs = [
      new Polygon([ceiling.points[0], ceiling.points[3], ridge[1], ridge[0]]),
      new Polygon([ceiling.points[2], ceiling.points[1], ridge[0], ridge[1]]),
    ];
    roofs.sort((a, b) => b.distanceToPoint(viewPoint) - a.distanceToPoint(viewPoint));

    this.base.path(ctx);
    ctx.fillStyle = wall;
    ctx.fill();
    ctx.strokeStyle = paint.shadow;
    ctx.lineWidth = 20;
    ctx.stroke();

    for (const side of sides) {
      side.poly.path(ctx);
      ctx.fillStyle = wall;
      ctx.fill();
      ctx.strokeStyle = paint.wallEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (paint.windows) this.drawWindows(ctx, paint.windows, pts[side.i], pts[side.j], top[side.i], top[side.j], wallTop, side.i);
    }

    ceiling.path(ctx);
    ctx.fillStyle = flat ? roof : wall;
    ctx.fill();
    ctx.strokeStyle = flat ? paint.roofEdge : wall;
    ctx.lineWidth = flat && paint.roofDetail === "parapet" ? 10 : 6;
    ctx.stroke();
    if (flat) {
      if (paint.roofDetail === "ac") this.drawRoofUnits(ctx, top, paint);
      return;
    }

    ctx.lineJoin = "round";
    for (const r of roofs) {
      r.path(ctx);
      ctx.fillStyle = roof;
      ctx.fill();
      ctx.strokeStyle = paint.roofEdge;
      ctx.lineWidth = 8;
      ctx.stroke();
    }
    ctx.lineJoin = "miter";
  }

  /** Rows of windows on one wall, mapped onto the wall's (slanted) face. */
  private drawWindows(
    ctx: CanvasRenderingContext2D,
    w: NonNullable<ItemPaint["windows"]>,
    a: Point, b: Point, ta: Point, tb: Point,
    wallHeight: number, side: number,
  ): void {
    const along = Math.hypot(b.x - a.x, b.y - a.y);
    const cols = Math.max(1, Math.floor(along / 38));
    const floors = Math.max(1, Math.round(wallHeight / 48));
    // A face seen nearly edge-on would only show slivers.
    const face = Math.abs((b.x - a.x) * (ta.y - a.y) - (b.y - a.y) * (ta.x - a.x)) / along;
    if (face < 12) return;
    const at = (u: number, v: number): Point => lerp2D(lerp2D(a, b, u), lerp2D(ta, tb, u), v);
    const dark = new Path2D();
    const lit = new Path2D();
    for (let f = 0; f < floors; f++) {
      for (let c = 0; c < cols; c++) {
        const u0 = (c + 0.28) / cols;
        const u1 = (c + 0.72) / cols;
        const v0 = (f + 0.3) / floors;
        const v1 = (f + 0.72) / floors;
        const quad = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
        const path = hash2(this.seed.x + c * 7, this.seed.y + f * 13, side + 3) < w.litShare ? lit : dark;
        path.moveTo(quad[0].x, quad[0].y);
        for (let k = 1; k < 4; k++) path.lineTo(quad[k].x, quad[k].y);
        path.closePath();
      }
    }
    ctx.fillStyle = w.dark;
    ctx.fill(dark);
    ctx.fillStyle = w.lit;
    ctx.fill(lit);
  }

  /** One or two air-conditioning boxes on a flat roof. */
  private drawRoofUnits(ctx: CanvasRenderingContext2D, top: Point[], paint: ItemPaint): void {
    const at = (u: number, v: number): Point => lerp2D(lerp2D(top[0], top[1], u), lerp2D(top[3], top[2], u), v);
    const count = hash2(this.seed.x, this.seed.y, 4) < 0.5 ? 1 : 2;
    for (let i = 0; i < count; i++) {
      const u = 0.2 + 0.45 * i + hash2(this.seed.x, this.seed.y, 5 + i) * 0.15;
      const v = 0.3 + hash2(this.seed.x, this.seed.y, 7 + i) * 0.3;
      const q = [at(u, v), at(u + 0.18, v), at(u + 0.18, v + 0.25), at(u, v + 0.25)];
      ctx.beginPath();
      q.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = paint.roofEdge;
      ctx.fill();
      ctx.strokeStyle = paint.shadow;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

const LEVELS = 7;

/** Seven stacked noisy discs, each lifted further toward the viewer and lighter (course: Pseudo 3D). */
export class Tree {
  base: Polygon;

  constructor(public center: Point, public size: number, public height = 200) {
    this.base = this.level(center, size);
  }

  /** The course's "kind of random" radius: stable per tree, no RNG needed. */
  private level(point: Point, size: number, spikes = false): Polygon {
    const points: Point[] = [];
    const rad = size / 2;
    const step = spikes ? Math.PI / 9 : Math.PI / 16;
    for (let a = spikes ? (size % 7) * 0.2 : 0, i = 0, end = a + Math.PI * 2; a < end - 1e-6; a += step, i++) {
      const kindOfRandom = Math.cos(((a + this.center.x) * size) % 17) ** 2;
      // Pine tiers: a soft saw-tooth edge, so each tier reads as a skirt of branches, not a star.
      const r = spikes ? rad * (i % 2 ? 0.84 : 1) * lerp(0.92, 1, kindOfRandom) : rad * lerp(0.5, 1, kindOfRandom);
      points.push(translate(point, a, r));
    }
    return new Polygon(points);
  }

  distanceTo(p: Point): number {
    return this.base.distanceToPoint(p);
  }

  draw(ctx: CanvasRenderingContext2D, viewPoint: Point, paint: ItemPaint): void {
    const style = paint.treeStyle ?? "round";
    if (style === "cactus") return this.drawCactus(ctx, viewPoint, paint);
    const k = paint.treeScale ?? 1;
    const [low, high] = pick(paint.leaves, [paint.leafLow, paint.leafHigh] as [RGB, RGB], hash2(this.center.x, this.center.y, 9));
    const pine = style === "pine";
    const top = fake3d(this.center, viewPoint, this.height * k * (pine ? 1.25 : 1));
    for (let l = 0; l < LEVELS; l++) {
      const t = l / (LEVELS - 1);
      const c = low.map((v, i) => Math.round(lerp(v, high[i], t)));
      // Pines narrow to a point; round trees keep a crown.
      const size = pine ? lerp(this.size * k, 8, t) : lerp(this.size * k, 40 * k, t);
      const poly = this.level(lerp2D(this.center, top, t), size, pine);
      poly.path(ctx);
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fill();
      if (pine && paint.snowTips && l % 2 === 1) {
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }
  }

  /** A saguaro seen from above: a ribbed column with two arms, lifted toward the viewer. */
  private drawCactus(ctx: CanvasRenderingContext2D, viewPoint: Point, paint: ItemPaint): void {
    const k = (paint.treeScale ?? 1) * (0.7 + hash2(this.center.x, this.center.y, 11) * 0.5);
    const h = this.height * 0.55 * k;
    const base = this.center;
    const top = fake3d(base, viewPoint, h);
    const side = hash2(base.x, base.y, 12) < 0.5 ? 1 : -1;
    const dark = `rgb(${paint.leafLow.join(",")})`;
    const light = `rgb(${paint.leafHigh.join(",")})`;
    // Shadow on the sand.
    ctx.fillStyle = paint.shadow;
    ctx.beginPath();
    ctx.ellipse(base.x, base.y, 16 * k, 10 * k, 0, 0, Math.PI * 2);
    ctx.fill();
    const stroke = (from: Point, to: Point, width: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    };
    // Arms branch off the trunk and bend upward.
    const arm = (t: number, dir: number, len: number) => {
      const at = lerp2D(base, top, t);
      const out = { x: at.x + dir * 18 * k, y: at.y };
      const up = fake3d({ x: base.x + dir * 18 * k, y: base.y }, viewPoint, h * (t + len));
      stroke(at, out, 11 * k, dark);
      stroke(out, up, 11 * k, dark);
      stroke(out, up, 4 * k, light);
    };
    arm(0.45, side, 0.3);
    arm(0.6, -side, 0.25);
    stroke(base, top, 18 * k, dark);
    stroke(base, top, 7 * k, light);
    ctx.lineCap = "butt";
  }
}
