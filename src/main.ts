import "./style.css";
import { NeuralNetwork, type NetworkJSON } from "./network";
import { Simulation, isParent, type Parent } from "./simulation";
import pretrained from "./pretrained/highway.json";
import { drawNetwork } from "./visualizer";

// v4: pages start from random brains; the trained brain is opt-in.
const STORAGE_KEY = "sdc.parent.v4";
/** A brain trained offline with scripts/train.ts that clears the course layout. */
const PRETRAINED = pretrained as Parent;
const ROAD_WIDTH = 210;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const roadCanvas = $<HTMLCanvasElement>("#road");
const brainCanvas = $<HTMLCanvasElement>("#brain");
const chartCanvas = $<HTMLCanvasElement>("#chart");
const chartCtx = chartCanvas.getContext("2d")!;
const roadCtx = roadCanvas.getContext("2d")!;
const brainCtx = brainCanvas.getContext("2d")!;

const ui = {
  generation: $("#stat-generation"),
  alive: $("#stat-alive"),
  run: $("#stat-run"),
  best: $("#stat-best"),
  population: $<HTMLInputElement>("#population"),
  populationOut: $<HTMLOutputElement>("#population-out"),
  mutation: $<HTMLInputElement>("#mutation"),
  mutationOut: $<HTMLOutputElement>("#mutation-out"),
  speed: $<HTMLFieldSetElement>("#speed"),
  layout: $<HTMLFieldSetElement>("#layout"),
  sensors: $<HTMLInputElement>("#sensors"),
  drive: $<HTMLButtonElement>("#drive"),
  next: $<HTMLButtonElement>("#next"),
  forget: $<HTMLButtonElement>("#forget"),
  download: $<HTMLButtonElement>("#download"),
  pretrained: $<HTMLButtonElement>("#pretrained"),
  importBrain: $<HTMLInputElement>("#import"),
  status: $("#status"),
  brainNote: $("#brain-note"),
};

const css = getComputedStyle(document.documentElement);
const color = (name: string) => css.getPropertyValue(name).trim();
const palette = {
  asphalt: color("--asphalt"),
  white: color("--marking-white"),
  yellow: color("--marking-yellow"),
  orange: color("--construction"),
  blue: color("--sign-blue"),
  concrete: color("--concrete"),
  green: color("--sign-green"),
  shoulder: color("--shoulder"),
};

