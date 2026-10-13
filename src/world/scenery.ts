import type { Car } from "../car";
import { hash2 } from "./items";
import type { Point } from "./geom";
import type { World } from "./world";
import type { WorldTheme } from "./worldThemes";
import type { ClosureStyle, Hazard, IcePatch } from "./hazards";

/**
 * What a town paints around its roads: textures on the ground, the sea, street lamps after dark,
 * headlights, and the barricades of closed roads. All of it is placed by position, so it never
 * flickers and costs nothing to remember.
 */

interface View {
  center: Point;
  radius: number;
}

/** The town's extent, padded: ground texture stops a little past the last road. */
function bounds(world: World, pad: number) {
  const xs = world.graph.points.map((p) => p.x);
  const ys = world.graph.points.map((p) => p.y);
  return { left: Math.min(...xs) - pad, right: Math.max(...xs) + pad, top: Math.min(...ys) - pad, bottom: Math.max(...ys) + pad };
}

/** Grid cells of `size` px that are in view and near the town. */
function* cells(world: World, view: View, size: number): Generator<[number, number]> {
  const b = bounds(world, 900);
  const x0 = Math.floor(Math.max(b.left, view.center.x - view.radius) / size);
  const x1 = Math.ceil(Math.min(b.right, view.center.x + view.radius) / size);
  const y0 = Math.floor(Math.max(b.top, view.center.y - view.radius) / size);
  const y1 = Math.ceil(Math.min(b.bottom, view.center.y + view.radius) / size);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) yield [cx, cy];
}

