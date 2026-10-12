import { lerp, type Point } from "./utils";

const INFINITY = 1_000_000;

export class Road {
  left: number;
  right: number;
  top = -INFINITY;
  bottom = INFINITY;
  borders: Point[][];

  constructor(public x: number, public width: number, public laneCount = 3) {
    this.left = x - width / 2;
    this.right = x + width / 2;
    this.borders = [
      [{ x: this.left, y: this.top }, { x: this.left, y: this.bottom }],
      [{ x: this.right, y: this.top }, { x: this.right, y: this.bottom }],
    ];
  }

  getLaneCenter(index: number): number {
    const laneWidth = this.width / this.laneCount;
    return this.left + laneWidth / 2 + Math.min(index, this.laneCount - 1) * laneWidth;
  }

  /** Draws US-style markings: yellow left edge, white right edge, dashed white lane lines. */
  draw(
    ctx: CanvasRenderingContext2D,
    colors: { surface: string; shoulder: string; lane: string; edge: string; center: string },
    viewTop: number,
    viewBottom: number,
  ): void {
    const shoulder = 18;
    ctx.fillStyle = colors.shoulder;
    ctx.fillRect(this.left - shoulder, viewTop, this.width + shoulder * 2, viewBottom - viewTop);
    ctx.fillStyle = colors.surface;
    ctx.fillRect(this.left, viewTop, this.width, viewBottom - viewTop);
    ctx.lineWidth = 4;
    ctx.strokeStyle = colors.lane;
    for (let i = 1; i < this.laneCount; i++) {
      const x = lerp(this.left, this.right, i / this.laneCount);
      ctx.setLineDash([24, 36]);
      ctx.beginPath();
      ctx.moveTo(x, this.top);
      ctx.lineTo(x, this.bottom);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = colors.center;
    ctx.beginPath();
    ctx.moveTo(this.left, this.top);
    ctx.lineTo(this.left, this.bottom);
    ctx.stroke();
    ctx.strokeStyle = colors.edge;
    ctx.beginPath();
    ctx.moveTo(this.right, this.top);
    ctx.lineTo(this.right, this.bottom);
    ctx.stroke();
  }
}
