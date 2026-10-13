import "./world.css";
import type { Parent } from "../simulation";
import { GraphEditor, MarkingEditor, type Editor } from "./editors";
import { Graph } from "./graph";
import type { MarkingType } from "./markings";
import { drawMinimap } from "./minimap";
import { isOsmData, OVERPASS_QUERY, parseOsm } from "./osm";
import { sampleWorld } from "./sample";
import { WorldSim } from "./sim";
import { Viewport } from "./viewport";
import { drawNetwork } from "../visualizer";
import { World, type CourseSave, type WorldJSON, type WorldPaint } from "./world";

const WORLD_KEY = "sdc.world.v1";
const PARENT_KEY = "sdc.world.parent.v1";
const PX_PER_METER = 10;
const ITEM_DELAY_MS = 300;
/** Regenerating roads is quadratic in road count; above this, maps are view-and-drive only. */
const EDIT_LIMIT = 300;
const COURSE_CITY_URL = "samples/course-city.json";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const canvas = $<HTMLCanvasElement>("#world");
const ctx = canvas.getContext("2d")!;
const mini = $<HTMLCanvasElement>("#minimap");
const brainCanvas = $<HTMLCanvasElement>("#brain");
const brainCtx = brainCanvas.getContext("2d")!;
const miniCtx = mini.getContext("2d")!;

const ui = {
  tools: $<HTMLFieldSetElement>("#tools"),
  toolHelp: $("#tool-help"),
  generation: $("#stat-generation"),
  alive: $("#stat-alive"),
  run: $("#stat-run"),
  best: $("#stat-best"),
  population: $<HTMLInputElement>("#population"),
  populationOut: $<HTMLOutputElement>("#population-out"),
  mutation: $<HTMLInputElement>("#mutation"),
  mutationOut: $<HTMLOutputElement>("#mutation-out"),
  sensors: $<HTMLInputElement>("#sensors"),
  train: $<HTMLButtonElement>("#train"),
  driveSelf: $<HTMLButtonElement>("#drive-self"),
  stop: $<HTMLButtonElement>("#stop-driving"),
  forget: $<HTMLButtonElement>("#forget"),
  importFile: $<HTMLInputElement>("#import"),
  copyJson: $<HTMLButtonElement>("#copy-json"),
  sample: $<HTMLButtonElement>("#sample"),
  courseCity: $<HTMLButtonElement>("#course-city"),
  clear: $<HTMLButtonElement>("#clear"),
  query: $("#overpass-query"),
  copyQuery: $<HTMLButtonElement>("#copy-query"),
  zoomIn: $<HTMLButtonElement>("#zoom-in"),
  zoomOut: $<HTMLButtonElement>("#zoom-out"),
  zoomFit: $<HTMLButtonElement>("#zoom-fit"),
  status: $("#status"),
};

const css = getComputedStyle(document.documentElement);
const color = (name: string) => css.getPropertyValue(name).trim();
const paint: WorldPaint = {
  white: color("--marking-white"),
  yellow: color("--marking-yellow"),
  orange: color("--construction"),
  red: color("--signal-red"),
  green: color("--signal-green"),
  asphalt: color("--asphalt-deep"),
  road: color("--asphalt"),
  items: {
    wall: color("--wall"),
    wallEdge: color("--wall-edge"),
    roof: color("--roof"),
    roofEdge: color("--roof-edge"),
    shadow: color("--ground-shadow"),
    // Course trees fade from rgb(30,50,70) at the base to rgb(30,200,70) at the top; toned to sit on this ground.
    // Sage foam trees, light enough to sit on the model's pale ground.
    leafLow: [118, 146, 122],
    leafHigh: [196, 214, 184],
  },
};
const ground = color("--ground");

