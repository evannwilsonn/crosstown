import { Car } from "./car";
import { NeuralNetwork, type NetworkJSON } from "./network";
import { Road } from "./road";
import { TrafficCourse } from "./traffic";

export type DriveMode = "AI" | "KEYS";

export interface SimSettings {
  population: number;
  mutation: number;
  seed: number;
}

/** The brain each new generation is bred from, and how far it got. */
export interface Parent {
  brain: NetworkJSON;
  progress: number;
}

const LEADER_PATIENCE = 420; // frames the leader may go without gaining ground before the generation ends

export class Simulation {
  road: Road;
  course!: TrafficCourse;
  cars: Car[] = [];
  leader!: Car;
  generation = 1;
  mode: DriveMode = "AI";
  parent: Parent | null;

  private leaderBest = 0;
  private framesSinceLeaderGain = 0;

  constructor(roadX: number, roadWidth: number, public settings: SimSettings, parent: Parent | null) {
    this.road = new Road(roadX, roadWidth, 3);
    this.parent = parent;
    this.reset();
  }

  /** Builds a fresh generation on the same seeded course. */
  reset(): void {
    this.cars.forEach((c) => c.dispose());
    this.course = new TrafficCourse(this.road, this.settings.seed);
    const x = this.road.getLaneCenter(1);

    if (this.mode === "KEYS") {
      this.cars = [new Car(x, 100, 30, 50, "KEYS")];
    } else {
      this.cars = Array.from({ length: this.settings.population }, (_, i) => {
        const car = new Car(x, 100, 30, 50, "AI");
        if (this.parent) {
          car.brain = NeuralNetwork.fromJSON(this.parent.brain);
          // Car 0 keeps the parent's brain unchanged so a generation never does worse than the last.
          if (i > 0) NeuralNetwork.mutate(car.brain, this.settings.mutation);
        }
        return car;
      });
    }
    this.leader = this.cars[0];
    this.leaderBest = 0;
    this.framesSinceLeaderGain = 0;
  }

  get alive(): number {
    return this.cars.filter((c) => !c.damaged).length;
  }

  /** Advances one frame. Returns true when the generation just ended. */
  step(): boolean {
    this.course.extend(this.leader.y);
    this.course.update();
    for (const car of this.cars) car.update(this.road.borders, this.course.near(car.y));

    this.leader = this.cars.reduce((a, b) => (b.progress > a.progress ? b : a));
    if (this.mode === "KEYS") return false;

    if (this.leader.progress > this.leaderBest + 1) {
      this.leaderBest = this.leader.progress;
      this.framesSinceLeaderGain = 0;
    } else {
      this.framesSinceLeaderGain++;
    }

    if (this.alive === 0 || this.framesSinceLeaderGain > LEADER_PATIENCE) {
      this.nextGeneration();
      return true;
    }
    return false;
  }

  /** Keeps the leader's brain if it beat the parent, then breeds the next generation. */
  nextGeneration(): void {
    const best = this.leader;
    if (best.brain && (!this.parent || best.progress >= this.parent.progress)) {
      this.parent = { brain: best.brain.toJSON(), progress: best.progress };
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
    this.reset();
  }
}
