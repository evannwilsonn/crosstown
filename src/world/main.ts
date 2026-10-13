import "../style.css";
import { GraphEditor, MarkingEditor, type Editor } from "./editors";
import { Graph } from "./graph";
import type { MarkingType } from "./markings";
import { drawMinimap } from "./minimap";
import { isOsmData, OVERPASS_QUERY, parseOsm } from "./osm";
import { sampleWorld } from "./sample";
import { WORLD_INPUTS, WorldSim, type WorldSaved } from "./sim";
import { generateMap } from "./mapgen";
import { WORLD_THEMES } from "./worldThemes";
import { drawLearningCurve } from "../chart";
import { Genome } from "../neat";
import { Viewport } from "./viewport";
import { drawGenome } from "../visualizer";
import { World, type CourseSave, type WorldJSON, type WorldPaint } from "./world";

const WORLD_KEY = "sdc.world.v1";
// NEAT replaced the fixed network; the whole population and level are saved.
const STATE_KEY = "sdc.world.neat.v1";
/** Max speed runs as many steps as fit in this much of each frame. */
const MAX_BUDGET_MS = 14;
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
const chartCanvas = $<HTMLCanvasElement>("#chart");
const chartCtx = chartCanvas.getContext("2d")!;
const miniCtx = mini.getContext("2d")!;

const ui = {
  tools: $<HTMLFieldSetElement>("#tools"),
  toolHelp: $("#tool-help"),
  generation: $("#stat-generation"),
  alive: $("#stat-alive"),
  run: $("#stat-run"),
  level: $("#stat-level"),
  speed: $<HTMLFieldSetElement>("#speed"),
  brainNote: $("#brain-note"),
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
    leafLow: [26, 58, 42],
    leafHigh: [56, 150, 86],
  },
};
const ground = color("--ground");

