import { average, distance, fake3d, lerp2D, Polygon, translate, type Point } from "./geom";
import { lerp } from "../utils";

export interface ItemPaint {
  wall: string;
  wallEdge: string;
  roof: string;
  roofEdge: string;
  shadow: string;
  leafLow: [number, number, number];
  leafHigh: [number, number, number];
}

/** A footprint extruded toward the viewer, with a pitched roof along its long axis (course: Pseudo 3D). */
export class Building {
  constructor(public base: Polygon, public height = 200) {}

  distanceTo(p: Point): number {
    return this.base.distanceToPoint(p);
  }

  draw(ctx: CanvasRenderingContext2D, viewPoint: Point, paint: ItemPaint): void {
    const pts = this.base.points;
    const top = pts.map((p) => fake3d(p, viewPoint, this.height * 0.6));
    const ceiling = new Polygon(top);

    const sides = pts.map((p, i) => {
      const j = (i + 1) % pts.length;
      return new Polygon([p, pts[j], top[j], top[i]]);
    });
    sides.sort((a, b) => b.distanceToPoint(viewPoint) - a.distanceToPoint(viewPoint));

    // Ridge runs between the midpoints of the two short ends.
    const ridge = [average(pts[0], pts[1]), average(pts[2], pts[3])].map((p) => fake3d(p, viewPoint, this.height));
    const roofs = [
      new Polygon([ceiling.points[0], ceiling.points[3], ridge[1], ridge[0]]),
      new Polygon([ceiling.points[2], ceiling.points[1], ridge[0], ridge[1]]),
    ];
    roofs.sort((a, b) => b.distanceToPoint(viewPoint) - a.distanceToPoint(viewPoint));

    this.base.path(ctx);
    ctx.fillStyle = paint.wall;
    ctx.fill();
    ctx.strokeStyle = paint.shadow;
    ctx.lineWidth = 20;
    ctx.stroke();

    for (const side of sides) {
      side.path(ctx);
      ctx.fillStyle = paint.wall;
      ctx.fill();
      ctx.strokeStyle = paint.wallEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ceiling.path(ctx);
    ctx.fillStyle = paint.wall;
    ctx.fill();
    ctx.strokeStyle = paint.wall;
    ctx.lineWidth = 6;
    ctx.stroke();

    ctx.lineJoin = "round";
    for (const roof of roofs) {
      roof.path(ctx);
      ctx.fillStyle = paint.roof;
      ctx.fill();
      ctx.strokeStyle = paint.roofEdge;
      ctx.lineWidth = 8;
      ctx.stroke();
    }
    ctx.lineJoin = "miter";
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
  private level(point: Point, size: number): Polygon {
    const points: Point[] = [];
    const rad = size / 2;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
      const kindOfRandom = Math.cos(((a + this.center.x) * size) % 17) ** 2;
      points.push(translate(point, a, rad * lerp(0.5, 1, kindOfRandom)));
    }
    return new Polygon(points);
  }

  distanceTo(p: Point): number {
    return distance(this.center, p);
  }

  draw(ctx: CanvasRenderingContext2D, viewPoint: Point, paint: ItemPaint): void {
    const top = fake3d(this.center, viewPoint, this.height);
    for (let l = 0; l < LEVELS; l++) {
      const t = l / (LEVELS - 1);
      const c = paint.leafLow.map((v, i) => Math.round(lerp(v, paint.leafHigh[i], t)));
      const poly = this.level(lerp2D(this.center, top, t), lerp(this.size, 40, t));
      poly.path(ctx);
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fill();
    }
  }
}
