# Self-Driving Car + Virtual World

Two pages where cars learn to drive from nothing. No training data and no pretrained brains: every visit starts with a population of random, minimal networks, and NEAT grows them, adding neurons and connections as the challenges get harder. The levels never run out.

- **Highway** (`index.html`): get past traffic on a road that keeps changing. It curves, narrows to two lanes, closes lanes for construction and moves through different scenery.
- **Virtual world** (`world.html`): learn the streets of a town and reach random destinations against the clock. A new town is generated every three levels. You can also draw your own map or import a real one and train on that.

Written in TypeScript with the Canvas API. It started as a port of Radu Mariescu-Istodor's two freeCodeCamp courses ([Self-driving car](https://github.com/gniziemazity/Self-driving-car), [Virtual world](https://github.com/gniziemazity/virtual-world), both MIT). It was rebuilt with typed modules and tests, then taken in its own direction: growing NEAT brains instead of a fixed network, unlimited procedurally generated levels, timed GPS trips and themed worlds.

## Run it

```bash
npm install
npm run dev      # local dev server: / is the highway, /world.html is the virtual world
npm test         # unit tests (Vitest)
npm run build    # both pages to dist/
SINGLE=index npm run build   # one self-contained HTML file in dist-single/index/
SINGLE=world npm run build   # one self-contained HTML file in dist-single/world/
```

Use the arrow keys or W A S D to drive in "Drive it yourself" mode.

## How the learning works

| Step | In this project |
| --- | --- |
| Problem | Drive with no labelled data, and keep improving as the challenge grows. |
| Inputs | Seven ray sensors across 180 degrees (0 when a ray sees nothing, rising to 1 as an obstacle gets close) plus the car's speed. In the world, a GPS input and a road-condition input are added as well. |
| Starting point | Generation 1 is random minimal networks: inputs wired straight to 4 controls (forward, left, right, reverse), no hidden neurons. |
| Model | A NEAT genome (`src/neat.ts`, after Stanley & Miikkulainen 2002): any acyclic network of step neurons, with as many hidden neurons as evolution has added. |
| Breeding | Brains are grouped into species by structure and compete mostly within their species, so a new neuron gets time to prove itself. Parents cross over gene by gene using innovation numbers. Mutations nudge weights and sometimes add a connection or split one with a new neuron. The best brain rides unchanged into the next generation, so progress never goes backwards. |
| Self-improvement | Unlimited levels on both pages. The leader's brain is drawn live as it grows, and a learning curve charts every generation by level, with a dot wherever the best brain gained a neuron. |
| Memory | Learning lasts for the browser tab session. Refreshing, or leaving and coming back in the same tab, keeps the brains and the level. Closing the tab or window starts over from random brains. |

## Highway

**Fitness** is distance gained on the traffic, not raw distance. Traffic moves forward too, so raw distance rewards tailgating, and a tailgater never learns to overtake.

**New traffic every generation.** Every generation gets newly generated traffic, level 1 included, so a brain can't memorize a layout. To clear a level, the best car has to reach the goal on **3 different generations**. One lucky run isn't enough.

**Levels never run out**, and the road changes every three levels:

| Road | Levels | What changes |
| --- | --- | --- |
| 1 | 1-3 | Three straight lanes. Level 1 is the course's seven cars, in a random arrangement. |
| 2 | 4-6 | Two lanes |
| 3 | 7-9 | Curves |
| 4 | 10-12 | Construction zones that close a lane, with cones and merges |
| 5+ | 13+ | Random mixes of the above, getting tighter |

- **Traffic difficulty.** Within each road, traffic gets denser and faster. Each new road starts a little easier, so the brains get a foothold on the new shape.
- **Traffic behavior.** Later levels give lanes different speeds and add cars that change lanes.
- **Generated so it stays passable.** Traffic follows its lane, merges out of closed lanes and never blocks every lane.

**Themes:** the road moves through the original highway, a desert highway, a coast road, downtown at night (with headlights) and a snowy mountain pass, then mixes them. Road layouts are random for each session.

`npx tsx scripts/train.ts [generations] [cars] [mutation] [frame cap] [start level]` runs the highway headless and prints each generation's level, clears, cars passed and brain size.

## Virtual world

The world builds a town around a road network: road borders, buildings and trees in pseudo 3D, road markings with working traffic lights, OpenStreetMap import and a minimap.

**Inputs:** the seven rays and speed, plus GPS and the road condition.

- **GPS** is the angle to a point about 15 m ahead along the shortest legal route to the destination (`world/nav.ts`: Dijkstra over the road graph, respecting one-way streets and closed roads). It calls a turn as the car approaches it, like a phone's GPS. It never asks for a U-turn in the middle of a street; it routes on to the next junction instead.
  - An earlier version pointed at the next junction, so the arrow barely moved until the car was in the junction and then flipped.
  - It also routed straight back the way the car faced, which more than half of all trips needed. These cars can't turn round in a two-lane street, so the brains learned to ignore the GPS and loop the block.
