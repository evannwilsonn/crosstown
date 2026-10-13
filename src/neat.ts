/**
 * NEAT: NeuroEvolution of Augmenting Topologies (Stanley & Miikkulainen, 2002).
 *
 * The course evolves the weights of a fixed 5-6-4 network. NEAT evolves the network itself:
 * every brain starts as the smallest possible one, sensors wired straight to the controls,
 * and mutations add connections and neurons only when they help. Three ideas make that work:
 *
 * - Innovation numbers. Every new connection gets a historical id, shared by every genome that
 *   makes the same change, so two different networks can be lined up gene by gene for crossover.
 * - Speciation. Brains are grouped by how similar their structure is and compete mostly inside
 *   their group, so a new neuron gets a few generations to prove itself before it is judged
 *   against brains that have had longer to tune their weights.
 * - Growth from minimal. Nothing starts with a hidden layer, so the networks stay as small as
 *   the problem allows and grow when the problem gets harder.
 *
 * Neurons use the course's step activation: a neuron fires (1) when its weighted input plus
 * its bias is above zero, otherwise it outputs 0.
 */

export type NodeKind = "input" | "output" | "hidden";

export interface NodeGene {
  id: number;
  kind: NodeKind;
  bias: number;
}

export interface ConnGene {
  /** Innovation number: the historical id of this connection. */
  inn: number;
  from: number;
  to: number;
  weight: number;
  enabled: boolean;
}

export interface GenomeJSON {
  nodes: NodeGene[];
  conns: ConnGene[];
}

/** Mutation settings. `power` scales how far weights move; the rest are per-genome chances. */
export interface MutationRates {
  power: number;
  addConnection: number;
  addNode: number;
}

const WEIGHT_LIMIT = 2;
const clampWeight = (w: number) => Math.max(-WEIGHT_LIMIT, Math.min(WEIGHT_LIMIT, w));

/** Roughly normal noise from the sum of uniforms, enough for weight perturbation. */
function noise(rand: () => number): number {
  return (rand() + rand() + rand() - 1.5) * 1.15;
}

/**
 * The shared record of structural changes. When two genomes add the same connection, or split
 * the same connection with a neuron, they get the same innovation number or neuron id.
 */
export class Innovations {
  private conns = new Map<string, number>();
  private splits = new Map<number, number>();

  constructor(public nextNode: number, public nextInn = 0) {}

  connection(from: number, to: number): number {
    const key = `${from}>${to}`;
    let inn = this.conns.get(key);
    if (inn === undefined) {
      inn = this.nextInn++;
      this.conns.set(key, inn);
    }
    return inn;
  }

  /** The neuron id for splitting connection `inn`; a fresh one if this genome already has it. */
  split(inn: number, taken: (id: number) => boolean): number {
    const known = this.splits.get(inn);
    if (known !== undefined && !taken(known)) return known;
    const id = this.nextNode++;
    if (known === undefined) this.splits.set(inn, id);
    return id;
  }

  toJSON() {
    return { nextNode: this.nextNode, nextInn: this.nextInn, conns: [...this.conns], splits: [...this.splits] };
  }

  static fromJSON(j: ReturnType<Innovations["toJSON"]>): Innovations {
    const inno = new Innovations(j.nextNode, j.nextInn);
    inno.conns = new Map(j.conns);
    inno.splits = new Map(j.splits);
    return inno;
  }
}

export class Genome {
  /** Each neuron's output from the last activation, for drawing the live network. */
  values = new Map<number, number>();
  private order: number[] | null = null;

  constructor(public nodes: NodeGene[], public conns: ConnGene[]) {}

  /** Inputs wired straight to outputs, with random weights: the smallest network that can act. */
  static minimal(inputs: number, outputs: number, inno: Innovations, rand: () => number = Math.random): Genome {
    const nodes: NodeGene[] = [];
    for (let i = 0; i < inputs; i++) nodes.push({ id: i, kind: "input", bias: 0 });
    for (let o = 0; o < outputs; o++) nodes.push({ id: inputs + o, kind: "output", bias: rand() * 2 - 1 });
    const conns: ConnGene[] = [];
    for (let i = 0; i < inputs; i++) {
      for (let o = 0; o < outputs; o++) {
        conns.push({ inn: inno.connection(i, inputs + o), from: i, to: inputs + o, weight: rand() * 2 - 1, enabled: true });
      }
    }
    return new Genome(nodes, conns);
  }

