import { invLerp, Segment, type Point } from "./geom";
import { Graph } from "./graph";

/** Query for overpass-turbo.eu: drivable roads inside the map view. Export the result as raw JSON. */
export const OVERPASS_QUERY = `[out:json];
(
  way['highway']
  ['highway' !~ 'pedestrian|footway|cycleway|path|service|corridor|track|steps|raceway|bridleway|proposed|construction|elevator|bus_guideway']
  ['access' !~ 'private|no']
  ({{bbox}});
);
out body;
>;
out skel;`;

interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
}
interface OsmWay {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}
export interface OsmData {
  elements: (OsmNode | OsmWay | { type: string })[];
}

/** Pixels per meter: a 100 px road is about 10 m wide. */
const PX_PER_METER = 10;

export function isOsmData(data: unknown): data is OsmData {
  return typeof data === "object" && data !== null && Array.isArray((data as OsmData).elements);
}

/** Projects OSM nodes onto a flat plane centered on the map and links consecutive way nodes. */
export function parseOsm(data: OsmData): Graph {
  const nodes = data.elements.filter((e): e is OsmNode => e.type === "node");
  const ways = data.elements.filter((e): e is OsmWay => e.type === "way");
  if (nodes.length === 0 || ways.length === 0) throw new Error("No roads found. Export the Overpass result as raw OSM JSON.");

  const lats = nodes.map((n) => n.lat);
  const lons = nodes.map((n) => n.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const deltaLat = maxLat - minLat || 1e-6;
  const deltaLon = maxLon - minLon || 1e-6;
  const height = deltaLat * 111_000 * PX_PER_METER;
  const width = (height * deltaLon * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180)) / deltaLat;

  const byId = new Map<number, Point>();
  for (const n of nodes) {
    byId.set(n.id, {
      // A map that is a single north-south (or east-west) line has zero span on one axis.
      x: maxLon > minLon ? invLerp(minLon, maxLon, n.lon) * width - width / 2 : 0,
      y: maxLat > minLat ? invLerp(maxLat, minLat, n.lat) * height - height / 2 : 0,
    });
  }

  const used = new Set<Point>();
  const segments: Segment[] = [];
  for (const way of ways) {
    // Course: a way is one-way when tagged so or when it has a single lane.
    const oneWay = way.tags?.oneway === "yes" || way.tags?.lanes === "1";
    for (let i = 1; i < way.nodes.length; i++) {
      const a = byId.get(way.nodes[i - 1]);
      const b = byId.get(way.nodes[i]);
      if (!a || !b || a === b) continue;
      segments.push(new Segment(a, b, oneWay));
      used.add(a);
      used.add(b);
    }
  }
  return new Graph([...used], segments);
}
