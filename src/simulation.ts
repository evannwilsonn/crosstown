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
}

/** Share of each generation given fresh random brains, so a stuck population can find new moves. */
const IMMIGRANTS = 0.1;
const LEADER_PATIENCE = 420; // frames the leader may go without gaining ground before the generation ends

export class Simulation {
  road: Road;
  course!: TrafficCourse;
  cars: Car[] = [];
  leader!: Car;
  generation = 1;
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
      this.cars = [new Car(x, 100, 30, 50, "KEYS")];
    } else {
      const n = this.settings.population;
      const immigrants = this.parent ? Math.floor(n * IMMIGRANTS) : 0;
      this.cars = Array.from({ length: n }, (_, i) => {
        const car = new Car(x, 100, 30, 50, "AI");
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

    if (this.alive === 0 || this.framesSinceLeaderGain > LEADER_PATIENCE || this.clearedCourse()) {
      this.nextGeneration();
      return true;
    }
    return false;
  }

  /** Keeps the leader's brain if it beat the parent, then breeds the next generation. */
  nextGeneration(): void {
    const best = this.leader;
    const fitness = this.score(best);
    if (best.brain && (!this.parent || fitness > this.parent.progress + 1)) {
      this.parent = { brain: best.brain.toJSON(), progress: fitness, passed: Math.max(this.leaderPassed, this.passedBy(best)) };
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
    this.stagnant = 0;
    this.reset();
  }
}