- **Road condition** reads 0 on a dry road, 0.5 in rain and 1 on ice, the way a driver sees rain on the windshield. It says the road is slippery; evolution has to work out what to do about it. This is a sensor, not knowledge: brains start random either way.

Navigation never steers. The brain has to learn to follow the arrow and stay on the road at the same time.

**Levels never run out, and they add one challenge at a time.** Every town has six levels: an easy one to learn the new streets, then one level per challenge on its own (a farther target, a tighter clock, road closures, the town's hazard), then a level that stacks them all. The sample town has five, without closures or a hazard. Then the town changes, and the next town's base is a notch harder (`worldLevelSpec` in `world/sim.ts`).

| Levels | Town | What each level asks |
| --- | --- | --- |
| 1-5 | Sample town | 1. Stay on the road for 45 s · 2. A close target, relaxed clock · 3. Farther away · 4. Tighter clock · 5. Far and fast |
| 6-11 | Downtown | 6. New streets, close target · 7. Farther · 8. Tighter clock · 9. Detours · 10. Pedestrians · 11. Everything at once |
| 12+ | A new town every six levels | The same six steps with the town's own hazard, each town a notch harder: longer trips, tighter clocks (never below 1.3× the ideal time), and more road closures per trip (1, then 2, then 3) |

**Hazards** change how the cars drive, not just how the town looks (`world/hazards.ts`). Each town introduces its own on a level by itself, then folds it into its last level. Every hazard also adds fair time to the clock: per crosswalk on the route for pedestrians, or a share of the time for weather and darkness.

| Town | Hazard | What it does to the cars |
| --- | --- | --- |
| Downtown | Pedestrians | People wait at the curb and walk the crosswalks on the simulation's clock. The sensors see them, and hitting one is a crash |
| Desert | Sandstorm | Every sensor sees less than half as far |
| Snowy | Black ice | Snow cuts grip everywhere, and patches of ice on the trips' routes give almost none. Cars slide wide and take longer to stop |
| Coastal | Sea fog | Every sensor sees less than half as far |
| Autumn | Rain | Wet roads cut grip, so fast turns slide |
| Dusk and night towns | Darkness, on every level | Past the headlights the side sensors see less (much less at night), except under the street lamp at every junction |

Grip is modelled simply: with less grip the car's direction of travel lags its heading, so it slides through turns, and it accelerates and brakes less.

1. **Staying on the road (level 1)** is the course's challenge. Fitness is distance driven. It's cleared when a car is still driving at 45 s and has covered at least 300 m away from the start, so circling in place doesn't count.
2. **Every other level is three timed trips** from the town's Start marking to the same target, the red pin. A level picks its target at random once and keeps it until the level is cleared, so every generation faces the same test. A level is cleared when one brain arrives in time on all three trips. Reset learning picks new targets; a refresh keeps them.
3. **Detours.** On detour levels, trip 2 closes a street on the route trip 1 would take, and trip 3 keeps that closure and closes another on trip 2's route. Every trip needs a different way to the same target. Closed streets get orange barricades that the sensors see as walls, and the GPS routes around them. A street is only closed if the target stays reachable and the detour stays reasonable (at most about 1.6 times the direct route, or 90 m more).

**Fair time limits.** Each trip's limit is worked out from its own route, closures included: the ideal time at top speed, plus time for each turn, stop sign and traffic light, times the level's factor. A longer detour gets more time.

**Scoring per trip:** the share of the route covered, plus a bonus for arriving in time that grows with the time to spare. Every trip counts the same, however long it is.

The camera and the highlighted car follow the best car that is still moving. A car stopped in place for over a second is skipped while others drive. A crashed or stopped leader still scores and breeds; it just isn't followed.

**Every town looks different.** Towns are generated fresh each session (`world/mapgen.ts`), and each brings its own street feature and its own look (`world/worldThemes.ts`, `world/items.ts`, `world/scenery.ts`):

| Town | Streets | Look |
| --- | --- | --- |
| Downtown | A regular grid, the first traffic lights | Tall flat-roofed towers with window rows and rooftop units, concrete plazas, a few street trees |
| Desert town | Bent and missing streets, diagonal shortcuts | Low adobe blocks with parapets, sand with wind ripples and pebbles, saguaro cacti |
| Snowy town | Adds one-way streets | Brick and timber houses with snowy roofs and lit windows, snow-tipped pines |
| Coastal town | Bigger | White houses with blue roofs, a beach and the sea |
| Autumn suburb | Bigger still, up to 8 by 8 blocks | Brick and clapboard houses, orange, red and gold trees, fallen leaves |
| Towns 6-10 | Keep growing | The same five at dusk: warm light, lamps coming on, headlights. Darkness is the new challenge |
| Towns 11-15 | Keep growing | The same five at night: lit windows, street lamps at every junction, headlights |

After that the cycle repeats, and two towns in a row never look alike. Buildings line both sides of every street. The course's method only follows the town's outline, which leaves the inside of big blocks empty.

Every generated town is checked to be connected both ways, one-way streets included. Traffic lights ramp in town by town. Red lights are walls for the sensors; yellow is not. Yellow lights crushed cars that were already in the junction, so this is a deliberate difference from the course. The lights run on the simulation's clock, so they keep pace at Max speed.

`npx tsx scripts/train-world.ts [generations] [cars] [mutation] [start level]` runs the world headless, swapping towns as levels clear. In test runs, populations cleared the sample town's five levels in roughly 15 to 60 generations, and the first downtown levels soon after. The first detour level is the first real wall. Before the GPS fixes above, three populations sat on it for 350+ generations. After them, one run cleared it in about 60 generations and another in about 10, then the pedestrian level within a few more.

### Your own maps

When you draw on the map (roads or markings), import a file, load the course city or open a saved map, the page switches to **training on your map**:

- **One timed trip per generation,** from your Start marking to your Target marking. Without a Target, the cars head for the farthest road.
- **The level brains are set aside first,** and "Back to the levels" puts them back exactly as they were. Nothing learned on your map changes the level brains.
- **Drive it yourself** on your map gets the same red pin, GPS line and timer.
- **My maps** keeps named maps in your browser. The last map you edited is always offered there.
- **Sharing is opt-in.** When the page runs as a published Claude artifact, saving a map can also share it with the developer for inspiration. Only the roads and markings are sent, never a name or email. Each visitor writes only to their own folder, and only the page's owner can read shared maps. Viewers who can only view the page aren't offered sharing. On other hosts there is no database, so the option doesn't appear.

### Course chapters

| Course chapter | Here |
| --- | --- |
| Spatial graphs | `world/graph.ts`, `world/geom.ts`: points, segments, polygons, envelopes |
| Graph editor | `world/editors.ts` GraphEditor: click to add, click to connect, drag, right-click to delete |
| Dynamic viewport | `world/viewport.ts`: wheel zoom toward the cursor, Space or middle-drag to pan, Fit |
| Generating roads | `World.generateRoads`: envelope per road, `Polygon.union` for the borders |
| Buildings and trees | `World.generateBuildings / generateTrees`: guide envelopes, spaced bases, rejection-sampled trees |
| Pseudo 3D | `world/items.ts`: walls and roofs lifted away from the camera, layered trees, per-theme styles |
| Road markings | `world/markings.ts`: stop, yield, crossing, parking, light, start, target |
| Saving the world | Autosaves in the browser, copy or import map JSON, opens the course's own `.world` saves, My maps |
| Integration | `world/sim.ts`: NEAT, levels, timed trips, your-map training |
| OpenStreetMap | `world/osm.ts`: paste the query into overpass-turbo.eu, export raw JSON, import it |
| Minimap | `world/minimap.ts` |

"Load the course city" opens `public/samples/course-city.json`, converted from the course repo's `big.world` save.

Other deliberate differences from the course:
- Lane guides are computed per road with an explicit direction (right-hand traffic), so markings always face the way cars drive.
- Generations advance automatically with a time limit.
- Maps over 300 roads are view-and-drive only, since regenerating roads is quadratic.

## Code map

```
src/
  neat.ts        NEAT: genomes, innovation numbers, speciation, crossover, growth
  network.ts     the course's fixed-shape network (kept for reference and tests)
  sensor.ts      ray casting against road edges and nearby traffic
  car.ts         physics, collision, progress tracking, drawing
  road.ts        road shapes: lanes, curves, construction zones, cones
  traffic.ts     seeded traffic: lane speeds, lane changes, merges
  themes.ts      highway themes and scenery
  simulation.ts  highway levels, generations, NEAT breeding, saving
  chart.ts       learning curve shared by both pages
  visualizer.ts  draws the leader's network live
  main.ts        highway canvas, UI controls, session storage
  world/         geometry, graph, world generation, markings, editors, viewport, OSM, minimap,
                 navigation (nav.ts), level maps (mapgen.ts), themes, sim, sharing (share.ts)
tests/core.test.ts, tests/world.test.ts
```

## Design notes

The interface borrows from US highway signage. It uses Overpass (an open-source revival of Highway Gothic), green guide signs for the title and progress, real lane paint on the road, and construction orange reserved for the main action. In the network view, yellow connections excite a neuron and blue ones inhibit it.

## Credits and licences

- The courses this started from are © Radu Mariescu-Istodor, MIT licence. See `public/samples/COURSE-LICENSE.txt`, which also covers the converted course city.
- Map data from OpenStreetMap is © OpenStreetMap contributors and available under the [Open Database License (ODbL)](https://www.openstreetmap.org/copyright). The page shows this credit whenever an OpenStreetMap map is loaded. If you share a database built from OSM data, ODbL's share-alike terms apply to it.
- NEAT: Kenneth O. Stanley and Risto Miikkulainen, "Evolving Neural Networks through Augmenting Topologies", 2002.
