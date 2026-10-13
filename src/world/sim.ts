import { Car } from "../car";
import { NeuralNetwork } from "../network";
import type { Parent } from "../simulation";
import type { Point } from "./geom";
import type { Marking } from "./markings";
import type { World } from "./world";

export type WorldDriveMode = "off" | "AI" | "KEYS";

const LEADER_PATIENCE = 600;
/** Odometer fitness never stalls for a car driving in circles, so each generation also gets a time limit. */
const GENERATION_FRAMES = 60 * 45;
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

/** Spawns cars at the world's start marking and evolves them like the highway trainer (course: Integration). */
export class WorldSim {
  cars: Car[] = [];
  leader: Car | null = null;
  generation = 1;
  mode: WorldDriveMode = "off";
  population = 100;
  mutation = 0.15;
  private leaderBest = 0;
  private framesSinceGain = 0;
  private frames = 0;

  constructor(private world: () => World, public parent: Parent | null) {}

  get start(): Marking | undefined {
    return this.world().markings.find((m) => m.type === "start");
  }

  get alive(): number {
    return this.cars.filter((c) => !c.damaged).length;
  }

  /** Returns false when the world has no start marking to spawn from. */
  begin(mode: Exclude<WorldDriveMode, "off">): boolean {
    if (!this.start) return false;
    this.mode = mode;
    this.spawn();
    return true;
  }

  stop(): void {
    this.cars.forEach((c) => c.dispose());
    this.cars = [];
    this.leader = null;
    this.mode = "off";
  }

  private spawn(): void {
    this.cars.forEach((c) => c.dispose());
    const start = this.start!;
    const heading = Math.atan2(-start.direction.x, -start.direction.y);
    const make = (type: "AI" | "KEYS") => {
      const car = new Car(start.center.x, start.center.y, 30, 50, type);
      car.angle = heading;
      car.fitness = "odometer";
      return car;
    };
    if (this.mode === "KEYS") {
      this.cars = [make("KEYS")];
    } else {
      this.cars = Array.from({ length: this.population }, (_, i) => {
        const car = make("AI");
        if (this.parent) {
          car.brain = NeuralNetwork.fromJSON(this.parent.brain);
          if (i > 0) NeuralNetwork.mutate(car.brain, this.mutation);
        }
        return car;
      });
    }
    this.leader = this.cars[0];
    this.leaderBest = 0;
    this.framesSinceGain = 0;
    this.frames = 0;
  }

  /** Advances one frame. Returns true when a generation just ended. */
  step(): boolean {
    if (this.mode === "off" || this.cars.length === 0) return false;
    this.frames++;
    const obstacles = this.world().obstacles();
    for (const car of this.cars) {
      if (car.damaged && car.type === "AI") continue;
      car.update(obstacles.filter((o) => near(o, car)), []);
    }
    this.leader = this.cars.reduce((a, b) => (b.progress > a.progress ? b : a));
    if (this.mode === "KEYS") return false;

    if (this.leader.progress > this.leaderBest + 1) {
      this.leaderBest = this.leader.progress;
      this.framesSinceGain = 0;
    } else {
      this.framesSinceGain++;
    }
    if (this.alive === 0 || this.framesSinceGain > LEADER_PATIENCE || this.frames > GENERATION_FRAMES) {
      this.nextGeneration();
      return true;
    }
    return false;
  }

  nextGeneration(): void {
    const best = this.leader;
    if (best?.brain && (!this.parent || best.progress >= this.parent.progress)) {
      this.parent = { brain: best.brain.toJSON(), progress: best.progress };
    }
    this.generation++;
    this.spawn();
  }

  /** Breeds from this brain from now on, restarting the generation count. */
  adopt(parent: Parent): void {
    this.parent = parent;
    this.generation = 1;
    if (this.mode !== "off") this.spawn();
  }

  forget(): void {
    this.parent = null;
    this.generation = 1;
    if (this.mode !== "off") this.spawn();
  }
}