  get inputIds(): number[] {
    return this.nodes.filter((n) => n.kind === "input").map((n) => n.id);
  }

  get outputIds(): number[] {
    return this.nodes.filter((n) => n.kind === "output").map((n) => n.id);
  }

  get hiddenCount(): number {
    return this.nodes.filter((n) => n.kind === "hidden").length;
  }

  get enabledCount(): number {
    return this.conns.filter((c) => c.enabled).length;
  }

  node(id: number): NodeGene | undefined {
    return this.nodes.find((n) => n.id === id);
  }

  /** Neurons in an order where every neuron comes after everything feeding it. */
  private evaluationOrder(): number[] {
    if (this.order) return this.order;
    const incoming = new Map<number, number>(this.nodes.map((n) => [n.id, 0]));
    for (const c of this.conns) if (c.enabled) incoming.set(c.to, (incoming.get(c.to) ?? 0) + 1);
    const ready = this.nodes.filter((n) => incoming.get(n.id) === 0).map((n) => n.id);
    const order: number[] = [];
    while (ready.length) {
      const id = ready.shift()!;
      order.push(id);
      for (const c of this.conns) {
        if (!c.enabled || c.from !== id) continue;
        const left = (incoming.get(c.to) ?? 0) - 1;
        incoming.set(c.to, left);
        if (left === 0) ready.push(c.to);
      }
    }
    this.order = order;
    return order;
  }

  /** Feeds sensor readings through the network; returns one 0 or 1 per output. */
  activate(inputs: number[]): number[] {
    const values = this.values;
    values.clear();
    this.inputIds.forEach((id, i) => values.set(id, inputs[i] ?? 0));
    const byTo = new Map<number, ConnGene[]>();
    for (const c of this.conns) {
      if (!c.enabled) continue;
      const list = byTo.get(c.to);
      if (list) list.push(c);
      else byTo.set(c.to, [c]);
    }
    for (const id of this.evaluationOrder()) {
      const n = this.node(id)!;
      if (n.kind === "input") continue;
      let sum = n.bias;
      for (const c of byTo.get(id) ?? []) sum += (values.get(c.from) ?? 0) * c.weight;
      values.set(id, sum > 0 ? 1 : 0);
    }
    return this.outputIds.map((id) => values.get(id) ?? 0);
  }

  clone(): Genome {
    return new Genome(this.nodes.map((n) => ({ ...n })), this.conns.map((c) => ({ ...c })));
  }

