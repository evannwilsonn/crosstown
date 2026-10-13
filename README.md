# Self-Driving Car + Virtual World

A population of cars learns to drive through traffic with no training data and no libraries. Every car senses the road with five rays and starts with the smallest possible brain, sensors wired straight to its controls. The highway evolves those brains with NEAT, so the network itself grows new neurons and connections as the traffic gets harder, level after level.

Phase 2 (`world.html`) builds a virtual town around a road network you draw: road borders, buildings and trees in pseudo 3D, road markings with working traffic lights, OpenStreetMap import and a minimap. Cars with the same growing NEAT brains then learn its streets, level by level: stay on the road, reach a destination, reach any destination.

Written in TypeScript with the Canvas API. A port of Radu Mariescu-Istodor's two freeCodeCamp courses ([Self-driving car](https://github.com/gniziemazity/Self-driving-car), [Virtual world](https://github.com/gniziemazity/virtual-world), both MIT), rebuilt with typed modules, tests, automatic generations and a redesigned interface. Both pages go beyond the course: NEAT instead of a fixed network, and levels that keep getting harder.

## Run it

```bash
npm install
npm run dev      # local dev server: / is the highway, /world.html is the virtual world
npm test         # unit tests (Vitest)
npm run build    # both pages to dist/
SINGLE=world npm run build   # one self-contained HTML file in dist-single/world/
```

Arrow keys or W A S D drive the car in "Drive it yourself" mode.

## How it works

| Step | In this project |
| --- | --- |
| Problem | Get a car past traffic on a three-lane road without crashing, with no labelled data, and keep getting better as the traffic gets harder. |
| Data | None up front. Each car's five ray sensors produce inputs every frame: 0 when the ray sees nothing, rising to 1 as an obstacle gets close. |
| Baseline | Generation 1 is 100 random minimal networks: 5 sensors wired straight to 4 controls, no hidden neurons. Most crash within 100 m. |
| Model | A NEAT genome (`src/neat.ts`, after Stanley & Miikkulainen 2002): any acyclic network of step neurons, 5 inputs and 4 outputs (forward, left, right, reverse), with as many hidden neurons as evolution has added. |
| Evaluation | Fitness is distance gained on the traffic, not raw distance: traffic moves forward too, so raw distance rewards a car for tailgating, and that brain never learns to overtake and eventually rear-ends the car ahead. Every generation replays the same course, so runs are compared fairly. |
| Improvement | NEAT breeds every generation: brains are grouped into species by structure and compete mostly within their species, so a new neuron gets time to prove itself; parents cross over gene by gene using innovation numbers; mutations nudge weights and sometimes add a connection or split one with a new neuron. The generation's best brain rides unchanged into the next one, so progress never goes backwards. |
| Self-improvement | Seven levels. Level 1 is the course's seven cars; each later level is endless traffic with rows closer together and moving faster, unlocked when the best car passes the level's goal. Level 7 has no goal, so learning never runs out of road. In headless runs (`scripts/train.ts`), populations cleared level 1 in 8 to 86 generations and reached level 6 or 7 within about 130, with brains growing to between 1 and 8 hidden neurons along the way. The page saves the whole population and picks up where it left off. |
| Deployment | `npm run build` emits a single HTML file for GitHub Pages or any static host. A learning curve charts each generation by level and marks when the best brain grew; the best brain copies out as JSON. |

## Virtual world (phase 2)

| Course chapter | Here |
| --- | --- |
| Spatial graphs | `world/graph.ts`, `world/geom.ts`: points, segments, polygons, envelopes |
| Graph editor | `world/editors.ts` GraphEditor: click to add, click to connect, drag, right-click to delete |
| Dynamic viewport | `world/viewport.ts`: wheel zoom toward the cursor, Space or middle-drag to pan, Fit |
| Generating roads | `World.generateRoads`: envelope per road, `Polygon.union` for the borders |
| Buildings and trees | `World.generateBuildings / generateTrees`: guide envelopes, spaced bases, rejection-sampled trees |
| Pseudo 3D | `world/items.ts`: walls and pitched roofs lifted away from the camera, seven-level trees |
| Road markings | `world/markings.ts`: stop, yield, crossing, parking, light, start, target |
| Saving the world | Autosaves in the browser, copy or import map JSON, and opens the course's own `.world` saves |
| Integration | `world/sim.ts`: cars spawn at the start marking and evolve with NEAT through four levels (below) |
| OpenStreetMap | `world/osm.ts`: paste the query into overpass-turbo.eu, export raw JSON, import it |
| Minimap | `world/minimap.ts` |

