import { Car } from "./car";
import type { Road } from "./road";
import { mulberry32 } from "./utils";

const ROW_GAP = 210;
const FIRST_ROW_Y = -150;

/**
 * Generates traffic lazily, row by row, from a fixed seed. Every generation replays
 * the same course, so cars are compared fairly. A row never blocks every lane.
 */
export class TrafficCourse {
  cars: Car[] = [];
  private rng: () => number;
  private nextRowY = FIRST_ROW_Y;

  constructor(private road: Road, seed: number) {
    this.rng = mulberry32(seed);
  }

  /** Make sure rows exist far enough ahead of `leaderY`. */
  extend(leaderY: number, lookahead = 1400): void {
    while (this.nextRowY > leaderY - lookahead) {
      const lanes = [...Array(this.road.laneCount).keys()];
      const blocked = this.rng() < 0.55 ? 1 : this.road.laneCount - 1;
      for (let i = 0; i < blocked; i++) {
        const lane = lanes.splice(Math.floor(this.rng() * lanes.length), 1)[0];
        const jitter = (this.rng() - 0.5) * 60;
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
