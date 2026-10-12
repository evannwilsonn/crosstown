# Self-Driving Car

A population of cars learns to drive through traffic using a tiny neural network and a genetic algorithm. No training data, no libraries: every car senses the road with five rays, a 5 → 6 → 4 network turns those readings into steering, and after each run the farthest driver's brain is copied and mutated to breed the next generation.

Written in TypeScript with the Canvas API. Based on Radu Mariescu-Istodor's freeCodeCamp course, rebuilt with typed modules, an infinite seeded course, automatic generations, tests and a redesigned interface.

## Run it

```bash
npm install
npm run dev      # local dev server
npm test         # unit tests (Vitest)
npm run build    # one self-contained dist/index.html
```

Arrow keys or W A S D drive the car in "Drive it yourself" mode.

## How it works

| Step | In this project |
| --- | --- |
| Problem | Get a car through endless three-lane traffic without crashing, with no labelled data. |
| Data | None up front. Each car's five ray sensors produce inputs every frame: 0 when the ray sees nothing, rising to 1 as an obstacle gets close. |
| Baseline | Generation 1 is 200 random networks. Most crash within 100 m. |
| Model | Feed-forward network, 5 inputs, 6 hidden, 4 outputs (forward, left, right, reverse), step activation. |
| Evaluation | Fitness is distance driven. Every generation replays the same seeded course, so runs are compared fairly. Cars that stop making progress for 4 s are retired. |
| Improvement | The farthest car becomes the parent only if it beats the previous parent. Car 0 of each generation is an unmutated copy, so progress never goes backwards. Mutation is adjustable live. |
| Deployment | `npm run build` emits a single HTML file for GitHub Pages or any static host. The best brain persists in the browser and can be copied as JSON. |

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
tests/core.test.ts
```

## Design notes

The interface borrows from US highway signage: Overpass (an open-source revival of Highway Gothic), green guide signs for the title and progress, real lane paint on the road, and construction orange reserved for the one action that interrupts a run. In the network view, yellow connections excite a neuron and blue ones inhibit it; the dashed ring on each neuron is its threshold.

## Next

- Phase 2 of the course: a graph-based world editor so cars learn on real road networks.
- Replace the step activation with a smooth one and compare learning speed.
