# CAAD app

The browser app: a static site (Vite + TypeScript). build123d runs in a Web Worker (Pyodide + OCP.wasm); `public/caad_kernel.py` turns a part file into a timeline, runs it up to a feature, tessellates the result per face and edge, and finds verified build123d selectors for selected geometry.

```bash
npm install
npm run dev          # http://localhost:5173 — open in Chrome or Edge
npm run build        # static files in dist/, deployable as-is (e.g. Vercel)
npm run test:smoke   # drives the app in headless Chromium (CHROME=/path/to/chrome to override)
npm run build:bridge # builds the agent bridge for all systems into public/bridge (needs Go, see ../bridge)
npm run test:bridge  # bridge protocol test
npm run test:agent   # the real bridge + app in headless Chromium, every agent tool
npm run test:sketch  # sketch mode: draw, cut, sketch on a face, new part
npm run test:feature # feature dialog: double-click, edit with live preview, OK/Cancel
```

The first start takes about a minute while the CAD kernel loads (see `../docs/02-spike-results.md`).

| File | What it does |
| :-- | :-- |
| `src/main.ts` | Glue: project, building, saving, watching for outside edits |
| `src/kernel.worker.ts` / `src/kernel.ts` | Pyodide + lean build123d in a worker; client that keeps only the latest request |
| `public/caad_kernel.py` | Timeline from the code, rollback, errors per feature, per-face/edge mesh; reading and patching features |
| `src/viewer.ts` | three.js view, Z up, face/edge picking and highlighting |
| `src/editor.ts` | CodeMirror code panel with error and feature line marks |
| `src/timeline.ts` | Timeline panel with rollback bar; double-click edits a feature, × deletes one, + Fillet / + Chamfer at the bar add one |
| `src/feature-dialog.ts` | Feature dialog: fields from the kernel, live preview, surgical patch on OK (`../docs/05-feature-model.md`) |
| `src/selection.ts` | Selection panel: properties and verified build123d selectors |
| `src/project.ts` | Local folder (File System Access API) or the bundled examples |
| `src/agent.ts` / `src/tools.ts` | Connection to the local bridge; the agent's tools, answered by the page |
| `src/agent-dialog.ts` | Agent button and setup dialog (bridge download, `claude mcp add` line) |
| `src/sketcher.ts` / `src/sketch-code.ts` | Sketch mode (draw, snap, dimensions); a sketch's body and its extrude's arguments (the kernel inserts them as named features) |
| `public/agent/guide.md` | build123d guide for the agent (every example is tested) |
