import { Car } from "../car";
import { mulberry32 } from "../utils";
import { distance, type Point } from "./geom";
import type { Graph } from "./graph";
import { Light, type Marking } from "./markings";

/**
 * Other cars on the town's streets: they keep to their lane, pick a street at each junction,
 * stop at red lights, and queue behind each other. They never react to the learning cars; the
 * learners have to keep clear of them, and hitting one is a crash. Every trip starts the
 * traffic the same way, so all the brains in a generation meet the same traffic.
 */

const SPEED = 1.9;
/** Gap kept to the car ahead in the same lane. */
const GAP = 70;
const STOP_BEFORE_LIGHT = 22;
/** Lane points are set back this far from the junction so turns cut the corner a little. */
const CORNER = 34;

interface Leg {
  from: number;
  to: number;
}

export class TrafficCar {
  readonly body: Car;
  /** Points to drive through for the current street, in lane position. */
  private path: Point[] = [];
  private step = 0;
  private leg: Leg;
  speed = SPEED;

  constructor(private town: CityTraffic, leg: Leg, at: number, color: string) {
    this.body = new Car(0, 0, 30, 50, "DUMMY");
    this.body.color = color;
    this.leg = leg;
    this.path = town.lanePath(leg);
    // Start part way along the street.
    const a = this.path[0];
    const b = this.path[this.path.length - 1];
    this.place({ x: a.x + (b.x - a.x) * at, y: a.y + (b.y - a.y) * at }, b);
    this.step = 1;
  }

  get polygon(): Point[] {
    return this.body.polygon;
  }
  get x(): number {
    return this.body.x;
  }
  get y(): number {
    return this.body.y;
  }

  private place(p: Point, toward: Point): void {
    const angle = Math.atan2(-(toward.x - p.x), -(toward.y - p.y));
    this.body.place(p.x, p.y, Number.isFinite(angle) && (toward.x !== p.x || toward.y !== p.y) ? angle : this.body.angle);
  }

  /** True when a red light is just ahead in this car's lane. */
  private redAhead(lights: Light[]): boolean {
    const fx = -Math.sin(this.body.angle);
    const fy = -Math.cos(this.body.angle);
    return lights.some((l) => {
      if (l.state !== "red") return false;
      // Same direction of travel, and just ahead in this lane.
      if (l.direction.x * fx + l.direction.y * fy < 0.8) return false;
      const dx = l.center.x - this.x;
      const dy = l.center.y - this.y;
      const ahead = dx * fx + dy * fy;
      return Math.abs(dx * fy - dy * fx) < 22 && ahead > 0 && ahead < 25 + STOP_BEFORE_LIGHT + 30;
    });
  }

  update(others: TrafficCar[], lights: Light[]): void {
    const fx = -Math.sin(this.body.angle);
    const fy = -Math.cos(this.body.angle);
    // Queue behind whoever is ahead in the same lane.
    const blocked = others.some((o) => {
      if (o === this) return false;
      const dx = o.x - this.x;
      const dy = o.y - this.y;
      const ahead = dx * fx + dy * fy;
      const cross = dx * fy - dy * fx;
      const side = Math.abs(cross);
      // Same lane: keep the gap. In a junction, give way to a car just ahead on the right (or dead
      // ahead), so two cars meeting at right angles never both wait for each other.
      return ahead > 0 && ((ahead < GAP && side < 20) || (ahead < 48 && side < ahead && (cross < 0 || side < 10)));
    });
    const want = blocked || this.redAhead(lights) ? 0 : SPEED;
    this.speed += Math.max(-0.25, Math.min(0.08, want - this.speed));
    let left = this.speed;
    for (let guard = 0; left > 0 && guard < 8; guard++) {
      const target = this.path[this.step];
      const d = distance(this.body, target);
      if (d > left) {
        const t = left / d;
        this.place({ x: this.x + (target.x - this.x) * t, y: this.y + (target.y - this.y) * t }, target);
        break;
      }
      left -= d;
      this.place(target, this.path[this.step + 1] ?? target);
      this.step++;
      if (this.step >= this.path.length) {
        this.leg = this.town.nextLeg(this.leg);
        this.path = [target, ...this.town.lanePath(this.leg)];
        this.step = 1;
      }
    }
  }
}

