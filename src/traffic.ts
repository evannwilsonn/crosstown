import { Car } from "./car";
import type { Road } from "./road";
import { mulberry32 } from "./utils";

/** "course": the video's exact seven cars. "seven": seven cars in the course's pattern, placed at random. "endless": rows forever. */
export type TrafficLayout = "course" | "seven" | "endless";

/** How traffic behaves; levels tighten and add to these. */
export interface TrafficOptions {
  rowGap?: number;
  /** Speed of the middle lane. */
  speed?: number;
  /** Share by which the left lane runs faster and the right lane slower than the middle (0 = all the same). */
  laneSpread?: number;
  /** Chance per traffic car per frame of starting a lane change (0 = nobody changes lanes). */
  changeRate?: number;
}

/** How far a lane-changing car turns its wheel, for the look of it. */
const CHANGE_ANGLE = 0.25;
/** Lanes crossed per frame while changing lanes: about 2 s for one lane. */
const LANE_CHANGE_STEP = 1 / 120;

const ROW_GAP = 210;
const TRAFFIC_SPEED = 2;
const FIRST_ROW_Y = -350; // room to reach speed and see the first row before it arrives

/**
 * Generates traffic lazily, row by row, from a fixed seed. Every generation replays
 * the same course, so cars are compared fairly. A row never blocks every lane.
 */
export class TrafficCourse {
  cars: Car[] = [];
  private rng: () => number;
  private nextRowY = FIRST_ROW_Y;

  private rowGap: number;
  /** Speed of the middle lane; rows ahead are placed relative to it. */
  readonly speed: number;
  private laneSpread: number;
  private changeRate: number;
  /** Each traffic car's lane, fractional while it moves between lanes, and the lane it's heading for. */
  private lanes = new Map<Car, { at: number; target: number }>();

  constructor(private road: Road, seed: number, public layout: TrafficLayout = "endless", options: TrafficOptions = {}) {
    this.rowGap = options.rowGap ?? ROW_GAP;
    this.speed = options.speed ?? TRAFFIC_SPEED;
    this.laneSpread = options.laneSpread ?? 0;
    this.changeRate = options.changeRate ?? 0;
    this.rng = mulberry32(seed);
    if (layout === "course") this.placeCourseLayout();
    if (layout === "seven") this.placeRandomSeven();
  }

  /**
   * Seven cars at the course's difficulty in a new arrangement: one car in a random lane, then
   * three rows that each block two lanes, every 200 px, like the video's layout.
   */
  private placeRandomSeven(): void {
    const lanes = [...Array(this.road.laneCount).keys()];
    const add = (lane: number, y: number) => {
      const car = new Car(this.road.laneCenterAt(lane, y), y, 30, 50, "DUMMY", this.speed);
      car.color = `hsl(${290 + this.rng() * 260}, 100%, 60%)`;
      this.add(car, lane);
    };
    add(lanes[Math.floor(this.rng() * lanes.length)], -100);
    for (const y of [-300, -500, -700]) {
      const gap = lanes[Math.floor(this.rng() * lanes.length)];
      for (const lane of lanes) if (lane !== gap) add(lane, y);
    }
  }

  /** The seven cars from the course video (main.js), in the same lanes and rows. */
  private placeCourseLayout(): void {
    const rows: [number, number][] = [[1, -100], [0, -300], [2, -300], [0, -500], [1, -500], [1, -700], [2, -700]];
    for (const [lane, y] of rows) {
      const car = new Car(this.road.laneCenterAt(lane, y), y, 30, 50, "DUMMY", this.speed);
      car.color = `hsl(${290 + this.rng() * 260}, 100%, 60%)`;
      this.add(car, lane);
    }
  }

  private add(car: Car, lane: number): void {
    this.cars.push(car);
    this.lanes.set(car, { at: lane, target: lane });
  }

  /** Open lane of the last row that blocked two lanes, so the next one stays reachable. */
  private lastGap = 1;
  private lastWasDouble = false;