export function drawGround(ctx: CanvasRenderingContext2D, theme: WorldTheme, world: World, view: View): void {
  const g = theme.groundStyle;
  if (!g || world.graph.points.length === 0) return;
  // Fine texture is invisible when zoomed far out; skip it there.
  if (view.radius > 3200) return;
  if (g.kind === "slabs") {
    ctx.strokeStyle = g.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const b = bounds(world, 900);
    const left = Math.max(b.left, view.center.x - view.radius);
    const right = Math.min(b.right, view.center.x + view.radius);
    const top = Math.max(b.top, view.center.y - view.radius);
    const bottom = Math.min(b.bottom, view.center.y + view.radius);
    for (let x = Math.ceil(left / g.size) * g.size; x < right; x += g.size) {
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    for (let y = Math.ceil(top / g.size) * g.size; y < bottom; y += g.size) {
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
    return;
  }
  if (g.kind === "dunes") {
    // Wind ripples: short shallow arcs, all facing the same way, plus scattered pebbles.
    ctx.strokeStyle = g.ripple;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const [cx, cy] of cells(world, view, 140)) {
      const h = hash2(cx, cy, 31);
      if (h > 0.55) continue;
      const x = (cx + hash2(cx, cy, 32)) * 140;
      const y = (cy + hash2(cx, cy, 33)) * 140;
      const w = 40 + h * 70;
      ctx.moveTo(x - w / 2, y);
      ctx.quadraticCurveTo(x, y - 10, x + w / 2, y);
    }
    ctx.stroke();
    for (const [cx, cy] of cells(world, view, 90)) {
      const h = hash2(cx, cy, 34);
      if (h > 0.5) continue;
      ctx.fillStyle = g.pebbles[Math.floor(hash2(cx, cy, 35) * g.pebbles.length)];
      ctx.beginPath();
      ctx.arc((cx + hash2(cx, cy, 36)) * 90, (cy + hash2(cx, cy, 37)) * 90, 3 + h * 6, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  // Speckle: leaves, snow, flowers.
  for (const [cx, cy] of cells(world, view, 120)) {
    for (let i = 0; i < g.perCell; i++) {
      ctx.fillStyle = g.colors[Math.floor(hash2(cx, cy, 40 + i) * g.colors.length)];
      const x = (cx + hash2(cx, cy, 50 + i)) * 120;
      const y = (cy + hash2(cx, cy, 60 + i)) * 120;
      const r = g.size * (0.6 + hash2(cx, cy, 70 + i) * 0.8);
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.6, hash2(cx, cy, 80 + i) * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** A beach and the sea along the east side of town, with a few wave crests. */
export function drawSea(ctx: CanvasRenderingContext2D, theme: WorldTheme, world: World): void {
  if (!theme.sea || world.graph.points.length === 0) return;
  const b = bounds(world, 0);
  const shore = b.right + 230;
  const top = b.top - 3000;
  const bottom = b.bottom + 3000;
  ctx.fillStyle = theme.sea.sand;
  ctx.fillRect(shore, top, 160, bottom - top);
  ctx.fillStyle = theme.sea.water;
  ctx.fillRect(shore + 120, top, 6000, bottom - top);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 3;
  for (let y = top; y < bottom; y += 90) {
    const x = shore + 170 + (Math.abs(Math.round(y)) % 5) * 60;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + 18, y - 8, x + 36, y);
    ctx.stroke();
  }
}

/** Dusk: a warm wash over the ground and roads, under the buildings. */
export function drawTint(ctx: CanvasRenderingContext2D, theme: WorldTheme, view: View): void {
  if (!theme.tint) return;
  ctx.fillStyle = theme.tint;
  ctx.fillRect(view.center.x - view.radius, view.center.y - view.radius, view.radius * 2, view.radius * 2);
}

/** Street lamps: a pool of light at every junction. */
export function drawLamps(ctx: CanvasRenderingContext2D, theme: WorldTheme, world: World, view: View): void {
  if (!theme.lamps) return;
  const { color, strength } = theme.lamps;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const p of world.graph.points) {
    if (Math.abs(p.x - view.center.x) > view.radius + 200 || Math.abs(p.y - view.center.y) > view.radius + 200) continue;
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 170);
    glow.addColorStop(0, `rgba(${color},${strength})`);
    glow.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(p.x - 170, p.y - 170, 340, 340);
  }
  ctx.restore();
}

/** Headlight beams ahead of each car still driving; the followed car's are brightest. */
export function drawHeadlights(ctx: CanvasRenderingContext2D, theme: WorldTheme, cars: Car[], followed: Car | null): void {
  if (!theme.lamps) return;
  const strong = theme.lamps.strength > 0.3;
  // A pack of cars at the start would add up to a white blur; past the followed car, only a
  // few beams are drawn, and faintly.
  const others = cars.filter((c) => c !== followed && !c.damaged).slice(0, strong ? 20 : 0);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const car of followed && !followed.damaged ? [followed, ...others] : others) {
    const main = car === followed;
    const a = main ? 0.34 : 0.05;
    const reach = main ? 190 : 140;
    const fx = -Math.sin(car.angle);
    const fy = -Math.cos(car.angle);
    const nose = { x: car.x + fx * 25, y: car.y + fy * 25 };
    const beam = ctx.createRadialGradient(nose.x, nose.y, 0, nose.x, nose.y, reach);
    beam.addColorStop(0, `rgba(255,240,200,${a})`);
    beam.addColorStop(1, "rgba(255,240,200,0)");
    ctx.fillStyle = beam;
    const spread = 0.42;
    ctx.beginPath();
    ctx.moveTo(nose.x, nose.y);
    for (const s of [-spread, spread]) {
      const ang = Math.atan2(fy, fx) + s;
      ctx.lineTo(nose.x + Math.cos(ang) * reach, nose.y + Math.sin(ang) * reach);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * A closed road. Construction gets an orange wash, striped boards and cones; weather closes
 * roads its own way: snowdrifts, flooding (water over the road, boards at each end), or sand
 * drifts. The barricades are the same walls to the sensors whatever they look like.
 */
export function drawClosures(
  ctx: CanvasRenderingContext2D,
  world: World,
  closed: ReadonlySet<number>,
  barriers: Point[][],
  colors: { orange: string; white: string },
  style: ClosureStyle = "construction",
  clock = 0,
): void {
  if (closed.size === 0) return;
  ctx.save();
  const wash: Record<ClosureStyle, string> = {
    construction: "rgba(242,112,31,0.22)",
    snow: "rgba(244,248,252,0.85)",
    flood: "rgba(40,112,150,0.7)",
    sand: "rgba(214,178,120,0.85)",
  };
  for (const si of closed) {
    const s = world.graph.segments[si];
    ctx.strokeStyle = wash[style];
    if (style === "flood") {
      // Water over the road, with ripples drifting along it.
      ctx.lineWidth = world.settings.roadWidth * 0.95;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.p1.x, s.p1.y);
      ctx.lineTo(s.p2.x, s.p2.y);
      ctx.stroke();
      const len = Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y);
      ctx.strokeStyle = "rgba(220,240,250,0.45)";
      ctx.lineWidth = 2;
      for (let d = 30; d < len - 30; d += 45) {
        const t = ((d + clock * 0.3) % len) / len;
        const x = s.p1.x + (s.p2.x - s.p1.x) * t + (d % 3 - 1) * 18;
        const y = s.p1.y + (s.p2.y - s.p1.y) * t + ((d >> 1) % 3 - 1) * 14;
        ctx.beginPath();
        ctx.arc(x, y, 8, 0.2, Math.PI - 0.2);
        ctx.stroke();
      }
      continue;
    }
    ctx.lineWidth = world.settings.roadWidth * 0.8;
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.moveTo(s.p1.x, s.p1.y);
    ctx.lineTo(s.p2.x, s.p2.y);
    ctx.stroke();
  }
  if (style === "snow" || style === "sand") {
    // Drifts piled across the road: overlapping mounds with a shadowed edge.
    const [fill, shade] = style === "snow" ? ["#f7fafc", "rgba(120,150,180,0.5)"] : ["#dcb77c", "rgba(140,100,50,0.5)"];
    for (const [a, b] of barriers) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (const [color, dx, dy, grow] of [[shade, 4, 6, 0], [fill, 0, 0, 0]] as const) {
        ctx.fillStyle = color;
        for (let d = 0; d <= len; d += 14) {
          const t = d / len;
          const r = 15 + 7 * Math.sin(t * Math.PI * 3 + a.x) + grow;
          ctx.beginPath();
          ctx.arc(a.x + (b.x - a.x) * t + dx, a.y + (b.y - a.y) * t + dy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
    return;
  }
  for (const [a, b] of barriers) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(ang);
    // The board: alternating orange and white stripes.
    ctx.fillStyle = colors.white;
    ctx.fillRect(0, -7, len, 14);
    ctx.fillStyle = colors.orange;
    for (let x = 0; x < len; x += 20) {
      ctx.beginPath();
      ctx.moveTo(x, -7);
      ctx.lineTo(x + 10, -7);
      ctx.lineTo(x + 4, 7);
      ctx.lineTo(x - 6, 7);
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, -7, len, 14);
    // Cones at both ends.
    for (const x of [6, len - 6]) {
      ctx.fillStyle = colors.orange;
      ctx.beginPath();
      ctx.arc(x, 0, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colors.white;
      ctx.beginPath();
      ctx.arc(x, 0, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
}

/** Black ice: glassy pale patches across the road, with a few glints. */
export function drawIce(ctx: CanvasRenderingContext2D, patches: readonly IcePatch[]): void {
  ctx.save();
  for (const { a, b, halfWidth } of patches) {
    ctx.strokeStyle = "rgba(190,225,255,0.55)";
    ctx.lineWidth = halfWidth * 2 - 8;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 2;
    for (let k = 0; k < 4; k++) {
      const t = 0.15 + k * 0.23;
      const x = a.x + (b.x - a.x) * t + (k % 2 ? 14 : -18);
      const y = a.y + (b.y - a.y) * t + (k % 2 ? -10 : 12);
      ctx.beginPath();
      ctx.moveTo(x - 8, y - 4);
      ctx.lineTo(x + 8, y + 4);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Weather over everything: fog and sandstorms close in around the followed car (they're how far
 * the sensors can see), rain streaks down, and snow drifts on icy levels.
 */
export function drawWeather(
  ctx: CanvasRenderingContext2D,
  hazards: readonly Hazard[],
  view: View,
  focus: Point,
  clock: number,
): void {
  const left = view.center.x - view.radius;
  const top = view.center.y - view.radius;
  const size = view.radius * 2;
  const haze = hazards.includes("fog") ? "200,206,212" : hazards.includes("sandstorm") ? "214,178,120" : null;
  if (haze) {
    const fog = ctx.createRadialGradient(focus.x, focus.y, 50, focus.x, focus.y, 330);
    fog.addColorStop(0, `rgba(${haze},0.05)`);
    fog.addColorStop(0.45, `rgba(${haze},0.5)`);
    fog.addColorStop(1, `rgba(${haze},0.78)`);
    ctx.fillStyle = fog;
    ctx.fillRect(left, top, size, size);
  }
  const drift = (count: number, speedX: number, speedY: number, draw: (x: number, y: number, i: number) => void) => {
    for (let i = 0; i < count; i++) {
      const h1 = hash2(i, 7, 91);
      const h2 = hash2(i, 13, 92);
      const x = left + ((h1 * size + clock * speedX * (0.7 + h2 * 0.6)) % size + size) % size;
      const y = top + ((h2 * size + clock * speedY * (0.7 + h1 * 0.6)) % size + size) % size;
      draw(x, y, i);
    }
  };
  if (hazards.includes("rain")) {
    ctx.strokeStyle = "rgba(205,220,240,0.6)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    drift(Math.min(500, Math.round(size / 6)), 3, 14, (x, y) => {
      ctx.moveTo(x, y);
      ctx.lineTo(x - 4, y - 22);
    });
    ctx.stroke();
  }
  if (hazards.includes("sandstorm")) {
    ctx.strokeStyle = "rgba(235,205,150,0.5)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    drift(Math.min(400, Math.round(size / 8)), 9, 1.5, (x, y) => {
      ctx.moveTo(x, y);
      ctx.lineTo(x - 26, y - 3);
    });
    ctx.stroke();
  }
  if (hazards.includes("ice")) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    drift(Math.min(400, Math.round(size / 8)), 0.8, 2.2, (x, y, i) => {
      ctx.beginPath();
      ctx.arc(x, y, 2 + (i % 3), 0, Math.PI * 2);
      ctx.fill();
    });
  }
}
