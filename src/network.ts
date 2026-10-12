import { lerp } from "./utils";

/** One fully connected layer with a step activation. */
export class Level {
  inputs: number[];
  outputs: number[];
  biases: number[];
  weights: number[][];

  constructor(inputCount: number, outputCount: number, random: () => number = Math.random) {
    this.inputs = new Array(inputCount).fill(0);
    this.outputs = new Array(outputCount).fill(0);
    this.biases = Array.from({ length: outputCount }, () => random() * 2 - 1);
    this.weights = Array.from({ length: inputCount }, () =>
      Array.from({ length: outputCount }, () => random() * 2 - 1),
    );
  }

  static feedForward(inputs: number[], level: Level): number[] {
    level.inputs = inputs.slice();
    for (let o = 0; o < level.outputs.length; o++) {
      let sum = 0;
      for (let i = 0; i < inputs.length; i++) sum += inputs[i] * level.weights[i][o];
      level.outputs[o] = sum > level.biases[o] ? 1 : 0;
    }
    return level.outputs;
  }
}

export interface NetworkJSON {
  counts: number[];
  levels: { biases: number[]; weights: number[][] }[];
}

export class NeuralNetwork {
  levels: Level[];

  constructor(public counts: number[], random: () => number = Math.random) {
    this.levels = [];
    for (let i = 0; i < counts.length - 1; i++) {
      this.levels.push(new Level(counts[i], counts[i + 1], random));
    }
  }

  static feedForward(inputs: number[], net: NeuralNetwork): number[] {
    let out = inputs;
    for (const level of net.levels) out = Level.feedForward(out, level);
    return out;
  }

  /** Nudge every weight and bias toward a random value by `amount` (0 = unchanged, 1 = fully random). */
  static mutate(net: NeuralNetwork, amount: number, random: () => number = Math.random): void {
    if (amount <= 0) return;
    for (const level of net.levels) {
      for (let b = 0; b < level.biases.length; b++) {
        level.biases[b] = lerp(level.biases[b], random() * 2 - 1, amount);
      }
      for (const row of level.weights) {
        for (let o = 0; o < row.length; o++) row[o] = lerp(row[o], random() * 2 - 1, amount);
      }
    }
  }

  static clone(net: NeuralNetwork): NeuralNetwork {
    return NeuralNetwork.fromJSON(net.toJSON());
  }

  toJSON(): NetworkJSON {
    return {
      counts: this.counts.slice(),
      levels: this.levels.map((l) => ({
        biases: l.biases.slice(),
        weights: l.weights.map((r) => r.slice()),
      })),
    };
  }

  static fromJSON(data: NetworkJSON): NeuralNetwork {
    const net = new NeuralNetwork(data.counts);
    data.levels.forEach((l, i) => {
      net.levels[i].biases = l.biases.slice();
      net.levels[i].weights = l.weights.map((r) => r.slice());
    });
    return net;
  }
}
