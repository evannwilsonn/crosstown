import type { Road } from "./road";
import type { Hazard } from "./world/hazards";
import { mulberry32 } from "./utils";

/**
 * How a highway looks. Scenery sits beyond the shoulders, so it never touches the driving: the
 * sensors only see the road edges and other cars. It is placed from a hash of its position, so
 * the same stretch of road always looks the same while the camera moves along it.
 */
export interface HighwayTheme {
  name: string;
  /** Ground beyond the road; empty strings keep the page's original colors. */
  ground: string;
  shoulder: string;
  asphalt: string;
  /** Paint for the learning cars that aren't leading, chosen to show on this ground. */
  ghost: string;
  night?: boolean;
  /** The weather this road brings on its third level: it changes the driving, not just the look. */
  hazard?: Hazard;
  scenery: (ctx: CanvasRenderingContext2D, road: Road, viewTop: number, viewBottom: number, seed: number) => void;
}

const SLICE = 70;

/** Calls `place` for each slice of roadside in view, with a random source stable for that slice. */
function roadside(
  road: Road,
  viewTop: number,
  viewBottom: number,
  seed: number,
  place: (side: -1 | 1, edgeX: number, y: number, rand: () => number) => void,
): void {
  const first = Math.floor(viewTop / SLICE) - 1;
  const last = Math.ceil(viewBottom / SLICE) + 1;
  for (let k = first; k <= last; k++) {
    const y = k * SLICE;
    for (const side of [-1, 1] as const) {
      const rand = mulberry32((seed ^ Math.imul(k, 0x27d4eb2d) ^ (side > 0 ? 0x165667b1 : 0)) >>> 0);
      const edgeX = side < 0 ? road.leftAt(y) - 18 : road.rightAt(y) + 18;
      place(side, edgeX, y + rand() * SLICE, rand);
    }
  }
}

function rock(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rand: () => number, fill: string, shade: string): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const rr = r * (0.7 + rand() * 0.4);
    if (i) ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.8);
    else ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.8);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.ellipse(x + r * 0.2, y + r * 0.25, r * 0.5, r * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
}

function cactus(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.strokeStyle = "#3f7a3a";
  ctx.lineCap = "round";
  ctx.lineWidth = 7 * s;
  ctx.beginPath();
  ctx.moveTo(x, y + 16 * s);
  ctx.lineTo(x, y - 16 * s);
  ctx.moveTo(x - 9 * s, y - 6 * s);
  ctx.lineTo(x - 9 * s, y + 2 * s);
  ctx.lineTo(x, y + 2 * s);
  ctx.moveTo(x + 9 * s, y - 10 * s);
  ctx.lineTo(x + 9 * s, y - 2 * s);
  ctx.lineTo(x, y - 2 * s);
  ctx.stroke();
  ctx.lineCap = "butt";
}

