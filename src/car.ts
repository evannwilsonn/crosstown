import { Controls, type ControlType } from "./controls";
import { Genome } from "./neat";
import { NeuralNetwork } from "./network";
import { Sensor } from "./sensor";
import { polysIntersect, type Point } from "./utils";

/** Anything a car can hit and its sensors can see: other cars, pedestrians. */
export interface Obstacle {
  polygon: Point[];
}

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
  /** A fixed-shape network (the course's, used in the world) or a NEAT genome that grows (the highway). */
  brain?: NeuralNetwork | Genome;

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
  /** Frames since this car last made progress: a car stopped in place counts up. */
  get idleFrames(): number {
    return this.framesSinceProgress;
  }

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

  /** Frames an AI car may go without progress before it is retired. The world raises it so cars can wait at lights. */
  stallFrames = STALL_FRAMES;
  /**
   * How well the tyres hold the road, 1 on a dry road. Below 1 the car keeps sliding the way it
   * was going before it turned, takes longer to brake, and spins up more slowly: rain, then ice.
   */
  grip = 1;
  /** The direction the car is actually moving; it lags the heading when grip is low. */
  private travel: number | null = null;

  /** `extra` feeds the brain inputs beyond the rays (the world's GPS direction). */
  update(borders: Point[][], traffic: Obstacle[], extra: number[] = []): void {
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
        const inputs = extra.length ? this.sensor.inputs().concat(extra) : this.sensor.inputs();
        const [forward, left, right, reverse] =
          this.brain instanceof Genome ? this.brain.activate(inputs) : NeuralNetwork.feedForward(inputs, this.brain);
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
    } else if (this.type === "AI" && ++this.framesSinceProgress > this.stallFrames) {
      this.damaged = true;
    }
  }

  private assessDamage(borders: Point[][], traffic: Obstacle[]): boolean {
    for (const b of borders) if (polysIntersect(this.polygon, b)) return true;
    for (const car of traffic) if (polysIntersect(this.polygon, car.polygon)) return true;
    return false;
  }

  /** Moves the car directly (traffic that follows its lane along a curve). */
  place(x: number, y: number, angle: number): void {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.polygon = this.createPolygon();
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
    const grip = this.grip;
    // On a slippery road the wheels spin and the brakes lock: less push either way, and the car
    // coasts further when nothing is pressed.
    const push = grip >= 1 ? this.acceleration : this.acceleration * (0.35 + 0.65 * grip);
    const drag = grip >= 1 ? this.friction : this.friction * (0.4 + 0.6 * grip);
    if (c.forward) this.speed += push;
    if (c.reverse) this.speed -= push;
    this.speed = Math.max(-this.maxSpeed / 2, Math.min(this.maxSpeed, this.speed));
    if (this.speed > 0) this.speed -= drag;
    if (this.speed < 0) this.speed += drag;
    if (Math.abs(this.speed) < drag) this.speed = 0;

    if (this.speed !== 0) {
      const flip = this.speed > 0 ? 1 : -1;
      if (c.left) this.angle += 0.03 * flip;
      if (c.right) this.angle -= 0.03 * flip;
    }
    // With full grip the car goes where it points (the course's model). With less, the direction
    // of travel only catches up with the heading gradually, so fast turns slide wide.
    if (grip >= 1 || this.travel === null) this.travel = this.angle;
    else this.travel += Math.atan2(Math.sin(this.angle - this.travel), Math.cos(this.angle - this.travel)) * Math.min(1, grip * 0.6);
    this.x -= Math.sin(this.travel) * this.speed;
    this.y -= Math.cos(this.travel) * this.speed;
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
  sensor.rays.forEach(([start, full], i) => {
    // In the dark or fog only part of each ray can see; draw just that part.
    const seen = sensor.visibility?.[i] ?? 1;
    const end = { x: start.x + (full.x - start.x) * seen, y: start.y + (full.y - start.y) * seen };
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
