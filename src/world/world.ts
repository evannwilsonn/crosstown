import { mulberry32, lerp } from "../utils";
import { add, distance, Envelope, getNearestPoint, Polygon, rightOf, samePoint, scale, Segment, type Point } from "./geom";
import { Graph, type GraphJSON } from "./graph";
import { Building, Tree, type ItemPaint } from "./items";
import { createMarking, Light, markingFromJSON, type Marking, type MarkingJSON, type MarkingType, type Paint } from "./markings";

/** Shape of a `.world` save from the course's editor (the file body inside `World.load(...)`). */
export interface CourseSave {
  graph: { points: Point[]; segments: { p1: Point; p2: Point }[] };
  roadWidth?: number;
  roadRoundness?: number;
  buildingWidth?: number;
  buildingMinLength?: number;
  spacing?: number;
  envelopes?: { skeleton: { p1: Point; p2: Point }; poly: { points: Point[] } }[];
  roadBorders?: { p1: Point; p2: Point }[];
  buildings?: { base: { points: Point[] }; height?: number }[];
  trees?: { center: Point }[];
  treeSize?: number;
  markings?: { type: string; center: Point; directionVector: Point }[];
  zoom?: number;
  offset?: Point;
}

/** Light timing from the course: each light at an intersection gets green 2 s then yellow 1 s, in turn. */
const GREEN_S = 2;
const YELLOW_S = 1;

export interface WorldSettings {
  roadWidth: number;
  roadRoundness: number;
  buildingWidth: number;
  buildingMinLength: number;
  spacing: number;
  treeSize: number;
}

export const DEFAULT_SETTINGS: WorldSettings = {
  roadWidth: 100,
  roadRoundness: 10,
  buildingWidth: 150,
  buildingMinLength: 150,
  spacing: 50,
  treeSize: 160,
};

/** Above this many roads, scenery is skipped so large imported maps stay responsive. */
export const SCENERY_LIMIT = 260;

export interface WorldJSON {
  graph: GraphJSON;
  markings: MarkingJSON[];
  /** The course keeps the viewport with the world so a reload opens where you left off. */
  view?: { zoom: number; center: Point };
}

export interface WorldPaint extends Paint {
  road: string;
  items: ItemPaint;
}

export class World {
  envelopes: Envelope[] = [];
  roadBorders: Segment[] = [];
  /** One guide per lane, pointing the way traffic drives (right-hand traffic). */
  laneGuides: Segment[] = [];
  buildings: Building[] = [];
  trees: Tree[] = [];
  markings: Marking[] = [];
  roadsVersion = -1;
  itemsVersion = -1;

  constructor(public graph: Graph, public settings: WorldSettings = DEFAULT_SETTINGS) {}

  static fromJSON(data: WorldJSON, settings = DEFAULT_SETTINGS): World {
    const world = new World(Graph.fromJSON(data.graph), settings);
    world.markings = data.markings.map((m) => markingFromJSON(m, settings.roadWidth));
    return world;
  }

  /**
   * Loads a `.world` save from the course's editor, reusing its precomputed roads and scenery
   * so large real-city maps open instantly.
   */
  static fromCourseSave(info: CourseSave, settings = DEFAULT_SETTINGS): World {
    const world = new World(Graph.fromJSON(info.graph), {
      roadWidth: info.roadWidth ?? settings.roadWidth,
      roadRoundness: info.roadRoundness ?? settings.roadRoundness,
      buildingWidth: info.buildingWidth ?? settings.buildingWidth,
      buildingMinLength: info.buildingMinLength ?? settings.buildingMinLength,
      spacing: info.spacing ?? settings.spacing,
      treeSize: info.treeSize ?? settings.treeSize,
    });
    const pt = (p: Point) => ({ x: p.x, y: p.y });
    if (info.envelopes && info.roadBorders) {
      world.envelopes = info.envelopes.map((e) => {
        const env = new Envelope(new Segment(pt(e.skeleton.p1), pt(e.skeleton.p2)), world.settings.roadWidth, 1);
        env.poly = new Polygon(e.poly.points.map(pt));
        return env;
      });
      world.roadBorders = info.roadBorders.map((b) => new Segment(pt(b.p1), pt(b.p2)));
      world.laneGuides = world.generateLaneGuides();
      world.roadsVersion = world.graph.version;
    }
    if (info.buildings || info.trees) {
      world.buildings = (info.buildings ?? []).map((b) => new Building(new Polygon(b.base.points.map(pt)), b.height));
      world.trees = (info.trees ?? []).map((t) => new Tree(pt(t.center), info.treeSize ?? world.settings.treeSize));
      world.itemsVersion = world.graph.version;
    }
    const known: MarkingType[] = ["stop", "yield", "crossing", "parking", "light", "start", "target"];
    world.markings = (info.markings ?? [])
      .filter((m) => known.includes(m.type as MarkingType))
      .map((m) => createMarking(m.type as MarkingType, pt(m.center), pt(m.directionVector), world.settings.roadWidth));
    return world;
  }

