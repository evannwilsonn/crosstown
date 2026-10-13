import { add, angle, Envelope, Polygon, rightOf, scale, Segment, translate, type Point } from "./geom";

export type MarkingType = "stop" | "yield" | "crossing" | "parking" | "light" | "start" | "target";

export interface MarkingJSON {
  type: MarkingType;
  center: Point;
  direction: Point;
}

export interface Paint {
  white: string;
  yellow: string;
  orange: string;
  red: string;
  green: string;
  asphalt: string;
}

/**
 * A marking sits on a lane, oriented with its direction of travel.
 * In its local frame, -y points the way cars drive, so text reads upright for the driver.
 */
export abstract class Marking {
  abstract readonly type: MarkingType;
  poly: Polygon;

  constructor(public center: Point, public direction: Point, public width: number, public height: number) {
    const support = new Segment(
      translate(center, angle(direction), height / 2),
      translate(center, angle(direction), -height / 2),
    );
    this.poly = new Envelope(support, width, 0).poly;
  }

  /** The line across the lane at the marking's far edge, the one a car reaches last. */
  frontLine(): Segment {
    const ahead = add(this.center, scale(this.direction, this.height / 2));
    const r = scale(rightOf(this.direction), this.width / 2);
    return new Segment(add(ahead, r), add(ahead, scale(r, -1)));
  }

  protected local(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.translate(this.center.x, this.center.y);
    ctx.rotate(angle(this.direction) + Math.PI / 2);
  }

  abstract draw(ctx: CanvasRenderingContext2D, paint: Paint): void;

  toJSON(): MarkingJSON {
    return { type: this.type, center: { ...this.center }, direction: { ...this.direction } };
  }
}

/** Road text, stretched 3x along the lane as in the course so it reads at a shallow angle. */
function roadText(ctx: CanvasRenderingContext2D, label: string, size: number, color: string): void {
  ctx.save();
  ctx.scale(1, 3);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `800 ${size}px Overpass, system-ui, sans-serif`;
  ctx.fillText(label, 0, 1);
  ctx.restore();
}

/** Stop line at the far edge plus STOP painted in the lane. */
export class Stop extends Marking {
  readonly type = "stop";
  draw(ctx: CanvasRenderingContext2D, paint: Paint): void {
    this.local(ctx);
    ctx.fillStyle = paint.white;
    ctx.fillRect(-this.width / 2, -this.height / 2 - 2.5, this.width, 5);
    roadText(ctx, "STOP", this.height * 0.3, paint.white);
    ctx.restore();
  }
}

export class Yield extends Marking {
  readonly type = "yield";
  draw(ctx: CanvasRenderingContext2D, paint: Paint): void {
    this.local(ctx);
    ctx.fillStyle = paint.white;
    ctx.fillRect(-this.width / 2, -this.height / 2 - 2.5, this.width, 5);
    roadText(ctx, "YIELD", this.height * 0.3, paint.white);
    ctx.restore();
  }
}

/** Zebra stripes across the whole road. */
export class Crossing extends Marking {
  readonly type = "crossing";
  draw(ctx: CanvasRenderingContext2D, paint: Paint): void {
    this.local(ctx);
    ctx.fillStyle = paint.white;
    for (let x = -this.width / 2; x < this.width / 2; x += 22) ctx.fillRect(x, -this.height / 2, 11, this.height);
    ctx.restore();
  }
}

export class Parking extends Marking {
  readonly type = "parking";
  draw(ctx: CanvasRenderingContext2D, paint: Paint): void {
    this.local(ctx);
    ctx.fillStyle = paint.white;
    ctx.fillRect(-this.width / 2 - 2.5, -this.height / 2, 5, this.height);
    ctx.fillRect(this.width / 2 - 2.5, -this.height / 2, 5, this.height);
    // The course draws the P rotated to read from the side of the road.
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = paint.white;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `800 ${this.height * 0.9}px Overpass, system-ui, sans-serif`;
    ctx.fillText("P", 0, 3);
    ctx.restore();
  }
}

/** Where cars spawn. Drawn as a car outline facing the lane's direction. */
export class Start extends Marking {
  readonly type = "start";
  draw(ctx: CanvasRenderingContext2D, paint: Paint): void {
    this.local(ctx);
    ctx.strokeStyle = paint.yellow;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(-15, -25, 30, 50, 7);
    ctx.stroke();
    ctx.fillStyle = paint.yellow;
    ctx.fillRect(-11, -16, 22, 9); // windshield marks the front
    ctx.restore();
  }
}

export class Target extends Marking {
  readonly type = "target";
  draw(ctx: CanvasRenderingContext2D, paint: Paint): void {
    [
      [paint.red, 15],
      [paint.white, 10],
      [paint.red, 5],
    ].forEach(([c, r]) => {
      ctx.beginPath();
      ctx.arc(this.center.x, this.center.y, r as number, 0, Math.PI * 2);
      ctx.fillStyle = c as string;
      ctx.fill();
    });
  }
}

export type LightState = "off" | "green" | "yellow" | "red";

/** A signal head across the lane. Its state is set by the world's intersection controller. */
export class Light extends Marking {
  readonly type = "light";
  state: LightState = "off";

  constructor(center: Point, direction: Point, width: number) {
    super(center, direction, width, 18);
  }

  draw(ctx: CanvasRenderingContext2D, paint: Paint): void {
    this.local(ctx);
    const r = this.height * 0.3;
    // Housing runs across the lane: green on the left, red on the right, as in the course.
    ctx.strokeStyle = paint.asphalt;
    ctx.lineWidth = this.height;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-this.width * 0.3, 0);
    ctx.lineTo(this.width * 0.3, 0);
    ctx.stroke();
    ctx.lineCap = "butt";
    const lamps: [Exclude<LightState, "off">, number, string][] = [
      ["green", -0.3, paint.green],
      ["yellow", 0, paint.yellow],
      ["red", 0.3, paint.red],
    ];
    for (const [s, t, c] of lamps) {
      ctx.beginPath();
      ctx.arc(this.width * t, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.globalAlpha = this.state === s ? 1 : 0.22;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

/** Builds a marking with the course's dimensions: one lane square, crossings span the road. */
export function createMarking(type: MarkingType, center: Point, direction: Point, roadWidth: number): Marking {
  const lane = roadWidth / 2;
  switch (type) {
    case "stop": return new Stop(center, direction, lane, lane);
    case "yield": return new Yield(center, direction, lane, lane);
    case "crossing": return new Crossing(center, direction, roadWidth, lane);
    case "parking": return new Parking(center, direction, lane, lane);
    case "light": return new Light(center, direction, lane);
    case "start": return new Start(center, direction, lane, lane);
    case "target": return new Target(center, direction, lane, lane);
  }
}

export function markingFromJSON(m: MarkingJSON, roadWidth: number): Marking {
  return createMarking(m.type, m.center, m.direction, roadWidth);
}
