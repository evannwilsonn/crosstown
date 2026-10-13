import type { Point } from "./geom";

/** Pan and zoom over the world. Wheel zooms toward the cursor; middle-drag, Space + drag or touch pans. */
export class Viewport {
  zoom = 0.6;
  center: Point = { x: 0, y: 0 };
  spaceDown = false;
  private drag: { start: Point; startCenter: Point; id: number } | null = null;

  constructor(public canvas: HTMLCanvasElement, public minZoom = 0.05, public maxZoom = 4) {
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    window.addEventListener("pointermove", (e) => this.onMove(e));
    window.addEventListener("pointerup", (e) => this.onUp(e));
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && document.activeElement === canvas) {
        this.spaceDown = true;
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") this.spaceDown = false;
    });
  }

  get isPanning(): boolean {
    return this.drag !== null;
  }

  get width(): number {
    return this.canvas.clientWidth;
  }

  get height(): number {
    return this.canvas.clientHeight;
  }

  /** Radius of the visible area in world units, for culling. */
  get viewRadius(): number {
    return Math.hypot(this.width, this.height) / 2 / this.zoom;
  }

  apply(ctx: CanvasRenderingContext2D): void {
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.center.x, -this.center.y);
  }

  toWorld(e: { clientX: number; clientY: number }): Point {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - this.width / 2) / this.zoom + this.center.x,
      y: (e.clientY - rect.top - this.height / 2) / this.zoom + this.center.y,
    };
  }

  zoomBy(factor: number, anchor?: { clientX: number; clientY: number }): void {
    const before = anchor ? this.toWorld(anchor) : this.center;
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const after = anchor ? this.toWorld(anchor) : this.center;
    this.center = { x: this.center.x + before.x - after.x, y: this.center.y + before.y - after.y };
  }

  /** Center and zoom so every point is visible. */
  fit(points: Point[]): void {
    if (points.length === 0) return;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs) + 400;
    const h = Math.max(...ys) - Math.min(...ys) + 400;
    this.center = { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 };
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, Math.min(this.width / w, this.height / h)));
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.zoomBy(Math.exp(-e.deltaY * 0.0015), e);
  }

  private onDown(e: PointerEvent): void {
    const pan = e.button === 1 || (e.button === 0 && this.spaceDown) || e.pointerType === "touch";
    if (!pan) return;
    e.preventDefault();
    this.drag = { start: { x: e.clientX, y: e.clientY }, startCenter: { ...this.center }, id: e.pointerId };
  }

  private onMove(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.center = {
      x: this.drag.startCenter.x - (e.clientX - this.drag.start.x) / this.zoom,
      y: this.drag.startCenter.y - (e.clientY - this.drag.start.y) / this.zoom,
    };
  }

  private onUp(e: PointerEvent): void {
    if (this.drag && e.pointerId === this.drag.id) this.drag = null;
  }
}
