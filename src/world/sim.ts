import { Car } from "../car";
import { Sensor } from "../sensor";
import type { CurvePoint } from "../chart";
import { Genome, Neat, type NeatJSON } from "../neat";
import { mulberry32 } from "../utils";
import { add, distance, lerp2D, normalize, rightOf, scale, subtract, type Point } from "./geom";
import { Light, Stop, type Marking } from "./markings";
import { Navigator } from "./nav";
import {
  CROSSWALK_WAIT_FRAMES, HAZARD_NAMES, hazardTimeFactor, ICE_GRIP, onIce, pedestriansFor, RAIN_GRIP, roadCondition,
  SNOW_GRIP, townHazards, visibility, type Hazard, type IcePatch, type Pedestrian,
} from "./hazards";
import { townLook, type TimeOfDay } from "./worldThemes";
import { CityTraffic } from "./citytraffic";
import type { World } from "./world";

export type WorldDriveMode = "off" | "AI" | "KEYS";

/**
 * The world's levels never run out, and they add one challenge at a time.
 *
 * Every town has five levels. The first is easy, so the brains learn the new streets: a close
 * target on a relaxed clock. The next three each add one challenge on its own (a farther
 * target, a tighter clock, then road closures that force a detour) and the fifth stacks them
 * all. Then the town changes, and the next town's base is a notch harder. The sample town comes
 * first; its first level is the course's challenge, staying on the road, and road closures wait
 * for the second town.
 *
 * Each level picks its target at random, once, and keeps it until the level is cleared: every
 * generation faces the same test. Every trip starts from the town's Start marking. Time limits
 * come from each trip's own route (top speed plus an allowance for each turn, stop sign and
 * light), times the level's factor, which never drops below what is drivable.
 */
export type WorldStage = "survive" | "easy" | "far" | "tight" | "detour" | "hazard" | "stack";

export interface WorldLevel {
  number: number;
  name: string;
  /** Which town the level is in: 0 is the sample town. */
  map: number;
  stage: WorldStage;
  /** "survive": still driving at the time limit. "every": arrive in time on every trip of a generation. */
  goal: "survive" | "every";
  /** Shortest trip by road, in px (shorter if the town is small). */
  minTrip: number;
  /** Time limit as a multiple of the trip's ideal time. */
  timeFactor: number;
  /** Streets closed on each trip after the first, on top of the earlier trips' closures. */
  closures: number;
  /** The town's hazard, on its own level and then on the town's last level. */
  hazards: Hazard[];
  /** Dusk and night towns are dark on every level. */
  light: TimeOfDay;
}

/** The sample town has five levels; every town after it has six, one for its hazard. */
export const SAMPLE_LEVELS = 5;
export const LEVELS_PER_MAP = 6;
const TOWN_STAGES: WorldStage[] = ["easy", "far", "tight", "detour", "hazard", "stack"];
const SAMPLE_STAGES: WorldStage[] = ["survive", "easy", "far", "tight", "stack"];

/**
 * Training on a map the visitor drew or imported: one timed trip a generation from their Start
 * marking to their Target marking (or the farthest road, without one). There are no levels here,
 * and the page puts the level brains back when the visitor returns to the levels.
 */
export const CUSTOM_LEVEL: WorldLevel = {
  number: 0,
  name: "Your map",
  map: -1,
  stage: "easy",
  goal: "every",
  minTrip: 0,
  timeFactor: 2,
  closures: 0,
  hazards: [],
  light: "day",
};
/** The tightest clock: 30% over the ideal time, plus the allowances, stays drivable. */
const MIN_TIME_FACTOR = 1.3;

/** The first level number in a town. */
export function firstLevelOf(map: number): number {
  return map === 0 ? 1 : SAMPLE_LEVELS + 1 + (map - 1) * LEVELS_PER_MAP;
}

