# Self-Driving Car + Virtual World

A population of cars learns to drive through traffic using a tiny neural network and a genetic algorithm. No training data, no libraries: every car senses the road with five rays, a 5 → 6 → 4 network turns those readings into steering, and after each run the farthest driver's brain is copied and mutated to breed the next generation.

Phase 2 (`world.html`) builds a virtual town around a road network you draw: road borders, buildings and trees in pseudo 3D, road markings with working traffic lights, OpenStreetMap import and a minimap. The same cars then learn to drive its streets.

Written in TypeScript with the Canvas API. A port of Radu Mariescu-Istodor's two freeCodeCamp courses ([Self-driving car](https://github.com/gniziemazity/Self-driving-car), [Virtual world](https://github.com/gniziemazity/virtual-world), both MIT), rebuilt with typed modules, tests, automatic generations and a redesigned interface.

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
| Problem | Get a car through endless three-lane traffic without crashing, with no labelled data. |
| Data | None up front. Each car's five ray sensors produce inputs every frame: 0 when the ray sees nothing, rising to 1 as an obstacle gets close. |
| Baseline | Generation 1 is 100 random networks. Most crash within 100 m. |
| Model | Feed-forward network, 5 inputs, 6 hidden, 4 outputs (forward, left, right, reverse), step activation. |
| Evaluation | Fitness is distance driven. Every generation replays the same seeded course, so runs are compared fairly. Cars that stop making progress for 4 s are retired. |
| Improvement | The farthest car becomes the parent only if it beats the previous parent. Car 0 of each generation is an unmutated copy, so progress never goes backwards. Mutation is adjustable live. |
| Deployment | `npm run build` emits a single HTML file for GitHub Pages or any static host. The best brain persists in the browser and can be copied as JSON. |

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
| Integration | `world/sim.ts`: cars spawn at the start marking and evolve; fitness is distance driven, as in the course |
| OpenStreetMap | `world/osm.ts`: paste the query into overpass-turbo.eu, export raw JSON, import it |
| Minimap | `world/minimap.ts` |

Traffic lights follow the course's controller: lights are grouped by nearest intersection and take turns, green 2 s then yellow 1 s, while the others stay red. Red and yellow stop lines are walls for the cars' sensors.

"Load the course city" opens `public/samples/course-city.json`, converted from the course repo's `big.world` save (real streets from OpenStreetMap with prebuilt buildings and trees).

Both ports were checked against the course videos' full transcripts as well as the course code; details the videos explain (the intersection epsilon that stops buildings flickering, animated dashed network connections, random traffic hues, editor overlay at 30%, parking lines across the lane, one-way roads from OpenStreetMap) are implemented.

Deliberate differences from the course: lane guides are computed per road with an explicit direction (right-hand traffic), so markings always face the way cars drive; generations advance automatically with a 45 s cap, because distance-driven fitness never stalls for a car driving in circles; maps over 300 roads are view-and-drive only, since regenerating roads is quadratic.

## Code map

```
src/
  utils.ts       segment intersection, polygon overlap, seeded RNG
  network.ts     Level and NeuralNetwork: feed-forward, mutate, clone, JSON
  sensor.ts      ray casting against road edges and nearby traffic
  car.ts         physics, collision, progress tracking, drawing
  road.ts        road surface and US-style markings
  traffic.ts     lazily generated, seeded traffic rows (never blocks all lanes)
  simulation.ts  generations, parent selection, mode switching
  visualizer.ts  draws the leader's network live
  main.ts        canvas, UI controls, storage
  world/         phase 2: geometry, graph, world generation, markings, editors, viewport, OSM, minimap, sim
tests/core.test.ts, tests/world.test.ts
```

## Design notes

The interface borrows from US highway signage: Overpass (an open-source revival of Highway Gothic), green guide signs for the title and progress, real lane paint on the road, and construction orange reserved for the one action that interrupts a run. In the network view, yellow connections excite a neuron and blue ones inhibit it; the dashed ring on each neuron is its threshold.

## Next

- Course phase 3: path-finding to the target marking, so cars drive somewhere instead of just far.
- Replace the step activation with a smooth one and compare learning speed.
