import { Car } from "./car";
import { NeuralNetwork, type NetworkJSON } from "./network";
import { Road } from "./road";
import { TrafficCourse, type TrafficLayout } from "./traffic";

export type DriveMode = "AI" | "KEYS";

export interface SimSettings {
  population: number;
  mutation: number;
  seed: number;
  /** "course": the video's seven cars. "endless": seeded rows forever. */
  layout?: TrafficLayout;
}


/** The brain each new generation is bred from, and how far it got. */
export interface Parent {
  brain: NetworkJSON;
  /** Fitness the parent reached: px gained on the traffic (highway) or distance driven (world). */
  progress: number;
  /** Traffic cars the parent had passed, for display. */
  passed?: number;
  /** Share of the parent's driving time spent inside a lane (0 to 1). */
  inLane?: number;
  /** Seconds the parent took to reach the world's target, when it got there. */
  arrivedIn?: number;
}

/** Share of each generation given fresh random brains, so a stuck population can find new moves. */
const IMMIGRANTS = 0.1;

/** One point on the learning curve. */
export interface GenerationRecord {
  generation: number;
  /** How far the leader got ahead of traffic, in px. */
  lead: number;
  passed: number;
  cleared: boolean;
}

/** True when the value is a saved parent whose brain fits the given layer sizes. */
export function isParent(v: unknown, counts: number[] = BRAIN_COUNTS): v is Parent {
  const p = v as Parent | null;
  const b = p?.brain;
  if (!b || typeof p.progress !== "number" || !Array.isArray(b.counts) || !Array.isArray(b.levels)) return false;
  if (b.counts.length !== counts.length || b.counts.some((c, i) => c !== counts[i])) return false;
  return b.levels.length === counts.length - 1 && b.levels.every((l, i) =>
    l.biases?.length === counts[i + 1] && l.weights?.length === counts[i] &&
    l.weights.every((row) => row.length === counts[i + 1] && row.every(Number.isFinite)));
}

/**
 * Lane discipline. AI cars drive with lane assist: the brain picks throttle, brake and lane
 * changes, and a controller keeps the car centered in its target lane and makes smooth changes.
 * On top of the 5 rays the brain senses its speed, which lane it is in, and whether a lane change
 * is under way. Each lane change costs a little fitness, so needless weaving loses.
 */
export const LANE_INPUTS = 3;
/** Layer sizes of the highway brain. */
export const BRAIN_COUNTS = [5 + 3, 8, 4];
export const HIDDEN = 8;
/** Offset from lane center (0 = center, 1 = on the line) that still counts as inside the lane. */
const LANE_SLACK = 0.35;
/** Fitness cost of one lane change, in px (overtaking earns about 1 px per frame). */
const LANE_CHANGE_COST = 10;
/** How far ahead the lane-keeping controller aims, in px. */
const LOOKAHEAD = 80;
const LEADER_PATIENCE = 420; // frames the leader may go without gaining ground before the generation ends

export class Simulation {
  road: Road;
  course!: TrafficCourse;
  cars: Car[] = [];
  leader!: Car;
  generation = 1;
  /** True when the generation that just ended cleared the course layout. */
  lastCleared = false;
  /** Learning curve: one record per finished generation. */
  history: GenerationRecord[] = [];
  /** Generations in a row that failed to beat the parent; raises mutation until one does. */
  stagnant = 0;
  mode: DriveMode = "AI";
  parent: Parent | null;

  private leaderBest = 0;
  private framesSinceLeaderGain = 0;
  /** How far traffic has driven this generation. */
  private trafficTravel = 0;
  /** Best fitness per car: distance gained on the traffic, so tailgating scores nothing. */
  private scores = new Map<Car, number>();
  /** Cars the leader had passed at its best moment (counting after a crash would undercount). */
  private leaderPassed = 0;
  private penalties = new Map<Car, number>();
  /** Lane each AI car is holding or moving into. */
  private targets = new Map<Car, number>();
  private lane = new Map<Car, { frames: number; inLane: number }>();

  constructor(roadX: number, roadWidth: number, public settings: SimSettings, parent: Parent | null) {
    this.road = new Road(roadX, roadWidth, 3);
    this.parent = parent;
    this.reset();
  }

  /** Builds a fresh generation on the same seeded course. */
  reset(): void {
    this.cars.forEach((c) => c.dispose());
    this.course = new TrafficCourse(this.road, this.settings.seed, this.settings.layout ?? "endless");
    const x = this.road.getLaneCenter(1);

    if (this.mode === "KEYS") {
      this.cars = [new Car(x, 100, 30, 50, "KEYS", 3, 0.2, 0.05, LANE_INPUTS, HIDDEN)];
    } else {
      const n = this.settings.population;
      const immigrants = this.parent ? Math.floor(n * IMMIGRANTS) : 0;
      this.cars = Array.from({ length: n }, (_, i) => {
        const car = new Car(x, 100, 30, 50, "AI", 3, 0.2, 0.05, LANE_INPUTS, HIDDEN);
        // The last few cars keep their random brains as immigrants.
        if (this.parent && i < n - immigrants) {
          car.brain = NeuralNetwork.fromJSON(this.parent.brain);
          // Car 0 keeps the parent's brain unchanged so a generation never does worse than the last.
          if (i > 0) NeuralNetwork.mutate(car.brain, this.mutationNow());
        }
        return car;
      });
    }
    this.leader = this.cars[0];
    this.leaderBest = 0;
    this.framesSinceLeaderGain = 0;
    this.trafficTravel = 0;
    this.scores = new Map(this.cars.map((c) => [c, 0]));
    this.leaderPassed = 0;
    this.penalties = new Map(this.cars.map((c) => [c, 0]));
    this.targets = new Map(this.cars.map((c) => [c, 1]));
    for (const car of this.cars) {
      if (car.type !== "AI") continue;
      // Aim at a point down the road in the target lane.
      car.assist = (c) => Math.atan2(-(this.road.getLaneCenter(this.targets.get(c) ?? 1) - c.x), LOOKAHEAD);
    }
    this.lane = new Map(this.cars.map((c) => [c, { frames: 0, inLane: 0 }]));
  }