export function worldLevelSpec(n: number): WorldLevel {
  const level = Math.max(1, Math.floor(n));
  const map = level <= SAMPLE_LEVELS ? 0 : 1 + Math.floor((level - SAMPLE_LEVELS - 1) / LEVELS_PER_MAP);
  const stage = map === 0 ? SAMPLE_STAGES[level - 1] : TOWN_STAGES[(level - SAMPLE_LEVELS - 1) % LEVELS_PER_MAP];
  const look = map === 0 ? null : townLook(map);
  const light: TimeOfDay = look?.time ?? "day";
  const town = look ? townHazards(look.theme, map) : null;
  const hazards = town ? (stage === "hazard" ? town.alone : stage === "stack" ? town.stacked : []) : [];
  if (stage === "survive") {
    return { number: level, name: "Stay on the road for 45 s", map, stage, goal: "survive", minTrip: 0, timeFactor: 3, closures: 0, hazards, light };
  }
  // Each town's base is a notch harder than the last one's.
  const near = 500 + 80 * map;
  const far = Math.round(near * 1.9);
  const easy = Math.max(1.6, 2.4 - 0.08 * map);
  const tight = Math.max(MIN_TIME_FACTOR, easy - 0.45);
  const closures = map === 0 ? 0 : Math.min(3, 1 + Math.floor((map - 1) / 3));
  const spec = (name: string, minTrip: number, timeFactor: number, detours: number): WorldLevel => ({
    number: level, name, map, stage, goal: "every", minTrip, timeFactor, closures: detours, hazards, light,
  });
  const roads = closures === 1 ? "a road closes" : `${closures} roads close`;
  switch (stage) {
    case "easy": return spec(map === 0 ? "A short trip" : "New streets, a short trip", near, easy, 0);
    case "far": return spec("Farther away", far, easy, 0);
    case "tight": return spec("Beat a tighter clock", near, tight, 0);
    case "detour": return spec(`Detours: ${roads} each trip`, near, easy, closures);
    case "hazard": return spec(hazards.map((h) => HAZARD_NAMES[h]).join(" and "), near, easy, 0);
    default: return spec(map === 0 ? "Far and fast" : "Everything at once", far, tight, closures);
  }
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
  /** Which targets and closures the levels pick; Reset learning rolls a new one. */
  targetSeed?: number;
  neat: NeatJSON;
  level: number;
  generation: number;
  history?: WorldSummary[];
}

export const WORLD_RAYS = 7;
/** Seven rays across 180 degrees, the car's speed, the GPS direction, and the road condition. */
/** Plus the road condition: 0 dry, 0.5 wet, 1 icy. */
export const WORLD_INPUTS = WORLD_RAYS + 3;
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
/** Each ray's angle from straight ahead, matching the Sensor's fan (left first). */
const rayAngles = Array.from({ length: WORLD_RAYS }, (_, i) => Math.PI / 2 - (i / (WORLD_RAYS - 1)) * Math.PI);
/** Streets shorter than this are never closed: there'd be no room for the barricades. */
const MIN_CLOSED_LENGTH = 240;
/** A car that hasn't made progress for this long (1 s) isn't followed while others are moving. */
const FOLLOW_IDLE_FRAMES = 60;
/**
 * When every car still on the road has been stopped this long (2.5 s), and none is waiting at a
 * red light, the trip ends instead of waiting out each car's stall timer.
 */
