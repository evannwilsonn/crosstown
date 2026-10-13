import { Car } from "../car";
import { Sensor } from "../sensor";
import type { CurvePoint } from "../chart";
import { Genome, Neat, type NeatJSON } from "../neat";
import { mulberry32 } from "../utils";
import { add, distance, lerp2D, normalize, rightOf, scale, subtract, type Point } from "./geom";
import { Light, Stop, type Marking } from "./markings";
import { Navigator } from "./nav";
import type { World } from "./world";

export type WorldDriveMode = "off" | "AI" | "KEYS";

/**
 * The world's levels never run out. Level 1 is the course's challenge: stay on the road. Every
 * level after it is timed trips to random destinations: each trip has a time limit worked out
 * from its own route (the ideal time at top speed, plus time for each turn, stop sign and
 * traffic light), times a factor that shrinks level by level but never below what is drivable.
 * Trips get longer and later levels start from random spots too. Every three levels the map
 * changes; a new map starts a little easier, like a new road on the highway.
 */
export interface WorldLevel {
  number: number;
  name: string;
  /** Which map the level is on: a new one every LEVELS_PER_MAP levels. */
  map: number;
  /** "survive": still driving at the time limit. "every": arrive in time on every trip of a generation. */
  goal: "survive" | "every";
  /** Shortest trip by road, in px (shorter if the map is small). */
  minTrip: number;
  /** Time limit as a multiple of the trip's ideal time. */
  timeFactor: number;
  randomStart: boolean;
}

export const LEVELS_PER_MAP = 3;

/**
 * Training on a map the visitor drew or imported: one timed trip a generation from their Start
 * marking to their Target marking (or the farthest road, without one). There are no levels here,
 * and the page puts the level brains back when the visitor returns to the levels.
 */
export const CUSTOM_LEVEL: WorldLevel = {
  number: 0,
  name: "Your map",
  map: -1,
  goal: "every",
  minTrip: 0,
  timeFactor: 2,
  randomStart: false,
};
/** The tightest clock: 30% over the ideal time, plus the allowances, stays drivable. */
const MIN_TIME_FACTOR = 1.3;
const DISTANCE_NAMES = ["Around the block", "Short trips", "Across the neighborhood", "Across town", "Long trips", "Cross-town runs"];

export function worldLevelSpec(n: number): WorldLevel {
  const map = Math.floor((n - 1) / LEVELS_PER_MAP);
  if (n <= 1) return { number: 1, name: "Stay on the road for 45 s", map: 0, goal: "survive", minTrip: 0, timeFactor: 3, randomStart: false };
  const stage = (n - 1) % LEVELS_PER_MAP;
  const tier = Math.max(0, map + stage - 1);
  const timeFactor = Math.max(MIN_TIME_FACTOR, 2.4 - 0.1 * tier);
  const clock = timeFactor >= 2.1 ? "easy clock" : timeFactor >= 1.8 ? "on schedule" : timeFactor >= 1.5 ? "tight clock" : "rush";
  const where = DISTANCE_NAMES[Math.min(tier, DISTANCE_NAMES.length - 1)];
  const randomStart = tier >= 2;
  return {
    number: n,
    name: `${where}, ${clock}${randomStart ? ", any start" : ""}`,
    map,
    goal: "every",
    minTrip: 450 + 120 * tier,
    timeFactor,
    randomStart,
  };
}

/**
 * Every timed level scores each brain on this many random trips per generation. One random trip
 * is luck: a brain that happened to get an easy one would win. Several trips reward brains that
 * really follow directions.
 */
export const TRIPS_PER_GENERATION = 3;

/** Allowances added to a trip's ideal time, in frames. */
const TURN_FRAMES = 45;
const STOP_FRAMES = 80;
/** A light can be red for most of its cycle; allow a typical wait at each one. */
const LIGHT_FRAMES = 240;
const START_FRAMES = 60;

