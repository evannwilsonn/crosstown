import { Car } from "../car";
import { NeuralNetwork } from "../network";
import type { Parent } from "../simulation";
import { dot, normalize, subtract, type Point } from "./geom";
import { Light, Stop, type Marking } from "./markings";
import { planRoute, type Route } from "./route";
import type { World } from "./world";

export type WorldDriveMode = "off" | "AI" | "KEYS";

/** Extra brain inputs: speed, the bend coming up, a stop sign ahead, a red or yellow light ahead. */
export const WORLD_EXTRAS = 4;
export const WORLD_HIDDEN = 8;
export const WORLD_COUNTS = [5 + WORLD_EXTRAS, WORLD_HIDDEN, 4];

/** A car that makes no headway for this long is retired. Longer than a full red at a four-way light. */
const STALL_FRAMES = 660;
const LEADER_PATIENCE = 660;
const GENERATION_FRAMES = 60 * 60;
const SENSOR_REACH = 220;
/** How far ahead the brain is told about stop signs and lights, in px. */
const NOTICE = 200;
/** A car counts as stopped below this speed. */
const STOPPED = 0.3;
/** Drifting this far from the lane center (as a share of road width) means the car left its lane. */
const LANE_LIMIT = 0.35;
/** How hard lane following pulls back toward the lane center. */
const STANLEY_GAIN = 0.15;

function near(o: Point[], car: Car): boolean {
  const [a, b] = o;
  return (
    car.x > Math.min(a.x, b.x) - SENSOR_REACH &&
    car.x < Math.max(a.x, b.x) + SENSOR_REACH &&
    car.y > Math.min(a.y, b.y) - SENSOR_REACH &&
    car.y < Math.max(a.y, b.y) + SENSOR_REACH
  );
}

/** Where a stop sign or light sits along the route. */
interface RouteSign {
  along: number;
  marking: Marking;
}

interface Progress {
  hint: number;
  along: number;
  best: number;
  idle: number;
  /** Stop signs this car came to a full stop at. */
  stopped: Set<Marking>;
  arrivedAt?: number;
  /** Why the car was taken off the road, when a rule did it. */
  violation?: "ran a stop sign" | "left its lane";
}

/**
 * Spawns cars at the world's start marking and evolves them like the highway trainer
 * (course: Integration). Each car follows a planned route in the right-hand lane: lane
 * following steers, and the brain decides when to go, slow and stop. Rules of the road are
 * enforced: red and yellow lights are walls, a car that rolls through a stop sign or drifts out
 * of its lane is taken off the road. Fitness is how far along the route a car got, and arriving
 * earns a bonus for every frame to spare.
 */
export class WorldSim {
  cars: Car[] = [];
  leader: Car | null = null;
  route: Route | null = null;
  generation = 1;
  mode: WorldDriveMode = "off";
  population = 100;
  mutation = 0.15;
  /** Frames since driving began; drives the traffic lights so they run at simulation speed. */
  clock = 0;
  /** Outcome of the last generation, for the status line. */
  lastArrived = false;
  /** Every car's final score in the generation that just ended. */
  results: { car: Car; score: number; arrived: boolean }[] = [];
  /** Rule breaks this generation, by kind. */
  violations = { stop: 0, lane: 0 };
  private leaderBest = 0;
  private framesSinceGain = 0;
  private frames = 0;
  private progress = new Map<Car, Progress>();
  private stops: RouteSign[] = [];
  private lights: RouteSign[] = [];

  constructor(private world: () => World, public parent: Parent | null) {}

  get start(): Marking | undefined {
    return this.world().markings.find((m) => m.type === "start");
  }

  get target(): Marking | undefined {
    return this.world().markings.find((m) => m.type === "target");
  }

  get alive(): number {
    return this.cars.filter((c) => !c.damaged && this.progress.get(c)?.arrivedAt === undefined).length;
  }

  /** Fitness: px along the route, plus a bonus for each frame to spare on arrival. */
  score(car: Car): number {
    const p = this.progress.get(car);
    if (!p) return 0;
    return p.arrivedAt === undefined ? p.best : p.best + (GENERATION_FRAMES - p.arrivedAt);
  }

  /** How far along the route a car is right now, in px. */
  along(car: Car): number {
    return this.progress.get(car)?.along ?? 0;
  }

  /** Returns false when the world has no start marking or no road to drive. */
  begin(mode: Exclude<WorldDriveMode, "off">): boolean {
    if (!this.start) return false;
    this.mode = mode;
    this.planRoute();
    // Scores from another map or route don't compare: keep the brain, rescore it on this route.
    if (this.parent) this.parent = { ...this.parent, progress: 0, arrivedIn: undefined };
    if (!this.route) {
      this.mode = "off";
      return false;
    }
    this.spawn();
    return true;
  }

