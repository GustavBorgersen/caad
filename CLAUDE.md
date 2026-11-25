# CAAD — notes for agents working on this repo

A browser CAD program for build123d (static site) plus a small agent bridge. Docs in `docs/` — start with `04-roadmap.md`; design decisions are in numbered design docs (`05-feature-model.md`, …). Write a design doc before building anything that changes how code maps to features, sketches, parts or files.

## Layout

| Path | What |
| :-- | :-- |
| `app/` | The web app (Vite + TypeScript, no UI framework). `src/main.ts` is the glue |
| `app/public/caad_kernel.py` | Python run inside Pyodide: timeline from code, rollback, errors per feature, tessellation, selectors, agent helpers |
| `app/public/agent/guide.md` | build123d guide served to agents — every code example must build (test them) |
| `bridge/` | `caad-mcp`, the Go MCP bridge (stdio ↔ WebSocket on 127.0.0.1:7337+). `tools.json` and `instructions.md` are the agent's tool definitions and instructions; the page imports `tools.json` too |
| `examples/` | Example parts, bundled into the app |
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
```

The headless tests start their own Vite server on other ports. Kernel changes can be tested faster in Node: `spike/01-build123d-wasm/{kernel,select,agent,sketch}-test.mjs` (needs `node snapshot2.mjs` once there to fetch the wheels).

## Conventions

- **Code is the source of truth.** Everything the GUI does must end up as readable build123d in the part file; never store model state elsewhere.
- **Part files**: parameters at the top, one `with BuildPart() as <name>:` block; each statement in the block is one timeline feature.
- **The page is the agent's toolbox**: new agent abilities are page-side tool handlers (`app/src/tools.ts`) plus an entry in `bridge/tools.json`. The bridge only relays.
- Verify build123d assumptions in the real kernel (Node test or `run_snippet`) before relying on them; the page runs build123d 0.13 in Pyodide with some dependencies replaced by placeholders (see `kernel.worker.ts`).
- Don't commit binaries (`bridge/dist`, `app/public/bridge`) or `node_modules`.