export interface WorldSummary extends CurvePoint {
  levelUp: boolean;
  /** Trips the best car reached in time, out of `trips`. */
  inTime: number;
  /** Seconds the best car took on the last trip, if it arrived. */
  arrivedIn: number | null;
  /** Trips the best car arrived on, out of `trips`. */
  arrivedTrips: number;
  trips: number;
  neurons: number;
  connections: number;
  species: number;
}

export interface WorldSaved {
  /** This session's seed: which towns the level maps generate. */
  seed?: number;
  neat: NeatJSON;
  level: number;
  generation: number;
  history?: WorldSummary[];
}

export const WORLD_RAYS = 7;
/** Seven rays across 180 degrees, the car's speed, and the GPS direction. */
export const WORLD_INPUTS = WORLD_RAYS + 2;
const OUTPUTS = 4;
const LEADER_PATIENCE = 600;
/** Level 1 is passed by a car still driving at the time limit. */
export const SURVIVE_FRAMES = 60 * 45;
/**
 * Level 1 also needs real ground covered: at least 300 m driven, and at least this far from
 * the start at some point, so a car circling in place can't clear it.
 */
export const SURVIVE_DISTANCE = 3000;
const SURVIVE_LEAVE_START = 400;
/** Within this distance of the destination counts as arrived. */
const ARRIVE_RADIUS = 40;
/** Cars may wait this long without progress, enough for a full red light. */
const CAR_STALL_FRAMES = 600;
const SENSOR_REACH = 220;

function near(o: Point[], car: Car): boolean {
  const [a, b] = o;
  return (
    car.x > Math.min(a.x, b.x) - SENSOR_REACH &&
    car.x < Math.max(a.x, b.x) + SENSOR_REACH &&
    car.y > Math.min(a.y, b.y) - SENSOR_REACH &&
    car.y < Math.max(a.y, b.y) + SENSOR_REACH
  );
}

interface Trip {
  /** Farthest this car has been from where it started, in a straight line. */
  far: number;
  segment: number;
  remaining: number;
  waypoint: Point;
  best: number;
  arrivedAt?: number;
}

/**
 * Spawns cars at the world's start marking and evolves their brains with NEAT, level by level.
 * The cars steer themselves; navigation only tells each brain which way the destination is.
 */
export class WorldSim {
  cars: Car[] = [];
  /** The best-scoring car, crashed or not: what ends a generation early. */
  leader: Car | null = null;
  /**
   * The car the page highlights and follows: the best one still driving (or already arrived),
   * falling back to the leader only once every car has crashed. Display only; it never
   * changes scoring or breeding.
   */
  followed: Car | null = null;
  generation = 1;
  level = 1;
  mode: WorldDriveMode = "off";
  population = 100;
  mutation = 0.1;
  neat: Neat;
  history: WorldSummary[] = [];
  last: WorldSummary | null = null;
  /** Which trip of the generation is running. */
  trip = 0;
  /** This trip's time limit, in frames (null on level 1). */
  timeLimit: number | null = null;
  /** Frames since this trip started. */
  frames = 0;
  /** This session's seed for generated maps. */
  seed = (Math.random() * 2 ** 32) >>> 0;
  /** Called when a level starts on a different map, so the page can load it before cars spawn. */
  onMapChange?: (map: number) => void;
  private currentMap = 0;
  /** True while training on the visitor's own map instead of the levels. */
  custom = false;
  destination: Point | null = null;
  /** Where this generation starts and which way it faces. */
  origin: { center: Point; direction: Point } | null = null;
  /** Frames since driving began; drives the traffic lights so they keep pace at any speed. */
  clock = 0;
  private nav: Navigator | null = null;
  private startRemaining = 0;
  private trips = new Map<Car, Trip>();
  /** Score so far this generation, per genome, summed over trips. */
  private totals: number[] = [];
  /** Trips each genome reached in time this generation. */
  private arrivals: number[] = [];
  private leaderBest = 0;
  private framesSinceGain = 0;
  private goalReached = false;

