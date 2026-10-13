import type { Genome } from "./neat";
import type { NeuralNetwork } from "./network";
import { lerp } from "./utils";

export interface VisualizerColors {
  positive: string;
  negative: string;
  node: string;
  nodeOn: string;
  label: string;
}

const OUTPUT_LABELS = ["↑", "←", "→", "↓"];

/** The course's getRGBA: sign picks yellow or blue, magnitude picks opacity. */
function valueColor(value: number, colors: VisualizerColors, ctx: CanvasRenderingContext2D): string {
  ctx.globalAlpha = Math.min(1, Math.abs(value));
  return value >= 0 ? colors.positive : colors.negative;
}

/**
 * Draws the network bottom-up: sensor inputs at the bottom, steering outputs at the top.
 * Connections are dashed and animated with `dashOffset` (the course passes -time / 50).
 */
export function drawNetwork(
  ctx: CanvasRenderingContext2D,
  net: NeuralNetwork,
  width: number,
  height: number,
  colors: VisualizerColors,
  dashOffset = 0,
): void {
  const margin = 26;
  const levelHeight = (height - margin * 2) / net.levels.length;
  ctx.clearRect(0, 0, width, height);
  ctx.lineDashOffset = dashOffset;

  for (let i = net.levels.length - 1; i >= 0; i--) {
    const top =
      margin + lerp(height - margin * 2 - levelHeight, 0, net.levels.length === 1 ? 0.5 : i / (net.levels.length - 1));
    drawLevel(ctx, net, i, margin, top, width - margin * 2, levelHeight, colors);
  }
  ctx.lineDashOffset = 0;
}

function nodeX(count: number, index: number, left: number, right: number): number {
  return lerp(left, right, count === 1 ? 0.5 : index / (count - 1));
}

function drawLevel(
  ctx: CanvasRenderingContext2D,
  net: NeuralNetwork,
  levelIndex: number,
  left: number,
  top: number,
  width: number,
  height: number,
  colors: VisualizerColors,
): void {
  const level = net.levels[levelIndex];
  const right = left + width;
  const bottom = top + height;
  const { inputs, outputs, weights, biases } = level;
  const r = 11;

  ctx.setLineDash([7, 3]);
  ctx.lineWidth = 2;
  for (let i = 0; i < inputs.length; i++) {
    for (let o = 0; o < outputs.length; o++) {
      ctx.beginPath();
      ctx.moveTo(nodeX(inputs.length, i, left, right), bottom);
      ctx.lineTo(nodeX(outputs.length, o, left, right), top);
      ctx.strokeStyle = valueColor(weights[i][o], colors, ctx);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Nodes: a dark disc with an inner circle colored by the value (course: 0.6r over r).
  const node = (x: number, y: number, value: number) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = colors.node;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = valueColor(value, colors, ctx);
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  for (let i = 0; i < inputs.length; i++) node(nodeX(inputs.length, i, left, right), bottom, inputs[i]);

  outputs.forEach((value, o) => {
    const x = nodeX(outputs.length, o, left, right);
    node(x, top, value);
    // Bias: dashed ring at 0.8r inside the node, colored by the threshold.
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.arc(x, top, r * 0.8, 0, Math.PI * 2);
    ctx.strokeStyle = valueColor(biases[o], colors, ctx);
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    if (levelIndex === net.levels.length - 1) {
      ctx.font = "800 15px Overpass, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = colors.node;
      ctx.strokeText(OUTPUT_LABELS[o] ?? "", x, top - r - 9);
      ctx.fillStyle = value ? colors.nodeOn : colors.label;
      ctx.fillText(OUTPUT_LABELS[o] ?? "", x, top - r - 9);
    }
  });
}

/**
 * Draws a NEAT genome, whatever shape it has grown into. Sensors sit on the bottom row and
 * controls on the top row; each hidden neuron sits one row above the deepest neuron feeding it,
 * so new neurons appear between the rows as the brain grows. Same look as the course's view.
 */
export function drawGenome(
  ctx: CanvasRenderingContext2D,
  genome: Genome,
  width: number,
  height: number,
  colors: VisualizerColors,
  dashOffset = 0,
): void {
  const margin = 26;
  ctx.clearRect(0, 0, width, height);

  // Depth of each neuron: inputs 0, everything else one more than its deepest source.
  const depth = new Map<number, number>();
  for (const n of genome.nodes) if (n.kind === "input") depth.set(n.id, 0);
  const live = genome.conns.filter((c) => c.enabled);
  for (let pass = 0; pass < genome.nodes.length; pass++) {
    let changed = false;
    for (const c of live) {
      const d = (depth.get(c.from) ?? 0) + 1;
      if (genome.node(c.to)?.kind === "hidden" && d > (depth.get(c.to) ?? 0)) {
        depth.set(c.to, d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const hidden = genome.nodes.filter((n) => n.kind === "hidden");
  for (const n of hidden) if (!depth.has(n.id)) depth.set(n.id, 1);
  const top = Math.max(1, ...hidden.map((n) => depth.get(n.id)! + 1));
  for (const n of genome.nodes) if (n.kind === "output") depth.set(n.id, top);

  const rows = new Map<number, number[]>();
  for (const n of genome.nodes) {
    const d = depth.get(n.id)!;
    rows.set(d, [...(rows.get(d) ?? []), n.id]);
  }
  const pos = new Map<number, { x: number; y: number }>();
  let r = 11;
  for (const [d, ids] of rows) {
    ids.sort((a, b) => a - b);
    const y = lerp(height - margin, margin, d / top);
    // Spread hidden rows a little inward so their links don't hide behind the input row's.
    const inset = d === 0 || d === top ? 0 : (width - margin * 2) * 0.08;
    ids.forEach((id, i) => pos.set(id, { x: nodeX(ids.length, i, margin + inset, width - margin - inset), y }));
    r = Math.min(r, Math.max(6, (width - margin * 2) / (ids.length * 2.6)));
  }

  ctx.lineDashOffset = dashOffset;
  ctx.setLineDash([7, 3]);
  ctx.lineWidth = 2;
  for (const c of live) {
    const a = pos.get(c.from);
    const b = pos.get(c.to);
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = valueColor(c.weight, colors, ctx);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  ctx.globalAlpha = 1;

  const outputs = genome.outputIds;
  for (const n of genome.nodes) {
    const p = pos.get(n.id)!;
    const value = genome.values.get(n.id) ?? 0;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = colors.node;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = valueColor(value, colors, ctx);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (n.kind === "input") continue;
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.arc(p.x, p.y, r * 0.8, 0, Math.PI * 2);
    ctx.strokeStyle = valueColor(n.bias, colors, ctx);
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const o = outputs.indexOf(n.id);
    if (o >= 0) {
      ctx.font = "800 15px Overpass, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = colors.node;
      ctx.strokeText(OUTPUT_LABELS[o] ?? "", p.x, p.y - r - 9);
      ctx.fillStyle = value ? colors.nodeOn : colors.label;
      ctx.fillText(OUTPUT_LABELS[o] ?? "", p.x, p.y - r - 9);
    }
  }
}
