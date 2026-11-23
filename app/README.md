# CAAD app

The browser app: a static site (Vite + TypeScript). build123d runs in a Web Worker (Pyodide + OCP.wasm); `public/caad_kernel.py` turns a part file into a timeline, runs it up to a feature, tessellates the result per face and edge, and finds verified build123d selectors for selected geometry.

```bash
npm install
npm run dev          # http://localhost:5173 — open in Chrome or Edge
npm run build        # static files in dist/, deployable as-is (e.g. Vercel)
npm run test:smoke   # drives the app in headless Chromium (CHROME=/path/to/chrome to override)
```

The first start takes about a minute while the CAD kernel loads (see `../docs/02-spike-results.md`).

| File | What it does |
| :-- | :-- |
| `src/main.ts` | Glue: project, building, saving, watching for outside edits |
| `src/kernel.worker.ts` / `src/kernel.ts` | Pyodide + lean build123d in a worker; client that keeps only the latest request |
| `public/caad_kernel.py` | Timeline from the code, rollback, errors per feature, per-face/edge mesh |
| `src/viewer.ts` | three.js view, Z up, face/edge picking and highlighting |
| `src/editor.ts` | CodeMirror code panel with error and feature line marks |
| `src/timeline.ts` | Timeline panel with rollback bar |
| `src/selection.ts` | Selection panel: properties and verified build123d selectors |
| `src/project.ts` | Local folder (File System Access API) or the bundled examples |
