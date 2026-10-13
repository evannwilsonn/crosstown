import type { ItemPaint } from "./items";

export type WorldThemeName = "downtown" | "desert" | "snowy" | "coastal";

/** How a generated town looks: ground, road, buildings and trees. Map 1 keeps the page's own colors. */
export interface WorldTheme {
  name: string;
  ground: string;
  road: string;
  items: ItemPaint;
  /** Water along one side of town, with a beach. */
  sea?: boolean;
}

export const WORLD_THEMES: Record<WorldThemeName, WorldTheme> = {
  downtown: {
    name: "Downtown",
    ground: "#3a3d42",
    road: "#24272c",
    items: {
      wall: "#8d939c",
      wallEdge: "#5f656e",
      roof: "#6b717a",
      roofEdge: "#50555d",
      shadow: "rgba(0,0,0,0.35)",
      leafLow: [38, 70, 52],
      leafHigh: [70, 120, 86],
      roofStyle: "flat",
      heightScale: 2.2,
    },
  },
  desert: {
    name: "Desert town",
    ground: "#cfae79",
    road: "#4a443e",
    items: {
      wall: "#e3cfa5",
      wallEdge: "#b89f72",
      roof: "#d8be8c",
      roofEdge: "#b39466",
      shadow: "rgba(90,60,20,0.25)",
      leafLow: [96, 120, 70],
      leafHigh: [140, 160, 96],
      roofStyle: "flat",
      heightScale: 0.7,
      treeScale: 0.55,
    },
  },
  snowy: {
    name: "Snowy town",
    ground: "#e9eef2",
    road: "#3b4148",
    items: {
      wall: "#8c6f5a",
      wallEdge: "#5e4a3c",
      roof: "#f7f9fb",
      roofEdge: "#cfd8df",
      shadow: "rgba(40,60,80,0.18)",
      leafLow: [24, 64, 48],
      leafHigh: [235, 242, 246],
    },
  },
  coastal: {
    name: "Coastal town",
    ground: "#6fae6a",
    road: "#33383d",
    sea: true,
    items: {
      wall: "#f2efe6",
      wallEdge: "#c9c3b4",
      roof: "#3f7fb3",
      roofEdge: "#2c5f88",
      shadow: "rgba(0,0,0,0.2)",
      leafLow: [40, 110, 70],
      leafHigh: [120, 190, 110],
    },
  },
};
