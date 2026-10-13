import { Car } from "./car";
import { Neat, type NeatJSON } from "./neat";
import type { NetworkJSON } from "./network";
import { Road, type RoadShape } from "./road";
import { mulberry32 } from "./utils";
import { Sensor } from "./sensor";
import { TrafficCourse, type TrafficLayout } from "./traffic";

export type DriveMode = "AI" | "KEYS";

export interface SimSettings {
  population: number;
  /** Slider value, 0 to 0.5: how far mutation moves weights. */
  mutation: number;
  seed: number;
}

/** The world page's fixed-shape brain and how far it got. */
export interface Parent {
  brain: NetworkJSON;
  progress: number;
  passed?: number;
}

/**
 * A stage of the highway. Levels never run out. Level 1 is seven cars in the course's pattern;
 * after that traffic never ends. Every three levels the road itself changes (two lanes, curves,
 * construction zones, then mixes). A new road starts with lighter traffic so the brains can
 * learn its new skill first, then traffic ramps up over its three levels: rows closer together
 * and faster up to the densest traffic that stays passable, then lanes moving at different
 * speeds, then drivers who change lanes, with more cars to pass. Each road starts harder than
 * the last one did, so difficulty keeps rising.
 */
export interface Level {
  number: number;
  name: string;
  layout: TrafficLayout;
  rowGap: number;
  trafficSpeed: number;
  laneSpread: number;
  changeRate: number;
  /** Cars the leader must pass to clear the level. */
  goal: number;
  /** Which road the level is on: a new one every LEVELS_PER_ROAD levels. */
  road: number;
}

export const LEVELS_PER_ROAD = 3;
/** Densest rows that stay passable, and the fastest traffic. */
const MIN_ROW_GAP = 150;
const MAX_TRAFFIC_SPEED = 2.5;
/** Lanes start running at different speeds from this traffic tier, and drivers change lanes from this one. */
const LANE_SPEEDS_FROM = 6;
const LANE_CHANGES_FROM = 9;
const MAX_GOAL = 50;

const TRAFFIC_NAMES = ["Open road", "Light traffic", "Steady traffic", "Heavy traffic", "Congestion", "Rush hour"];

/** The level's settings, for any level number. */
export function levelSpec(n: number): Level {
  const road = Math.floor((n - 1) / LEVELS_PER_ROAD);
  if (n <= 1) {
    return { number: 1, name: "Seven cars", layout: "seven", rowGap: 210, trafficSpeed: 2, laneSpread: 0, changeRate: 0, goal: 7, road };
  }
  // Traffic tier: one step per level within a road, one step per road at each road's start.
  const stage = (n - 1) % LEVELS_PER_ROAD;
  const k = road + stage - 1;
  const laneSpread = k >= LANE_SPEEDS_FROM ? Math.min(0.4, 0.1 * (k - LANE_SPEEDS_FROM + 1)) : 0;
  const changeRate = k >= LANE_CHANGES_FROM ? Math.min(0.004, 0.001 * (k - LANE_CHANGES_FROM + 1)) : 0;
  const extras = [laneSpread ? "lanes at different speeds" : "", changeRate ? "drivers changing lanes" : ""].filter(Boolean);
  const base = TRAFFIC_NAMES[Math.min(k, TRAFFIC_NAMES.length - 1)];
  return {
    number: n,
    name: extras.length ? `${base}, ${extras.join(" and ")}` : base,
    layout: "endless",
    rowGap: Math.max(MIN_ROW_GAP, 230 - 15 * k),
    trafficSpeed: Math.min(MAX_TRAFFIC_SPEED, 2 + 0.1 * k),
    laneSpread,
    changeRate,
    goal: Math.min(MAX_GOAL, 15 + 2 * k),
    road,
  };
}

/** Lane width on every road, in px (the course's 210 px road has three 70 px lanes). */
export const LANE_WIDTH = 70;

/**
 * The road for a stage of the highway. Road 1 is the course's straight three lanes. Then two
 * lanes (fewer escape routes), then curves, then construction zones that close a lane, then
 * roads that mix all three and get curvier. `seed` picks the exact curves.
 */
export function roadShape(road: number, seed: number): RoadShape {
  const rand = mulberry32(seed ^ (road * 0x51ed27));
  const bend = (amplitude: number, wavelength: number) => ({ amplitude, wavelength, phase: rand() * Math.PI * 2 });
  const zones = { start: 900 + rand() * 400, period: 1500 + rand() * 500, length: 520 };
  switch (road) {
    case 0:
      return { laneCount: 3, bends: [] };
    case 1:
      return { laneCount: 2, bends: [] };
    case 2:
      return { laneCount: 3, bends: [bend(70, 1700), bend(22, 750)] };
    case 3:
      return { laneCount: 3, bends: [bend(50, 1800)], closures: zones };
    default: {
      const k = road - 4;
      const lanes = rand() < 0.35 ? 2 : 3;
      return {
        laneCount: lanes,
        bends: [bend(Math.min(90, 70 + 5 * k), 1500 + rand() * 500), bend(Math.min(20, 12 + 2 * k), 650 + rand() * 200)],
        closures: lanes === 3 ? zones : undefined,
      };
    }
  }
}