  /**
   * Make sure rows exist far enough ahead of `leaderY`.
   * Rows alternate: a two-lane block is always followed by a lighter row, and its open lane is
   * at most one lane over from the previous block's, like the course's hand-built layout.
   * Without these rules random rows can zig-zag the only gap across the road every 210 px,
   * a weave no car can make, and training stalls at that spot forever.
   */
  extend(leaderY: number, lookahead = 1400): void {
    if (this.layout !== "endless") return;
    while (this.nextRowY > leaderY - lookahead) {
      const y = this.nextRowY;
      // Rows never put cars in a lane that is closed for construction here.
      const lanes = [...Array(this.road.laneCount).keys()].filter((l) => !this.road.closedAhead(l, y + 60, 120));
      let blocked: number[];
      if (lanes.length >= 3 && !this.lastWasDouble && this.rng() < 0.5) {
        const options = lanes.filter((l) => Math.abs(l - this.lastGap) <= 1);
        const gap = options[Math.floor(this.rng() * options.length)] ?? lanes[0];
        blocked = lanes.filter((l) => l !== gap);
        this.lastGap = gap;
        this.lastWasDouble = true;
      } else {
        // On a two-lane stretch (or a narrowed one) a row blocks one lane at most.
        blocked = lanes.length >= 2 ? [lanes[Math.floor(this.rng() * lanes.length)]] : [];
        this.lastWasDouble = false;
      }
      for (const lane of blocked) {
        const jitter = (this.rng() - 0.5) * 40;
        const car = new Car(this.road.laneCenterAt(lane, y + jitter), y + jitter, 30, 50, "DUMMY", this.laneSpeed(lane));
        if (this.cars.length) car.speed = car.maxSpeed; // join the flow at its speed
        car.color = `hsl(${290 + this.rng() * 260}, 100%, 60%)`; // the course's getRandomColor, seeded
        this.add(car, lane);
      }
      this.nextRowY -= this.rowGap;
    }
  }

  /** Cruising speed in a lane: the left lane is the fast lane, the right lane the slow one. */
  laneSpeed(lane: number): number {
    const middle = (this.road.laneCount - 1) / 2;
    const side = middle === 0 ? 0 : (middle - lane) / middle; // 1 for the left lane, -1 for the right
    return this.speed * (1 + this.laneSpread * side);
  }

  /**
   * Some drivers change lanes on their own, into an adjacent lane with room around them, and
   * settle to that lane's speed. Drivers in a lane that closes ahead merge out of it. Nobody
   * checks behind for the learning cars, like real traffic, so the brains have to watch their sides.
   */
  private changeLanes(): void {
    const n = this.road.laneCount;
    for (const car of this.cars) {
      const l = this.lanes.get(car)!;
      if (l.at !== l.target) continue;
      let next = -1;
      if (this.road.closedAhead(l.target, car.y, 260)) {
        next = l.target === 0 ? 1 : l.target - 1; // merge toward the open lanes
      } else if (this.changeRate > 0 && this.rng() < this.changeRate) {
        const pick = l.target + (this.rng() < 0.5 ? -1 : 1);
        const room = this.cars.every((o) => {
          if (o === car) return true;
          const ol = this.lanes.get(o)!;
          return Math.abs(ol.at - pick) > 0.6 || Math.abs(o.y - car.y) > 110;
        });
        if (pick >= 0 && pick < n && room && !this.road.closedAhead(pick, car.y, 400)) next = pick;
      }
      if (next >= 0 && next < n) l.target = next;
    }
  }

  update(): void {
    this.changeLanes();
    for (const car of this.cars) {
      car.update([], []);
      // Traffic follows its lane along the road, easing across when it changes lanes.
      const l = this.lanes.get(car)!;
      let tilt = 0;
      if (l.at !== l.target) {
        const dir = Math.sign(l.target - l.at);
        l.at += dir * LANE_CHANGE_STEP;
        if ((l.target - l.at) * dir <= 0) {
          l.at = l.target;
          car.maxSpeed = this.laneSpeed(l.target);
        } else tilt = -dir * CHANGE_ANGLE;
      }
      car.place(this.road.laneCenterAt(l.at, car.y), car.y, this.road.heading(car.y) + tilt);
    }
    // Rows ahead are placed relative to the moving traffic, not the map: without this, rows made
    // later land closer to the ones already driving, and the spacing collapses as the run goes on.
    this.nextRowY -= this.speed;
  }

  /** Lane a traffic car is in (fractional while changing). */
  laneAt(car: Car): number {
    return this.lanes.get(car)?.at ?? 0;
  }

  /** Traffic within `range` of y, for cheaper collision and sensor checks. */
  near(y: number, range = 260): Car[] {
    return this.cars.filter((c) => Math.abs(c.y - y) < range);
  }
}
