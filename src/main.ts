import "./style.css";
import { NeuralNetwork, type NetworkJSON } from "./network";
import { Simulation, type Parent } from "./simulation";
import { drawNetwork } from "./visualizer";

const STORAGE_KEY = "sdc.parent.v1";
const ROAD_WIDTH = 210;
const PX_PER_METER = 10;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const roadCanvas = $<HTMLCanvasElement>("#road");
const brainCanvas = $<HTMLCanvasElement>("#brain");
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
  sensors: $<HTMLInputElement>("#sensors"),
  drive: $<HTMLButtonElement>("#drive"),
  next: $<HTMLButtonElement>("#next"),
  forget: $<HTMLButtonElement>("#forget"),
  download: $<HTMLButtonElement>("#download"),
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
    return raw ? (JSON.parse(raw) as Parent) : null;
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
}, loadParent());

let stepsPerFrame = 1;
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
}
new ResizeObserver(resize).observe(roadCanvas);
new ResizeObserver(() => fitCanvas(brainCanvas, brainCtx)).observe(brainCanvas);

const meters = (px: number) => `${Math.round(px / PX_PER_METER).toLocaleString()} m`;

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

  for (const car of sim.course.near(leader.y, viewH / scale)) car.draw(ctx, palette.concrete);

  ctx.globalAlpha = 0.16;
  for (const car of sim.cars) if (car !== leader && !car.damaged) car.draw(ctx, palette.white);
  ctx.globalAlpha = 1;

  leader.draw(ctx, leader.damaged ? palette.orange : palette.yellow, ui.sensors.checked ? palette.yellow : undefined);
  ctx.restore();
}

function drawBrain(): void {
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
  });
}

let lastStats = 0;
function updateStats(now: number): void {
  if (now - lastStats < 120) return;
  lastStats = now;
  const keys = sim.mode === "KEYS";
  ui.generation.textContent = keys ? "Manual" : String(sim.generation);
  ui.alive.textContent = keys ? "1" : `${sim.alive} of ${sim.cars.length}`;
  ui.run.textContent = meters(sim.leader.progress);
  ui.best.textContent = sim.parent ? meters(sim.parent.progress) : "None yet";
}

function frame(now: number): void {
  for (let i = 0; i < stepsPerFrame; i++) {
    if (sim.step()) {
      saveParent(sim.parent);
      announce(`Generation ${sim.generation} started from a ${sim.parent ? meters(sim.parent.progress) : "random"} brain.`);
    }
  }
  drawRoad();
  drawBrain();
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

ui.speed.addEventListener("change", (e) => {
  stepsPerFrame = Number((e.target as HTMLInputElement).value);
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

resize();
requestAnimationFrame(frame);
