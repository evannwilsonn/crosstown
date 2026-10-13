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
