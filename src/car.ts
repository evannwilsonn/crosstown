import { Controls, type ControlType } from "./controls";
import { NeuralNetwork } from "./network";
import { Sensor } from "./sensor";
import { polysIntersect, type Point } from "./utils";

const STALL_FRAMES = 240; // a car that stops making progress for ~4s is retired

export class Car {
  speed = 0;
  angle = 0;
  damaged = false;
  /** Body color for traffic; the course gives each traffic car a random hue. */
  color?: string;
  polygon: Point[] = [];
  controls: Controls;
  sensor?: Sensor;
  brain?: NeuralNetwork;

  /** Best fitness reached: forward distance on the highway, distance from spawn in an open world. */
  progress = 0;
  /**
   * "forward" scores how far up the highway a car got (course phase 1).
   * "odometer" adds up distance driven, as the course does in the virtual world.
   */
  fitness: "forward" | "odometer" = "forward";
  private odometer = 0;
  private readonly startY: number;
  private framesSinceProgress = 0;

  constructor(
    public x: number,
    public y: number,
    public width: number,
    public height: number,
    public type: ControlType,
    public maxSpeed = 3,
    private acceleration = 0.2,
    private friction = 0.05,
  ) {
    this.startY = y;
    this.controls = new Controls(type);
    if (type !== "DUMMY") this.sensor = new Sensor(this);
    if (type === "AI") this.brain = new NeuralNetwork([this.sensor!.rayCount, 6, 4]);
    this.polygon = this.createPolygon();
  }

  update(borders: Point[][], traffic: Car[]): void {
    if (!this.damaged) {
      this.move();
      this.polygon = this.createPolygon();
      this.damaged = this.assessDamage(borders, traffic);
      this.trackProgress();
    }
    if (this.sensor) {
      this.sensor.update(borders, traffic);
      // The course keeps thinking after a crash, so the network view stays live.
      if (this.brain) {
        const [forward, left, right, reverse] = NeuralNetwork.feedForward(this.sensor.inputs(), this.brain);
        this.controls.forward = forward === 1;
        this.controls.left = left === 1;
        this.controls.right = right === 1;
        this.controls.reverse = reverse === 1;
      }
    }
  }

  private trackProgress(): void {
    if (this.type === "DUMMY") return;
    this.odometer += this.speed;
    const distance = this.fitness === "forward" ? this.startY - this.y : this.odometer;
    if (distance > this.progress + 1) {
      this.progress = distance;
      this.framesSinceProgress = 0;
    } else if (this.type === "AI" && ++this.framesSinceProgress > STALL_FRAMES) {
      this.damaged = true;
    }
  }

  private assessDamage(borders: Point[][], traffic: Car[]): boolean {
    for (const b of borders) if (polysIntersect(this.polygon, b)) return true;
    for (const car of traffic) if (polysIntersect(this.polygon, car.polygon)) return true;
    return false;
  }

  private createPolygon(): Point[] {
    const rad = Math.hypot(this.width, this.height) / 2;
    const alpha = Math.atan2(this.width, this.height);
    const corner = (a: number) => ({ x: this.x - Math.sin(a) * rad, y: this.y - Math.cos(a) * rad });
    return [
      corner(this.angle - alpha),
      corner(this.angle + alpha),
      corner(Math.PI + this.angle - alpha),
      corner(Math.PI + this.angle + alpha),
    ];
  }

  private move(): void {
    const c = this.controls;
    if (c.forward) this.speed += this.acceleration;
    if (c.reverse) this.speed -= this.acceleration;
    this.speed = Math.max(-this.maxSpeed / 2, Math.min(this.maxSpeed, this.speed));
    if (this.speed > 0) this.speed -= this.friction;
    if (this.speed < 0) this.speed += this.friction;
    if (Math.abs(this.speed) < this.friction) this.speed = 0;

    if (this.speed !== 0) {
      const flip = this.speed > 0 ? 1 : -1;
      if (c.left) this.angle += 0.03 * flip;
      if (c.right) this.angle -= 0.03 * flip;
    }
    this.x -= Math.sin(this.angle) * this.speed;
    this.y -= Math.cos(this.angle) * this.speed;
  }

  /** Car body with a windshield so heading reads at a glance (the course uses a car sprite). */
  draw(ctx: CanvasRenderingContext2D, fill: string, sensorColor?: string): void {
    if (this.sensor && sensorColor) drawSensor(ctx, this.sensor, sensorColor);
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(-this.angle);
    const w = this.width;
    const h = this.height;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, w * 0.28);
    ctx.fill();
    ctx.fillStyle = "rgba(20, 24, 26, 0.55)";
    ctx.beginPath();
    ctx.roundRect(-w / 2 + 4, -h / 2 + h * 0.2, w - 8, h * 0.2, 3);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(-w / 2 + 5, h / 2 - h * 0.24, w - 10, h * 0.12, 3);
    ctx.fill();
    ctx.restore();
  }

  dispose(): void {
    this.controls.dispose();
  }
}

function drawSensor(ctx: CanvasRenderingContext2D, sensor: Sensor, color: string): void {
  ctx.lineWidth = 1.5;
  sensor.rays.forEach(([start, end], i) => {
    const hit = sensor.readings[i] ?? end;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(hit.x, hit.y);
    ctx.stroke();
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    ctx.moveTo(hit.x, hit.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    if (sensor.readings[i]) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(hit.x, hit.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  ctx.globalAlpha = 1;
}
