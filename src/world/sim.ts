import { Car } from "../car";
import { Sensor } from "../sensor";
import type { CurvePoint } from "../chart";
import { Genome, Neat, type NeatJSON } from "../neat";
import { mulberry32 } from "../utils";
import { add, distance, lerp2D, normalize, rightOf, scale, subtract, type Point } from "./geom";
import type { Marking } from "./markings";
import { Navigator } from "./nav";
import type { World } from "./world";

export type WorldDriveMode = "off" | "AI" | "KEYS";

/**
 * The world's levels. Each one keeps the same brains and asks more of them: stay on the road,
 * then get somewhere, then get anywhere (so the brain must really follow directions instead of
 * memorizing one trip), then get anywhere from anywhere.
 */
export interface WorldLevel {
  number: number;
  name: string;
  /** What clears the level: survive the time limit, arrive, or arrive on every trip of a generation. */
  goal: "survive" | "arrive" | "every" | null;
  /** New random destination each generation. */
  randomDestination: boolean;
  /** New random starting spot each generation. */
  randomStart: boolean;
}

export const WORLD_LEVELS: WorldLevel[] = [
  { number: 1, name: "Stay on the road", goal: "survive", randomDestination: false, randomStart: false },
  { number: 2, name: "Find the destination", goal: "arrive", randomDestination: false, randomStart: false },
  { number: 3, name: "Any destination", goal: "every", randomDestination: true, randomStart: false },
  { number: 4, name: "Anywhere to anywhere", goal: null, randomDestination: true, randomStart: true },
];

/**
 * Levels with random trips score every brain on this many trips per generation. One random trip
 * is luck: a brain that happened to get an easy one would win. Several trips reward brains that
 * really follow directions.
 */
export const TRIPS_PER_GENERATION = 3;

export interface WorldSummary extends CurvePoint {
  levelUp: boolean;
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
const SURVIVE_FRAMES = 60 * 45;
const GENERATION_FRAMES = 60 * 60;
/** Within this distance of the destination counts as arrived. */
const ARRIVE_RADIUS = 40;
/** Fitness for arriving, on top of the distance covered; every frame to spare adds one more. */
const ARRIVE_BONUS = 1000;
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
  leader: Car | null = null;
  generation = 1;
  level = 1;
  mode: WorldDriveMode = "off";
  population = 100;
  mutation = 0.1;
  neat: Neat;
  history: WorldSummary[] = [];
  last: WorldSummary | null = null;
  /** Which trip of the generation is running (random levels drive several). */
  trip = 0;
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
  /** Trips each genome arrived on this generation. */
  private arrivals: number[] = [];
  private leaderBest = 0;
  private framesSinceGain = 0;
  private frames = 0;
  private goalReached = false;

  constructor(private world: () => World, saved: WorldSaved | null = null) {
    if (saved) {
      this.neat = Neat.fromJSON(saved.neat);
      this.level = Math.min(WORLD_LEVELS.length, Math.max(1, saved.level));
      this.generation = saved.generation;
      this.history = saved.history ?? [];
      this.last = this.history[this.history.length - 1] ?? null;
    } else {
      this.neat = new Neat(WORLD_INPUTS, OUTPUTS, this.population);
    }
  }

  get tripsPerGeneration(): number {
    return this.levelSpec.randomDestination ? TRIPS_PER_GENERATION : 1;
  }

  get levelSpec(): WorldLevel {
    return WORLD_LEVELS[this.level - 1];
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
    this.mode = "off";
  }

  /** A random point along a random road, as a spot and the direction of its right-hand lane. */
  private randomRoadSpot(rand: () => number): { center: Point; direction: Point } {
    const w = this.world();
    const s = w.graph.segments[Math.floor(rand() * w.graph.segments.length)];
    const forward = rand() < 0.5;
    const [a, b] = forward ? [s.p1, s.p2] : [s.p2, s.p1];
    const dir = normalize(subtract(b, a));
    const lane = scale(rightOf(dir), w.settings.roadWidth / 4);
    return { center: add(lerp2D(a, b, 0.25 + rand() * 0.5), lane), direction: dir };
  }

  /**
   * Where this generation starts and drives to. Levels 1 and 2: the Start marking to the
   * Target marking (or, without one, the road point farthest from the start). Level 3: a new
   * random destination each generation. Level 4: random start too.
   */
  private chooseTrip(): void {
    const w = this.world();
    const spec = this.levelSpec;
    const rand = mulberry32(this.generation * 7919 + this.level * 31 + this.trip);
    const marking = this.start!;
    this.origin = spec.randomStart ? this.randomRoadSpot(rand) : { center: marking.center, direction: marking.direction };
    const from = new Navigator(w.graph, this.origin.center);
    const target = w.markings.find((m) => m.type === "target");
    if (!spec.randomDestination && target) {
      this.destination = target.center;
      return;
    }
    if (spec.randomDestination) {
      for (let tries = 0; tries < 30; tries++) {
        const p = this.randomRoadSpot(rand).center;
        const d = from.remaining(p);
        if (d > 700 && d < Infinity) {
          this.destination = p;
          return;
        }
      }
    }
    const reachable = w.graph.points.map((p, i) => ({ p, d: from.distanceFrom(i) })).filter((x) => x.d < Infinity);
    this.destination = reachable.length ? reachable.reduce((a, b) => (b.d > a.d ? b : a)).p : null;
  }