Traffic lights follow the course's controller: lights are grouped by nearest intersection and take turns, green 2 s then yellow 1 s, while the others stay red. Red and yellow stop lines are walls for the cars' sensors.

"Load the course city" opens `public/samples/course-city.json`, converted from the course repo's `big.world` save (real streets from OpenStreetMap with prebuilt buildings and trees).

Both ports were checked against the course videos' full transcripts as well as the course code; details the videos explain (the intersection epsilon that stops buildings flickering, animated dashed network connections, random traffic hues, editor overlay at 30%, parking lines across the lane, one-way roads from OpenStreetMap) are implemented.

Endless traffic is generated so it is always passable: a two-lane block is never followed directly by another, and the open lane moves at most one lane between blocks. Rows are also placed relative to the moving traffic: placing them at fixed map positions (as earlier versions did) put each new row closer to the traffic already driving, so the spacing collapsed to under 100 px as a run went on and every population stalled around eight cars.

`npx tsx scripts/train.ts [generations] [cars] [mutation] [frame cap]` runs NEAT headless and prints each generation's level, cars passed and brain size.

### Levels in the world

The world's brains get the 5 rays plus one GPS input: the angle to the next turn on the shortest road route to the destination (`world/nav.ts`, Dijkstra over the road graph). Navigation never steers. The brain has to learn to follow the arrow and stay on the road at the same time.

1. **Stay on the road.** Fitness is distance driven, as in the course. Cleared when a car is still driving at the 45 s limit.
2. **Find the destination.** The Target marking, or, without one, the farthest road from the start. Fitness is how much closer by road the car got, plus a bonus for arriving that grows the sooner it arrives.
3. **Any destination.** A new random destination every trip, three trips per generation, each scored as a share of its length. Cleared when one brain arrives on all three. One random trip per generation turned out to be luck: champions were picked on easy trips and the population got worse over time.
4. **Anywhere to anywhere.** Random start and destination every trip, no final goal. In headless runs (`scripts/train-world.ts`), populations reached level 4 within about 40 generations; in two of three runs the best car's arrival rate on level 4 roughly doubled over the next 85 generations (20% to 39%, 21% to 42%), while the third held around 40%.

Lights are driven by the simulation's own clock, so they keep pace at Max speed. Loading a new map starts the levels over but keeps the brains.

Deliberate differences from the course: lane guides are computed per road with an explicit direction (right-hand traffic), so markings always face the way cars drive; generations advance automatically with a time limit, because distance-driven fitness never stalls for a car driving in circles; maps over 300 roads are view-and-drive only, since regenerating roads is quadratic.

## Code map

```
src/
  utils.ts       segment intersection, polygon overlap, seeded RNG
  neat.ts        NEAT: genomes, innovation numbers, speciation, crossover, growth
  network.ts     the course's fixed-shape network (used by the virtual world)
  sensor.ts      ray casting against road edges and nearby traffic
  car.ts         physics, collision, progress tracking, drawing
  road.ts        road surface and US-style markings
  traffic.ts     lazily generated, seeded traffic rows (never blocks all lanes)
  simulation.ts  levels, generations, NEAT breeding, saving
  chart.ts       learning curve shared by both pages
  visualizer.ts  draws the leader's network live
  main.ts        canvas, UI controls, storage
  world/         phase 2: geometry, graph, world generation, markings, editors, viewport, OSM, minimap, navigation, sim
tests/core.test.ts, tests/world.test.ts
```

## Design notes

The interface borrows from US highway signage: Overpass (an open-source revival of Highway Gothic), green guide signs for the title and progress, real lane paint on the road, and construction orange reserved for the one action that interrupts a run. In the network view, yellow connections excite a neuron and blue ones inhibit it; the dashed ring on each neuron is its threshold.

## Next

- Other cars in the world, so brains learn to share the road.
- Replace the step activation with a smooth one and compare learning speed.
