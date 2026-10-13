import type { Car } from "../car";
import { hash2 } from "./items";
import { Crossing, type Marking } from "./markings";
import type { Point } from "./geom";
import type { TimeOfDay, WorldThemeName } from "./worldThemes";

/**
 * Hazards change how the cars drive, not just how the town looks. Each town brings one of its
 * own, introduced on a level by itself before it joins the town's last level:
 *
 * - pedestrians cross at crosswalks; hitting one is a crash,
 * - fog and sandstorms shorten what every sensor can see,
 * - rain and ice take away grip, so cars slide and need longer to stop,
 * - and dusk and night (whole towns) shorten the side sensors, except under street lamps.
 *
 * Wet and icy roads also show on one of the brain's inputs, the way a driver sees rain on the
 * windshield: it says the road is slippery, and evolution has to work out what to do about it.
 */
export type Hazard = "pedestrians" | "sandstorm" | "ice" | "fog" | "rain" | "traffic";

export const THEME_HAZARD: Record<WorldThemeName, Hazard> = {
  downtown: "pedestrians",
  desert: "sandstorm",
  snowy: "ice",
  coastal: "fog",
  autumn: "rain",
};

export const HAZARD_NAMES: Record<Hazard, string> = {
  pedestrians: "Pedestrians at the crosswalks",
  sandstorm: "Sandstorm",
  ice: "Black ice",
  fog: "Sea fog",
  rain: "Rain on the roads",
  traffic: "Night traffic",
};

export const HAZARD_HINTS: Record<Hazard, string> = {
  pedestrians: "people walk across the crosswalks, and hitting one is a crash, so cars have to slow down or wait",
  sandstorm: "blowing sand cuts every sensor to under half its reach",
  ice: "falling snow cuts how far the sensors see, the snow makes the roads slippery, and patches of black ice give almost no grip",
  fog: "thick fog cuts every sensor to under half its reach",
  rain: "wet roads give less grip, so fast turns slide wide and stopping takes longer",
  traffic: "other cars drive the streets, stop at red lights and queue at junctions; hitting one is a crash",
};

/**
 * The hazards a town brings. The first round of towns (day) and the second (dusk) each bring
 * their own theme's hazard; dusk towns are also dark on every level. Night towns introduce
 * traffic on its own, then stack it with the theme's hazard. After that, every town has both.
 */
export function townHazards(theme: WorldThemeName, map: number): { alone: Hazard[]; stacked: Hazard[] } {
  const own = THEME_HAZARD[theme];
  const round = Math.floor((map - 1) / 5);
  if (round < 2) return { alone: [own], stacked: [own] };
  if (round === 2) return { alone: ["traffic"], stacked: [own, "traffic"] };
  return { alone: [own, "traffic"], stacked: [own, "traffic"] };
}

/** What closes a road on detour levels: construction, or the weather. */
export type ClosureStyle = "construction" | "snow" | "flood" | "sand";
export const CLOSURE_STYLE: Record<WorldThemeName, ClosureStyle> = {
  downtown: "construction",
  desert: "sand",
  snowy: "snow",
  coastal: "flood",
  autumn: "flood",
};

/** Road condition, as the brain's input sees it: 0 dry, 0.5 wet, 1 icy. */
export function roadCondition(hazards: readonly Hazard[]): number {
  if (hazards.includes("ice")) return 1;
  if (hazards.includes("rain")) return 0.5;
  return 0;
}

/** Extra time a trip is allowed, as a factor, for slower driving in bad conditions. */
export function hazardTimeFactor(hazards: readonly Hazard[], light: TimeOfDay): number {
  let f = 1;
  if (hazards.includes("rain")) f *= 1.15;
  if (hazards.includes("ice")) f *= 1.3;
  if (hazards.includes("fog") || hazards.includes("sandstorm")) f *= 1.15;
  if (hazards.includes("traffic")) f *= 1.2;
  if (light === "dusk") f *= 1.05;
  if (light === "night") f *= 1.1;
  return f;
}

/** Frames allowed for waiting at each crosswalk on the route when pedestrians are about. */
export const CROSSWALK_WAIT_FRAMES = 120;

/* Sight */

const LAMP_RADIUS = 170;
/** Rays within this angle of straight ahead are in the headlights. */
const HEADLIGHT_HALF_ANGLE = 0.5;

/**
 * How much of each ray can see. Fog and sandstorms shorten every ray, headlights included. At
 * dusk and night the headlights still reach full length, the side rays fall short, and near a
 * street lamp (every junction) everything is lit again.
 */
export function visibility(
  car: Car,
  rayAngles: readonly number[],
  hazards: readonly Hazard[],
  light: TimeOfDay,
  lamps: readonly Point[],
): number[] | null {
  // Falling snow on icy levels hides less than fog, but still hides.
  const haze = hazards.includes("fog") ? 0.42 : hazards.includes("sandstorm") ? 0.45 : hazards.includes("ice") ? 0.7 : 1;
  if (light === "day" && haze === 1) return null;
  const side = light === "night" ? 0.4 : light === "dusk" ? 0.7 : 1;
  const lit = side < 1 && lamps.some((p) => Math.abs(p.x - car.x) < LAMP_RADIUS && Math.abs(p.y - car.y) < LAMP_RADIUS && Math.hypot(p.x - car.x, p.y - car.y) < LAMP_RADIUS);
  return rayAngles.map((a) => {
    const dark = lit || Math.abs(a) <= HEADLIGHT_HALF_ANGLE ? 1 : side;
    return Math.min(dark, haze);
  });
}