  constructor(private world: () => World, saved: WorldSaved | null = null) {
    this.neat = new Neat(WORLD_INPUTS, OUTPUTS, this.population);
    if (saved) this.restore(saved);
  }

  /** Puts back a saved state: the population, level, generation and learning curve. */
  restore(saved: WorldSaved): void {
    this.neat = Neat.fromJSON(saved.neat);
    this.neat.rates.power = this.mutation * 5;
    this.level = Math.max(1, saved.level);
    if (saved.seed !== undefined) this.seed = saved.seed;
    this.currentMap = worldLevelSpec(this.level).map;
    this.generation = saved.generation;
    this.history = saved.history ?? [];
    this.last = this.history[this.history.length - 1] ?? null;
  }

  get tripsPerGeneration(): number {
    return this.custom || this.levelSpec.goal === "survive" ? 1 : TRIPS_PER_GENERATION;
  }

  get levelSpec(): WorldLevel {
    return this.custom ? CUSTOM_LEVEL : worldLevelSpec(this.level);
  }

  get start(): Marking | undefined {
    return this.world().markings.find((m) => m.type === "start");
  }

  get alive(): number {
    return this.cars.filter((c) => !c.damaged && this.trips.get(c)?.arrivedAt === undefined).length;
  }

  /** Returns false when the world has no start marking or no road to drive. */
  begin(mode: Exclude<WorldDriveMode, "off">): boolean {
    if (!this.start || this.world().graph.segments.length === 0) return false;
    this.mode = mode;
    this.neat.rates.power = this.mutation * 5;
    this.neat.resize(this.population);
    this.startGeneration();
    return true;
  }

  stop(): void {
    this.cars.forEach((c) => c.dispose());
    this.cars = [];
    this.leader = null;
    this.followed = null;
    this.mode = "off";
  }

  /** A random point along a random road, as a spot and the direction of its right-hand lane. */
  private randomRoadSpot(rand: () => number): { center: Point; direction: Point } {
    const w = this.world();
    const s = w.graph.segments[Math.floor(rand() * w.graph.segments.length)];
    // One-way streets only run from p1 to p2, and their traffic uses the whole road.
    const forward = s.oneWay || rand() < 0.5;
    const [a, b] = forward ? [s.p1, s.p2] : [s.p2, s.p1];
    const dir = normalize(subtract(b, a));
    const lane = scale(rightOf(dir), s.oneWay ? 0 : w.settings.roadWidth / 4);
    return { center: add(lerp2D(a, b, 0.25 + rand() * 0.5), lane), direction: dir };
  }

  /**
   * Where this trip starts and drives to: from the Start marking (or, on later levels, a random
   * spot) to a random spot at least the level's trip length away by road. On a small map the
   * trip length is capped to what the map can offer.
   */
  private chooseTrip(): void {
    const w = this.world();
    const spec = this.levelSpec;
    const rand = mulberry32((this.generation * 7919 + this.level * 31 + this.trip * 104729) >>> 0);
    const marking = this.start!;
    if (this.custom) {
      this.origin = { center: marking.center, direction: marking.direction };
      this.destination = this.customDestination(this.origin.center);
      return;
    }
    this.origin = spec.randomStart ? this.randomRoadSpot(rand) : { center: marking.center, direction: marking.direction };
    const from = new Navigator(w.graph, this.origin.center);
    let reach = 0;
    w.graph.points.forEach((_, i) => {
      const d = from.distanceFrom(i);
      if (d < Infinity && d > reach) reach = d;
    });
    const want = Math.min(spec.minTrip, reach * 0.6);
    let best: { p: Point; d: number } | null = null;
    for (let tries = 0; tries < 40; tries++) {
      const p = this.randomRoadSpot(rand).center;
      const d = from.remaining(p);
      if (d === Infinity) continue;
      if (d >= want) {
        best = { p, d };
        break;
      }
      if (!best || d > best.d) best = { p, d };
    }
    this.destination = best?.p ?? null;
  }