/** The first levels, for reference and tests. */
export const LEVELS: Level[] = Array.from({ length: 12 }, (_, i) => levelSpec(i + 1));

/** What happened in the generation that just ended, for the status line and the chart. */
export interface GenerationSummary {
  generation: number;
  level: number;
  /** Fitness of the generation's best car: px gained on the traffic. */
  best: number;
  passed: number;
  levelUp: boolean;
  /** True when this generation reached the level's goal (one of the clears needed to pass). */
  cleared: boolean;
  /** Clears on this level so far, out of CLEARS_TO_PASS. */
  clears: number;
  /** Hidden neurons and live connections in the generation's best brain. */
  neurons: number;
  connections: number;
  species: number;
  /** True when the best brain has more neurons than the previous generation's best. */
  grew: boolean;
}

export interface SavedState {
  /** This session's traffic seed. */
  seed?: number;
  neat: NeatJSON;
  level: number;
  generation: number;
  clears?: number;
  history?: GenerationSummary[];
}

/**
 * Seven rays fanned across 180 degrees, so the car sees beside itself as well as ahead (cars
 * cutting in, merges, curves), plus its own speed so it knows how hard it would have to brake.
 * Forward / left / right / reverse out.
 */
export const RAYS = 7;
export const RAY_SPREAD = Math.PI;
export const INPUTS = RAYS + 1;
const OUTPUTS = 4;
/**
 * Traffic is new every generation, so one generation can get an easy layout. A level only counts
 * as passed once its goal has been reached on this many different layouts.
 */
export const CLEARS_TO_PASS = 3;
const LEADER_PATIENCE = 420; // frames the leader may go without gaining ground before the generation ends
/** Safety limit on a generation's length, in frames. */
const MAX_GENERATION_FRAMES = 60 * 240;

export class Simulation {
  road!: Road;
  private roadIndex = -1;
  private roadX = 0;
  course!: TrafficCourse;
  cars: Car[] = [];
  leader!: Car;
  generation = 1;
  level = 1;
  /** Generations on this level that reached its goal; CLEARS_TO_PASS of them pass the level. */
  clears = 0;
  mode: DriveMode = "AI";
  neat: Neat;
  history: GenerationSummary[] = [];
  /** The generation that just ended, or null before the first one. */
  last: GenerationSummary | null = null;

  private leaderBest = 0;
  private framesSinceLeaderGain = 0;
  private frames = 0;
  /** How far traffic has driven this generation. */
  private trafficTravel = 0;
  /** Best fitness per car: distance gained on the traffic, so tailgating scores nothing. */
  private scores = new Map<Car, number>();
  /** Cars the leader had passed at its best moment (counting after a crash would undercount). */
  private leaderPassed = 0;
  private goalReached = false;

  constructor(roadX: number, _roadWidth: number, public settings: SimSettings, saved: SavedState | null = null) {
    this.roadX = roadX;
    if (saved) {
      this.neat = Neat.fromJSON(saved.neat);
      if (saved.seed !== undefined) settings.seed = saved.seed;
      this.neat.resize(settings.population);
      this.level = Math.max(1, saved.level);
      this.generation = saved.generation;
      this.clears = saved.clears ?? 0;
      this.history = saved.history ?? [];
      this.last = this.history[this.history.length - 1] ?? null;
    } else {
      this.neat = new Neat(INPUTS, OUTPUTS, settings.population);
    }
    this.applyMutation();
    this.reset();
  }

  get levelSpec(): Level {
    return levelSpec(this.level);
  }

  /** Builds a fresh generation: one car per genome, on this level's traffic. */
  reset(): void {
    this.cars.forEach((c) => c.dispose());
    const spec = this.levelSpec;
    // The road stays the same for all of its levels, so the brains get a fair shot at it.
    if (spec.road !== this.roadIndex) {
      const shape = roadShape(spec.road, this.settings.seed);
      this.road = new Road(this.roadX, shape.laneCount * LANE_WIDTH, shape.laneCount, shape);
      this.roadIndex = spec.road;
    }
    // New traffic every generation, so brains learn to read the road instead of memorizing one
    // layout. Every car in a generation drives the same traffic, so they still compare fairly.
    this.course = new TrafficCourse(this.road, this.trafficSeed(), spec.layout, {
      rowGap: spec.rowGap,
      speed: spec.trafficSpeed,
      laneSpread: spec.laneSpread,
      changeRate: spec.changeRate,
    });
    const x = this.road.getLaneCenter(Math.min(1, this.road.laneCount - 1));
    const withSensors = (car: Car) => {
      car.sensor = new Sensor(car, RAYS, 150, RAY_SPREAD);
      return car;
    };
    if (this.mode === "KEYS") {
      this.cars = [withSensors(new Car(x, 100, 30, 50, "KEYS"))];
    } else {
      this.cars = this.neat.genomes.map((g) => {
        const car = withSensors(new Car(x, 100, 30, 50, "AI"));
        car.brain = g;
        return car;
      });
    }
    this.leader = this.cars[0];
    this.leaderBest = 0;
    this.framesSinceLeaderGain = 0;
    this.frames = 0;
    this.trafficTravel = 0;
    this.scores = new Map(this.cars.map((c) => [c, 0]));
    this.leaderPassed = 0;
    this.goalReached = false;
  }

