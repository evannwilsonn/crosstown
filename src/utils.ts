export interface Point {
  x: number;
  y: number;
}

/** Where two segments cross, plus how far along the first segment (0..1) the hit is. */
export interface Touch extends Point {
  offset: number;
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Intersection of segment AB with segment CD, or null if they do not cross. */
export function getIntersection(A: Point, B: Point, C: Point, D: Point): Touch | null {
  const tTop = (D.x - C.x) * (A.y - C.y) - (D.y - C.y) * (A.x - C.x);
  const uTop = (C.y - A.y) * (A.x - B.x) - (C.x - A.x) * (A.y - B.y);
  const bottom = (D.y - C.y) * (B.x - A.x) - (D.x - C.x) * (B.y - A.y);

  if (bottom === 0) return null;
  const t = tTop / bottom;
  const u = uTop / bottom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;

  return { x: lerp(A.x, B.x, t), y: lerp(A.y, B.y, t), offset: t };
}

/** True when any edge of polygon a crosses any edge of polygon b. */
export function polysIntersect(a: Point[], b: Point[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (getIntersection(a1, a2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

/** Small deterministic RNG so every generation faces the same course. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
