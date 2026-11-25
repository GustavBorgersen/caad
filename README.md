# CAAD — Computer Agent Aided Design

A browser-based, open-source CAD program for [build123d](https://github.com/gumyr/build123d): Onshape-like modelling (timeline, sketches, solids, assemblies) on top of a git repo of Python files, with an AI agent working on the same model through MCP. Everything — yours and the agent's — ends up as code.

Working name. The MVP works end to end; see the [roadmap](docs/04-roadmap.md). Try it at **[caad.vercel.app](https://caad.vercel.app)** (Chrome or Edge).

| Doc | |
| :-- | :-- |
| [01 — Concept](docs/01-concept.md) | The idea and architecture |
| [02 — Spike results](docs/02-spike-results.md) | Feasibility: build123d in WebAssembly, PlaneGCS, MCP bridge |
| [03 — MVP plan](docs/03-mvp-plan.md) | Completed |
| [04 — Roadmap](docs/04-roadmap.md) | Phases from here, future features |
| [05 — Feature model](docs/05-feature-model.md) | Reading code back as editable features |
| [06 — Sketches](docs/06-sketches.md) | Constrained sketches in code, PlaneGCS at rebuild, the sketch editor |

Code: `app/` (the web app), `bridge/` (the agent bridge), `examples/`, `spike/`.

## Licence

[MIT](LICENSE). CAAD builds on [build123d](https://github.com/gumyr/build123d) (Apache-2.0), [OCP.wasm](https://github.com/yeicor/OCP.wasm) (MIT), [Pyodide](https://pyodide.org) (MPL-2.0), [three.js](https://threejs.org) and [CodeMirror](https://codemirror.net) (MIT).
