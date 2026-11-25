# CAAD — Feasibility spike results

**Date:** 2026-11-23
**Code:** `spike/` (each folder runs on its own; see the commands below)

Three questions decide whether the architecture in [01 — Concept](01-concept.md) holds. All three: **yes**. Start-up takes ~45–60 s once per session, which is accepted.

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
- **Cold start is the problem.** ~2.5 minutes on first load — mostly avoidable, see 1b. Ways to cut it further:
    - **Cache the wheels** in the browser (HTTP cache / Cache Storage) — removes the 75 s download after the first visit.
    - **Browsers cache compiled WebAssembly**; Node doesn't. The 59 s import should shrink on repeat visits in Chrome — must be measured in a real browser.
    - **Pyodide memory snapshot** taken after `import build123d`: tried, fails ("Unexpected hiwire entry") because the installer leaves references to JavaScript objects; needs a cleaner install path (local wheels, no `pyfetch`) — promising but not solved.
    - **Load in a Web Worker** so the UI is usable (and can show the files and last-known geometry) while Python loads.
    - Learn from [Yet Another CAD Viewer](https://github.com/yeicor-3d/yet-another-cad-viewer)'s playground, which solves the same problem.

### Spike 1b — where the time and megabytes go, and a lean build123d

`spike/01-build123d-wasm/analyze.mjs` measured what the standard install pulls in:

| Download | Size | Needed for modelling? |
| :-- | --: | :-- |
| **threejs-materials** (photo textures for 3D rendering, via bd-materials) | **90 MB** | No |
| OCP.wasm (the OpenCascade kernel) | 23 MB | **Yes** |
| scipy | 14 MB | Only for a few functions (e.g. spline fitting) |
| Pyodide itself | ~10 MB | Yes |
| scikit-learn, sympy, numpy, IPython, others | ~15 MB | Mostly no (sympy is listed but never imported) |

Import time by package: sympy 13.5 s, OpenCascade 15.8 s, ezdxf 7.1 s, IPython 7.3 s, build123d itself (+ scikit-learn) 25.6 s.

**Compression or compiling Python won't fix this:** the wheels are already compressed (and textures don't compress further), and Pyodide already *is* Python compiled to WebAssembly — the time is spent loading large libraries, not running the model.

**Trimming does.** `lean.mjs` installs build123d with placeholder modules for threejs-materials, sympy, scikit-learn, IPython and ezdxf (they import fine and only fail if that specific feature is used); `lean-noscipy.mjs` also replaces scipy, which can be loaded on demand later.

| | Full | Lean | **Lean, scipy on demand** |
| :-- | --: | --: | --: |
| Download | ~150 MB | ~50 MB | **~36 MB** |
| On disk | 368 MB | 224 MB | 176 MB |
| Install | 75 s | 17 s | 17 s |
| `import build123d` | 59 s | 33 s | 27 s |
| **Cold start to first model** | 147 s | 71 s | **58 s** |

Same geometry in all three (pump body volume 105 145 mm³; a filleted sketch works). The rest is mostly OpenCascade's 152 MB of WebAssembly being compiled on import.

### Spike 1c — in a real browser (Chrome 152)

`spike/04-browser/` runs the lean build123d (scipy on demand) in a module Web Worker; the page stays responsive throughout.

| Step | First run | Repeat visit (normal reload) |
| :-- | --: | --: |
| Pyodide + numpy | 12.9 s | 9.9 s |
| Install build123d + OCP.wasm | 15.0 s | 12.9 s |
| **`import build123d`** | **34.9 s** | **34.2 s** |
| First model | 1.7 s | 1.9 s |
| **Rebuild after an edit** | **0.98 s** | **0.94 s** |
| Total to first model | 64.5 s | 58.9 s |

- **Editing speed is fine:** rebuilds under a second.
- **The browser cache barely helps**, because the remaining cost isn't downloading: the install unpacks and installs every time (~13 s), and **OpenCascade's 152 MB of WebAssembly is compiled from scratch on every visit (~34 s)** — Pyodide passes it to the browser as raw bytes, so Chrome's compiled-code cache isn't used.

**Ways to fix it (next steps):**

1. ~~**Compiled-code cache**~~ — tested in 1d: compiling is only ~3 s, so this can't help much.
2. **Persist the installed packages** in IndexedDB (Pyodide supports it) → saves the ~13 s install on repeat visits.
3. **Show the model before the kernel is ready:** cache the last tessellation, show part, timeline and code immediately; enable editing when the kernel is warm.
4. **Native kernel via the bridge:** when Claude Code's bridge is running, it can run native build123d (ready in seconds, ~10× faster); the browser kernel stays the fallback.

### Spike 1d — what the import actually spends its time on, and a memory snapshot

**Compiling is not the problem.** Compiling OpenCascade's 152 MB of WebAssembly takes **2.9 s** (`WebAssembly.compile`; the engine compiles lazily). The library is also loaded during install and not re-read at import, so a compiled-code cache can't help much. `where.mjs` splits the import:

| Step | Time (Node) |
| :-- | --: |
| `import OCP` — the Python bindings register thousands of OpenCascade classes in 330 modules | 15 s |
| `import build123d` on top — ordinary Python module loading | 11 s |

That is code *running*, so the only thing that skips it is a **memory snapshot**: save the state after `import build123d`, restore it next time. `snapshot2.mjs` does it with a clean install path — the lean set is **20 wheels, 28 MB**, unpacked straight into site-packages without micropip:

- Fresh start this way (unpack + import, no micropip): **46 s** (vs 58 s with micropip).
- **Making the snapshot works** now (the earlier "hiwire" error came from micropip): 311 MB, about 50 MB with brotli.
- **Restoring fails** ("offset is out of bounds"): Pyodide's snapshot saves memory only, and has no step to reload dynamically loaded libraries (OpenCascade, numpy) at the same addresses. Cloudflare's Python Workers solved exactly this in production with their own loader, so it is possible — but it is a project, not a spike. **Parked.**

**Decision (2026-11-23):** a one-time start of ~45–60 s per session is acceptable; what matters is that the workflow is smooth once running. So the design should hide the start-up instead of fighting it:

- Show code, timeline and the last cached geometry immediately; the kernel warms up in a Web Worker and editing switches on when it is ready.
- Load only the lean build123d; load scipy and the other extras on demand.
- Keep the kernel alive for the whole session (rebuilds < 1 s).
- When the bridge is running, a native kernel is an option for speed.

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

The architecture holds: **static site + build123d in WebAssembly + PlaneGCS on both sides + a tiny stdio MCP bridge**. Start-up stays at **~45–60 s once per session** — dominated by OpenCascade's Python bindings initialising, not by download or compilation (1d). That is accepted; the UI hides it (cached geometry, kernel in a Web Worker), and a working memory snapshot is a later optimisation.

## Running the spikes

```bash
cd spike/01-build123d-wasm && npm install && node run.mjs   # also: analyze.mjs, lean.mjs, lean-noscipy.mjs, where.mjs
node snapshot2.mjs   # run three times: fetch wheels, make snapshot, restore (fails, see 1d)
cd spike/04-browser && python3 -m http.server 8765   # open http://127.0.0.1:8765 in Chrome
cd spike/02-planegcs && npm install && node sketch.mjs
python3 -m venv .venv && .venv/bin/pip install planegcs && .venv/bin/python sketch.py
cd spike/03-mcp-bridge && npm install && node test.mjs
```