/* Pedestrians */

const WALK_SPEED = 0.55;
const SIZE = 11;

/**
 * Someone crossing at a crosswalk: they wait at the curb, walk across, wait, and walk back, on
 * the simulation's clock, so every car in a generation meets them at the same moments.
 */
export class Pedestrian {
  polygon: Point[] = [];
  x = 0;
  y = 0;
  /** -1 or 1: which way they face across the road. */
  facing = 1;
  walking = false;
  readonly color: string;
  private from: Point;
  private to: Point;
  private cycle: number;
  private waitA: number;
  private waitB: number;
  private walk: number;
  private phase: number;

  constructor(crossing: Marking, roadWidth: number, lane: number, seed: number) {
    const along = crossing.direction;
    const across = { x: -along.y, y: along.x };
    const half = roadWidth / 2 + 14;
    const off = lane * 14;
    const c = crossing.center;
    this.from = { x: c.x + along.x * off - across.x * half, y: c.y + along.y * off - across.y * half };
    this.to = { x: c.x + along.x * off + across.x * half, y: c.y + along.y * off + across.y * half };
    const h = (k: number) => hash2(c.x + lane * 31, c.y + seed, k);
    this.walk = Math.round((half * 2) / (WALK_SPEED * (0.8 + h(1) * 0.4)));
    this.waitA = Math.round(90 + h(2) * 240);
    this.waitB = Math.round(90 + h(3) * 240);
    this.cycle = this.waitA + this.walk + this.waitB + this.walk;
    this.phase = Math.floor(h(4) * this.cycle);
    this.color = ["#e5483b", "#3b7bd6", "#f6c21b", "#3fc27a", "#b36bff", "#f3f3ee"][Math.floor(h(5) * 6)];
    this.update(0);
  }

  update(clock: number): void {
    let t = (clock + this.phase) % this.cycle;
    let p: Point;
    if (t < this.waitA) {
      p = this.from;
      this.walking = false;
      this.facing = 1;
    } else if ((t -= this.waitA) < this.walk) {
      p = lerp(this.from, this.to, t / this.walk);
      this.walking = true;
      this.facing = 1;
    } else if ((t -= this.walk) < this.waitB) {
      p = this.to;
      this.walking = false;
      this.facing = -1;
    } else {
      t -= this.waitB;
      p = lerp(this.to, this.from, t / this.walk);
      this.walking = true;
      this.facing = -1;
    }
    this.x = p.x;
    this.y = p.y;
    this.polygon = [
      { x: p.x - SIZE, y: p.y },
      { x: p.x, y: p.y - SIZE },
      { x: p.x + SIZE, y: p.y },
      { x: p.x, y: p.y + SIZE },
    ];
  }

  draw(ctx: CanvasRenderingContext2D, clock: number): void {
    // Seen from above: shoulders, a head, and legs that swing while walking.
    const swing = this.walking ? Math.sin(clock * 0.25) * 4 : 0;
    const dir = { x: this.to.x - this.from.x, y: this.to.y - this.from.y };
    const len = Math.hypot(dir.x, dir.y) || 1;
    const fx = (dir.x / len) * this.facing;
    const fy = (dir.y / len) * this.facing;
    ctx.save();
    // Drawn a little larger than life so they read at town zoom.
    ctx.translate(this.x, this.y);
    ctx.scale(1.5, 1.5);
    ctx.translate(-this.x, -this.y);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath();
    ctx.ellipse(this.x + 3, this.y + 3, 9, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#2b2e30";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(this.x - fy * 3 * s, this.y + fx * 3 * s);
      ctx.lineTo(this.x - fy * 3 * s + fx * swing * s, this.y + fx * 3 * s + fy * swing * s);
      ctx.stroke();
    }
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(this.x, this.y, 8, 5, Math.atan2(fy, fx) + Math.PI / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#8a5a3c";
    ctx.beginPath();
    ctx.arc(this.x, this.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Two people on every crosswalk, one in each lane's half. */
export function pedestriansFor(markings: readonly Marking[], roadWidth: number, seed: number): Pedestrian[] {
  return markings.filter((m) => m instanceof Crossing).flatMap((m) => [new Pedestrian(m, roadWidth, -1, seed), new Pedestrian(m, roadWidth, 1, seed)]);
}

/* Ice */

/** A patch of black ice across the road, as a stretch of a street. */
export interface IcePatch {
  a: Point;
  b: Point;
  halfWidth: number;
}

export function onIce(p: Point, patches: readonly IcePatch[]): boolean {
  return patches.some(({ a, b, halfWidth }) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)) < halfWidth;
  });
}

/** Grip on a snowy road, and on a patch of ice. */
export const SNOW_GRIP = 0.55;
export const ICE_GRIP = 0.12;
export const RAIN_GRIP = 0.4;

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
