/** One finished generation, as the learning curve needs it. */
export interface CurvePoint {
  generation: number;
  level: number;
  /** The generation's best fitness. */
  best: number;
  /** True when the generation's best brain had more neurons than the one before. */
  grew: boolean;
}

export interface CurveColors {
  odd: string;
  even: string;
  axis: string;
  label: string;
  muted: string;
}

/**
 * Learning curve: one bar per generation, its best fitness. Bars alternate color by level,
 * each level is labeled where it starts, and a dot marks generations whose best brain grew.
 */
export function drawLearningCurve(
  ctx: CanvasRenderingContext2D,
  history: CurvePoint[],
  width: number,
  height: number,
  colors: CurveColors,
  empty = "Each finished generation adds a bar here.",
): void {
  const rows = history.slice(-90);
  ctx.clearRect(0, 0, width, height);
  const pad = { l: 2, r: 2, t: 16, b: 16 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  ctx.font = "600 10px Overpass, system-ui, sans-serif";
  ctx.strokeStyle = colors.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t + h + 0.5);
  ctx.lineTo(pad.l + w, pad.t + h + 0.5);
  ctx.stroke();
  ctx.fillStyle = colors.muted;
  ctx.textBaseline = "alphabetic";
  if (!rows.length) {
    ctx.fillText(empty, pad.l, pad.t + h / 2);
    return;
  }
  const top = Math.max(100, ...rows.map((r) => r.best));
  const slot = w / Math.max(rows.length, 30);
  let lastLabel = -Infinity;
  rows.forEach((r, i) => {
    const x = pad.l + i * slot;
    const bh = (Math.max(0, r.best) / top) * h;
    ctx.fillStyle = r.level % 2 ? colors.odd : colors.even;
    ctx.fillRect(x + 1, pad.t + h - bh, Math.max(1, slot - 2), bh);
    if (r.grew) {
      ctx.fillStyle = colors.label;
      ctx.beginPath();
      ctx.arc(x + slot / 2, pad.t + h - bh - 4, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    // Label where each level starts; quick level-ups share one label so they don't overlap.
    if ((i === 0 || rows[i - 1].level !== r.level) && x - lastLabel > 22) {
      ctx.fillStyle = colors.label;
      ctx.fillText(r.level > 0 ? `L${r.level}` : "Your map", x + 1, pad.t - 4);
      lastLabel = x;
    }
  });
  ctx.fillStyle = colors.muted;
  ctx.fillText(`gen ${rows[0].generation}`, pad.l, height - 3);
  const last = `gen ${rows[rows.length - 1].generation}`;
  ctx.fillText(last, pad.l + w - ctx.measureText(last).width, height - 3);
}