export class CityTraffic {
  cars: TrafficCar[] = [];
  private lights: Light[];
  /** Streets leaving each point, legal directions only. */
  private out: { to: number; seg: number }[][];
  private rand: () => number;

  constructor(
    private graph: Graph,
    markings: readonly Marking[],
    private roadWidth: number,
    seed: number,
    count: number,
    /** Streets traffic never uses (closed roads). */
    closed: ReadonlySet<number>,
    /** A spot to keep clear when placing cars: where the learners start. */
    keepClear: Point,
  ) {
    this.lights = markings.filter((m): m is Light => m instanceof Light);
    this.rand = mulberry32(seed >>> 0);
    const index = new Map(graph.points.map((p, i) => [`${p.x},${p.y}`, i]));
    this.out = graph.points.map(() => []);
    graph.segments.forEach((s, si) => {
      if (closed.has(si)) return;
      const a = index.get(`${s.p1.x},${s.p1.y}`);
      const b = index.get(`${s.p2.x},${s.p2.y}`);
      if (a === undefined || b === undefined) return;
      this.out[a].push({ to: b, seg: si });
      if (!s.oneWay) this.out[b].push({ to: a, seg: si });
    });
    const colors = ["#c94f4f", "#4f7fc9", "#d9d4c7", "#5f6b73", "#3f8f6a", "#c9a24f", "#8a5fc9"];
    const legs = graph.points.flatMap((_, from) => this.out[from].map((e) => ({ from, to: e.to })));
    for (let tries = 0; this.cars.length < count && tries < count * 20 && legs.length; tries++) {
      const leg = legs[Math.floor(this.rand() * legs.length)];
      const at = 0.15 + this.rand() * 0.6;
      const a = graph.points[leg.from];
      const b = graph.points[leg.to];
      const p = { x: a.x + (b.x - a.x) * at, y: a.y + (b.y - a.y) * at };
      if (distance(p, keepClear) < 260) continue;
      if (this.cars.some((c) => distance(c.body, p) < GAP + 20)) continue;
      this.cars.push(new TrafficCar(this, leg, at, colors[Math.floor(this.rand() * colors.length)]));
    }
  }

  /** The next street at a junction: any legal one except straight back, unless it's a dead end. */
  nextLeg(leg: Leg): Leg {
    const options = this.out[leg.to].filter((e) => e.to !== leg.from);
    const pool = options.length ? options : this.out[leg.to];
    if (!pool.length) return { from: leg.to, to: leg.from };
    return { from: leg.to, to: pool[Math.floor(this.rand() * pool.length)].to };
  }

  /** The right-hand lane of a street, set back from each junction. */
  lanePath(leg: Leg): Point[] {
    const a = this.graph.points[leg.from];
    const b = this.graph.points[leg.to];
    const len = distance(a, b) || 1;
    const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const seg = this.out[leg.from].find((e) => e.to === leg.to);
    const oneWay = seg ? this.graph.segments[seg.seg].oneWay : false;
    // Right of the direction of travel, matching the world's lane guides.
    const off = oneWay ? 0 : this.roadWidth / 4;
    const right = { x: -dir.y * off, y: dir.x * off };
    const back = Math.min(CORNER, len / 3);
    return [
      { x: a.x + dir.x * back + right.x, y: a.y + dir.y * back + right.y },
      { x: b.x - dir.x * back + right.x, y: b.y - dir.y * back + right.y },
    ];
  }

  update(): void {
    for (const c of this.cars) c.update(this.cars, this.lights);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const c of this.cars) c.body.draw(ctx, c.body.color ?? "#999");
  }
}
