import type { Point } from "./utils";

/** One sweep of a curving road: a sideways sine wave along its length. */
export interface Bend {
  amplitude: number;
  wavelength: number;
  phase: number;
}

/**
 * Construction zones: every `period` px from `start`, one outside lane closes for `length` px,
 * alternating sides. Its traffic has to merge into the next lane, and so do the learning cars.
 */
export interface Closures {
  start: number;
  period: number;
  length: number;
}

/** Everything that makes one highway different from another. */
export interface RoadShape {
  laneCount: number;
  bends: Bend[];
  closures?: Closures;
}

/** Closed lanes taper over this distance, like cones angling across a real lane. */
const TAPER = 160;
/** Curves fade in over the first stretch so every run starts on a straight. */
const STRAIGHT_START = 200;
const CURVE_FADE = 700;
/** Border segments are cut this finely and cached in strips this tall. */
const BORDER_STEP = 25;
const STRIP = 200;

export class Road {
  readonly laneWidth: number;
  readonly shape: RoadShape;
  private stripCache = new Map<number, Point[][]>();

  constructor(public x: number, public width: number, public laneCount = 3, shape?: RoadShape) {
    this.laneWidth = width / laneCount;
    this.shape = shape ?? { laneCount, bends: [] };
  }

  /** Left edge of the road at the start line (straight roads only change with curves). */
  get left(): number {
    return this.leftAt(100);
  }

  get right(): number {
    return this.rightAt(100);
  }

  /** Sideways position of the road's middle at a point along it. */
  centerX(y: number): number {
    if (!this.shape.bends.length) return this.x;
    const fade = Math.max(0, Math.min(1, (-y - STRAIGHT_START) / CURVE_FADE));
    if (fade === 0) return this.x;
    let dx = 0;
    for (const b of this.shape.bends) dx += b.amplitude * Math.sin((y / b.wavelength) * Math.PI * 2 + b.phase);
    // Anchor every bend to zero at the start so the fade-in is smooth.
    for (const b of this.shape.bends) dx -= b.amplitude * Math.sin(b.phase);
    return this.x + dx * fade;
  }

  /** The road's direction at a point, as a car angle (0 = straight up the screen). */
  heading(y: number): number {
    const dx = this.centerX(y - 5) - this.centerX(y + 5);
    return Math.atan2(-dx, 10);
  }

  leftAt(y: number): number {
    return this.centerX(y) - this.width / 2;
  }

  rightAt(y: number): number {
    return this.centerX(y) + this.width / 2;
  }

  /** Middle of a lane at a point along the road; fractional lanes are in-between positions. */
  laneCenterAt(lane: number, y: number): number {
    return this.leftAt(y) + this.laneWidth * (lane + 0.5);
  }

  /** Middle of a lane at the start line. */
  getLaneCenter(index: number, y = 100): number {
    return this.laneCenterAt(Math.min(index, this.laneCount - 1), y);
  }

  /** Which outside lane a construction zone closes, and how closed it is (0 open to 1 shut), at a point. */
  closure(y: number): { lane: number; amount: number } | null {
    const c = this.shape.closures;
    if (!c) return null;
    const along = -y - c.start;
    if (along < 0) return null;
    const k = Math.floor(along / c.period);
    const into = along - k * c.period;
    if (into > c.length) return null;
    const amount = Math.min(1, into / TAPER, (c.length - into) / TAPER);
    return { lane: k % 2 === 0 ? this.laneCount - 1 : 0, amount: Math.max(0, amount) };
  }

  /** True when a lane is closed (or closing) anywhere from `y` to `ahead` px further along. */
  closedAhead(lane: number, y: number, ahead: number): boolean {
    for (let d = 0; d <= ahead; d += 40) {
      const c = this.closure(y - d);
      if (c && c.lane === lane && c.amount > 0) return true;
    }
    return false;
  }

  /** Drivable edges at a point: the road's sides, pulled in where a lane is closed. */
  edgesAt(y: number): [number, number] {
    let left = this.leftAt(y);
    let right = this.rightAt(y);
    const c = this.closure(y);
    if (c) {
      if (c.lane === 0) left += c.amount * this.laneWidth;
      else right -= c.amount * this.laneWidth;
    }
    return [left, right];
  }