/* Storage is a convenience: the page works when it is blocked. */
function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function save(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const savedView = load<WorldJSON>(WORLD_KEY)?.view;

function initialWorld(): World {
  const saved = load<WorldJSON>(WORLD_KEY);
  if (saved?.graph) {
    try {
      return World.fromJSON(saved);
    } catch {
      /* fall through to the sample */
    }
  }
  return sampleWorld();
}

let world = initialWorld();
const viewport = new Viewport(canvas);
const sim = new WorldSim(() => world, load<Parent>(PARENT_KEY));

const graphEditor = new GraphEditor(viewport, () => world.graph);
const markingEditors = new Map<MarkingType, MarkingEditor>();
let editor: Editor | null = null;

const HELP: Record<string, string> = {
  roads: "Click empty ground to add an intersection. Click another to connect them. Drag to move one, right-click to delete it.",
  stop: "Hover a lane and click to paint a stop line. Right-click a marking to remove it.",
  yield: "Hover a lane and click to paint yield triangles. Right-click a marking to remove it.",
  light: "Click a lane before an intersection to add a signal. Cars treat red and yellow as a wall.",
  crossing: "Hover a road and click to paint a crosswalk across both lanes.",
  parking: "Hover a lane and click to paint a parking bay.",
  start: "Click a lane to set where cars spawn and which way they face. The first start marking is used.",
  target: "Click a lane to mark a destination.",
};

function setTool(tool: string): void {
  editor?.disable();
  editor = null;
  const tooBig = world.graph.segments.length > EDIT_LIMIT;
  ui.tools.disabled = tooBig || sim.mode !== "off";
  if (tooBig) {
    ui.toolHelp.textContent = `This map has ${world.graph.segments.length} roads, too many to edit smoothly. You can still explore it and train cars on it.`;
    return;
  }
  if (tool === "roads") editor = graphEditor;
  else {
    const type = tool as MarkingType;
    if (!markingEditors.has(type)) markingEditors.set(type, new MarkingEditor(viewport, () => world, type));
    editor = markingEditors.get(type)!;
  }
  editor.enable();
  ui.toolHelp.textContent = HELP[tool];
}

function announce(msg: string): void {
  ui.status.textContent = msg;
}

/* Generation: roads at once, scenery once edits pause. */
let lastChange = 0;
let seenVersion = -1;
let markingCount = -1;
function regenerate(now: number): void {
  const v = world.graph.version;
  if (v !== seenVersion) {
    seenVersion = v;
    lastChange = now;
    world.generateRoads();
    world.buildings = [];
    world.trees = [];
  }
  if (world.itemsVersion !== v && now - lastChange > ITEM_DELAY_MS && sim.mode === "off") {
    world.generateItems();
    saveWorld();
  }
  if (world.markings.length !== markingCount) {
    markingCount = world.markings.length;
    saveWorld();
  }
}

function saveWorld(): void {
  save(WORLD_KEY, { ...world.toJSON(), view: { zoom: viewport.zoom, center: viewport.center } });
}

function replaceWorld(next: World, msg: string, view?: { zoom: number; center: { x: number; y: number } }): void {
  stopDriving();
  world = next;
  markingCount = -1;
  // Course saves arrive with roads and scenery already built.
  if (world.roadsVersion !== world.graph.version) world.generateRoads();
  if (world.itemsVersion !== world.graph.version) world.generateItems();
  seenVersion = world.graph.version;
  if (view) {
    viewport.zoom = view.zoom;
    viewport.center = view.center;
  } else viewport.fit(world.graph.points);
  saveWorld();
  setTool((ui.tools.querySelector("input:checked") as HTMLInputElement).value);
  announce(msg);
}

/* Canvas sizing */
function fit(c: HTMLCanvasElement, cx: CanvasRenderingContext2D): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { width, height } = c.getBoundingClientRect();
  c.width = Math.round(width * dpr);
  c.height = Math.round(height * dpr);
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
new ResizeObserver(() => fit(canvas, ctx)).observe(canvas);
new ResizeObserver(() => fit(mini, miniCtx)).observe(mini);

/* Render loop */
const meters = (px: number) => `${Math.round(px / PX_PER_METER).toLocaleString()} m`;
let lastStats = 0;

function frame(nowMs: number): void {
  const time = nowMs / 1000;
  regenerate(nowMs);
  world.updateLights(time);

  if (sim.step()) {
    save(PARENT_KEY, sim.parent);
    announce(`Generation ${sim.generation} started from a ${sim.parent ? meters(sim.parent.progress) : "random"} brain.`);
  }
  if (sim.leader && !viewport.isPanning) {
    viewport.center = {
      x: viewport.center.x + (sim.leader.x - viewport.center.x) * 0.12,
      y: viewport.center.y + (sim.leader.y - viewport.center.y) * 0.12,
    };
  }

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  viewport.apply(ctx);
  const viewPoint = viewport.center;
  const radius = viewport.viewRadius;
  world.draw(ctx, viewPoint, radius, paint, sim.mode === "off");

  ctx.globalAlpha = 0.2;
  for (const car of sim.cars) if (car !== sim.leader) car.draw(ctx, car.damaged ? paint.items.wallEdge : paint.white);
  ctx.globalAlpha = 1;
  if (sim.leader) {
    const crashed = sim.leader.damaged;
    sim.leader.draw(ctx, crashed ? paint.items.wallEdge : color("--car"), ui.sensors.checked ? color("--car") : undefined);
  }

  world.drawItems(ctx, viewPoint, radius, paint.items);
  // Course 2:49: editors draw at 30% so the roads stay the focus.
  ctx.globalAlpha = 0.3;
  editor?.draw(ctx, paint);
  ctx.globalAlpha = 1;
  ctx.restore();

  drawMinimap(
    miniCtx, mini.clientWidth, mini.clientHeight, world.graph, viewport.center,
    { width: w / viewport.zoom, height: h / viewport.zoom }, sim.cars, sim.leader,
    { road: color("--asphalt"), car: color("--accent"), view: color("--accent") },
  );

  drawBrain(nowMs);

  if (nowMs - lastStats > 150) {
    lastStats = nowMs;
    const driving = sim.mode !== "off";
    ui.generation.textContent = !driving ? "Parked" : sim.mode === "KEYS" ? "Manual" : String(sim.generation);
    ui.alive.textContent = !driving ? "0" : `${sim.alive} of ${sim.cars.length}`;
    ui.run.textContent = meters(sim.leader?.progress ?? 0);
    ui.best.textContent = sim.parent ? meters(sim.parent.progress) : "None";
  }
  requestAnimationFrame(frame);
}

function drawBrain(now: number): void {
  const { width, height } = brainCanvas.getBoundingClientRect();
  const brain = sim.leader?.brain;
  if (!brain) {
    brainCtx.clearRect(0, 0, width, height);
    brainCtx.fillStyle = color("--ink-muted");
    brainCtx.font = "500 13px Geist, system-ui, sans-serif";
    brainCtx.textAlign = "center";
    brainCtx.textBaseline = "middle";
    brainCtx.fillText("Appears when the cars drive", width / 2, height / 2);
    return;
  }
  drawNetwork(brainCtx, brain, width, height, {
    positive: color("--pos"),
    negative: color("--neg"),
    node: color("--ink"),
    nodeOn: color("--pos"),
    label: color("--ink"),
  }, -now / 50);
}
new ResizeObserver(() => fit(brainCanvas, brainCtx)).observe(brainCanvas);

/* Driving */
function setDriving(on: boolean): void {
  ui.tools.disabled = on;
  ui.stop.disabled = !on;
  ui.train.disabled = on;
  ui.driveSelf.disabled = on;
  document.body.classList.toggle("is-driving", on);
  if (on) {
    editor?.disable();
    editor = null;
    viewport.zoom = Math.max(viewport.zoom, 0.8);
  }
}

function startDriving(mode: "AI" | "KEYS"): void {
  sim.population = Number(ui.population.value);
  sim.mutation = Number(ui.mutation.value);
  if (!sim.begin(mode)) {
    announce("Add a start marking first: pick Start, then click a lane.");
    return;
  }
  setDriving(true);
  announce(mode === "KEYS" ? "You're driving. Use the arrow keys or W, A, S, D." : `Generation ${sim.generation} is on the road.`);
  canvas.focus();
}

function stopDriving(): void {
  if (sim.mode === "off") return;
  sim.stop();
  setDriving(false);
  setTool((ui.tools.querySelector("input:checked") as HTMLInputElement).value);
}

ui.train.addEventListener("click", () => startDriving("AI"));
ui.driveSelf.addEventListener("click", () => startDriving("KEYS"));
ui.stop.addEventListener("click", () => {
  stopDriving();
  announce("Parked. The map is editable again.");
});
ui.forget.addEventListener("click", () => {
  sim.forget();
  save(PARENT_KEY, null);
  announce("Learning reset. The next generation starts from random brains.");
});

ui.population.addEventListener("input", () => (ui.populationOut.value = ui.population.value));
ui.mutation.addEventListener("input", () => {
  ui.mutationOut.value = `${Math.round(Number(ui.mutation.value) * 100)}%`;
  sim.mutation = Number(ui.mutation.value);
});

ui.tools.addEventListener("change", (e) => setTool((e.target as HTMLInputElement).value));

/* Map file */
ui.importFile.addEventListener("change", async () => {
  const file = ui.importFile.files?.[0];
  ui.importFile.value = "";
  if (!file) return;
  try {
    loadMapText(await file.text(), file.name);
  } catch {
    announce("Couldn't read that file. Check that it's valid JSON.");
  }
});

/** Accepts this page's map JSON, raw OSM JSON from Overpass, or a `.world` save from the course's editor. */
function loadMapText(text: string, name: string): void {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const data: unknown = JSON.parse(text.slice(start, end + 1)); // strips the course's `const world = World.load(...)` wrapper
  if (isOsmData(data)) {
    const next = new World(parseOsm(data));
    replaceWorld(
      next,
      next.hasScenery
        ? `Imported ${next.graph.segments.length} road segments from OpenStreetMap.`
        : `Imported ${next.graph.segments.length} road segments. Buildings and trees are skipped on maps this large.`,
    );
    return;
  }
  if (typeof data !== "object" || !data || !("graph" in data)) {
    announce("That file isn't a map. Import a map JSON from this page, raw OSM JSON from Overpass, or a course .world file.");
    return;
  }
  const save = data as CourseSave & WorldJSON;
  const isCourse = "roadBorders" in save || (save.markings?.[0] && "directionVector" in save.markings[0]);
  if (isCourse) {
    const view = save.zoom && save.offset ? { zoom: 1 / save.zoom, center: { x: -save.offset.x, y: -save.offset.y } } : undefined;
    replaceWorld(World.fromCourseSave(save), `Loaded ${name}.`, view);
  } else {
    replaceWorld(World.fromJSON(save), `Loaded ${name}.`);
  }
}

async function copy(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    announce(done);
  } catch {
    announce("Your browser blocked clipboard access. Select the text and copy it manually.");
  }
}
ui.copyJson.addEventListener("click", () => copy(JSON.stringify(world.toJSON()), "Map JSON copied."));
ui.query.textContent = OVERPASS_QUERY;
ui.copyQuery.addEventListener("click", () => copy(OVERPASS_QUERY, "Overpass query copied."));

