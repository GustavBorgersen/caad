# CAAD — notes for agents working on this repo

A browser CAD program for build123d (static site) plus a small agent bridge. Docs in `docs/` — start with `04-roadmap.md`; design decisions are in numbered design docs (`05-feature-model.md`, …). Write a design doc before building anything that changes how code maps to features, sketches, parts or files.

## Layout

| Path | What |
| :-- | :-- |
| `app/` | The web app (Vite + TypeScript, no UI framework). `src/main.ts` is the glue |
| `app/kernel-lock.json` | The kernel's wheels (URL + sha256) and Pyodide version. `scripts/kernel-fetch.mjs` (run by the Vite plugin) puts them and Pyodide's core into `app/public/kernel/` (git-ignored): the page loads nothing from CDNs or PyPI. `scripts/kernel-lock.mjs` re-resolves after a version change |
| `app/public/caad_kernel.py` | Python run inside Pyodide: timeline from code, rollback, errors per feature, tessellation, selectors, agent helpers |
| `app/public/caad.py` | The `caad` module part files import: constrained sketches (`Constrained`), solved by PlaneGCS (`app/src/gcs-solve.ts` in the page); must also build outside CAAD |
| `app/public/agent/guide.md` | build123d guide served to agents — every code example must build (test them) |
| `bridge/` | `caad-mcp`, the Go MCP bridge (stdio ↔ WebSocket on 127.0.0.1:7337+). `tools.json` and `instructions.md` are the agent's tool definitions and instructions; the page imports `tools.json` too |
| `examples/` | The bundled examples: a workspace with one project (`caad-examples/`: `pyproject.toml`, `params.py`, `parts/`) |
| `spike/` | Feasibility spikes; `spike/01-build123d-wasm/*-test.mjs` test the kernel in Node with Pyodide |

## Commands

```bash
cd app && npm install
npm run dev -- --host 127.0.0.1   # http://127.0.0.1:5173 (Chrome/Edge); kernel takes ~30-60 s to load
npm run build                     # type-check + static build into app/dist
npm run build:bridge              # Go via mise (bridge/mise.toml): all OS binaries into app/public/bridge (git-ignored)
npm run test:bridge               # bridge protocol test
npm run test:smoke                # headless Chromium (/usr/bin/chromium, override with CHROME=)
npm run test:agent                # real bridge + app, every agent tool
npm run test:sketch               # sketch mode end to end
npm run test:feature              # editing features in the dialog end to end
npm run test:project              # workspace, projects, shared code end to end
```

**Deployment**: `.github/workflows/deploy.yml` builds the bridge into `app/public/bridge`, runs the bridge test and deploys to Vercel (project `caad`, root directory `app`) with `vercel build` + `vercel deploy --prebuilt` — production on pushes to `main`, previews for pull requests. Vercel's own Git builds are off (`app/vercel.json`) since they can't build Go.

The headless tests start their own Vite server on other ports. Kernel changes can be tested faster in Node: `spike/01-build123d-wasm/{kernel,select,agent,sketch,feature,caad}-test.mjs` (needs `node snapshot2.mjs` once there to fetch the wheels; `kernel-env.mjs` boots the kernel as the page does).

## Conventions

- **Code is the source of truth.** Everything the GUI does must end up as readable build123d in the part file; never store model state elsewhere.
- **Part files**: parameters at the top, one `with BuildPart() as <name>:` block; each statement in the block is one timeline feature.
- **Projects** (docs/07): the folder you open is a workspace; projects are folders with a `pyproject.toml` that has `[tool.caad]`; parts in `<project>/parts/`, the project's folder is the import root (shared code like `params.py`).
- **The page is the agent's toolbox**: new agent abilities are page-side tool handlers (`app/src/tools.ts`) plus an entry in `bridge/tools.json`. The bridge only relays.
- **Agent guidance goes in `app/public/agent/guide.md`** (served by the page, always current), not in `bridge/instructions.md`: that is built into the bridge users install and rarely update, so it stays short and stable.
- Verify build123d assumptions in the real kernel (Node test or `run_snippet`) before relying on them; the page runs build123d 0.13 in Pyodide with some dependencies replaced by placeholders (see `kernel.worker.ts`).
- Don't commit binaries (`bridge/dist`, `app/public/bridge`, `app/public/kernel`) or `node_modules`.
- **The page loads everything from its own origin** (work networks filter CDNs and PyPI); the smoke test fails on any request to another origin.