  /**
   * Road edges near `y` as short segments, for collisions and sensors. Cut into cached strips,
   * so a road thousands of screens long costs the same as a short one.
   */
  bordersNear(y: number, range = 260): Point[][] {
    const out: Point[][] = [];
    const first = Math.floor((y - range) / STRIP);
    const last = Math.floor((y + range) / STRIP);
    for (let s = first; s <= last; s++) {
      let strip = this.stripCache.get(s);
      if (!strip) {
        strip = [];
        for (let yy = s * STRIP; yy < (s + 1) * STRIP; yy += BORDER_STEP) {
          const [l0, r0] = this.edgesAt(yy);
          const [l1, r1] = this.edgesAt(yy + BORDER_STEP);
          strip.push([{ x: l0, y: yy }, { x: l1, y: yy + BORDER_STEP }]);
          strip.push([{ x: r0, y: yy }, { x: r1, y: yy + BORDER_STEP }]);
        }
        this.stripCache.set(s, strip);
        if (this.stripCache.size > 400) this.stripCache.delete(this.stripCache.keys().next().value!);
      }
      out.push(...strip);
    }
    return out;
  }

  /** Draws US-style markings: yellow left edge, white right edge, dashed white lane lines, cones in work zones. */
  draw(
    ctx: CanvasRenderingContext2D,
    colors: { surface: string; shoulder: string; lane: string; edge: string; center: string; cone?: string },
    viewTop: number,
    viewBottom: number,
  ): void {
    const step = 20;
    const ys: number[] = [];
    for (let y = Math.floor(viewBottom / step) * step + step; y >= viewTop - step; y -= step) ys.push(y);
    const shoulder = 18;
    const band = (offsetL: number, offsetR: number, fill: string) => {
      ctx.beginPath();
      ys.forEach((y, i) => (i ? ctx.lineTo(this.leftAt(y) - offsetL, y) : ctx.moveTo(this.leftAt(y) - offsetL, y)));
      for (let i = ys.length - 1; i >= 0; i--) ctx.lineTo(this.rightAt(ys[i]) + offsetR, ys[i]);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    band(shoulder, shoulder, colors.shoulder);
    band(0, 0, colors.surface);

    const line = (xAt: (y: number) => number, color: string, dash: number[]) => {
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ys.forEach((y, i) => (i ? ctx.lineTo(xAt(y), y) : ctx.moveTo(xAt(y), y)));
      ctx.stroke();
    };
    ctx.lineWidth = 4;
    // Dash offset tied to world y so the paint stays put on the road as the camera moves.
    ctx.lineDashOffset = -((ys[0] ?? 0) % 60);
    for (let i = 1; i < this.laneCount; i++) line((y) => this.leftAt(y) + this.laneWidth * i, colors.lane, [24, 36]);
    ctx.lineDashOffset = 0;
    line((y) => this.leftAt(y), colors.center, []);
    line((y) => this.rightAt(y), colors.edge, []);
    ctx.setLineDash([]);

    // Work zones: hatch the closed lane and line its edge with cones.
    if (this.shape.closures) {
      const cone = colors.cone ?? "#ff7a1a";
      // The closed area as one smooth shape between the road edge and the cone line.
      const closed = ys.filter((y) => (this.closure(y)?.amount ?? 0) > 0);
      if (closed.length > 1) {
        ctx.fillStyle = "rgba(255, 122, 26, 0.16)";
        ctx.beginPath();
        closed.forEach((y, i) => {
          const c = this.closure(y)!;
          const [l, r] = this.edgesAt(y);
          const x = c.lane === 0 ? l : r;
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        for (let i = closed.length - 1; i >= 0; i--) {
          const y = closed[i];
          ctx.lineTo(this.closure(y)!.lane === 0 ? this.leftAt(y) : this.rightAt(y), y);
        }
        ctx.closePath();
        ctx.fill();
      }
      for (const y of closed) {
        const c = this.closure(y)!;
        const [l, r] = this.edgesAt(y);
        if (Math.round(y / step) % 2 === 0) {
          const cx = c.lane === 0 ? l : r;
          ctx.fillStyle = cone;
          ctx.beginPath();
          ctx.moveTo(cx, y - 7);
          ctx.lineTo(cx + 5, y + 5);
          ctx.lineTo(cx - 5, y + 5);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
  }
}
