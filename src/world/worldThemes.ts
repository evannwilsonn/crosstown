import type { ItemPaint, RGB } from "./items";
import type { WorldSettings } from "./world";

export type WorldThemeName = "downtown" | "desert" | "snowy" | "coastal" | "autumn";
/** Towns past the first five come back at a different time of day. */
export type TimeOfDay = "day" | "dusk" | "night";

/** Texture painted on the ground under the roads. */
export type GroundStyle =
  | { kind: "slabs"; line: string; size: number }
  | { kind: "dunes"; ripple: string; pebbles: string[] }
  | { kind: "speckle"; colors: string[]; perCell: number; size: number };

/** How a generated town looks: ground, road, buildings, trees, and what's painted on the ground. */
export interface WorldTheme {
  name: string;
  ground: string;
  road: string;
  items: ItemPaint;
  groundStyle?: GroundStyle;
  /** Water along one side of town, with a beach. */
  sea?: { water: string; sand: string };
  /** Building sizes and spacing; trees and buildings grow from these. */
  settings?: Partial<WorldSettings>;
  /** Range of building heights, as multiples of the course's. */
  heights: [number, number];
  /** Share of buildings and trees kept; the rest is open ground. */
  buildingDensity?: number;
  treeDensity?: number;
  /** Lane paint, dimmed after dark. */
  marking?: { white: string; yellow: string };
  /** Street lamps glow at junctions and cars run headlights. */
  lamps?: { color: string; strength: number };
  /** Tint over the ground and roads at dusk. */
  tint?: string;
}

const BASE: Record<WorldThemeName, WorldTheme> = {
  downtown: {
    name: "Downtown",
    ground: "#474b52",
    road: "#24272c",
    heights: [1.2, 2.6],
    settings: { buildingWidth: 130, buildingMinLength: 120, spacing: 26 },
    treeDensity: 0.45,
    groundStyle: { kind: "slabs", line: "rgba(255,255,255,0.06)", size: 90 },
    items: {
      wall: "#8d939c",
      wallEdge: "#5f656e",
      roof: "#6b717a",
      roofEdge: "#4c5259",
      shadow: "rgba(0,0,0,0.35)",
      walls: ["#8d939c", "#a6acb4", "#76818e", "#b8b2a6", "#6f7a88"],
      roofs: ["#6b717a", "#5c636c", "#7d8289"],
      windows: { dark: "#33465c", lit: "#f2d27a", litShare: 0.06 },
      roofDetail: "ac",
      leafLow: [38, 70, 52],
      leafHigh: [70, 120, 86],
      roofStyle: "flat",
      treeScale: 0.75,
    },
  },
  desert: {
    name: "Desert town",
    ground: "#d2b07a",
    road: "#4a443e",
    heights: [0.45, 0.85],
    settings: { buildingWidth: 110, buildingMinLength: 100, spacing: 45 },
    buildingDensity: 0.7,
    treeDensity: 0.9,
    groundStyle: { kind: "dunes", ripple: "rgba(150,105,55,0.28)", pebbles: ["#b8955e", "#e3c995"] },
    items: {
      wall: "#e3cfa5",
      wallEdge: "#b89f72",
      roof: "#d8be8c",
      roofEdge: "#b08e5e",
      shadow: "rgba(110,70,25,0.28)",
      walls: ["#e3cfa5", "#d9b98a", "#ead8ba", "#cfa77a", "#e0bf98"],
      roofs: ["#d8be8c", "#caa877", "#dcc79e"],
      windows: { dark: "#6b5134", lit: "#f6d58a", litShare: 0 },
      roofDetail: "parapet",
      leafLow: [62, 104, 58],
      leafHigh: [118, 160, 92],
      roofStyle: "flat",
      treeStyle: "cactus",
    },
  },
  snowy: {
    name: "Snowy town",
    ground: "#e9eef2",
    road: "#3b4148",
    heights: [0.8, 1.15],
    settings: { buildingWidth: 110, buildingMinLength: 100, spacing: 50 },
    buildingDensity: 0.8,
    groundStyle: { kind: "speckle", colors: ["#ffffff", "#d3dce4", "#c4cfd9"], perCell: 3, size: 5 },
    items: {
      wall: "#8c6f5a",
      wallEdge: "#5e4a3c",
      roof: "#f7f9fb",
      roofEdge: "#cfd8df",
      shadow: "rgba(40,60,80,0.18)",
      walls: ["#8c6f5a", "#7a5a48", "#9b7d63", "#a8553f", "#6e5546"],
      windows: { dark: "#4a3a30", lit: "#ffd98a", litShare: 0.35 },
      leafLow: [22, 60, 46],
      leafHigh: [64, 112, 84],
      treeStyle: "pine",
      snowTips: true,
    },
  },
  coastal: {
    name: "Coastal town",
    ground: "#6fae6a",
    road: "#33383d",
    heights: [0.7, 1.0],
    settings: { buildingWidth: 115, buildingMinLength: 105, spacing: 40 },
    sea: { water: "#1f6f8b", sand: "#e6d3a0" },
    groundStyle: { kind: "speckle", colors: ["#83c07c", "#5f9e5b", "#f3f0d8"], perCell: 2, size: 7 },
    items: {
      wall: "#f2efe6",
      wallEdge: "#c9c3b4",
      roof: "#3f7fb3",
      roofEdge: "#2c5f88",
      shadow: "rgba(0,0,0,0.2)",
      walls: ["#f2efe6", "#ffffff", "#e7eef3", "#f4e9d8"],
      roofs: ["#3f7fb3", "#2f6f9f", "#4b8fc0", "#357aa8"],
      windows: { dark: "#5b7a93", lit: "#ffe39a", litShare: 0.05 },
      leafLow: [40, 110, 70],
      leafHigh: [120, 190, 110],
    },
  },
  autumn: {
    name: "Autumn suburb",
    ground: "#5f6b40",
    road: "#34373a",
    heights: [0.8, 1.05],
    settings: { buildingWidth: 105, buildingMinLength: 100, spacing: 55 },
    buildingDensity: 0.85,
    treeDensity: 1,
    groundStyle: { kind: "speckle", colors: ["#c46a2b", "#d9a13a", "#a8432a", "#8a5a2a"], perCell: 6, size: 6 },
    items: {
      wall: "#e8dcc4",
      wallEdge: "#6b5a4c",
      roof: "#4a3b35",
      roofEdge: "#2e2622",
      shadow: "rgba(30,20,10,0.3)",
      walls: ["#e8dcc4", "#b5654a", "#9aa7b0", "#d9c39a", "#8f5b46", "#c9b8a0"],
      roofs: ["#4a3b35", "#5b4a3f", "#3f4448", "#5e3a30"],
      windows: { dark: "#3f4650", lit: "#ffd98a", litShare: 0.1 },
      leafLow: [150, 60, 20],
      leafHigh: [230, 120, 40],
      leaves: [
        [[150, 60, 20], [232, 122, 42]],
        [[150, 36, 28], [222, 72, 50]],
        [[166, 116, 18], [244, 196, 64]],
        [[96, 92, 40], [168, 156, 62]],
      ],
    },
  },
};

