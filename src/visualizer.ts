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

/** Draws the network bottom-up: sensor inputs at the bottom, steering outputs at the top. */
export function drawNetwork(
  ctx: CanvasRenderingContext2D,
  net: NeuralNetwork,
  width: number,
  height: number,
  colors: VisualizerColors,
): void {
  const margin = 26;
  const levelHeight = (height - margin * 2) / net.levels.length;
  ctx.clearRect(0, 0, width, height);

  for (let i = net.levels.length - 1; i >= 0; i--) {
    const top = margin + lerp(height - margin * 2 - levelHeight, 0, net.levels.length === 1 ? 0.5 : i / (net.levels.length - 1));
    drawLevel(ctx, net, i, margin, top, width - margin * 2, levelHeight, colors);
  }
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
  const r = 9;

  for (let i = 0; i < inputs.length; i++) {
    for (let o = 0; o < outputs.length; o++) {
      const w = weights[i][o];
      ctx.beginPath();
      ctx.moveTo(nodeX(inputs.length, i, left, right), bottom);
      ctx.lineTo(nodeX(outputs.length, o, left, right), top);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = w >= 0 ? colors.positive : colors.negative;
      ctx.globalAlpha = Math.min(1, Math.abs(w)) * 0.85 + 0.05;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  for (let i = 0; i < inputs.length; i++) {
    const x = nodeX(inputs.length, i, left, right);
    drawNode(ctx, x, bottom, r, inputs[i], colors);
  }

  outputs.forEach((value, o) => {
    const x = nodeX(outputs.length, o, left, right);
    drawNode(ctx, x, top, r, value, colors);
    // Bias ring: dashed outline whose color shows the threshold's sign.
    ctx.beginPath();
    ctx.arc(x, top, r + 3, 0, Math.PI * 2);
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = biases[o] >= 0 ? colors.positive : colors.negative;
    ctx.globalAlpha = Math.min(1, Math.abs(biases[o])) * 0.8 + 0.2;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    if (levelIndex === net.levels.length - 1) {
      ctx.fillStyle = value ? colors.node : colors.label;
      ctx.font = "700 12px Overpass, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(OUTPUT_LABELS[o] ?? "", x, top + 1);
    }
  });
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  value: number,
  colors: VisualizerColors,
): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = colors.node;
  ctx.fill();
  if (value > 0) {
    ctx.beginPath();
    ctx.arc(x, y, r * Math.min(1, 0.35 + value * 0.65), 0, Math.PI * 2);
    ctx.fillStyle = colors.nodeOn;
    ctx.fill();
  }
}