function palm(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, rand: () => number): void {
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.ellipse(x + 8 * s, y + 8 * s, 18 * s, 10 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#2f8a4a";
  ctx.lineWidth = 5 * s;
  ctx.lineCap = "round";
  const turn = rand() * Math.PI;
  for (let i = 0; i < 6; i++) {
    const a = turn + (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a) * 12 * s, y + Math.sin(a) * 12 * s - 4 * s, x + Math.cos(a) * 20 * s, y + Math.sin(a) * 20 * s);
    ctx.stroke();
  }
  ctx.fillStyle = "#7a5a32";
  ctx.beginPath();
  ctx.arc(x, y, 4 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineCap = "butt";
}

function pine(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  // Seen from above: a soft shadow, then three layers of boughs, darkest at the bottom.
  ctx.fillStyle = "rgba(40, 60, 80, 0.18)";
  ctx.beginPath();
  ctx.ellipse(x + 6 * s, y + 6 * s, 17 * s, 15 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  const layers = ["#1d4a37", "#245a43", "#2d6a4f"];
  layers.forEach((color, i) => {
    const r = (16 - i * 5) * s;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const rr = k % 2 ? r * 0.82 : r;
      if (k) ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      else ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  });
  // Snow caught on the top boughs.
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  for (const [dx, dy, r] of [[-4, -3, 3.2], [3, 2, 2.4], [-1, 5, 2]]) {
    ctx.beginPath();
    ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2);
    ctx.fill();
  }
}

export const HIGHWAY_THEMES: HighwayTheme[] = [
  { name: "Highway", ground: "", shoulder: "", asphalt: "", ghost: "", scenery: () => {} },
  {
    name: "Desert highway",
    hazard: "sandstorm",
    ground: "#c8a36b",
    shoulder: "#b08a55",
    asphalt: "#3b3632",
    ghost: "#2a2420",
    scenery: (ctx, road, top, bottom, seed) =>
      roadside(road, top, bottom, seed, (side, edge, y, rand) => {
        if (rand() < 0.35) return;
        const x = edge + side * (25 + rand() * 260);
        if (rand() < 0.45) cactus(ctx, x, y, 0.8 + rand() * 0.6);
        else rock(ctx, x, y, 8 + rand() * 18, rand, "#9a7b55", "#7d6244");
      }),
  },
  {
    name: "Coast road",
    hazard: "rain",
    ground: "#4f8a4f",
    shoulder: "#d9c48f",
    asphalt: "#33373b",
    ghost: "#16201a",
    scenery: (ctx, road, top, bottom, seed) => {
      // The sea on the right, beyond a strip of beach; palms on the land side.
      const ys: number[] = [];
      for (let y = Math.floor(bottom / 20) * 20 + 40; y >= top - 40; y -= 20) ys.push(y);
      const beach = (y: number) => road.rightAt(y) + 18;
      const sea = (y: number) => road.rightAt(y) + 70 + Math.sin(y / 90) * 10;
      const band = (from: (y: number) => number, fill: string) => {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ys.forEach((y, i) => (i ? ctx.lineTo(from(y), y) : ctx.moveTo(from(y), y)));
        for (let i = ys.length - 1; i >= 0; i--) ctx.lineTo(from(ys[i]) + 4000, ys[i]);
        ctx.closePath();
        ctx.fill();
      };
      band(beach, "#e6d3a0");
      band(sea, "#1f6f8b");
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 2;
      for (const y of ys) {
        if (Math.round(y / 20) % 3) continue;
        const x = sea(y) + 30 + (Math.abs(Math.round(y)) % 7) * 25;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + 10, y - 5, x + 20, y);
        ctx.stroke();
      }
      roadside(road, top, bottom, seed, (side, edge, y, rand) => {
        if (side > 0 ? rand() < 0.75 : rand() < 0.3) return;
        const x = side > 0 ? beach(y) + 25 : edge - 30 - rand() * 220;
        palm(ctx, x, y, 0.9 + rand() * 0.5, rand);
      });
    },
  },
  {
    name: "Downtown at night",
    hazard: "fog",
    ground: "#0e1016",
    shoulder: "#1b1e26",
    asphalt: "#22252d",
    ghost: "#8a93a6",
    night: true,
    scenery: (ctx, road, top, bottom, seed) =>
      roadside(road, top, bottom, seed, (side, edge, y, rand) => {
        // A tower block on every slice, set back from the road, with lit windows.
        const w = 70 + rand() * 90;
        const h = SLICE - 8;
        const gap = 40 + rand() * 30;
        const x = side < 0 ? edge - gap - w : edge + gap;
        ctx.fillStyle = rand() < 0.5 ? "#191c25" : "#1f2330";
        ctx.fillRect(x, y - h / 2, w, h);
        for (let wx = x + 6; wx < x + w - 8; wx += 12) {
          for (let wy = y - h / 2 + 6; wy < y + h / 2 - 8; wy += 12) {
            if (rand() < 0.45) continue;
            ctx.fillStyle = rand() < 0.8 ? "rgba(255, 214, 120, 0.85)" : "rgba(140, 200, 255, 0.7)";
            ctx.fillRect(wx, wy, 5, 6);
          }
        }
        // Streetlight with a warm pool of light on the shoulder.
        if (rand() < 0.6) {
          const lx = side < 0 ? edge + 6 : edge - 6;
          const glow = ctx.createRadialGradient(lx, y, 0, lx, y, 70);
          glow.addColorStop(0, "rgba(255, 196, 110, 0.32)");
          glow.addColorStop(1, "rgba(255, 196, 110, 0)");
          ctx.fillStyle = glow;
          ctx.fillRect(lx - 70, y - 70, 140, 140);
          ctx.fillStyle = "#ffd27a";
          ctx.beginPath();
          ctx.arc(lx, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }),
  },
  {
    name: "Snowy mountain pass",
    hazard: "ice",
    ground: "#e8eef2",
    shoulder: "#c9d3da",
    asphalt: "#3a4048",
    ghost: "#4a5560",
    scenery: (ctx, road, top, bottom, seed) =>
      roadside(road, top, bottom, seed, (side, edge, y, rand) => {
        // Snow banks plowed against the shoulder, then pines and boulders.
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.ellipse(edge + side * 10, y, 10 + rand() * 6, SLICE * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        if (rand() < 0.25) return;
        const x = edge + side * (40 + rand() * 240);
        if (rand() < 0.75) pine(ctx, x, y, 0.9 + rand() * 0.7);
        else rock(ctx, x, y, 10 + rand() * 14, rand, "#8a949c", "#f4f7f9");
      }),
  },
];

/**
 * The theme for a road: road 1 keeps the original look, roads 2 to 5 are the desert, the
 * coast, downtown at night and the snowy pass, and later roads cycle through those four in an
 * order that starts somewhere new each session, never repeating the theme just before.
 */
export function themeFor(road: number, seed: number): HighwayTheme {
  if (road < HIGHWAY_THEMES.length) return HIGHWAY_THEMES[road];
  const pool = HIGHWAY_THEMES.length - 1; // the four new looks
  const offset = Math.floor(mulberry32(seed)() * (pool - 1)); // never starts on the snowy pass, the theme of road 5
  return HIGHWAY_THEMES[1 + ((road - HIGHWAY_THEMES.length + offset) % pool)];
}