  /** Signed offset from the nearest lane center: 0 at the center, ±1 on a lane line. */
  laneOffset(car: Car): number {
    const w = this.road.width / this.road.laneCount;
    const lane = Math.max(0, Math.min(this.road.laneCount - 1, Math.floor((car.x - this.road.left) / w)));
    return (car.x - this.road.getLaneCenter(lane)) / (w / 2);
  }

  /** Offset from the center of the lane the car is heading for. */
  private targetOffset(car: Car): number {
    const w = this.road.width / this.road.laneCount;
    return (car.x - this.road.getLaneCenter(this.targets.get(car) ?? 1)) / (w / 2);
  }

  /** The brain's extra inputs: speed, which lane it holds (-1 left, 0 middle, 1 right), and whether it is changing lanes. */
  laneInputs(car: Car): number[] {
    const target = this.targets.get(car) ?? 1;
    const changing = Math.abs(this.targetOffset(car)) > 0.2 ? 1 : 0;
    return [car.speed / car.maxSpeed, target - (this.road.laneCount - 1) / 2, changing];
  }

  /**
   * Turns the brain's left/right outputs into lane-change requests. A second change can start
   * once the car is mostly into its new lane, so it can sweep across two lanes in one move.
   */
  private handleLaneChange(car: Car): void {
    if (car.type !== "AI" || car.damaged || Math.abs(this.targetOffset(car)) > 0.6) return;
    const [, left, right] = car.outputs;
    const target = this.targets.get(car) ?? 1;
    let next = target;
    if (left && !right) next = target - 1;
    if (right && !left) next = target + 1;
    if (next !== target && next >= 0 && next < this.road.laneCount) {
      this.targets.set(car, next);
      this.penalties.set(car, (this.penalties.get(car) ?? 0) + LANE_CHANGE_COST);
    }
  }

  /** Share of a car's driving time spent inside a lane. */
  inLaneShare(car: Car): number {
    const l = this.lane.get(car);
    return l && l.frames ? l.inLane / l.frames : 0;
  }

  /**
   * Fitness on the highway. Raw distance rewards a car for sitting behind traffic, because
   * traffic moves forward too; that brain never learns to overtake and eventually rear-ends
   * the car ahead. Scoring distance gained on the traffic makes overtaking the only way up.
   */
  score(car: Car): number {
    return this.scores.get(car) ?? 0;
  }

  /** True once the leader, still driving, has passed every car in the fixed course layout. */
  clearedCourse(): boolean {
    if (this.course.layout !== "course" || this.course.cars.length === 0) return false;
    return !this.leader.damaged && this.passedBy(this.leader) === this.course.cars.length;
  }

  /** Traffic cars fully behind this car. */
  passedBy(car: Car): number {
    return this.course.cars.filter((t) => t.y > car.y + car.height).length;
  }

  /** Best count of cars passed by this generation's leader so far. */
  get bestPassed(): number {
    return this.leaderPassed;
  }

  /** The slider's mutation, raised by half again for each generation that brought no improvement (capped at 1). */
  mutationNow(): number {
    return Math.min(1, this.settings.mutation * (1 + 0.5 * this.stagnant));
  }

  get alive(): number {
    return this.cars.filter((c) => !c.damaged).length;
  }

  /** Advances one frame. Returns true when the generation just ended. */
  step(): boolean {
    this.course.extend(this.leader.y);
    this.course.update();
    this.trafficTravel += this.course.cars[0]?.speed ?? 0;
    for (const car of this.cars) {
      this.handleLaneChange(car);
      car.update(this.road.borders, this.course.near(car.y), this.laneInputs(car));
      if (!car.damaged) {
        const l = this.lane.get(car)!;
        l.frames++;
        if (Math.abs(this.laneOffset(car)) <= LANE_SLACK) l.inLane++;
      }
      const fitness = car.progress - this.trafficTravel - (this.penalties.get(car) ?? 0);
      if (fitness > (this.scores.get(car) ?? 0)) this.scores.set(car, fitness);
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

    const cleared = this.clearedCourse();
    if (this.alive === 0 || this.framesSinceLeaderGain > LEADER_PATIENCE || cleared) {
      this.lastCleared = cleared;
      this.nextGeneration();
      return true;
    }
    return false;
  }

  /** Keeps the leader's brain if it beat the parent, then breeds the next generation. */
  nextGeneration(): void {
    const best = this.leader;
    const fitness = this.score(best);
    this.history.push({
      generation: this.generation,
      lead: fitness,
      passed: Math.max(this.leaderPassed, this.passedBy(best)),
      cleared: this.clearedCourse(),
    });
    if (this.history.length > 400) this.history.shift();
    if (best.brain && (!this.parent || fitness > this.parent.progress + 1)) {
      this.parent = {
        brain: best.brain.toJSON(),
        progress: fitness,
        passed: Math.max(this.leaderPassed, this.passedBy(best)),
        inLane: this.inLaneShare(best),
      };
      this.stagnant = 0;
    } else {
      this.stagnant++;
    }
    this.generation++;
    this.reset();
  }

  setMode(mode: DriveMode): void {
    this.mode = mode;
    this.reset();
  }

  forget(): void {
    this.parent = null;
    this.generation = 1;
    this.history = [];
    this.stagnant = 0;
    this.reset();
  }
}
