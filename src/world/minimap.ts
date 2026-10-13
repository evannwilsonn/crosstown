import type { Car } from "../car";
import type { Point } from "./geom";
import type { Graph } from "./graph";

export interface MinimapPaint {
  road: string;
  car: string;
  view: string;
}

/** Overview of the road network around `center`, with the visible area outlined. */
export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  graph: Graph,
  center: Point,
  view: { width: number; height: number },
  cars: Car[],
  leader: Car | null,
  paint: MinimapPaint,
  scale = 0.08,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-center.x, -center.y);

  ctx.strokeStyle = paint.road;
  ctx.lineWidth = 3 / scale;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (const s of graph.segments) {
    ctx.moveTo(s.p1.x, s.p1.y);
    ctx.lineTo(s.p2.x, s.p2.y);
  }
  ctx.stroke();

  ctx.fillStyle = paint.car;
  ctx.globalAlpha = 0.35;
  for (const c of cars) {
    if (c === leader || c.damaged) continue;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 2.5 / scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (leader) {
    ctx.beginPath();
    ctx.arc(leader.x, leader.y, 5 / scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // The main view's footprint, always centered.
  const vw = Math.min(width - 4, view.width * scale);
  const vh = Math.min(height - 4, view.height * scale);
  ctx.strokeStyle = paint.view;
  ctx.lineWidth = 1.5;
  ctx.strokeRect((width - vw) / 2, (height - vh) / 2, vw, vh);
}
