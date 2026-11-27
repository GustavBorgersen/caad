# CAAD — Computer Agent Aided Design

**Status:** Concept draft v0.1 — kept as written; where details changed, the later docs are current (an own three.js viewer instead of three-cad-viewer: [03](03-mvp-plan.md); sketches solved by PlaneGCS in the page only, the code storing the solved geometry: [06](06-sketches.md); the roadmap: [04](04-roadmap.md))
**Date:** 2026-11-23

## 1. The idea in one paragraph

A browser-based CAD program for **build123d**, open source and built from existing open-source parts. You open a git repository; its build123d parts and assemblies appear in a CAD interface that feels like Onshape or SolidWorks — a **timeline** of features, **sketches** with constraints, **solids**, an **assembly** with mates. You can model yourself, and an AI agent (Claude Code or any MCP client) works on the same model through **MCP**: it sees what you see, knows what you've selected, can point at things in your view, and edits the model. **Everything you and the agent do ends up as code in the repo**, versioned in git.

## 2. Why — what this fixes

From designing MiniBrewery together in Onshape through its API:

| Pain point (Onshape + API) | CAAD |
| :-- | :-- |
| API quota: 2 500 calls/year on the free plan, used up in two sessions | Runs in your browser — no quota, no cost |
| Errors come back as "REGEN_ERROR" with no detail | Python tracebacks, shown at the failing feature in the timeline |
| Pointing at a face means entity IDs and query strings | You click it; the agent gets a description and a selector |
| Moving parts in an assembly through the API went wrong | Mates are code; positions are values |
| The agent sees the model only through occasional screenshots | The agent can render any view, any time |
| Interference checks had to be home-made | Exact checks from the geometry kernel |
| The person's edits and the agent's edits don't meet | One source of truth: code in git |

## 3. Principles

1. **Code is the model.** Every action — yours in the GUI or the agent's — becomes a code change. The repo is the project; git is the version history.
2. **Both of you can model.** Sketch a quick draft yourself, let the agent refine it, tweak it yourself, and go back and forth. The GUI is not just a viewer.
3. **Build on open source; don't reinvent wheels.** Kernel, Python in the browser, viewer, constraint solver — all exist.
4. **Start small, grow.** A solid core (timeline, sketches, extrude/revolve/cut, fillet, basic assembly) that more CAD features can be added to.
5. **No server to run.** A static web app (Vercel, GitHub Pages…); the only local piece is a tiny MCP bridge that Claude Code starts by itself.

## 4. Building blocks (all open source)