/* Storage is a convenience: the page works when it is blocked. */
function load<T>(key: string, store: "local" | "session" = "local"): T | null {
  try {
    const raw = (store === "session" ? sessionStorage : localStorage).getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function save(key: string, value: unknown, store: "local" | "session" = "local"): void {
  try {
    const s = store === "session" ? sessionStorage : localStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, JSON.stringify(value));
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
function loadState(): WorldSaved | null {
  // Learning lasts for the tab session, like the highway: refresh keeps it, closing the tab resets it.
  try {
    localStorage.removeItem(STATE_KEY); // earlier versions kept it forever
  } catch {
    /* ignore */
  }
  const s = load<WorldSaved>(STATE_KEY, "session");
  return s?.neat?.inputs === WORLD_INPUTS && Array.isArray(s.neat.genomes) && s.neat.genomes.length ? s : null;
}
let sim: WorldSim;
try {
  sim = new WorldSim(() => world, loadState());
} catch {
  sim = new WorldSim(() => world);
}
// Every three levels the town changes; the brains carry over.
sim.onMapChange = (map) => showLevelMap(map);
function saveState(): void {
  save(STATE_KEY, sim.generation > 1 ? sim.toJSON() : null, "session");
}
let stepsPerFrame = 1;

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
  target: "Click a lane to mark the destination for levels 1 and 2. Without one, cars head for the farthest road.",
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

/** True while the map shown is one of the level maps rather than the visitor's own. */
let levelMapShown = false;

/** Shows the level map the simulation is on, keeping the cars and the brains. */
function showLevelMap(map: number): void {
  world = generateMap(map, sim.seed);
  levelMapShown = true;
  markingCount = world.markings.length;
  seenVersion = world.graph.version;
  if (!sim.leader) viewport.fit(world.graph.points);
}

function saveWorld(): void {
  if (levelMapShown) return; // level maps are made fresh each session; only the visitor's own map is kept
  save(WORLD_KEY, { ...world.toJSON(), view: { zoom: viewport.zoom, center: viewport.center } });
}

function replaceWorld(next: World, msg: string, view?: { zoom: number; center: { x: number; y: number } }): void {
  stopDriving();
  world = next;
  // A new map starts the levels over; the brains keep what they've learned.
  sim.restartLevels();
  saveState();
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

/** The coastal theme's beach and sea along the east side of town. */
function drawSea(c: CanvasRenderingContext2D): void {
  const xs = world.graph.points.map((p) => p.x);
  const ys = world.graph.points.map((p) => p.y);
  const shore = Math.max(...xs) + 230;
  const top = Math.min(...ys) - 3000;
  const bottom = Math.max(...ys) + 3000;
  c.fillStyle = "#e6d3a0";
  c.fillRect(shore, top, 160, bottom - top);
  c.fillStyle = "#1f6f8b";
  c.fillRect(shore + 120, top, 6000, bottom - top);
  c.strokeStyle = "rgba(255,255,255,0.35)";
  c.lineWidth = 3;
  for (let y = top; y < bottom; y += 90) {
    const x = shore + 170 + (Math.abs(Math.round(y)) % 5) * 60;
    c.beginPath();
    c.moveTo(x, y);
    c.quadraticCurveTo(x + 18, y - 8, x + 36, y);
    c.stroke();
  }
}

/* Render loop */
const meters = (px: number) => `${Math.round(px / PX_PER_METER).toLocaleString()} m`;
let lastStats = 0;

function frame(nowMs: number): void {
  const time = nowMs / 1000;
  regenerate(nowMs);
  // While cars drive, the sim runs the lights on its own clock so they keep pace at any speed.
  if (sim.mode === "off") world.updateLights(time);

  const t0 = performance.now();
  for (let i = 0; i < stepsPerFrame && performance.now() - t0 < MAX_BUDGET_MS; i++) {
    if (!sim.step()) continue;
    saveState();
    announce(describeGeneration());
  }
  if (sim.leader && !viewport.isPanning) {
    viewport.center = {
      x: viewport.center.x + (sim.leader.x - viewport.center.x) * 0.12,
      y: viewport.center.y + (sim.leader.y - viewport.center.y) * 0.12,
    };
  }

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const theme = world.theme ? WORLD_THEMES[world.theme] : null;
  ctx.fillStyle = theme?.ground ?? ground;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  viewport.apply(ctx);
  const viewPoint = viewport.center;
  const radius = viewport.viewRadius;
  if (theme?.sea) drawSea(ctx);
  const themed = theme ? { ...paint, road: theme.road, items: theme.items } : paint;
  world.draw(ctx, viewPoint, radius, themed, sim.mode === "off");
  if (sim.mode === "AI" && sim.level > 1) drawTrip();

  ctx.globalAlpha = 0.2;
  for (const car of sim.cars) if (car !== sim.leader) car.draw(ctx, car.damaged ? paint.items.wallEdge : paint.white);
  ctx.globalAlpha = 1;
  if (sim.leader) {
    const crashed = sim.leader.damaged;
    sim.leader.draw(ctx, crashed ? paint.items.wallEdge : paint.yellow, ui.sensors.checked ? paint.yellow : undefined);
  }

  world.drawItems(ctx, viewPoint, radius, themed.items);
  // Course 2:49: editors draw at 30% so the roads stay the focus.
  ctx.globalAlpha = 0.3;
  editor?.draw(ctx, paint);
  ctx.globalAlpha = 1;
  ctx.restore();

  drawMinimap(
    miniCtx, mini.clientWidth, mini.clientHeight, world.graph, viewport.center,
    { width: w / viewport.zoom, height: h / viewport.zoom }, sim.cars, sim.leader,
    { road: paint.white, car: paint.yellow, view: paint.yellow },
  );

  drawBrain(nowMs);
  drawChart();

  if (nowMs - lastStats > 150) {
    lastStats = nowMs;
    const driving = sim.mode !== "off";
    ui.generation.textContent = !driving ? "Parked" : sim.mode === "KEYS" ? "Manual" : String(sim.generation);
    ui.alive.textContent = !driving ? "0" : `${sim.alive} of ${sim.cars.length}`;
    ui.run.textContent = !driving || !sim.leader
      ? "0 m"
      : sim.level === 1
        ? meters(sim.leader.progress)
        : `${meters(sim.remaining(sim.leader))} to go, ${(sim.frames / 60).toFixed(0)} of ${((sim.timeLimit ?? 0) / 60).toFixed(0)} s${sim.tripsPerGeneration > 1 ? `, trip ${sim.trip + 1}/${sim.tripsPerGeneration}` : ""}`;
    ui.level.textContent = `${sim.level}: ${sim.levelSpec.name}`;
    const g = sim.leader?.brain instanceof Genome ? sim.leader.brain : null;
    ui.brainNote.textContent = g ? `${g.hiddenCount} hidden ${g.hiddenCount === 1 ? "neuron" : "neurons"}, ${g.enabledCount} links, ${sim.neat.species.length || 1} species` : "";
  }
  requestAnimationFrame(frame);
}

function drawBrain(now: number): void {
  const { width, height } = brainCanvas.getBoundingClientRect();
  const brain = sim.leader?.brain;
  if (!(brain instanceof Genome)) {
    brainCtx.clearRect(0, 0, width, height);
    brainCtx.fillStyle = color("--ink-muted");
    brainCtx.font = "600 14px Overpass, system-ui, sans-serif";
    brainCtx.textAlign = "center";
    brainCtx.textBaseline = "middle";
    brainCtx.fillText("The network appears once the cars are driving.", width / 2, height / 2);
    return;
  }
  drawGenome(brainCtx, brain, width, height, {
    positive: paint.yellow,
    negative: color("--sign-blue"),
    node: paint.asphalt,
    nodeOn: paint.yellow,
    label: paint.white,
  }, -now / 50);
}
new ResizeObserver(() => fit(brainCanvas, brainCtx)).observe(brainCanvas);

/* Levels, the trip and the learning curve */
function describeLevel(): string {
  const spec = sim.levelSpec;
  const what =
    spec.goal === "survive"
      ? "drive as long as they can without crashing."
      : `reach a random destination before the clock runs out, ${sim.tripsPerGeneration} trips a generation. A GPS input points the way; the brain does all the steering. Clear it by arriving in time on every trip.`;
  return `Level ${spec.number}, ${spec.name}: ${what}`;
}

function describeGeneration(): string {
  const s = sim.last;
  if (!s) return describeLevel();
  if (s.levelUp) {
    const newMap = sim.levelSpec.map !== Math.floor((s.level - 1) / 3);
    const where = newMap ? ` New map: ${world.theme ? WORLD_THEMES[world.theme].name : "the sample town"}, built fresh for this session.` : "";
    return `Generation ${s.generation} cleared level ${s.level}.${where} ${describeLevel()}`;
  }
  const arrived = s.trips > 1 ? ` Its best car arrived in time on ${s.inTime} of ${s.trips} trips.` : "";
  if (s.grew) return `Generation ${s.generation}'s best brain grew a neuron: ${s.neurons} hidden now.${arrived}`;
  return `Generation ${s.generation}: ${s.species} species competing.${arrived}`;
}

/** The destination and the leader's GPS arrow, drawn on the map. */
function drawTrip(): void {
  const d = sim.destination;
  if (d) {
    [
      [paint.red, 16],
      [paint.white, 11],
      [paint.red, 6],
    ].forEach(([c, r]) => {
      ctx.beginPath();
      ctx.arc(d.x, d.y, r as number, 0, Math.PI * 2);
      ctx.fillStyle = c as string;
      ctx.fill();
    });
  }
  const leader = sim.leader;
  const wp = leader ? sim.waypoint(leader) : null;
  if (leader && wp && !leader.damaged) {
    ctx.save();
    ctx.strokeStyle = paint.yellow;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 3;
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.moveTo(leader.x, leader.y);
    ctx.lineTo(wp.x, wp.y);
    ctx.stroke();
    ctx.restore();
  }
}

let chartKey = -1;
function drawChart(): void {
  if (chartKey === sim.history.length) return;
  chartKey = sim.history.length;
  const { width, height } = chartCanvas.getBoundingClientRect();
  drawLearningCurve(chartCtx, sim.history, width, height, {
    odd: paint.yellow,
    even: color("--sign-green"),
    axis: color("--shoulder"),
    label: paint.white,
    muted: color("--ink-muted"),
  });
}
new ResizeObserver(() => {
  fit(chartCanvas, chartCtx);
  chartKey = -1;
}).observe(chartCanvas);

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
  // Training and driving happen on the level maps.
  if (!levelMapShown || sim.levelSpec.map > 0) showLevelMap(sim.levelSpec.map);
  sim.population = Number(ui.population.value);
  sim.mutation = Number(ui.mutation.value);
  if (!sim.begin(mode)) {
    announce("Add a start marking first: pick Start, then click a lane.");
    return;
  }
  setDriving(true);
  announce(mode === "KEYS" ? "You're driving. Use the arrow keys or W, A, S, D." : sim.last ? describeGeneration() : describeLevel());
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
  saveState();
  announce("Learning reset: level 1, random brains with no hidden neurons.");
});

ui.population.addEventListener("input", () => (ui.populationOut.value = ui.population.value));
ui.mutation.addEventListener("input", () => {
  ui.mutationOut.value = `${Math.round(Number(ui.mutation.value) * 100)}%`;
  sim.mutation = Number(ui.mutation.value);
  sim.neat.rates.power = sim.mutation * 5;
});

ui.speed.addEventListener("change", (e) => {
  const v = (e.target as HTMLInputElement).value;
  stepsPerFrame = v === "max" ? Infinity : Number(v);
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

// Exposed for console experiments.
(window as unknown as { sim: WorldSim }).sim = sim;
