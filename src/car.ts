import { Controls, type ControlType } from "./controls";
import { NeuralNetwork } from "./network";
import { Sensor } from "./sensor";
import { polysIntersect, type Point } from "./utils";

const STALL_FRAMES = 240; // a car that stops making progress for ~4s is retired

export class Car {
  speed = 0;
  angle = 0;
  damaged = false;
  polygon: Point[] = [];
  controls: Controls;
  sensor?: Sensor;
  brain?: NeuralNetwork;

  /** Furthest forward distance reached, used as fitness. */
  progress = 0;
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
      if (this.brain && !this.damaged) {
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
    const distance = this.startY - this.y;
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

  draw(ctx: CanvasRenderingContext2D, fill: string, sensorColor?: string): void {
    if (this.sensor && sensorColor) drawSensor(ctx, this.sensor, sensorColor);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(this.polygon[0].x, this.polygon[0].y);
    for (let i = 1; i < this.polygon.length; i++) ctx.lineTo(this.polygon[i].x, this.polygon[i].y);
    ctx.closePath();
    ctx.fill();
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
