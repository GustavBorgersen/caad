# CAAD — MVP plan

**Date:** 2026-11-23
**Builds on:** [01 — Concept](01-concept.md) (section 9, first milestone) and [02 — Spike results](02-spike-results.md)

## Goal

One complete loop, end to end:

> open a repo folder → see a part and its timeline → change the code (you or the agent) → rebuild in about a second → the agent sees what you select and can point at things → simple modelling in the GUI writes code.

Everything else (assemblies, mates, more sketch tools, GitHub repos) comes after this loop feels good.

## Decisions

| Topic | Decision | Why |
| :-- | :-- | :-- |
| Where | `CAAD/app/` (web app), `CAAD/bridge/` (caad-mcp), `CAAD/examples/` (test parts) | Moves to its own repo later |
| App stack | Vite + TypeScript, no UI framework | Static build for Vercel; few dependencies; easy for contributors |
| Kernel | Pyodide + lean build123d in a module Web Worker (from the spikes) | UI stays responsive; start-up hidden |
| Kernel logic | Our own Python module `caad_kernel.py`, run inside Pyodide | Timeline analysis, rollback, tessellation and selectors are easiest in Python, next to build123d |
| 3D view | Own small three.js viewer instead of three-cad-viewer | We need face/edge picking and highlighting under our control, on meshes our kernel produces per face and edge. three-cad-viewer stays a reference |
| Code editor | CodeMirror 6 (Python mode) | Small, modular, standard |
| Files | File System Access API; changed files are polled every second | Agent edits rebuild live even before the bridge watches files. Chrome/Edge only for now |
| GUI → code | Text inserts at positions from Python's `ast` | Enough for adding features; LibCST later if formatting suffers |
| Agent link | The page is the agent's toolbox (docs, API lookup, running code, writing parts); a tiny local bridge only relays | One-stop: nothing else to install; works with agents that have no file tools |

## Part file convention

A part is a `.py` file in the repo with one top-level builder block. Parameters at the top become the parameter panel later.

```python
from build123d import *

width = 60          # parameters: plain top-level assignments
thickness = 8

with BuildPart() as bracket:                    # the part
    with BuildSketch() as base:                 # feature 1: Sketch
        Rectangle(width, 40)
    extrude(amount=thickness)                   # feature 2: Extrude
    fillet(bracket.edges().filter_by(Axis.Z), radius=3)   # feature 3: Fillet
```

- **Timeline = the statements directly inside the `with BuildPart()` block.** Each is one feature, with a label from the code (`Sketch`, `extrude 8`, `fillet r=3`…).
- **Rollback to feature N** = run the file with the block cut after statement N.
- **Errors:** the line in the traceback picks the failing feature (red, with the message). The view shows the part as it was before that feature, and later features are greyed.
- Files without a builder block are shown as one "custom code" feature, displaying the last `Part` they create.

## Milestones

| # | Milestone | Done when |
| :-- | :-- | :-- |
| **M1** | **Shell and kernel.** Layout (parts + timeline · 3D view · code); kernel worker with lean build123d; open a folder, list parts, build and show one | Opening `CAAD/examples` in Chrome shows the pump body, rotatable, with face and edge lines |
| **M2** | **Timeline and editing.** Features from the code, rollback by clicking, errors at the failing feature; edit in the code panel → save to file → rebuild; external edits (the agent) rebuild automatically | Breaking a fillet turns that feature red and the view shows the part before it; an edit from Claude Code shows up within ~2 s |
| **M3** | **Selection.** Pick faces and edges (hover highlight, click to select, multi-select); info panel: type, position, normal, radius, area; a **verified build123d selector** for the selection | Clicking the top face shows `bracket.faces().sort_by(Axis.Z)[-1]` |
| **M4** | **Agent package.** The page gives the agent everything it needs, so it needs no local build123d or Python: MCP *instructions* (CAAD conventions), `build123d_guide`, `api_help` (signatures and docs from the page's own build123d), `run_snippet`, `list_parts`/`read_part`/`write_part`/`edit_part` (the page writes the file, rebuilds and returns the result), `get_timeline`, `get_selection`, `highlight`, `render`. The **bridge** is a small self-contained program (Go, ~5 MB, no runtime needed), downloadable from the page for each OS, with the `claude mcp add` line shown; it accepts only the CAAD page's origin | With only the page and the bridge, Claude Code (in any folder) can answer "what have I selected?", look up the API, and add a fillet to the selected edges — and the change shows up in the file and the timeline |
| **M5** | **GUI modelling** (M5a: drawing and extrude/cut; M5b: persistent constraints). Sketch on a plane or a selected face: rectangle, circle, line, a few constraints (PlaneGCS in the browser); extrude/cut; each action inserts code at the timeline position | Drawing a rectangle on the top face and cutting it adds two readable statements to the file |

## Status

| # | State |
| :-- | :-- |
| M1 | **Done** (2026-11-23): `CAAD/app`, kernel in a worker, examples built in; headless smoke test passes |
| M2 | **Done** (2026-11-23): timeline, rollback, errors per feature, editing with save and rebuild; outside edits (the agent) show up in ~2 s — confirmed in Chrome with a real folder |
| M3 | **Done** (2026-11-23): hover/click/Shift-click selection; panel with type, area/length, radius, centre, normal/axis; up to three **verified** selectors (each is evaluated and must return exactly the selection; position-based ones are labelled); the selection is found again after every rebuild |
| M4 | **Done** (2026-11-24), to be tried with real Claude Code: Go bridge (`CAAD/bridge`, 6–7 MB per OS, origin allowlist, tool list from the page), 13 tools answered by the page, MCP instructions, tested build123d guide, Agent dialog with downloads and setup commands; end-to-end test with the real bridge and app passes |
| M5a | **Done** (2026-11-24): sketch mode on Top/Front/Right or a selected flat face (by its verified selector); rectangle, circle, polygon with grid snapping and editable dimensions; extrude/cut (depth, both directions, through all); writes plain build123d code after the timeline position; **+ New part** |
| M5b | Next, needs a design decision: constraints that stay in the code (coincident, horizontal, tangent, equal, dimensions referencing parameters), solved by PlaneGCS in the browser and in Python |

## After the MVP

| # | Milestone | Notes |
| :-- | :-- | :-- |
| **M6** | **GitHub mode.** Open a repo and branch on GitHub directly in the page (or create a branch); a working copy in browser storage; commit (by you, or by the agent through a `commit` tool) as one atomic commit via GitHub's Git Data API | No server needed: GitHub's REST API allows browser requests. Sign-in with a fine-grained personal access token first. Because the agent writes through the page, it then needs no local repo at all. Local folders remain an option |
| later | **Hosted relay** instead of the local bridge: the page shows an MCP URL (`claude mcp add --transport http caad https://…`) | Zero install; works with claude.ai on the web, Claude Desktop and any remote-MCP client. Needs a small always-on service (e.g. Cloudflare Durable Objects) and sends model data through it, so self-hostable and optional |
| later | **Sign in with GitHub** (OAuth) | Needs a tiny serverless function for the token exchange |
| later | **Native kernel via the bridge** | If build123d is installed locally, run models natively (fast start, ~10× faster), with the browser kernel as fallback |

## Not in the MVP

Assemblies and mates, parameter panel, fillet/chamfer/revolve tools in the GUI, GitHub mode (M6), Firefox/Safari, memory snapshots, hosted relay, multiple parts in one view.

## Order of work

M1 → M2 → M3 → M4 → M5. M1–M3 together make CAAD useful without an agent; M4 is where it becomes CAAD; M5 is the start of "real" GUI modelling.