const ALL_IDLE_FRAMES = 150;
/** A red light this close ahead of a stopped car means it's waiting, not stuck. */
const RED_WAIT_REACH = 90;

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
  /** This session's seed for each level's target and road closures. */
  targetSeed = (Math.random() * 2 ** 32) >>> 0;
  /** Streets closed on the trip under way, and the barricades across them. */
  closed: ReadonlySet<number> = new Set();
  barriers: Point[][] = [];
  private plan: { world: World; level: number; targetSeed: number; target: Point | null; closed: Set<number>[]; ice: IcePatch[] } | null = null;
  /** People on the crosswalks, on pedestrian levels. */
  pedestrians: Pedestrian[] = [];
  /** Patches of black ice on this level's routes, on ice levels. */
  ice: IcePatch[] = [];
  /** Other cars on the streets, on traffic levels. */
  traffic: CityTraffic | null = null;
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
    if (saved.targetSeed !== undefined) this.targetSeed = saved.targetSeed;
    this.plan = null;
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

  /** Cars still on the road that are actually moving, not stopped in place. */
  get moving(): number {
    return this.cars.filter((c) => !c.damaged && this.trips.get(c)?.arrivedAt === undefined && c.idleFrames < FOLLOW_IDLE_FRAMES).length;
  }

  /** True when a red light is just ahead of the car: it's waiting, so it isn't stuck. */
  private atRed(car: Car, lights: Light[]): boolean {
    const fx = -Math.sin(car.angle);
    const fy = -Math.cos(car.angle);
    return lights.some((l) => {
      if (l.state !== "red") return false;
      const dx = l.center.x - car.x;
      const dy = l.center.y - car.y;
      const ahead = dx * fx + dy * fy;
      return ahead > -10 && ahead < RED_WAIT_REACH && Math.abs(dx * fy - dy * fx) < 40;
    });
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
   * Where this trip starts and drives to: always from the Start marking, to the level's target,
   * with the level's road closures for this trip. Your own map uses your Target marking.
   */
  private chooseTrip(): void {
    const marking = this.start!;
    this.origin = { center: marking.center, direction: marking.direction };
    if (this.custom) {
      this.destination = this.customDestination(this.origin.center);
      this.setClosed(new Set());
      this.ice = [];
      this.pedestrians = [];
      this.traffic = null;
      return;
    }
    const plan = this.levelPlan();
    this.destination = plan.target;
    this.setClosed(plan.closed[Math.min(this.trip, plan.closed.length - 1)]);
    this.ice = plan.ice;
    const w = this.world();
    this.pedestrians = this.levelSpec.hazards.includes("pedestrians") ? pedestriansFor(w.markings, w.settings.roadWidth, this.targetSeed) : [];
    // Traffic starts the same way on every run of a trip, so each generation meets the same cars.
    this.traffic = this.levelSpec.hazards.includes("traffic")
      ? new CityTraffic(w.graph, w.markings, w.settings.roadWidth, (this.targetSeed ^ Math.imul(this.level, 7919) ^ Math.imul(this.trip + 1, 104729)) >>> 0, Math.min(18, Math.max(6, Math.round(w.graph.segments.length / 4))), this.closed, this.origin.center)
      : null;
  }

  /**
   * The level's test, picked once and kept until the level is cleared: a random target at least
   * the level's trip length away by road, and for detour levels, the streets each trip closes.
   * Trip 2 closes streets on the route trip 1 would take; trip 3 keeps those and closes more on
   * trip 2's route, so every trip needs a different way there. A street is only closed if the
   * target stays reachable. The same seed, town and level always give the same plan, so a
   * refresh keeps it.
   */
  levelPlan(): { target: Point | null; closed: Set<number>[]; ice: IcePatch[] } {
    const w = this.world();
    const p = this.plan;
    if (p && p.world === w && p.level === this.level && p.targetSeed === this.targetSeed) return p;
    const spec = this.levelSpec;
    const rand = mulberry32((this.targetSeed ^ Math.imul(this.level, 0x9e3779b1)) >>> 0);
    const start = this.start!.center;
    const facing = this.start!.direction;
    const from = new Navigator(w.graph, start);
    const startSeg = from.nearestSegment(start);
    let reach = 0;
    w.graph.points.forEach((_, i) => {
      const d = from.distanceFrom(i);
      if (d < Infinity && d > reach) reach = d;
    });
    // On a small town, the trip is capped to what the town can offer.
    const want = Math.min(spec.minTrip, reach * 0.8);
    const spots: { p: Point; d: number }[] = [];
    for (let tries = 0; tries < 160; tries++) {
      const spot = this.randomRoadSpot(rand).center;
      if (from.nearestSegment(spot) === startSeg) continue;
      const d = from.remaining(spot);
      if (d < Infinity) spots.push({ p: spot, d });
    }
    // Prefer targets just past the level's distance: far enough, but not across the town.
    spots.sort((a, b) => (a.d >= want) !== (b.d >= want) ? (a.d >= want ? -1 : 1) : a.d >= want ? a.d - b.d : b.d - a.d);
    const closuresFor = (target: Point): Set<number>[] => {
      const destSeg = new Navigator(w.graph, target).nearestSegment(target);
      // A detour should cost a few blocks, not send the car across town.
      const direct = new Navigator(w.graph, target).remaining(start, facing);
      const cap = Math.max(direct * 1.6, direct + 900);
      const closed: Set<number>[] = [new Set()];
      let current = new Set<number>();
      for (let trip = 1; trip < TRIPS_PER_GENERATION; trip++) {
        for (let k = 0; k < spec.closures; k++) {
          const route = new Navigator(w.graph, target, current).routeSegments(start, facing);
          const options = route.filter((si) => {
            const seg = w.graph.segments[si];
            return si !== startSeg && si !== destSeg && !current.has(si) && distance(seg.p1, seg.p2) >= MIN_CLOSED_LENGTH;
          });
          // Shuffle, then take the first closure that still leaves a way through.
          for (let i = options.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [options[i], options[j]] = [options[j], options[i]];
          }
          let shortest: { set: Set<number>; d: number } | null = null;
          let chosen: Set<number> | null = null;
          for (const si of options) {
            const trial = new Set(current).add(si);
            const d = new Navigator(w.graph, target, trial).remaining(start, facing);
            if (d === Infinity) continue;
            if (d <= cap) {
              chosen = trial;
              break;
            }
            if (!shortest || d < shortest.d) shortest = { set: trial, d };
          }
          // Nothing within the cap: close the street that adds the least.
          const next = chosen ?? shortest?.set;
          if (next) current = next;
        }
        closed.push(new Set(current));
      }
      return closed;
    };
    let target: Point | null = spots[0]?.p ?? null;
    let closed: Set<number>[] = [new Set()];
    if (spec.closures > 0) {
      // A detour needs a route with a street that can close and still leave a way round:
      // take the first target, in order of preference, where every later trip gets its closures.
      for (const spot of spots.slice(0, 25)) {
        const plan = closuresFor(spot.p);
        const full = plan.every((c, t) => t === 0 || c.size >= t * spec.closures);
        if (full || spot === spots[0]) {
          target = spot.p;
          closed = plan;
        }
        if (full) break;
      }
    }
    // Black ice lies on the streets the trips will drive, so every trip meets some.
    const ice: IcePatch[] = [];
    if (target && spec.hazards.includes("ice")) {
      const iced = new Set<number>();
      for (const c of closed) {
        const route = new Navigator(w.graph, target, c).routeSegments(start, facing).filter((si) => {
          const seg = w.graph.segments[si];
          return !iced.has(si) && distance(seg.p1, seg.p2) >= 180;
        });
        for (let k = 0; k < 2 && route.length; k++) {
          const si = route.splice(Math.floor(rand() * route.length), 1)[0];
          iced.add(si);
          const seg = w.graph.segments[si];
          const len = distance(seg.p1, seg.p2);
          const mid = 0.35 + rand() * 0.3;
          const half = 60 / len;
          ice.push({ a: lerp2D(seg.p1, seg.p2, mid - half), b: lerp2D(seg.p1, seg.p2, mid + half), halfWidth: w.settings.roadWidth / 2 });
        }
      }
    }
    this.plan = { world: w, level: this.level, targetSeed: this.targetSeed, target, closed, ice };
    return this.plan;
  }

  /** Closes these streets for the trip, with a barricade across each end that the sensors see. */
  private setClosed(closed: ReadonlySet<number>): void {
    const w = this.world();
    this.closed = closed;
    const width = w.settings.roadWidth;
    this.barriers = [...closed].flatMap((si) => {
      const s = w.graph.segments[si];
      const len = distance(s.p1, s.p2);
      const dir = normalize(subtract(s.p2, s.p1));
      const across = scale(rightOf(dir), width / 2);
      // Set back from each junction so the crossing street stays clear.
      const inset = Math.min(len * 0.3, width / 2 + 35);
      return [lerp2D(s.p1, s.p2, inset / len), lerp2D(s.p1, s.p2, 1 - inset / len)].map((c) => [add(c, across), subtract(c, across)]);
    });
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
    const path = nav.path(from, this.origin?.direction);
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
    const spec = this.levelSpec;
    const crossings = spec.hazards.includes("pedestrians") ? w.markings.filter((m) => m.type === "crossing" && onRoute(m)).length : 0;
    const ideal = length / 3 + turns * TURN_FRAMES + stops * STOP_FRAMES + lights * LIGHT_FRAMES + crossings * CROSSWALK_WAIT_FRAMES + START_FRAMES;
    return Math.round(ideal * spec.timeFactor * hazardTimeFactor(spec.hazards, spec.light));
  }

  private spawn(): void {
    this.cars.forEach((c) => c.dispose());
    const w = this.world();
    this.chooseTrip();
    const start = this.origin!;
    this.nav = this.destination ? new Navigator(w.graph, this.destination, this.closed) : null;
    this.startRemaining = this.nav ? this.nav.remaining(start.center, start.direction) : 0;
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
    const obstacles = this.barriers.length ? world.obstacles().concat(this.barriers) : world.obstacles();
    const nav = this.nav;
    const spec = this.levelSpec;
    for (const p of this.pedestrians) p.update(this.clock);
    this.traffic?.update();
    const movers = this.traffic ? [...this.pedestrians, ...this.traffic.cars] : this.pedestrians;
    const condition = roadCondition(spec.hazards);
    const wet = spec.hazards.includes("rain");
    const icy = spec.hazards.includes("ice");

    this.cars.forEach((car, i) => {
      const t = this.trips.get(car)!;
      if (t.arrivedAt !== undefined) return;
      if (car.damaged && car.type === "AI") return;
      if (car.sensor) car.sensor.visibility = visibility(car, rayAngles, spec.hazards, spec.light, world.graph.points);
      car.grip = wet ? RAIN_GRIP : icy ? (this.ice.length && onIce(car, this.ice) ? ICE_GRIP : SNOW_GRIP) : 1;
      const people = movers.length ? movers.filter((p) => Math.abs(p.x - car.x) < SENSOR_REACH && Math.abs(p.y - car.y) < SENSOR_REACH) : [];
      car.update(obstacles.filter((o) => near(o, car)), people, [car.speed / car.maxSpeed, this.gps(car, t), condition]);
      if (this.origin) t.far = Math.max(t.far, distance(car, this.origin.center));
      if (!nav) return;
      // Finding the nearest road is the costly part; each car does it every fourth frame.
      if ((this.frames + i) % 4 === 0 || t.segment < 0) t.segment = nav.nearestSegment(car);
      const g = nav.guide(car, t.segment, { x: -Math.sin(car.angle), y: -Math.cos(car.angle) });
      t.remaining = g.remaining;
      t.waypoint = g.waypoint;
      if (g.remaining < t.best) t.best = g.remaining;
      // Level 1 only asks cars to keep driving; there's nothing to arrive at.
      if (!car.damaged && this.destination && this.levelSpec.goal !== "survive" && distance(car, this.destination) < ARRIVE_RADIUS) {
        t.arrivedAt = this.frames;
        t.best = 0;
        car.speed = 0;
      }
    });

    this.leader = this.cars.reduce((a, b) => (this.total(b) > this.total(a) ? b : a));
    // Follow a car that is really driving: arrived, or still making progress. A car stopped in
    // place still counts as driving until it stalls out, but isn't worth watching.
    const best = (cars: Car[]) => cars.reduce((a, b) => (this.total(b) > this.total(a) ? b : a));
    const arrived = (c: Car) => this.trips.get(c)?.arrivedAt !== undefined;
    const moving = this.cars.filter((c) => arrived(c) || (!c.damaged && c.idleFrames < FOLLOW_IDLE_FRAMES));
    const alive = this.cars.filter((c) => !c.damaged);
    this.followed = moving.length ? best(moving) : alive.length ? best(alive) : this.leader;
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

    // Every car left is parked and none is at a red light: nothing more will happen this trip.
    const stuck = (() => {
      const left = this.cars.filter((c) => !c.damaged && this.trips.get(c)?.arrivedAt === undefined);
      if (!left.length || left.some((c) => c.idleFrames < ALL_IDLE_FRAMES)) return false;
      const lights = world.markings.filter((m): m is Light => m instanceof Light);
      return !left.some((c) => this.atRed(c, lights));
    })();
    let end = this.alive === 0 || stuck || this.framesSinceGain > LEADER_PATIENCE;
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
    // A fresh start picks new targets and closures too.
    this.targetSeed = (Math.random() * 2 ** 32) >>> 0;
    this.plan = null;
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
      targetSeed: this.targetSeed,
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