  stop(): void {
    this.cars.forEach((c) => c.dispose());
    this.cars = [];
    this.leader = null;
    this.route = null;
    this.mode = "off";
  }

  /** Plans the route and finds the stop signs and lights that sit on it. */
  private planRoute(): void {
    const w = this.world();
    const start = this.start!;
    this.route = planRoute(w.graph, start.center, start.direction, this.target?.center ?? null, w.settings.roadWidth);
    this.stops = [];
    this.lights = [];
    const route = this.route;
    if (!route) return;
    for (const m of w.markings) {
      if (!(m instanceof Stop) && !(m instanceof Light)) continue;
      const hit = this.locate(route, m.center);
      if (!hit) continue;
      // Only signs facing the way the route drives apply.
      const tangent = normalize(subtract(route.pointAt(hit.along + 5), route.pointAt(hit.along - 5)));
      if (dot(tangent, m.direction) < 0.7) continue;
      (m instanceof Stop ? this.stops : this.lights).push({ along: hit.along, marking: m });
    }
    this.stops.sort((a, b) => a.along - b.along);
    this.lights.sort((a, b) => a.along - b.along);
  }

  /** Projects a point onto the whole route; null when it is off the route's lane. */
  private locate(route: Route, p: Point): { along: number } | null {
    let best: { along: number; offset: number } | null = null;
    for (let i = 0; i < route.points.length - 1; i += 6) {
      const hit = route.project(p, i + 2);
      if (!best || hit.offset < best.offset) best = hit;
    }
    return best && best.offset < 15 ? best : null;
  }

  private spawn(): void {
    this.cars.forEach((c) => c.dispose());
    const start = this.start!;
    const heading = Math.atan2(-start.direction.x, -start.direction.y);
    const make = (type: "AI" | "KEYS") => {
      const car = new Car(start.center.x, start.center.y, 30, 50, type, 3, 0.2, 0.05, WORLD_EXTRAS, WORLD_HIDDEN);
      car.angle = heading;
      car.fitness = "odometer";
      car.stallFrames = Infinity; // the sim retires stalled cars itself, after waiting out a red light
      if (type === "AI") car.assist = (c) => this.steer(c);
      return car;
    };
    if (this.mode === "KEYS") {
      this.cars = [make("KEYS")];
    } else {
      this.cars = Array.from({ length: this.population }, (_, i) => {
        const car = make("AI");
        if (this.parent) {
          car.brain = NeuralNetwork.fromJSON(this.parent.brain);
          // Car 0 keeps the parent's brain unchanged so a generation never does worse than the last.
          if (i > 0) NeuralNetwork.mutate(car.brain, this.mutation);
        }
        return car;
      });
    }
    this.progress = new Map(this.cars.map((c) => [c, { hint: 0, along: 0, best: 0, idle: 0, stopped: new Set() }]));
    this.leader = this.cars[0];
    this.leaderBest = 0;
    this.framesSinceGain = 0;
    this.frames = 0;
    this.violations = { stop: 0, lane: 0 };
  }

  /**
   * Lane following (a Stanley controller, as on autonomous-driving test cars): hold the lane's
   * heading, plus a correction toward the lane center that grows with the sideways error and
   * shrinks with speed. Unlike aiming at a point ahead, it doesn't cut corners into the kerb.
   */
  private steer(car: Car): number {
    const route = this.route;
    const p = this.progress.get(car);
    if (!route || !p) return car.angle;
    const t = route.tangent(p.along + car.speed * 6);
    const q = route.pointAt(p.along);
    // Positive when the car sits right of the lane center (screen coordinates).
    const error = (car.x - q.x) * -t.y + (car.y - q.y) * t.x;
    return Math.atan2(-t.x, -t.y) + Math.atan((STANLEY_GAIN * error) / (Math.abs(car.speed) + 0.5));
  }

