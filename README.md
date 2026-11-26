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
| [07 — Project structure](docs/07-project-structure.md) | Workspaces with several projects, the project file and layout, shared code, export |

Code: `app/` (the web app), `bridge/` (the agent bridge), `examples/`, `spike/`.

## Projects

Open a folder (the *workspace*, e.g. a git repository); CAAD finds its projects — folders with a `pyproject.toml` that has a `[tool.caad]` table — and lists their parts, shared code and exports. *New project* creates one. A project looks like this ([design doc 07](docs/07-project-structure.md)):

```
my-project/
├── pyproject.toml     [tool.caad]; dependencies = ["build123d==0.13.*"]
├── params.py          shared parameters: parts import them (`from params import wall`)
├── parts/             one part per file
└── exports/           STEP / STL, written by ⇩ Export
```

### Running parts outside CAAD (advanced)

Everything is plain build123d, so parts also run without the browser. From the project's folder, with Python and `build123d==0.13` installed: `python -m parts.lid`. Parts with constrained sketches (`from caad import Constrained`) also need the `caad` module: download [caad.py](https://caad.vercel.app/caad.py) (the one the page runs, also [app/public/caad.py](app/public/caad.py)) into the project's folder. Their sketches then build from the geometry CAAD last saved.

## Hosting CAAD yourself

Every [release](https://github.com/GustavBorgersen/caad/releases) has a `caad-<version>.zip`: the whole site (app, CAD kernel, agent bridge downloads), loading nothing from other sites. Unzip it into any folder on a static web server — useful where a company network filters CDNs or downloads from caad.vercel.app. Needs HTTPS for *Open folder* and correct MIME types (`.mjs`); see the README in the zip ([app/hosting/README.md](app/hosting/README.md)).

## Licence

[MIT](LICENSE). CAAD builds on [build123d](https://github.com/gumyr/build123d) (Apache-2.0), [OCP.wasm](https://github.com/yeicor/OCP.wasm) (MIT), [Pyodide](https://pyodide.org) (MPL-2.0), [three.js](https://threejs.org) and [CodeMirror](https://codemirror.net) (MIT).