| Need | Project | Notes |
| :-- | :-- | :-- |
| CAD modelling | [build123d](https://github.com/gumyr/build123d) | Python, OpenCascade kernel |
| build123d **in the browser** | [OCP.wasm](https://github.com/yeicor/OCP.wasm) + [Pyodide](https://pyodide.org) | OpenCascade's Python bindings compiled to WebAssembly; build123d runs unchanged in the browser |
| 3D viewer | [three-cad-viewer](https://github.com/bernhard-42/three-cad-viewer) (the engine behind OCP CAD Viewer) or [Yet Another CAD Viewer](https://github.com/yeicor-3d/yet-another-cad-viewer) | three.js-based, made for OCP/build123d shapes |
| 2D sketch **constraint solver** | [PlaneGCS](https://github.com/Salusoft89/planegcs) — FreeCAD's sketcher solver | Available both as **WebAssembly for the browser** (`@salusoft89/planegcs`) and as [Python bindings](https://pypi.org/project/planegcs/) — the same solver on both sides |
| Agent connection | [Model Context Protocol](https://modelcontextprotocol.io) | Claude Code and other agents speak it |
| Local folder access | Browser File System Access API | Chrome/Edge; read and write a repo folder after the user grants access |

Prior art to study: OCP CAD Viewer, CQ-editor, [CADmium](https://github.com/CADmium-Co/CADmium) (browser CAD), [JSketcher](https://github.com/xibyte/jsketcher), the FreeCAD / Blender / Onshape MCP servers.

## 5. Architecture

```
┌─────────────────────────── Browser (static site, e.g. Vercel) ───────────────────────────┐
│  CAD UI: timeline · sketcher (PlaneGCS wasm) · 3D view (three.js) · assembly            │
│  Pyodide + OCP.wasm + build123d: runs the project's Python, tessellates, checks         │
│  Repo access: File System Access API (local folder); later GitHub                      │
└───────────────┬───────────────────────────────────────────────────────────────────────┘
                │ WebSocket to localhost
┌───────────────┴────────────────┐        stdio (MCP)        ┌──────────────────────────┐
│  caad-mcp bridge (tiny,        │ ◄────────────────────────► │  Claude Code (or other   │
│  started by Claude Code)       │                            │  MCP client)             │
└────────────────────────────────┘                            └──────────────────────────┘
```

- **Everything heavy runs in the browser:** Python, the CAD kernel, the solver, rendering. The site itself is just static files.
- **Why a bridge at all:** a browser tab can't accept connections, so Claude Code can't talk to it directly. Claude Code *can* start a local MCP server process (stdio). The bridge is that process: it's started automatically by Claude Code (configured once with `claude mcp add`), opens a localhost WebSocket, and the CAAD page connects to it. The user never runs a web server.
- **Files:** the agent also edits the repo's files directly (Claude Code's normal file tools); the bridge watches the folder and tells the page to rebuild.
- **Without an agent** the site works on its own — no installation at all.
- **Later option:** a hosted relay (pairing code instead of a local bridge) for agents that only speak remote MCP. Needs a small stateful service (serverless functions can't hold the WebSocket) and sends model data through the cloud — so not the default.

## 6. The timeline

A build123d part in builder style is already a sequence of operations:

```python
with BuildPart() as bracket:
    with BuildSketch(Plane.XY) as base:        # 1  Sketch "base"
        Rectangle(60, 40)
    extrude(amount=8)                          # 2  Extrude 8 mm
    with BuildSketch(bracket.faces().sort_by(Axis.Z)[-1]):   # 3  Sketch on top face
        with Locations((20, 0)):
            Circle(5)
    extrude(amount=-8, mode=Mode.SUBTRACT)     # 4  Hole
    fillet(bracket.edges().filter_by(Axis.Z), radius=3)       # 5  Fillet
```

- **Timeline = the feature statements.** Each one is a row in the timeline, named, linked to its line of code.
- **Rollback:** run the part up to feature N and show that state; edit an earlier feature and replay the rest.
- **When something breaks, the timeline shows where:** the failing feature turns red with the Python error, the features after it are greyed out — like Onshape.
- **The GUI needs a predictable structure** to read and write: one statement per feature, with names. Free Python is still allowed (loops, functions) — the GUI shows such blocks as "custom code" features that you edit as text.
- **Selections the agent writes into code** become selectors (e.g. `faces().sort_by(Axis.Z)[-1]`) rather than fragile IDs, so they survive replays — the classic "topological naming" problem.

## 7. Sketches and constraints

- A sketch is stored in code as entities (points, lines, arcs, circles), **constraints** (coincident, horizontal, tangent…) and **dimensions** (which can reference parameters).
- **While you drag in the sketcher**, PlaneGCS (WebAssembly) solves live in the browser.
- **When the model rebuilds** — after you or the agent change a dimension in code — PlaneGCS (Python) solves the same sketch. Same solver both sides → same result.
- A small CAAD library on top of build123d turns a solved sketch into build123d geometry. That library is the main piece we write ourselves.

## 8. MCP tools (first set)

| Tool | What it does |
| :-- | :-- |
| `get_selection` | What the user has selected: part, feature, face/edge type, position, normal, radius, a suggested selector, optionally an image |
| `render` | Render any view (or the user's current view) to an image |
| `highlight` | Point at geometry in the user's view ("this edge?") |
| `get_timeline` / `rebuild` | The timeline with each feature's status and errors |
| `measure` | Distances, angles, areas between entities |
| `check_interference` | Exact overlaps between parts / at mate positions |
| `set_parameter` | Change a named parameter (writes the code) |

## 9. First milestone (MVP)

1. Open a local repo folder; list its parts.
2. Run a build123d part in the browser (Pyodide + OCP.wasm) and show it (three-cad-viewer).
3. Timeline from the feature statements; rollback; errors at the failing feature.
4. Select faces/edges; MCP bridge with `get_selection`, `render`, `highlight`, `rebuild`.
5. Simple GUI modelling that writes code: sketch on a plane or face (rectangle, circle, line; a few constraints), extrude/cut.

After that: parameter panel, more sketch tools and constraints, fillet/chamfer/revolve, assemblies with mates and interference, GitHub repos.

## 10. Open questions

- **Browser support:** the File System Access API is Chromium-only (Chrome, Edge). Firefox/Safari would need upload/download or a GitHub-only mode.
- **Performance:** Pyodide + OCP.wasm load time (tens of MB) and modelling speed in WebAssembly — measure early with a realistic part.
- **Code style:** how strict should the "timeline style" be, and how do we round-trip GUI edits without destroying the user's hand-written formatting (concrete syntax trees, e.g. LibCST)?
- **Name:** CAAD is the working name.