  /** The brain's extra inputs: speed, bend ahead, stop sign ahead, red or yellow light ahead. */
  inputs(car: Car): number[] {
    const route = this.route;
    const p = this.progress.get(car);
    if (!route || !p) return [0, 0, 0, 0];
    const bend = Math.max(-1, Math.min(1, route.turnAhead(p.along + 20, 120) / (Math.PI / 2)));
    const ahead = (signs: RouteSign[], applies: (s: RouteSign) => boolean) => {
      // Ignore a sign once the car's nose is past its line: it has committed.
      const next = signs.find((s) => this.gap(car, s) > -10 && applies(s));
      const gap = next ? this.gap(car, next) : Infinity;
      return gap < NOTICE ? 1 - Math.max(0, gap) / NOTICE : 0;
    };
    const stop = ahead(this.stops, (s) => !p.stopped.has(s.marking));
    const light = ahead(this.lights, (s) => {
      const state = (s.marking as Light).state;
      return state === "red" || state === "yellow";
    });
    return [car.speed / car.maxSpeed, bend, stop, light];
  }

  /** Distance from the car's nose to a sign's stop line, along the route (negative once past it). */
  private gap(car: Car, s: RouteSign): number {
    return s.along + s.marking.height / 2 - (this.along(car) + car.height / 2);
  }

  /** Advances one frame. Returns true when a generation just ended. */
  step(): boolean {
    if (this.mode === "off" || this.cars.length === 0 || !this.route) return false;
    this.frames++;
    this.clock++;
    const world = this.world();
    world.updateLights(this.clock / 60);
    const obstacles = world.obstacles();
    const route = this.route;
    const laneLimit = world.settings.roadWidth * LANE_LIMIT;

    for (const car of this.cars) {
      const p = this.progress.get(car)!;
      if (p.arrivedAt !== undefined) continue;
      if (car.damaged && car.type === "AI") continue;
      car.update(obstacles.filter((o) => near(o, car)), [], this.inputs(car));

      const hit = route.project(car, p.hint);
      p.hint = hit.index;
      p.along = hit.along;
      if (p.along > p.best + 0.5) {
        p.best = p.along;
        p.idle = 0;
      } else if (car.type === "AI" && ++p.idle > STALL_FRAMES) {
        car.damaged = true;
      }
      if (car.type !== "AI" || car.damaged) continue;

      // Rules of the road.
      for (const s of this.stops) {
        const gap = this.gap(car, s);
        // A full stop counts anywhere from a car length back to the line itself.
        if (car.speed < STOPPED && gap > -10 && gap < 60) p.stopped.add(s.marking);
        if (gap < -car.height && gap > -car.height - 80 && !p.stopped.has(s.marking)) {
          car.damaged = true;
          p.violation = "ran a stop sign";
          this.violations.stop++;
          break;
        }
      }
      if (!car.damaged && hit.offset > laneLimit) {
        car.damaged = true;
        p.violation = "left its lane";
        this.violations.lane++;
      }
      if (!car.damaged && route.arrives && route.length - p.along < 20) {
        p.arrivedAt = this.frames;
        car.speed = 0;
      }
    }

    this.leader = this.cars.reduce((a, b) => (this.score(b) > this.score(a) ? b : a));
    if (this.mode === "KEYS") return false;

    if (this.score(this.leader) > this.leaderBest + 1) {
      this.leaderBest = this.score(this.leader);
      this.framesSinceGain = 0;
    } else {
      this.framesSinceGain++;
    }
    const arrived = this.progress.get(this.leader)?.arrivedAt !== undefined;
    if (arrived || this.alive === 0 || this.framesSinceGain > LEADER_PATIENCE || this.frames > GENERATION_FRAMES) {
      this.lastArrived = arrived;
      this.nextGeneration();
      return true;
    }
    return false;
  }

  /** Seconds the leader took to arrive, if it did. */
  arrivalSeconds(car: Car | null): number | null {
    const at = car ? this.progress.get(car)?.arrivedAt : undefined;
    return at === undefined ? null : at / 60;
  }

  violation(car: Car | null): string | undefined {
    return car ? this.progress.get(car)?.violation : undefined;
  }

  nextGeneration(): void {
    this.results = this.cars.map((car) => ({ car, score: this.score(car), arrived: this.arrivalSeconds(car) !== null }));
    const best = this.leader;
    // Light phases differ from run to run, so scores are noisy: the parent is always this run's
    // best. Car 0 drives the parent's brain unchanged, so a good brain keeps its place on merit.
    if (best?.brain) {
      const secs = this.arrivalSeconds(best);
      this.parent = { brain: best.brain.toJSON(), progress: this.score(best), arrivedIn: secs ?? undefined };
    }
    this.generation++;
    this.spawn();
  }

  /** Breeds from this brain from now on, restarting the count. */
  adopt(parent: Parent): void {
    this.parent = parent;
    this.generation = 1;
    if (this.mode === "AI") this.spawn();
  }

  forget(): void {
    this.parent = null;
    this.generation = 1;
    if (this.mode !== "off") this.spawn();
  }
}

