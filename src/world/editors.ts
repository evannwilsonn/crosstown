import { getNearestPoint, getNearestSegment, Segment, type Point } from "./geom";
import type { Graph } from "./graph";
import { createMarking, type Marking, type MarkingType, type Paint } from "./markings";
import type { Viewport } from "./viewport";
import type { World } from "./world";

export interface Editor {
  enable(): void;
  disable(): void;
  draw(ctx: CanvasRenderingContext2D, paint: Paint): void;
}

abstract class PointerEditor implements Editor {
  protected mouse: Point | null = null;
  private handlers: [string, (e: Event) => void][] = [];

  constructor(protected viewport: Viewport) {}

  enable(): void {
    const c = this.viewport.canvas;
    this.handlers = [
      ["pointerdown", (e) => this.guard(e as PointerEvent) && this.down(e as PointerEvent)],
      ["pointermove", (e) => this.move(e as PointerEvent)],
      ["pointerup", () => this.up()],
      ["contextmenu", (e) => e.preventDefault()],
    ];
    for (const [type, fn] of this.handlers) c.addEventListener(type, fn);
  }

  disable(): void {
    const c = this.viewport.canvas;
    for (const [type, fn] of this.handlers) c.removeEventListener(type, fn);
    this.handlers = [];
    this.mouse = null;
  }

  /** Ignore input that belongs to panning. */
  private guard(e: PointerEvent): boolean {
    if (e.pointerType === "touch" || e.button === 1) return false;
    if (e.button === 0 && this.viewport.spaceDown) return false;
    return true;
  }

  protected move(e: PointerEvent): void {
    this.mouse = this.viewport.toWorld(e);
  }

  protected up(): void {}
  protected abstract down(e: PointerEvent): void;
  abstract draw(ctx: CanvasRenderingContext2D, paint: Paint): void;
}

/**
 * Click empty ground to add an intersection, click another to connect them,
 * drag to move, right-click to delete (or to drop the current selection).
 */
export class GraphEditor extends PointerEditor {
  selected: Point | null = null;
  hovered: Point | null = null;
  private dragging = false;

  constructor(viewport: Viewport, private graph: () => Graph) {
    super(viewport);
  }

  override disable(): void {
    super.disable();
    this.selected = null;
    this.hovered = null;
    this.dragging = false;
  }

  protected down(e: PointerEvent): void {
    const graph = this.graph();
    if (!this.mouse) this.mouse = this.viewport.toWorld(e);
    if (e.button === 2) {
      if (this.selected) this.selected = null;
      else if (this.hovered) {
        graph.removePoint(this.hovered);
        this.hovered = null;
      }
      return;
    }
    if (e.button !== 0) return;
    if (this.hovered) {
      this.select(this.hovered);
      this.dragging = true;
      return;
    }
    const p = { x: this.mouse.x, y: this.mouse.y };
    graph.addPoint(p);
    this.select(p);
    this.hovered = p;
  }

  private select(p: Point): void {
    if (this.selected && this.selected !== p) this.graph().tryAddSegment(new Segment(this.selected, p));
    this.selected = p;
  }

  protected override move(e: PointerEvent): void {
    super.move(e);
    const graph = this.graph();
    if (this.dragging && this.selected && this.mouse) {
      this.selected.x = this.mouse.x;
      this.selected.y = this.mouse.y;
      graph.touch();
      return;
    }
    this.hovered = this.mouse ? getNearestPoint(this.mouse, graph.points, 14 / this.viewport.zoom) : null;
  }

  protected override up(): void {
    this.dragging = false;
  }

  draw(ctx: CanvasRenderingContext2D, paint: Paint): void {
    const graph = this.graph();
    const z = this.viewport.zoom;
    if (this.selected && this.mouse) {
      const to = this.hovered ?? this.mouse;
      ctx.setLineDash([8 / z, 6 / z]);
      ctx.strokeStyle = paint.yellow;
      ctx.lineWidth = 2 / z;
      ctx.beginPath();
      ctx.moveTo(this.selected.x, this.selected.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const p of graph.points) {
      const r = (p === this.hovered ? 8 : 6) / z;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = p === this.hovered ? paint.yellow : paint.white;
      ctx.fill();
      if (p === this.selected) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 12 / z, 0, Math.PI * 2);
        ctx.strokeStyle = paint.yellow;
        ctx.lineWidth = 2.5 / z;
        ctx.stroke();
      }
    }
  }
}

/** Snaps a marking preview onto the nearest lane (or road, for crossings); click to place, right-click to remove. */
export class MarkingEditor extends PointerEditor {
  private intent: Marking | null = null;

  constructor(viewport: Viewport, private world: () => World, public type: MarkingType) {
    super(viewport);
  }

  private targets(): Segment[] {
    const w = this.world();
    return this.type === "crossing" ? w.graph.segments : w.laneGuides;
  }

  protected override move(e: PointerEvent): void {
    super.move(e);
    this.intent = null;
    if (!this.mouse) return;
    const w = this.world();
    const seg = getNearestSegment(this.mouse, this.targets(), w.settings.roadWidth / 2);
    if (!seg) return;
    const proj = seg.projectPoint(this.mouse);
    if (proj.offset < 0 || proj.offset > 1) return;
    this.intent = createMarking(this.type, proj.point, seg.directionVector(), w.settings.roadWidth);
  }

  protected down(e: PointerEvent): void {
    const w = this.world();
    const mouse = this.viewport.toWorld(e);
    if (e.button === 2) {
      const i = w.markings.findIndex((m) => m.poly.containsPoint(mouse));
      if (i >= 0) w.markings.splice(i, 1);
      return;
    }
    if (e.button === 0 && this.intent) {
      w.markings.push(this.intent);
      this.intent = null;
    }
  }

  override disable(): void {
    super.disable();
    this.intent = null;
  }

  draw(ctx: CanvasRenderingContext2D, paint: Paint): void {
    if (!this.intent) return;
    ctx.globalAlpha = 0.65;
    this.intent.draw(ctx, paint);
    ctx.globalAlpha = 1;
  }
}