  /** Seed for this generation's traffic: depends on the session, the level and the generation. */
  trafficSeed(): number {
    return (Math.imul(this.settings.seed ^ (this.level * 0x9e3779b1), 2654435761) + this.generation * 7919) >>> 0;
  }

  /**
   * Fitness on the highway. Raw distance rewards a car for sitting behind traffic, because
   * traffic moves forward too; that brain never learns to overtake and eventually rear-ends
   * the car ahead. Scoring distance gained on the traffic makes overtaking the only way up.
   */
  score(car: Car): number {
    return this.scores.get(car) ?? 0;
  }

  /** Traffic cars fully behind this car. */
  passedBy(car: Car): number {
    return this.course.cars.filter((t) => t.y > car.y + car.height).length;
  }

  /** Best count of cars passed by this generation's leader so far. */
  get bestPassed(): number {
    return this.leaderPassed;
  }

  get alive(): number {
    return this.cars.filter((c) => !c.damaged).length;
  }

  /** The slider moves weights; structure grows at fixed NEAT rates. */
  applyMutation(): void {
    this.neat.rates.power = this.settings.mutation * 5;
  }

  setPopulation(n: number): void {
    this.settings.population = n;
    this.neat.resize(n);
    this.reset();
  }

  /** Advances one frame. Returns true when the generation just ended. */
  step(): boolean {
    this.frames++;
    this.course.extend(this.leader.y);
    this.course.update();
    this.trafficTravel += this.course.speed;
    for (const car of this.cars) {
      car.update(this.road.bordersNear(car.y), this.course.near(car.y), [car.speed / car.maxSpeed]);
      const gained = car.progress - this.trafficTravel;
      if (gained > (this.scores.get(car) ?? 0)) this.scores.set(car, gained);
    }

    this.leader = this.cars.reduce((a, b) => (this.score(b) > this.score(a) ? b : a));
    if (this.mode === "KEYS") return false;

    if (this.score(this.leader) > this.leaderBest + 1) {
      this.leaderBest = this.score(this.leader);
      this.leaderPassed = Math.max(this.leaderPassed, this.passedBy(this.leader));
      this.framesSinceLeaderGain = 0;
    } else {
      this.framesSinceLeaderGain++;
    }

    const goal = this.levelSpec.goal;
    this.goalReached = !this.leader.damaged && this.passedBy(this.leader) >= goal;
    const timeUp = this.frames > MAX_GENERATION_FRAMES;
    if (this.alive === 0 || this.framesSinceLeaderGain > LEADER_PATIENCE || this.goalReached || timeUp) {
      this.nextGeneration();
      return true;
    }
    return false;
  }

  /** Scores every brain, lets NEAT breed the next generation, and unlocks the next level if earned. */
  nextGeneration(): void {
    if (this.mode === "KEYS") return;
    const before = this.neat.champion?.hiddenCount ?? 0;
    this.neat.evolve(this.cars.map((c) => this.score(c)));
    const champ = this.neat.champion!;
    if (this.goalReached) this.clears++;
    const levelUp = this.clears >= CLEARS_TO_PASS;
    this.last = {
      generation: this.generation,
      level: this.level,
      best: this.score(this.leader),
      passed: Math.max(this.leaderPassed, this.passedBy(this.leader)),
      levelUp,
      cleared: this.goalReached,
      clears: this.clears,
      neurons: champ.hiddenCount,
      connections: champ.enabledCount,
      species: this.neat.species.length,
      grew: champ.hiddenCount > before,
    };
    this.history.push(this.last);
    if (this.history.length > 300) this.history.shift();
    if (levelUp) {
      this.level++;
      this.clears = 0;
    }
    this.generation++;
    this.reset();
  }

  setMode(mode: DriveMode): void {
    this.mode = mode;
    this.reset();
  }

  /** Starts over: minimal random brains, level 1. */
  forget(): void {
    this.neat = new Neat(INPUTS, OUTPUTS, this.settings.population);
    this.applyMutation();
    this.generation = 1;
    this.level = 1;
    this.clears = 0;
    this.history = [];
    this.last = null;
    this.reset();
  }

  toJSON(): SavedState {
    return { seed: this.settings.seed, neat: this.neat.toJSON(), level: this.level, generation: this.generation, clears: this.clears, history: this.history.slice(-120) };
  }
}