  private spawn(): void {
    this.cars.forEach((c) => c.dispose());
    const w = this.world();
    this.chooseTrip();
    const start = this.origin!;
    this.nav = this.destination ? new Navigator(w.graph, this.destination) : null;
    this.startRemaining = this.nav ? this.nav.remaining(start.center) : 0;
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
      this.cars.map((c) => [c, { segment: seg, remaining: this.startRemaining, waypoint: this.destination ?? start.center, best: this.startRemaining }]),
    );
    this.leader = this.cars[0];
    this.leaderBest = 0;
    this.framesSinceGain = 0;
    this.frames = 0;
    this.goalReached = false;
  }

  private startGeneration(): void {
    this.trip = 0;
    this.totals = this.neat.genomes.map(() => 0);
    this.arrivals = this.neat.genomes.map(() => 0);
    this.spawn();
  }

  /**
   * Fitness for this trip. Level 1: distance driven without crashing, as in the course. Level 2:
   * how much closer by road the car got to the destination, plus a bonus for arriving that grows
   * the sooner it arrives. Random-trip levels score the same way, scaled to the trip's length
   * so long and short trips count equally.
   */
  score(car: Car): number {
    if (this.level === 1) return car.progress;
    const t = this.trips.get(car);
    if (!t) return 0;
    const progress = this.startRemaining - t.best;
    const raw = t.arrivedAt === undefined ? progress : progress + ARRIVE_BONUS + (GENERATION_FRAMES - t.arrivedAt);
    return this.levelSpec.randomDestination ? (raw / (this.startRemaining + ARRIVE_BONUS + GENERATION_FRAMES)) * 1000 : raw;
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
      if (!nav) return;
      // Finding the nearest road is the costly part; each car does it every fourth frame.
      if ((this.frames + i) % 4 === 0 || t.segment < 0) t.segment = nav.nearestSegment(car);
      const g = nav.guide(car, t.segment);
      t.remaining = g.remaining;
      t.waypoint = g.waypoint;
      if (g.remaining < t.best) t.best = g.remaining;
      if (car.type === "AI" && !car.damaged && this.destination && distance(car, this.destination) < ARRIVE_RADIUS) {
        t.arrivedAt = this.frames;
        t.best = 0;
        car.speed = 0;
      }
    });

    this.leader = this.cars.reduce((a, b) => (this.total(b) > this.total(a) ? b : a));
    if (this.mode === "KEYS") return false;

    // Random trips run until no car is still getting closer; fixed ones follow the leader.
    const multi = this.levelSpec.randomDestination;
    const progress = multi ? this.cars.reduce((sum, c) => sum + this.score(c), 0) : this.score(this.leader);
    if (progress > this.leaderBest + 1) {
      this.leaderBest = progress;
      this.framesSinceGain = 0;
    } else {
      this.framesSinceGain++;
    }

    const goal = this.levelSpec.goal;
    let end = this.alive === 0 || this.framesSinceGain > LEADER_PATIENCE || this.frames >= GENERATION_FRAMES;
    if (goal === "survive" && this.frames >= SURVIVE_FRAMES) {
      end = true;
      this.goalReached = this.alive > 0;
    } else if (goal === "arrive" && this.trips.get(this.leader)?.arrivedAt !== undefined) {
      end = true;
      this.goalReached = true;
    }
    return end ? this.endTrip() : false;
  }

  /** Banks this trip's scores; drives the next trip, or breeds once the generation's trips are done. */
  private endTrip(): boolean {
    this.cars.forEach((c, i) => {
      this.totals[i] = (this.totals[i] ?? 0) + this.score(c);
      if (this.trips.get(c)?.arrivedAt !== undefined) this.arrivals[i] = (this.arrivals[i] ?? 0) + 1;
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
    if (this.levelSpec.goal === "every") this.goalReached = this.arrivals.some((a) => a >= this.tripsPerGeneration);
    this.neat.evolve(this.totals);
    const champ = this.neat.champion!;
    const levelUp = this.goalReached && this.level < WORLD_LEVELS.length;
    this.last = {
      generation: this.generation,
      level: this.level,
      best: this.totals[best] ?? 0,
      grew: champ.hiddenCount > before,
      levelUp,
      arrivedIn: arrivedAt === undefined ? null : arrivedAt / 60,
      arrivedTrips: this.arrivals[best] ?? 0,
      trips: this.tripsPerGeneration,
      neurons: champ.hiddenCount,
      connections: champ.enabledCount,
      species: this.neat.species.length,
    };
    this.history.push(this.last);
    if (this.history.length > 300) this.history.shift();
    if (levelUp) this.level++;
    this.generation++;
    this.startGeneration();
  }

  /** The map changed: keep the brains, start the levels over. */
  restartLevels(): void {
    this.level = 1;
  }

  forget(): void {
    this.neat = new Neat(WORLD_INPUTS, OUTPUTS, this.population);
    this.neat.rates.power = this.mutation * 5;
    this.generation = 1;
    this.level = 1;
    this.history = [];
    this.last = null;
    if (this.mode !== "off") this.startGeneration();
  }

  toJSON(): WorldSaved {
    return {
      neat: this.neat.toJSON(),
      level: this.level,
      generation: this.generation,
      history: this.history.slice(-120),
    };
  }
}