  toJSON(): WorldJSON {
    return { graph: this.graph.toJSON(), markings: this.markings.map((m) => m.toJSON()) };
  }

  get hasScenery(): boolean {
    return this.graph.segments.length <= SCENERY_LIMIT;
  }

  generateRoads(): void {
    const { roadWidth, roadRoundness } = this.settings;
    this.envelopes = this.graph.segments.map((s) => new Envelope(s, roadWidth, roadRoundness));
    this.roadBorders = Polygon.union(this.envelopes.map((e) => e.poly));
    this.laneGuides = this.generateLaneGuides();
    this.roadsVersion = this.graph.version;
  }

  generateItems(): void {
    if (this.hasScenery) {
      this.buildings = this.generateBuildings();
      this.trees = this.generateTrees();
    } else {
      this.buildings = [];
      this.trees = [];
    }
    this.itemsVersion = this.graph.version;
  }

  generateLaneGuides(): Segment[] {
    const offset = this.settings.roadWidth / 4;
    const guides: Segment[] = [];
    for (const s of this.graph.segments) {
      const r = scale(rightOf(s.directionVector()), offset);
      guides.push(new Segment(add(s.p1, r), add(s.p2, r)));
      guides.push(new Segment(add(s.p2, scale(r, -1)), add(s.p1, scale(r, -1))));
    }
    return guides;
  }

  private generateBuildings(): Building[] {
    const { roadWidth, roadRoundness, buildingWidth, buildingMinLength, spacing } = this.settings;
    const around = this.graph.segments.map(
      (s) => new Envelope(s, roadWidth + buildingWidth + spacing * 2, roadRoundness),
    );
    const guides = Polygon.union(around.map((e) => e.poly)).filter((s) => s.length() >= buildingMinLength);

    const supports: Segment[] = [];
    for (const seg of guides) {
      const len = seg.length() + spacing;
      const count = Math.floor(len / (buildingMinLength + spacing));
      const buildingLength = len / count - spacing;
      const dir = seg.directionVector();
      let q1 = seg.p1;
      let q2 = add(q1, scale(dir, buildingLength));
      supports.push(new Segment(q1, q2));
      for (let i = 2; i <= count; i++) {
        q1 = add(q2, scale(dir, spacing));
        q2 = add(q1, scale(dir, buildingLength));
        supports.push(new Segment(q1, q2));
      }
    }

    const bases = supports.map((s) => new Envelope(s, buildingWidth, 0).poly);
    for (let i = 0; i < bases.length - 1; i++) {
      for (let j = i + 1; j < bases.length; j++) {
        if (bases[i].intersectsPoly(bases[j]) || bases[i].distanceToPoly(bases[j]) < spacing - 0.001) {
          bases.splice(j, 1);
          j--;
        }
      }
    }
    return bases.map((b) => new Building(b));
  }

  private generateTrees(): Tree[] {
    const { treeSize } = this.settings;
    const rng = mulberry32(1234 + this.graph.points.length);
    const points = [
      ...this.roadBorders.flatMap((s) => [s.p1, s.p2]),
      ...this.buildings.flatMap((b) => b.base.points),
    ];
    if (points.length === 0) return [];
    const left = Math.min(...points.map((p) => p.x));
    const right = Math.max(...points.map((p) => p.x));
    const top = Math.min(...points.map((p) => p.y));
    const bottom = Math.max(...points.map((p) => p.y));
    const blocked = [...this.buildings.map((b) => b.base), ...this.envelopes.map((e) => e.poly)];

    const trees: Tree[] = [];
    let tries = 0;
    while (tries < 100) {
      const p = { x: lerp(left, right, rng()), y: lerp(top, bottom, rng()) };
      let keep = !blocked.some((poly) => poly.containsPoint(p) || poly.distanceToPoint(p) < treeSize / 2);
      if (keep) keep = !trees.some((t) => distance(t.center, p) < treeSize);
      // Keep trees near the town, not floating in empty space.
      if (keep) keep = blocked.some((poly) => poly.distanceToPoint(p) < treeSize * 2);
      if (keep) {
        trees.push(new Tree(p, treeSize));
        tries = 0;
      }
      tries++;
    }
    return trees;
  }