  /** The visitor's Target marking, or without one the road point farthest from the start. */
  private customDestination(from: Point): Point | null {
    const w = this.world();
    const target = w.markings.find((m) => m.type === "target");
    if (target) return target.center;
    const nav = new Navigator(w.graph, from);
    let far: Point | null = null;
    let reach = 0;
    w.graph.points.forEach((p, i) => {
      const d = nav.distanceFrom(i);
      if (d < Infinity && d > reach) {
        reach = d;
        far = p;
      }
    });
    return far;
  }

  /**
   * A fair time limit for this trip: the route at top speed, plus time to slow for each turn,
   * stop at each stop sign and wait at each light, times the level's factor.
   */
  private timeLimitFor(nav: Navigator, from: Point): number {
    const w = this.world();
    const path = nav.path(from);
    let length = 0;
    let turns = 0;
    for (let i = 1; i < path.length; i++) {
      length += distance(path[i - 1], path[i]);
      if (i >= 2) {
        const a = Math.atan2(path[i - 1].y - path[i - 2].y, path[i - 1].x - path[i - 2].x);
        const b = Math.atan2(path[i].y - path[i - 1].y, path[i].x - path[i - 1].x);
        if (Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) > 0.5) turns++;
      }
    }
    const onRoute = (m: Marking) => path.some((p, i) => i > 0 && distanceToSegment(m.center, path[i - 1], p) < 35);
    const stops = w.markings.filter((m) => m instanceof Stop && onRoute(m)).length;
    const lights = w.markings.filter((m) => m instanceof Light && onRoute(m)).length;
    const ideal = length / 3 + turns * TURN_FRAMES + stops * STOP_FRAMES + lights * LIGHT_FRAMES + START_FRAMES;
    return Math.round(ideal * this.levelSpec.timeFactor);
  }

  private spawn(): void {
    this.cars.forEach((c) => c.dispose());
    const w = this.world();
    this.chooseTrip();
    const start = this.origin!;
    this.nav = this.destination ? new Navigator(w.graph, this.destination) : null;
    this.startRemaining = this.nav ? this.nav.remaining(start.center) : 0;
    this.timeLimit = this.nav && this.levelSpec.goal !== "survive" ? this.timeLimitFor(this.nav, start.center) : null;
    const heading = Math.atan2(-start.direction.x, -start.direction.y);
    const make = (type: "AI" | "KEYS", brain?: Genome) => {
      const car = new Car(start.center.x, start.center.y, 30, 50, type);
      car.sensor = new Sensor(car, WORLD_RAYS, 150, Math.PI);
      car.angle = heading;
      car.fitness = "odometer";
      car.stallFrames = CAR_STALL_FRAMES;
      if (brain) car.brain = brain;
      return car;
    };
    this.cars = this.mode === "KEYS" ? [make("KEYS")] : this.neat.genomes.map((g) => make("AI", g));
    const seg = this.nav ? this.nav.nearestSegment(start.center) : -1;
    this.trips = new Map(
      this.cars.map((c) => [c, { far: 0, segment: seg, remaining: this.startRemaining, waypoint: this.destination ?? start.center, best: this.startRemaining }]),
    );
    this.leader = this.cars[0];
    this.followed = this.cars[0];
    this.leaderBest = 0;
    this.framesSinceGain = 0;
    this.frames = 0;
    this.goalReached = false;
  }

  private startGeneration(): void {
    if (!this.custom && this.levelSpec.map !== this.currentMap) {
      this.currentMap = this.levelSpec.map;
      this.onMapChange?.(this.currentMap);
    }
    this.trip = 0;
    this.totals = this.neat.genomes.map(() => 0);
    this.arrivals = this.neat.genomes.map(() => 0);
    this.spawn();
  }

  /**
   * Fitness for this trip. Level 1: distance driven without crashing, as in the course. Timed
   * levels: the share of the route covered, plus, only when the car arrives within the time
   * limit, a bonus that grows with the time to spare. Each trip counts the same however long it is.
   */
  score(car: Car): number {
    if (this.levelSpec.goal === "survive") return car.progress;
    const t = this.trips.get(car);
    if (!t || this.startRemaining <= 0) return 0;
    const covered = Math.max(0, Math.min(1, (this.startRemaining - t.best) / this.startRemaining));
    const limit = this.timeLimit ?? Infinity;
    const onTime = t.arrivedAt !== undefined && t.arrivedAt <= limit ? 1 + (limit - t.arrivedAt) / limit : 0;
    return (covered + onTime) * 1000;
  }

  /** Level 1: covered real ground, not just circled the start. */
  survived(car: Car): boolean {
    return car.progress >= SURVIVE_DISTANCE && (this.trips.get(car)?.far ?? 0) >= SURVIVE_LEAVE_START;
  }

  /** True when this car reached the destination within the time limit. */
  inTime(car: Car): boolean {
    const t = this.trips.get(car);
    return t?.arrivedAt !== undefined && (this.timeLimit === null || t.arrivedAt <= this.timeLimit);
  }

  /** Seconds this car took to arrive on the current trip, if it has. */
  arrivalSeconds(car: Car | null): number | null {
    const at = car ? this.trips.get(car)?.arrivedAt : undefined;
    return at === undefined ? null : at / 60;
  }

  /** Score so far this generation, including finished trips: what the chart and the leader use. */
  total(car: Car): number {
    const i = this.cars.indexOf(car);
    return (this.totals[i] ?? 0) + this.score(car);
  }

  /** Where the GPS is pointing this car, for drawing. */
  waypoint(car: Car): Point | null {
    return this.trips.get(car)?.waypoint ?? null;
  }

  remaining(car: Car): number {
    return this.trips.get(car)?.remaining ?? 0;
  }

  /** Signed angle to the GPS waypoint, -1 to 1: positive means the destination is to the left. */
  private gps(car: Car, t: Trip): number {
    const want = Math.atan2(-(t.waypoint.x - car.x), -(t.waypoint.y - car.y));
    const diff = Math.atan2(Math.sin(want - car.angle), Math.cos(want - car.angle));
    return diff / Math.PI;
  }

  /** Advances one frame. Returns true when a generation just ended. */
  step(): boolean {
    if (this.mode === "off" || this.cars.length === 0) return false;
    this.frames++;
    this.clock++;
    const world = this.world();
    world.updateLights(this.clock / 60);
    const obstacles = world.obstacles();
    const nav = this.nav;

    this.cars.forEach((car, i) => {
      const t = this.trips.get(car)!;
      if (t.arrivedAt !== undefined) return;
      if (car.damaged && car.type === "AI") return;
      car.update(obstacles.filter((o) => near(o, car)), [], [car.speed / car.maxSpeed, this.gps(car, t)]);
      if (this.origin) t.far = Math.max(t.far, distance(car, this.origin.center));
      if (!nav) return;
      // Finding the nearest road is the costly part; each car does it every fourth frame.
      if ((this.frames + i) % 4 === 0 || t.segment < 0) t.segment = nav.nearestSegment(car);
      const g = nav.guide(car, t.segment);
      t.remaining = g.remaining;
      t.waypoint = g.waypoint;
      if (g.remaining < t.best) t.best = g.remaining;
      if (!car.damaged && this.destination && distance(car, this.destination) < ARRIVE_RADIUS) {
        t.arrivedAt = this.frames;
        t.best = 0;
        car.speed = 0;
      }
    });

    this.leader = this.cars.reduce((a, b) => (this.total(b) > this.total(a) ? b : a));
    const active = this.cars.filter((c) => !c.damaged || this.trips.get(c)?.arrivedAt !== undefined);
    this.followed = active.length ? active.reduce((a, b) => (this.total(b) > this.total(a) ? b : a)) : this.leader;
    if (this.mode === "KEYS") return false;

    // Survival follows the leader; trips run until no car is still getting closer.
    const survive = this.levelSpec.goal === "survive";
    const progress = survive ? this.score(this.leader) : this.cars.reduce((sum, c) => sum + this.score(c), 0);
    if (progress > this.leaderBest + 1) {
      this.leaderBest = progress;
      this.framesSinceGain = 0;
    } else {
      this.framesSinceGain++;
    }

    let end = this.alive === 0 || this.framesSinceGain > LEADER_PATIENCE;
    if (survive && this.frames >= SURVIVE_FRAMES) {
      end = true;
      this.goalReached = this.cars.some((c) => !c.damaged && this.survived(c));
    }
    // A trip is over a little after its time limit: nothing more can be earned but distance.
    if (this.timeLimit !== null && this.frames >= this.timeLimit * 1.2) end = true;
    return end ? this.endTrip() : false;
  }

  /** Banks this trip's scores; drives the next trip, or breeds once the generation's trips are done. */
  private endTrip(): boolean {
    this.cars.forEach((c, i) => {
      this.totals[i] = (this.totals[i] ?? 0) + this.score(c);
      if (this.inTime(c)) this.arrivals[i] = (this.arrivals[i] ?? 0) + 1;
    });
    if (this.trip < this.tripsPerGeneration - 1) {
      this.trip++;
      this.spawn();
      return false;
    }
    this.breed();
    return true;
  }

  /** Skips to the next generation, scoring the trip under way as it stands. */
  nextGeneration(): void {
    if (this.mode !== "AI") return;
    this.trip = this.tripsPerGeneration - 1;
    this.endTrip();
  }

  /** Lets NEAT breed the next generation and unlocks the next level if this one earned it. */
  private breed(): void {
    const before = this.neat.champion?.hiddenCount ?? 0;
    const best = this.totals.indexOf(Math.max(...this.totals));
    const bestCar = this.cars[best];
    const arrivedAt = bestCar ? this.trips.get(bestCar)?.arrivedAt : undefined;
    if (this.levelSpec.goal === "every" && !this.custom) this.goalReached = this.arrivals.some((a) => a >= this.tripsPerGeneration);
    this.neat.evolve(this.totals);
    const champ = this.neat.champion!;
    const levelUp = this.goalReached;
    this.last = {
      generation: this.generation,
      level: this.custom ? 0 : this.level,
      best: this.totals[best] ?? 0,
      grew: champ.hiddenCount > before,
      levelUp,
      arrivedIn: arrivedAt === undefined ? null : arrivedAt / 60,
      arrivedTrips: this.arrivals[best] ?? 0,
      inTime: this.arrivals[best] ?? 0,
      trips: this.tripsPerGeneration,
      neurons: champ.hiddenCount,
      connections: champ.enabledCount,
      species: this.neat.species.length,
    };
    this.history.push(this.last);
    if (this.history.length > 300) this.history.shift();
    if (levelUp && !this.custom) this.level++;
    this.generation++;
    this.startGeneration();
  }

  /**
   * Switches to training on the visitor's own map. The brains carry over as a starting point;
   * the page keeps a copy of the level state and restores it afterwards.
   */
  startCustom(): void {
    this.custom = true;
    this.generation = 1;
    this.history = [];
    this.last = null;
  }

  forget(): void {
    this.neat = new Neat(WORLD_INPUTS, OUTPUTS, this.population);
    this.neat.rates.power = this.mutation * 5;
    this.generation = 1;
    if (!this.custom) this.level = 1;
    this.history = [];
    this.last = null;
    if (this.mode !== "off") this.startGeneration();
  }

  toJSON(): WorldSaved {
    return {
      seed: this.seed,
      neat: this.neat.toJSON(),
      level: this.level,
      generation: this.generation,
      history: this.history.slice(-120),
    };
  }
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}