/** The towns in the order they first appear. */
export const THEME_ORDER: WorldThemeName[] = ["downtown", "desert", "snowy", "coastal", "autumn"];
export const WORLD_THEMES = BASE;

/** Which look town `map` (1 = first generated town) gets: the five themes, then again at dusk, then at night. */
export function townLook(map: number): { theme: WorldThemeName; time: TimeOfDay } {
  const i = Math.max(0, map - 1);
  const round = Math.floor(i / THEME_ORDER.length);
  const time: TimeOfDay = round === 0 ? "day" : round % 2 === 1 ? "dusk" : "night";
  return { theme: THEME_ORDER[i % THEME_ORDER.length], time };
}

/* Color helpers: themes are written for daytime and shaded for dusk and night. */
function rgbOf(color: string): RGB | null {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hex = (c: RGB) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Mixes a hex color toward `to`; other color strings (rgba shadows) pass through. */
function mix(color: string, to: RGB, t: number): string {
  const c = rgbOf(color);
  return c ? hex(mixRGB(c, to, t)) : color;
}

const NIGHT: RGB = [10, 16, 36];
/** Dusk darkens toward a warm plum, so roads stay dark and the ground warms. */
const DUSK: RGB = [46, 28, 40];

/** A theme as it looks at this time of day. */
export function themeAt(name: WorldThemeName, time: TimeOfDay = "day"): WorldTheme {
  const t = BASE[name];
  if (time === "day") return t;
  const night = time === "night";
  const to = night ? NIGHT : DUSK;
  const k = night ? 0.66 : 0.24;
  const shade = (c: string) => mix(c, to, k);
  const leaf = (c: RGB): RGB => mixRGB(c, to, k);
  const i = t.items;
  return {
    ...t,
    name: `${t.name} ${night ? "at night" : "at dusk"}`,
    ground: shade(t.ground),
    road: shade(t.road),
    sea: t.sea && { water: shade(t.sea.water), sand: shade(t.sea.sand) },
    groundStyle: shadeGround(t.groundStyle, shade),
    marking: night ? { white: "#c4c8d4", yellow: "#d2aa44" } : { white: "#efe6dc", yellow: "#efb83a" },
    lamps: { color: night ? "255,206,120" : "255,190,110", strength: night ? 0.42 : 0.16 },
    tint: night ? undefined : "rgba(255,120,60,0.10)",
    items: {
      ...i,
      wall: shade(i.wall),
      wallEdge: shade(i.wallEdge),
      roof: shade(i.roof),
      roofEdge: shade(i.roofEdge),
      walls: i.walls?.map(shade),
      roofs: i.roofs?.map(shade),
      leafLow: leaf(i.leafLow),
      leafHigh: leaf(i.leafHigh),
      leaves: i.leaves?.map(([lo, hi]) => [leaf(lo), leaf(hi)] as [RGB, RGB]),
      // After dark, homes and offices light up.
      windows: {
        dark: shade(i.windows?.dark ?? "#3a4250"),
        lit: night ? "#ffd27a" : "#ffcf86",
        litShare: night ? 0.55 : 0.28,
      },
    },
  };
}

function shadeGround(g: GroundStyle | undefined, shade: (c: string) => string): GroundStyle | undefined {
  if (!g) return g;
  if (g.kind === "dunes") return { ...g, pebbles: g.pebbles.map(shade) };
  if (g.kind === "speckle") return { ...g, colors: g.colors.map(shade) };
  return g;
}