  /** True when enabled connections lead from `start` to `target`. */
  private reaches(start: number, target: number): boolean {
    const stack = [start];
    const seen = new Set<number>();
    while (stack.length) {
      const id = stack.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const c of this.conns) if (c.enabled && c.from === id) stack.push(c.to);
    }
    return false;
  }

  /** Adds a connection between two unconnected neurons, never into an input or around a loop. */
  addConnection(inno: Innovations, rand: () => number = Math.random): boolean {
    const sources = this.nodes.filter((n) => n.kind !== "output");
    const targets = this.nodes.filter((n) => n.kind !== "input");
    for (let tries = 0; tries < 20; tries++) {
      const from = sources[Math.floor(rand() * sources.length)].id;
      const to = targets[Math.floor(rand() * targets.length)].id;
      if (from === to || this.conns.some((c) => c.from === from && c.to === to)) continue;
      if (this.reaches(to, from)) continue;
      this.conns.push({ inn: inno.connection(from, to), from, to, weight: rand() * 2 - 1, enabled: true });
      this.order = null;
      return true;
    }
    return false;
  }

  /**
   * Splits a connection with a new neuron. The old connection is disabled; the path in gets
   * weight 1 and the path out keeps the old weight, so the network behaves about the same and
   * the new neuron can be tuned from there.
   */
  addNode(inno: Innovations, rand: () => number = Math.random): boolean {
    const enabled = this.conns.filter((c) => c.enabled);
    if (!enabled.length) return false;
    const c = enabled[Math.floor(rand() * enabled.length)];
    c.enabled = false;
    const id = inno.split(c.inn, (n) => this.nodes.some((x) => x.id === n));
    this.nodes.push({ id, kind: "hidden", bias: 0 });
    this.conns.push({ inn: inno.connection(c.from, id), from: c.from, to: id, weight: 1, enabled: true });
    this.conns.push({ inn: inno.connection(id, c.to), from: id, to: c.to, weight: c.weight, enabled: true });
    this.order = null;
    return true;
  }

  /** Nudges most weights and biases a little and resets a few, then maybe grows. */
  mutate(rates: MutationRates, inno: Innovations, rand: () => number = Math.random): void {
    if (rates.power > 0) {
      for (const c of this.conns) {
        if (rand() < 0.1) c.weight = rand() * 2 - 1;
        else c.weight = clampWeight(c.weight + noise(rand) * rates.power);
      }
      for (const n of this.nodes) {
        if (n.kind === "input") continue;
        if (rand() < 0.1) n.bias = rand() * 2 - 1;
        else n.bias = clampWeight(n.bias + noise(rand) * rates.power);
      }
    }
    if (rand() < rates.addConnection) this.addConnection(inno, rand);
    if (rand() < rates.addNode) this.addNode(inno, rand);
  }

  /**
   * Child of two parents, `fitter` first. Genes both parents share are taken from either at
   * random; genes only one parent has come from the fitter one, so the child keeps its shape.
   */
  static crossover(fitter: Genome, other: Genome, rand: () => number = Math.random): Genome {
    const otherByInn = new Map(other.conns.map((c) => [c.inn, c]));
    const conns = fitter.conns.map((c) => {
      const match = otherByInn.get(c.inn);
      const gene = { ...(match && rand() < 0.5 ? match : c) };
      // A gene disabled in either parent usually stays disabled.
      gene.enabled = (c.enabled && (match?.enabled ?? true)) || rand() > 0.75;
      return gene;
    });
    const nodes = fitter.nodes.map((n) => {
      const match = other.node(n.id);
      return { ...(match && rand() < 0.5 ? match : n) };
    });
    const child = new Genome(nodes, conns);
    // Re-enabling a gene can close a loop in the child; switch those back off.
    for (const c of child.conns) {
      if (!c.enabled) continue;
      c.enabled = false;
      if (!child.reaches(c.to, c.from)) c.enabled = true;
    }
    return child;
  }

  /** How different two genomes are: unmatched genes plus the average weight gap of matched ones. */
  static distance(a: Genome, b: Genome): number {
    const bByInn = new Map(b.conns.map((c) => [c.inn, c]));
    let matching = 0;
    let weightGap = 0;
    for (const c of a.conns) {
      const m = bByInn.get(c.inn);
      if (m) {
        matching++;
        weightGap += Math.abs(c.weight - m.weight);
      }
    }
    const unmatched = a.conns.length + b.conns.length - 2 * matching;
    const size = Math.max(a.conns.length, b.conns.length);
    const n = size < 20 ? 1 : size / 20;
    return unmatched / n + 0.5 * (matching ? weightGap / matching : 0);
  }

  toJSON(): GenomeJSON {
    return { nodes: this.nodes.map((n) => ({ ...n })), conns: this.conns.map((c) => ({ ...c })) };
  }

  static fromJSON(j: GenomeJSON): Genome {
    return new Genome(j.nodes.map((n) => ({ ...n })), j.conns.map((c) => ({ ...c })));
  }
}

interface Species {
  id: number;
  representative: Genome;
  members: number[];
  /** Best raw fitness the species has reached, and generations since it improved. */
  best: number;
  stale: number;
}

export interface NeatJSON {
  inputs: number;
  outputs: number;
  genomes: GenomeJSON[];
  champion: GenomeJSON | null;
  innovations: ReturnType<Innovations["toJSON"]>;
}

/** Species that go this many generations without improving stop breeding. */
const STALE_LIMIT = 15;
/** The population aims for about this many species, adjusting how alike brains must be to share one. */
const TARGET_SPECIES = 6;

/** A population of genomes that breeds itself, one generation per `evolve` call. */
export class Neat {
  genomes: Genome[];
  /** The best genome of the last generation; it rides unchanged in slot 0 of the next one. */
  champion: Genome | null = null;
  species: Species[] = [];
  innovations: Innovations;
  rates: MutationRates = { power: 0.5, addConnection: 0.08, addNode: 0.03 };
  private threshold = 3;
  private nextSpeciesId = 1;

  constructor(public inputs: number, public outputs: number, size: number, private rand: () => number = Math.random) {
    this.innovations = new Innovations(inputs + outputs);
    this.genomes = Array.from({ length: size }, () => Genome.minimal(inputs, outputs, this.innovations, rand));
  }

