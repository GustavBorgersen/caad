# CAAD app

The browser app: a static site (Vite + TypeScript). build123d runs in a Web Worker (Pyodide + OCP.wasm); `public/caad_kernel.py` turns a part file into a timeline, runs it up to a feature, tessellates the result per face and edge, and finds verified build123d selectors for selected geometry.

```bash
npm install
npm run dev          # http://localhost:5173 — open in Chrome or Edge
npm run build        # static files in dist/, deployable as-is (e.g. Vercel)
npm test             # the quick test set, ~30 s (see Tests below)
npm run test:all     # the complete set, as CI runs it
npm run build:bridge # builds the agent bridge for all systems into public/bridge (needs Go, see ../bridge)
```

The first start takes about a minute while the CAD kernel loads (see `../docs/02-spike-results.md`).

| File | What it does |
| :-- | :-- |
| `src/main.ts` | Glue: the workspace, building, saving, undo, watching for outside edits, the commands and menus, start-up |
| `src/style.css` / `src/theme.ts` | The visual system (`../docs/10-visual-system.md`): every colour a token, light and dark; the 3D view and the sketch editor read the tokens through `theme.ts` |
| `src/commands.ts` | The command registry: the toolbar, the keys, the tooltips and the shortcut sheet are built from it (`../docs/09-design-and-workflow.md`) |
| `src/ui.ts` | CAAD's own messages (with Undo), context menus, popovers, docked questions and naming in rows: no `prompt`/`confirm`/`alert` |
| `src/icons.ts` | Lucide icons plus CAAD's CAD icons, bundled |
| `src/files.ts` | The Files tab: projects and their files by kind; new, rename, duplicate and delete in the tree; the workspace switcher |
| `src/history.ts` | Undo and redo: each file's text, one step per change |
| `src/viewcube.ts` | The view cube: click a face, edge or corner to look from there |
| `src/kernel.worker.ts` / `src/kernel.ts` | Pyodide + lean build123d in a worker; client that keeps only the latest request |
| `kernel-lock.json`, `scripts/kernel-*.mjs` | The kernel's Python runtime, served from the site itself (`public/kernel/`, git-ignored), never from a CDN or PyPI: Pyodide's core from the `pyodide` npm package plus the wheels in the lock, checked by sha256. The Vite plugin fetches them before dev and build; `node scripts/kernel-lock.mjs` re-resolves the lock after a version change |
| `public/caad_kernel.py` | Timeline from the code, rollback, errors per feature, per-face/edge mesh; reading and patching features |
| `public/caad.py` / `src/gcs-solve.ts` | Constrained sketches (`from caad import Constrained`), solved by PlaneGCS (WebAssembly, called from Python); `points(sk1)` and `axis(sk1, line1)` for holes and revolve axes |
| `src/viewer.ts` | three.js view, Z up, face/edge picking and highlighting, outlines of unused sketches |
| `src/editor.ts` | CodeMirror code panel with error, feature and agent line marks; code colours from the tokens |
| `src/timeline.ts` | Timeline tab with the rollback bar: names as the code writes them, the agent's and errors' marks; double-click edits a feature, right-click for more; new features (the top bar's commands) go at the bar |
| `src/feature-dialog.ts` | Feature dialog: fields from the kernel, live preview, surgical patch on OK (`../docs/05-feature-model.md`) |
| `src/selection.ts` | Selection chip: what is selected and its best selector; properties and the other selectors behind "details" |
| `src/project.ts` | The workspace (a local folder via the File System Access API, or the bundled examples), its projects and their files by kind |
| `src/main.ts` (export) | Export: STEP / STL into the project's `exports/`, via the kernel's `export_part` |
| `src/agent.ts` / `src/tools.ts` | Connection to the local bridge; the agent's tools, answered by the page |
| `src/agent-dialog.ts` | Agent button and setup dialog (bridge download, `claude mcp add` line) |
| `src/sketcher.ts` | Sketch editor for constrained sketches: tools (in the top bar), snapping, dragging with live PlaneGCS solving, its docked panel; every action is a kernel code edit (`sketch_action`) |
| `public/agent/guide.md` | build123d guide for the agent (every example is tested) |

## Tests

Node's test runner (`node:test`); test files run in parallel, each in its own process.

| Command | What | Time |
| :-- | :-- | :-- |
| `npm test` | The quick set, while developing: `tests/kernel.test.mjs` (the kernel in Node: building, selectors, features, sketches, parameters, the agent guide), `tests/theme.test.mjs` (every colour pair passes WCAG AA in both themes) and `tests/ui-smoke.test.mjs` (the app in headless Chrome) | ~30 s |
| `npm run test:all` | Adds `tests/full/`: feature dialog, sketch editor, projects and files, layout and workflow (start page, keys, menus, views, parameters, undo, the agent's marks), no-reload, the agent end to end and the bridge protocol | ~2 min |
| `npm run test:kernel` | Only the kernel tests; no browser needed | ~30 s |
| `npm run test:bridge` | Only the bridge protocol | seconds |

- `CHROME=/path/to/chrome` for the UI tests (default `/usr/bin/chromium`; Chrome or Edge work).
- `SHOTS=dir` saves screenshots there, and `<suite>-error.png` when a step fails.
- The agent and bridge tests need the bridge binary (`npm run build:bridge`, or `CAAD_MCP=path`); without it they are skipped.
- One test by name: `node --test --test-name-pattern="sketch planes" tests/kernel.test.mjs`.
- The kernel tests (`tests/kernel/*.mjs`) share one kernel, booted by `tests/kernel/env.mjs` as the page's worker boots it. Each UI file opens the app with `openApp()` from `tests/ui/env.mjs`: its own Vite server on a free port, its own browser, and a page kept off every caad-mcp bridge but its own. A UI suite is a series of `step`s; after a failure the rest are skipped.
- `openApp(name, { start, theme, code })`: the app starts on the examples (or `start: "page"`, the start page), in the light theme, with the code pane shown; `app.nativeDialogs` lists any `alert`/`confirm`/`prompt` (there must be none) and `app.message()` reads CAAD's current message.
- `node tests/ui-shots.mjs [dir] [width] [height]`: screenshots of the main UI states at a laptop size, for checking the layout by eye.
