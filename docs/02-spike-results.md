# CAAD — Feasibility spike results

**Date:** 2026-11-23
**Code:** `CAAD/spike/` (each folder runs on its own; see the commands below)

Three questions decide whether the architecture in [01 — Concept](01-concept.md) holds. All three: **yes**, with one real problem to solve (start-up time).

## Spike 1 — build123d in WebAssembly (Pyodide + OCP.wasm)

`spike/01-build123d-wasm/run.mjs` runs Pyodide 314.0.8 under Node.js (the same WebAssembly a browser loads), installs build123d 0.13.0 with the OCP.wasm wheels, and builds the MiniBrewery pump body: a Ø100 ring with bore, recess, groove, two slots, four bolt holes and a fillet.

| Step | Time |
| :-- | --: |
| Load Pyodide | 9.6 s |
| Install build123d + OCP.wasm (wheels from PyPI; OCP wheel 22.7 MB) | 75 s |
| `import build123d` | 59 s |
| First model: build 2.4 s + tessellate 0.6 s (4 016 triangles) | 3.0 s |
| **Rebuild after an edit (warm)** | **1.4 s** |
| Cold start to first model | 147 s |

- **It works:** correct geometry (21 faces, right volume), real OpenCascade errors when something is invalid (an impossible fillet gave build123d's normal error message).
- **Rebuild speed is fine for interactive work** (~1.4 s for this part; native Python is ~10× faster, so heavy models will need care — rebuild only the part that changed, from the edited feature on).
- **Cold start is the problem.** ~2.5 minutes on first load. Ways to cut it, to investigate:
    - **Cache the wheels** in the browser (HTTP cache / Cache Storage) — removes the 75 s download after the first visit.
    - **Browsers cache compiled WebAssembly**; Node doesn't. The 59 s import should shrink on repeat visits in Chrome — must be measured in a real browser.
    - **Pyodide memory snapshot** taken after `import build123d`: tried, fails ("Unexpected hiwire entry") because the installer leaves references to JavaScript objects; needs a cleaner install path (local wheels, no `pyfetch`) — promising but not solved.
    - **Load in a Web Worker** so the UI is usable (and can show the files and last-known geometry) while Python loads.
    - Learn from [Yet Another CAD Viewer](https://github.com/yeicor-3d/yet-another-cad-viewer)'s playground, which solves the same problem.

## Spike 2 — PlaneGCS in the browser and in Python

`spike/02-planegcs/sketch.mjs` (WebAssembly, `@salusoft89/planegcs`) and `sketch.py` (Python, `planegcs` from PyPI) solve the same sketch: a rectangle with one fixed corner, horizontal/vertical sides, width 60 and height 40, and a circle (radius 5) whose centre is 25 mm from one corner and 45 mm from another.

| | Rectangle corners | Circle centre | Radius | Solve time |
| :-- | :-- | :-- | --: | --: |
| WebAssembly | (0,0) (60,0) (60,40) (0,40) | (18.333333, 16.996732) | 5 | ~50 ms (incl. setup) |
| Python | (0,0) (60,0) (60,40) (0,40) | (18.333333, 16.996732) | 5 | < 1 ms |

- **Identical results to six decimals** — one solver, two runtimes. The sketcher can solve live in the browser while dragging, and the rebuild can solve the same sketch in Python after a dimension changes in code.
- The two APIs differ (JSON primitives in JS, method calls in Python), so CAAD needs one small sketch format that maps to both.
- The Python API's `diagnose()` reports degrees of freedom and conflicting/redundant constraints — exactly what a sketcher needs to colour under-/over-constrained geometry.

## Spike 3 — MCP bridge between Claude Code and the page

`spike/03-mcp-bridge/bridge.mjs` is a ~60-line stdio MCP server that also listens on `ws://127.0.0.1:7337`. `test.mjs` starts it the way Claude Code does (official MCP client library), connects a fake CAAD page over WebSocket, and calls the tools.

- `get_selection`: agent → bridge → page → back, with part, feature, entity, geometry and a build123d selector.
- `highlight`: agent → bridge → page.
- With no page connected, tools fail with a clear message ("No CAAD page is connected").
- The bridge sees the page's origin, so it can **accept only the official CAAD site** (plus a pairing token) — necessary, since any web page could otherwise try to talk to it.

**Still to verify in a real browser:** an `https://` site connecting to `ws://127.0.0.1` is allowed (localhost counts as a secure context), but Chrome's Local Network Access rules show a one-time permission prompt. Expected, not a blocker.

## Conclusion

The architecture holds: **static site + build123d in WebAssembly + PlaneGCS on both sides + a tiny stdio MCP bridge**. The one thing to solve before it feels good is **start-up time** — the next spike should run build123d in a real browser (Web Worker, cached wheels) and measure a repeat visit.

## Running the spikes

```bash
cd CAAD/spike/01-build123d-wasm && npm install && node run.mjs
cd CAAD/spike/02-planegcs && npm install && node sketch.mjs
python3 -m venv .venv && .venv/bin/pip install planegcs && .venv/bin/python sketch.py
cd CAAD/spike/03-mcp-bridge && npm install && node test.mjs
```
