import { getIntersection, lerp, type Point, type Touch } from "./utils";
import type { Car } from "./car";

export class Sensor {
  rays: [Point, Point][] = [];
  readings: (Touch | null)[] = [];

  constructor(
    private car: Car,
    public rayCount = 5,
    public rayLength = 150,
    public raySpread = Math.PI / 2,
  ) {}

  update(borders: Point[][], traffic: Car[]): void {
    this.castRays();
    this.readings = this.rays.map((ray) => this.getReading(ray, borders, traffic));
  }

  /** Inputs for the network: 0 when nothing is seen, rising toward 1 as an obstacle gets closer. */
  inputs(): number[] {
    return this.readings.map((r) => (r ? 1 - r.offset : 0));
  }

  private getReading(ray: [Point, Point], borders: Point[][], traffic: Car[]): Touch | null {
    let nearest: Touch | null = null;
    const consider = (t: Touch | null) => {
      if (t && (!nearest || t.offset < nearest.offset)) nearest = t;
    };
    for (const b of borders) consider(getIntersection(ray[0], ray[1], b[0], b[1]));
    for (const car of traffic) {
      const p = car.polygon;
      for (let j = 0; j < p.length; j++) {
        consider(getIntersection(ray[0], ray[1], p[j], p[(j + 1) % p.length]));
      }
    }
    return nearest;
  }

  private castRays(): void {
    this.rays = [];
    for (let i = 0; i < this.rayCount; i++) {
      const t = this.rayCount === 1 ? 0.5 : i / (this.rayCount - 1);
      const angle = lerp(this.raySpread / 2, -this.raySpread / 2, t) + this.car.angle;
      const start = { x: this.car.x, y: this.car.y };
      const end = {
        x: this.car.x - Math.sin(angle) * this.rayLength,
        y: this.car.y - Math.cos(angle) * this.rayLength,
      };
      this.rays.push([start, end]);
    }
  }
}
