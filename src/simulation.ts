import { Car } from "./car";
import { Neat, type NeatJSON } from "./neat";
import type { NetworkJSON } from "./network";
import { Road } from "./road";
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
 * A stage of the highway. Level 1 is the course's seven cars; after that traffic never ends,
 * and each level packs the rows closer and runs them faster. The last level has no goal: the
 * cars just keep going as far as they can.
 */
export interface Level {
  number: number;
  name: string;
  layout: TrafficLayout;
  rowGap: number;
  trafficSpeed: number;
  /** Cars the leader must pass to unlock the next level; null on the last level. */
  goal: number | null;
}

export const LEVELS: Level[] = [
  { number: 1, name: "The course", layout: "course", rowGap: 210, trafficSpeed: 2, goal: 7 },
  { number: 2, name: "Open road", layout: "endless", rowGap: 230, trafficSpeed: 2, goal: 15 },
  { number: 3, name: "Light traffic", layout: "endless", rowGap: 200, trafficSpeed: 2.1, goal: 15 },
  { number: 4, name: "Steady traffic", layout: "endless", rowGap: 180, trafficSpeed: 2.2, goal: 20 },
  { number: 5, name: "Heavy traffic", layout: "endless", rowGap: 165, trafficSpeed: 2.3, goal: 20 },
  { number: 6, name: "Congestion", layout: "endless", rowGap: 150, trafficSpeed: 2.4, goal: 25 },
  { number: 7, name: "Rush hour", layout: "endless", rowGap: 140, trafficSpeed: 2.5, goal: null },
];

/** What happened in the generation that just ended, for the status line and the chart. */
export interface GenerationSummary {
  generation: number;
  level: number;
  /** Fitness of the generation's best car: px gained on the traffic. */
  best: number;
  passed: number;
  levelUp: boolean;
  /** Hidden neurons and live connections in the generation's best brain. */
  neurons: number;
  connections: number;
  species: number;
  /** True when the best brain has more neurons than the previous generation's best. */
  grew: boolean;
}

export interface SavedState {
  neat: NeatJSON;
  level: number;
  generation: number;
  history?: GenerationSummary[];
}

/** Ray sensors in, forward / left / right / reverse out. */
const INPUTS = 5;
const OUTPUTS = 4;
const LEADER_PATIENCE = 420; // frames the leader may go without gaining ground before the generation ends
/** On the last level a perfect driver never stops, so its generations end after two minutes. */
const LAST_LEVEL_FRAMES = 60 * 120;

export class Simulation {
  road: Road;
  course!: TrafficCourse;
  cars: Car[] = [];
  leader!: Car;
  generation = 1;
  level = 1;
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

  constructor(roadX: number, roadWidth: number, public settings: SimSettings, saved: SavedState | null = null) {
    this.road = new Road(roadX, roadWidth, 3);
    if (saved) {
      this.neat = Neat.fromJSON(saved.neat);
      this.neat.resize(settings.population);
      this.level = Math.min(LEVELS.length, Math.max(1, saved.level));
      this.generation = saved.generation;
      this.history = saved.history ?? [];
      this.last = this.history[this.history.length - 1] ?? null;
    } else {
      this.neat = new Neat(INPUTS, OUTPUTS, settings.population);
    }
    this.applyMutation();
    this.reset();
  }

  get levelSpec(): Level {
    return LEVELS[this.level - 1];
  }

  /** Builds a fresh generation: one car per genome, on this level's traffic. */
  reset(): void {
    this.cars.forEach((c) => c.dispose());
    const spec = this.levelSpec;
    // Each level has its own seeded traffic, replayed every generation so cars compare fairly.
    this.course = new TrafficCourse(this.road, this.settings.seed + this.level - 1, spec.layout, {
      rowGap: spec.rowGap,
      speed: spec.trafficSpeed,
    });
    const x = this.road.getLaneCenter(1);
    if (this.mode === "KEYS") {
      this.cars = [new Car(x, 100, 30, 50, "KEYS")];
    } else {
      this.cars = this.neat.genomes.map((g) => {
        const car = new Car(x, 100, 30, 50, "AI");
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
    this.trafficTravel += this.course.cars[0]?.speed ?? 0;
    for (const car of this.cars) {
      car.update(this.road.borders, this.course.near(car.y));
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
    this.goalReached = goal !== null && !this.leader.damaged && this.passedBy(this.leader) >= goal;
    const timeUp = goal === null && this.frames > LAST_LEVEL_FRAMES;
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
    const levelUp = this.goalReached && this.level < LEVELS.length;
    this.last = {
      generation: this.generation,
      level: this.level,
      best: this.score(this.leader),
      passed: Math.max(this.leaderPassed, this.passedBy(this.leader)),
      levelUp,
      neurons: champ.hiddenCount,
      connections: champ.enabledCount,
      species: this.neat.species.length,
      grew: champ.hiddenCount > before,
    };
    this.history.push(this.last);
    if (this.history.length > 300) this.history.shift();
    if (levelUp) this.level++;
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
    this.history = [];
    this.last = null;
    this.reset();
  }

  toJSON(): SavedState {
    return { neat: this.neat.toJSON(), level: this.level, generation: this.generation, history: this.history.slice(-120) };
  }
}