  /** Intersections are points where more than two roads meet. */
  private intersections(): Point[] {
    const degree = new Map<Point, number>();
    for (const s of this.graph.segments) {
      degree.set(s.p1, (degree.get(s.p1) ?? 0) + 1);
      degree.set(s.p2, (degree.get(s.p2) ?? 0) + 1);
    }
    const hubs = this.graph.points.filter((p) => (degree.get(p) ?? 0) > 2);
    return hubs.length ? hubs : this.graph.points;
  }

  /**
   * The course's controller: lights are grouped by their nearest intersection, and each group
   * cycles through its lights so only one approach is green or yellow at a time.
   */
  updateLights(time: number): void {
    const lights = this.markings.filter((m): m is Light => m instanceof Light);
    if (lights.length === 0) return;
    const hubs = this.intersections();
    const groups: { hub: Point; lights: Light[] }[] = [];
    for (const light of lights) {
      const hub = getNearestPoint(light.center, hubs) ?? light.center;
      const group = groups.find((g) => samePoint(g.hub, hub));
      if (group) group.lights.push(light);
      else groups.push({ hub, lights: [light] });
    }
    const tick = Math.floor(time);
    const phase = GREEN_S + YELLOW_S;
    for (const g of groups) {
      const t = tick % (g.lights.length * phase);
      const active = Math.floor(t / phase);
      const activeState = t % phase < GREEN_S ? "green" : "yellow";
      g.lights.forEach((light, i) => (light.state = i === active ? activeState : "red"));
    }
  }

  /** Road edges plus the stop lines of red and yellow lights, as [p1, p2] pairs for car sensors. */
  obstacles(): Point[][] {
    const out: Point[][] = this.roadBorders.map((s) => [s.p1, s.p2]);
    for (const m of this.markings) {
      if (m instanceof Light && (m.state === "red" || m.state === "yellow")) {
        const line = m.frontLine();
        out.push([line.p1, line.p2]);
      }
    }
    return out;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    viewPoint: Point,
    viewRadius: number,
    paint: WorldPaint,
    showStart = true,
  ): void {
    const near = (p: Point, pad = 0) => distance(p, viewPoint) < viewRadius + pad;

    for (const env of this.envelopes) {
      if (!near(env.skeleton.p1, env.skeleton.length() + 100)) continue;
      env.poly.path(ctx);
      ctx.fillStyle = paint.road;
      ctx.fill();
      ctx.strokeStyle = paint.road;
      ctx.lineWidth = 15;
      ctx.lineJoin = "round";
      ctx.stroke();
    }

    // Course order: markings go under the center line and road edges.
    for (const m of this.markings) {
      if (m.type === "start" && !showStart) continue;
      if (near(m.center, 60)) m.draw(ctx, paint);
    }

    ctx.setLineDash([22, 18]);
    ctx.strokeStyle = paint.yellow;
    ctx.lineWidth = 3;
    for (const s of this.graph.segments) {
      if (s.oneWay) continue; // one-way streets carry no center line
      ctx.beginPath();
      ctx.moveTo(s.p1.x, s.p1.y);
      ctx.lineTo(s.p2.x, s.p2.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.strokeStyle = paint.white;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const s of this.roadBorders) {
      ctx.moveTo(s.p1.x, s.p1.y);
      ctx.lineTo(s.p2.x, s.p2.y);
    }
    ctx.stroke();
    ctx.lineCap = "butt";
  }

  /** Buildings and trees, farthest first, drawn after cars so they occlude them. */
  drawItems(ctx: CanvasRenderingContext2D, viewPoint: Point, viewRadius: number, paint: ItemPaint): void {
    const items: (Building | Tree)[] = [...this.buildings, ...this.trees].filter(
      (i) => i.distanceTo(viewPoint) < viewRadius + 200,
    );
    items.sort((a, b) => b.distanceTo(viewPoint) - a.distanceTo(viewPoint));
    for (const item of items) item.draw(ctx, viewPoint, paint);
  }
}
