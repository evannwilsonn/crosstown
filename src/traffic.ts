import { Car } from "./car";
import type { Road } from "./road";
import { mulberry32 } from "./utils";

export type TrafficLayout = "course" | "endless";

const ROW_GAP = 210;
const FIRST_ROW_Y = -350; // room to reach speed and see the first row before it arrives

/**
 * Generates traffic lazily, row by row, from a fixed seed. Every generation replays
 * the same course, so cars are compared fairly. A row never blocks every lane.
 */
export class TrafficCourse {
  cars: Car[] = [];
  private rng: () => number;
  private nextRowY = FIRST_ROW_Y;

  constructor(private road: Road, seed: number, public layout: TrafficLayout = "endless") {
    this.rng = mulberry32(seed);
    if (layout === "course") this.placeCourseLayout();
  }

  /** The seven cars from the course video (main.js), in the same lanes and rows. */
  private placeCourseLayout(): void {
    const rows: [number, number][] = [[1, -100], [0, -300], [2, -300], [0, -500], [1, -500], [1, -700], [2, -700]];
    for (const [lane, y] of rows) {
      const car = new Car(this.road.getLaneCenter(lane), y, 30, 50, "DUMMY", 2);
      car.color = `hsl(${290 + this.rng() * 260}, 100%, 60%)`;
      this.cars.push(car);
    }
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
    if (this.layout === "course") return;
    while (this.nextRowY > leaderY - lookahead) {
      const lanes = [...Array(this.road.laneCount).keys()];
      let blocked: number[];
      if (!this.lastWasDouble && this.rng() < 0.5) {
        const options = lanes.filter((l) => Math.abs(l - this.lastGap) <= 1);
        const gap = options[Math.floor(this.rng() * options.length)];
        blocked = lanes.filter((l) => l !== gap);
        this.lastGap = gap;
        this.lastWasDouble = true;
      } else {
        blocked = [lanes[Math.floor(this.rng() * lanes.length)]];
        this.lastWasDouble = false;
      }
      for (const lane of blocked) {
        const jitter = (this.rng() - 0.5) * 40;
        const car = new Car(this.road.getLaneCenter(lane), this.nextRowY + jitter, 30, 50, "DUMMY", 2);
        car.color = `hsl(${290 + this.rng() * 260}, 100%, 60%)`; // the course's getRandomColor, seeded
        this.cars.push(car);
      }
      this.nextRowY -= ROW_GAP;
    }
  }

  update(): void {
    for (const car of this.cars) car.update([], []);
  }

  /** Traffic within `range` of y, for cheaper collision and sensor checks. */
  near(y: number, range = 260): Car[] {
    return this.cars.filter((c) => Math.abs(c.y - y) < range);
  }
}