  get size(): number {
    return this.genomes.length;
  }

  /** Grows or shrinks the population, filling new slots with mutated copies of the best genome. */
  resize(size: number): void {
    if (size < this.genomes.length) {
      this.genomes = this.genomes.slice(0, size);
      return;
    }
    while (this.genomes.length < size) {
      const base = (this.champion ?? this.genomes[0]).clone();
      base.mutate(this.rates, this.innovations, this.rand);
      this.genomes.push(base);
    }
  }

  /** Groups genomes into species by structural similarity. */
  private speciate(): void {
    for (const s of this.species) s.members = [];
    this.genomes.forEach((g, i) => {
      const home = this.species.find((s) => Genome.distance(g, s.representative) < this.threshold);
      if (home) home.members.push(i);
      else this.species.push({ id: this.nextSpeciesId++, representative: g, members: [i], best: -Infinity, stale: 0 });
    });
    this.species = this.species.filter((s) => s.members.length > 0);
    // Steer toward a workable number of species.
    if (this.species.length < TARGET_SPECIES) this.threshold = Math.max(0.3, this.threshold - 0.3);
    else if (this.species.length > TARGET_SPECIES) this.threshold += 0.3;
  }

  /** Breeds the next generation from this one's fitness scores (one per genome, higher is better). */
  evolve(scores: number[]): void {
    const fitness = scores.map((s) => Math.max(0, s) + 1);
    const best = fitness.indexOf(Math.max(...fitness));
    this.champion = this.genomes[best].clone();

    this.speciate();
    for (const s of this.species) {
      const top = Math.max(...s.members.map((i) => fitness[i]));
      if (top > s.best) {
        s.best = top;
        s.stale = 0;
      } else s.stale++;
    }
    // Stale species stop breeding, but the two strongest always survive.
    const ranked = [...this.species].sort((a, b) => b.best - a.best);
    this.species = ranked.filter((s, i) => i < 2 || s.stale < STALE_LIMIT);

    // Fitness sharing: a species' share of children is its members' average fitness, so one big
    // species can't crowd out a small one that is trying something new.
    const shares = this.species.map((s) => s.members.reduce((sum, i) => sum + fitness[i], 0) / s.members.length);
    const total = shares.reduce((a, b) => a + b, 0) || 1;
    const slots = this.size - 1; // slot 0 is the champion
    const counts = shares.map((sh) => Math.floor((sh / total) * slots));
    for (let k = 0; counts.reduce((a, b) => a + b, 0) < slots; k++) counts[k % counts.length]++;

    const next: Genome[] = [this.champion.clone()];
    this.species.forEach((s, si) => {
      const order = [...s.members].sort((a, b) => fitness[b] - fitness[a]);
      const parents = order.slice(0, Math.max(1, Math.ceil(order.length / 2)));
      let n = counts[si];
      // Big species keep their best member unchanged.
      if (n > 0 && order.length >= 5) {
        next.push(this.genomes[order[0]].clone());
        n--;
      }
      for (; n > 0; n--) {
        const pick = () => parents[Math.floor(this.rand() * parents.length)];
        let child: Genome;
        if (parents.length > 1 && this.rand() < 0.75) {
          let [a, b] = [pick(), pick()];
          if (fitness[b] > fitness[a]) [a, b] = [b, a];
          child = Genome.crossover(this.genomes[a], this.genomes[b], this.rand);
        } else {
          child = this.genomes[pick()].clone();
        }
        child.mutate(this.rates, this.innovations, this.rand);
        next.push(child);
      }
      // A random member represents the species next generation.
      s.representative = this.genomes[s.members[Math.floor(this.rand() * s.members.length)]].clone();
    });
    this.genomes = next.slice(0, this.size);
  }

  toJSON(): NeatJSON {
    return {
      inputs: this.inputs,
      outputs: this.outputs,
      genomes: this.genomes.map((g) => g.toJSON()),
      champion: this.champion?.toJSON() ?? null,
      innovations: this.innovations.toJSON(),
    };
  }

  static fromJSON(j: NeatJSON, rand: () => number = Math.random): Neat {
    const neat = new Neat(j.inputs, j.outputs, 0, rand);
    neat.genomes = j.genomes.map((g) => Genome.fromJSON(g));
    neat.champion = j.champion ? Genome.fromJSON(j.champion) : null;
    neat.innovations = Innovations.fromJSON(j.innovations);
    return neat;
  }
}