/* Storage is a convenience: the page works when it is blocked. */
function loadParent(): Parent | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const p: unknown = JSON.parse(raw);
    return isParent(p) ? p : null;
  } catch {
    return null;
  }
}
function saveParent(p: Parent | null): void {
  try {
    if (p) localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

const sim = new Simulation(0, ROAD_WIDTH, {
  population: Number(ui.population.value),
  mutation: Number(ui.mutation.value),
  seed: 2026,
  layout: "course",
}, loadParent());

/** Steps per frame, or Infinity for Max: as many steps as fit in a frame's time budget. */
let stepsPerFrame = 1;
const MAX_BUDGET_MS = 14;
let viewW = 0;
let viewH = 0;

function fitCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): [number, number] {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [width, height];
}

function resize(): void {
  [viewW, viewH] = fitCanvas(roadCanvas, roadCtx);
  fitCanvas(brainCanvas, brainCtx);
  fitCanvas(chartCanvas, chartCtx);
}
new ResizeObserver(resize).observe(roadCanvas);
new ResizeObserver(() => fitCanvas(brainCanvas, brainCtx)).observe(brainCanvas);
new ResizeObserver(() => { fitCanvas(chartCanvas, chartCtx); chartDrawn = -1; }).observe(chartCanvas);


function announce(msg: string): void {
  ui.status.textContent = msg;
}

function drawRoad(): void {
  const ctx = roadCtx;
  const leader = sim.leader;
  ctx.clearRect(0, 0, viewW, viewH);
  ctx.save();
  const scale = Math.min(1.4, Math.max(1, viewW / (ROAD_WIDTH + 120)));
  ctx.translate(viewW / 2, viewH * 0.74);
  ctx.scale(scale, scale);
  ctx.translate(0, -leader.y);

  const viewTop = leader.y - (viewH * 0.74) / scale;
  const viewBottom = leader.y + (viewH * 0.26) / scale;
  sim.road.draw(
    ctx,
    { surface: palette.asphalt, shoulder: palette.shoulder, lane: palette.white, edge: palette.white, center: palette.yellow },
    viewTop,
    viewBottom,
  );

  for (const car of sim.course.near(leader.y, viewH / scale)) car.draw(ctx, car.color ?? palette.concrete);

  ctx.globalAlpha = 0.16;
  for (const car of sim.cars) if (car !== leader) car.draw(ctx, car.damaged ? palette.concrete : palette.white);
  ctx.globalAlpha = 1;

  leader.draw(ctx, leader.damaged ? palette.concrete : palette.yellow, ui.sensors.checked ? palette.yellow : undefined);
  ctx.restore();
}

function drawBrain(now: number): void {
  const brain = sim.leader.brain;
  const { width, height } = brainCanvas.getBoundingClientRect();
  if (!brain) {
    brainCtx.clearRect(0, 0, width, height);
    return;
  }
  drawNetwork(brainCtx, brain, width, height, {
    positive: palette.yellow,
    negative: palette.blue,
    node: palette.asphalt,
    nodeOn: palette.yellow,
    label: palette.white,
  }, -now / 50);
}

/** Bars of the leader's lead on traffic per generation; cleared generations are drawn in green. */
let chartDrawn = -1;
function drawChart(): void {
  if (chartDrawn === sim.history.length) return;
  chartDrawn = sim.history.length;
  const ctx = chartCtx;
  const { width, height } = chartCanvas.getBoundingClientRect();
  ctx.clearRect(0, 0, width, height);
  const pad = { l: 4, r: 4, t: 14, b: 14 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  ctx.font = "600 10px Overpass, system-ui, sans-serif";
  ctx.fillStyle = palette.concrete;
  ctx.strokeStyle = palette.shoulder;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t + h + 0.5);
  ctx.lineTo(pad.l + w, pad.t + h + 0.5);
  ctx.stroke();
  const rows = sim.history.slice(-80);
  if (!rows.length) {
    ctx.fillText("Finished generations show up here.", pad.l, pad.t + h / 2);
    return;
  }
  const top = Math.max(100, ...rows.map((r) => r.lead));
  const slot = w / Math.max(rows.length, 20);
  rows.forEach((r, i) => {
    const bh = (Math.max(0, r.lead) / top) * h;
    ctx.fillStyle = r.cleared ? palette.green : palette.yellow;
    ctx.fillRect(pad.l + i * slot + 1, pad.t + h - bh, Math.max(1, slot - 2), bh);
  });
  ctx.fillStyle = palette.white;
  ctx.textBaseline = "top";
  ctx.fillText(`${Math.round(top / 10)} m ahead`, pad.l, 0);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = palette.concrete;
  ctx.fillText(`gen ${rows[0].generation}`, pad.l, height - 2);
  const last = `gen ${rows[rows.length - 1].generation}`;
  ctx.fillText(last, pad.l + w - ctx.measureText(last).width, height - 2);
}

let lastStats = 0;
function updateStats(now: number): void {
  if (now - lastStats < 120) return;
  lastStats = now;
  const keys = sim.mode === "KEYS";
  ui.generation.textContent = keys ? "Manual" : String(sim.generation);
  ui.alive.textContent = keys ? "1" : `${sim.alive} of ${sim.cars.length}`;
  ui.run.textContent = String(Math.max(sim.bestPassed, sim.passedBy(sim.leader)));
  ui.best.textContent = sim.parent
    ? `${sim.parent.passed ?? 0} cars, ${Math.round((sim.parent.inLane ?? 0) * 100)}% in lane`
    : "None yet";
}

function frame(now: number): void {
  const t0 = performance.now();
  for (let i = 0; i < stepsPerFrame && performance.now() - t0 < MAX_BUDGET_MS; i++) {
    if (sim.step()) {
      saveParent(sim.parent);
      if (sim.lastCleared) announce(`Generation ${sim.generation - 1} cleared all seven cars. Try Endless traffic for a harder road.`);
      else
        announce(
          sim.parent
            ? `Generation ${sim.generation} is breeding from a brain that passed ${sim.parent.passed ?? 0} cars.`
            : `Generation ${sim.generation} starts from random brains.`,
        );
    }
  }
  drawRoad();
  drawBrain(now);
  drawChart();
  updateStats(now);
  requestAnimationFrame(frame);
}

/* Controls */
ui.population.addEventListener("input", () => {
  ui.populationOut.value = ui.population.value;
});
ui.population.addEventListener("change", () => {
  sim.settings.population = Number(ui.population.value);
  sim.reset();
  announce(`Restarted generation ${sim.generation} with ${sim.settings.population} cars.`);
});
ui.mutation.addEventListener("input", () => {
  ui.mutationOut.value = `${Math.round(Number(ui.mutation.value) * 100)}%`;
  sim.settings.mutation = Number(ui.mutation.value);
});

ui.layout.addEventListener("change", (e) => {
  sim.settings.layout = (e.target as HTMLInputElement).value as "course" | "endless";
  sim.forget();
  saveParent(null);
  announce(
    sim.settings.layout === "course"
      ? "Course traffic: the seven cars from the video. Learning restarted."
      : "Endless traffic: seeded rows that never end. Learning restarted.",
  );
});

ui.speed.addEventListener("change", (e) => {
  const v = (e.target as HTMLInputElement).value;
  stepsPerFrame = v === "max" ? Infinity : Number(v);
});

ui.drive.addEventListener("click", () => {
  const toKeys = sim.mode === "AI";
  sim.setMode(toKeys ? "KEYS" : "AI");
  ui.drive.setAttribute("aria-pressed", String(toKeys));
  ui.drive.textContent = toKeys ? "Hand back to the cars" : "Drive it yourself";
  ui.next.disabled = toKeys;
  document.body.classList.toggle("is-manual", toKeys);
  announce(toKeys ? "You're driving. Use the arrow keys or W, A, S, D." : "The cars are driving again.");
  roadCanvas.focus();
});

ui.next.addEventListener("click", () => {
  sim.nextGeneration();
  saveParent(sim.parent);
  announce(`Skipped to generation ${sim.generation}.`);
});

ui.forget.addEventListener("click", () => {
  sim.forget();
  saveParent(null);
  announce("Learning reset. Generation 1 starts from random brains.");
});

function useBrain(p: Parent, msg: string): void {
  sim.parent = { ...p };
  sim.generation = 1;
  sim.stagnant = 0;
  sim.history = [];
  sim.reset();
  saveParent(sim.parent);
  announce(msg);
}

ui.pretrained.addEventListener("click", () => {
  if (sim.settings.layout !== "course") {
    (ui.layout.querySelector('input[value="course"]') as HTMLInputElement).checked = true;
    sim.settings.layout = "course";
  }
  useBrain(PRETRAINED, "Loaded the trained brain. Watch the yellow car weave through the seven cars.");
});

ui.importBrain.addEventListener("change", async () => {
  const file = ui.importBrain.files?.[0];
  ui.importBrain.value = "";
  if (!file) return;
  try {
    const data: unknown = JSON.parse(await file.text());
    // Accept either a saved parent or a bare brain from Copy brain JSON.
    const p = isParent(data) ? data : isParent({ brain: data, progress: 0 }) ? ({ brain: data, progress: 0 } as Parent) : null;
    if (!p) {
      announce("That file isn't a brain for this network (8 inputs, 8 hidden, 4 outputs).");
      return;
    }
    useBrain(p, `Imported ${file.name}. New generations breed from it.`);
  } catch {
    announce("Couldn't read that file as JSON.");
  }
});

ui.download.addEventListener("click", async () => {
  const brain: NetworkJSON | undefined = sim.parent?.brain ?? sim.leader.brain?.toJSON();
  if (!brain) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(brain, null, 2));
    announce("Brain copied to the clipboard as JSON.");
  } catch {
    announce("Your browser blocked clipboard access. Run sim.parent in the console to get the brain.");
  }
});

// Keep a reference so tree-shaking leaves NeuralNetwork in the bundle for console experiments.
(window as unknown as { sim: Simulation; NeuralNetwork: typeof NeuralNetwork }).sim = sim;
(window as unknown as { NeuralNetwork: typeof NeuralNetwork }).NeuralNetwork = NeuralNetwork;

announce(
  sim.parent
      ? "Picked up from the brain saved in this browser."
      : "Generation 1 starts from random brains. Try Max speed to watch them learn, or Load trained brain to see the finished result.",
);
resize();
requestAnimationFrame(frame);
