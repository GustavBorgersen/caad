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
| **M4** | **Agent bridge.** `CAAD/bridge` as an npm package (`caad-mcp`); the page connects to it automatically; tools `get_selection`, `highlight`, `get_timeline`, `rebuild`, `render` (image of the current view); origin check and pairing token | Asking Claude Code "what have I selected?" and "fillet that edge" works without describing geometry in words |
| **M5** | **GUI modelling.** Sketch on a plane or a selected face: rectangle, circle, line, a few constraints (PlaneGCS in the browser); extrude/cut; each action inserts code at the timeline position | Drawing a rectangle on the top face and cutting it adds two readable statements to the file |

## Status

| # | State |
| :-- | :-- |
| M1 | **Done** (2026-11-23): `CAAD/app`, kernel in a worker, examples built in; headless smoke test passes |
| M2 | **Done** (2026-11-23): timeline, rollback, errors per feature, editing with save and rebuild; outside edits (the agent) show up in ~2 s — confirmed in Chrome with a real folder |
| M3 | Started: face/edge hover and click selection work; info panel and selectors next |
| M4–M5 | Not started |

## Not in the MVP

Assemblies and mates, parameter panel, fillet/chamfer/revolve tools in the GUI, GitHub repos, Firefox/Safari, memory snapshots, hosted relay, multiple parts in one view.

## Order of work

M1 → M2 → M3 → M4 → M5. M1–M3 together make CAAD useful without an agent; M4 is where it becomes CAAD; M5 is the start of "real" GUI modelling.