ui.sample.addEventListener("click", () => replaceWorld(sampleWorld(), "Sample town loaded."));
ui.courseCity.addEventListener("click", async () => {
  announce("Loading the course city…");
  try {
    const res = await fetch(COURSE_CITY_URL);
    if (!res.ok) throw new Error(String(res.status));
    loadMapText(await res.text(), "the course city");
    announce("Loaded the city from the course's own save: real streets from OpenStreetMap with buildings and trees.");
  } catch {
    announce("Couldn't load the course city. Import public/samples/course-city.json from the repo instead.");
  }
});

let clearArmed = 0;
ui.clear.addEventListener("click", () => {
  if (Date.now() - clearArmed < 3000) {
    replaceWorld(new World(new Graph()), "Map cleared. Click the ground to start a road.");
    ui.clear.textContent = "Clear the map";
    clearArmed = 0;
    return;
  }
  clearArmed = Date.now();
  ui.clear.textContent = "Click again to clear";
  setTimeout(() => (ui.clear.textContent = "Clear the map"), 3000);
});

ui.zoomIn.addEventListener("click", () => viewport.zoomBy(1.25));
ui.zoomOut.addEventListener("click", () => viewport.zoomBy(0.8));
ui.zoomFit.addEventListener("click", () => viewport.fit(world.graph.points));
// Keep the view with the world, as the course does, so a reload opens where you left off.
window.addEventListener("pagehide", saveWorld);
setInterval(saveWorld, 5000);

/* Boot */
world.generateRoads();
world.generateItems();
seenVersion = world.graph.version;
requestAnimationFrame(() => {
  if (savedView) {
    viewport.zoom = savedView.zoom;
    viewport.center = savedView.center;
  } else viewport.fit(world.graph.points);
  setTool("roads");
  requestAnimationFrame(frame);
});
