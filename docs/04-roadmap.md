# CAAD — Roadmap

**Date:** 2026-11-24
**Replaces:** [03 — MVP plan](03-mvp-plan.md) (completed)

## Where we are

The MVP loop works end to end. You open a folder of build123d files and see a part with its timeline; rollback, errors at the failing feature and editing all work, and edits from you or the agent rebuild in about a second. Faces and edges can be selected and get verified selectors. You can sketch on a plane or face and extrude or cut. An agent (Claude Code) connects through a small bridge program and gets everything else from the page: docs, API lookup, running code, writing parts, selection, highlight and render.

The first real session — "what have I selected?" → "chamfer the edge" → "make a toy car" — worked without workarounds.

## Goal from here

**A solid, Onshape-like base on top of build123d that we extend with CAD features as the need arises** — with the agent as a first-class user of the same model, and a path all the way from an idea to G-code.

Principles that carry over from the concept:

- **Code is the source of truth.** Everything the GUI does ends up as readable build123d in the repo; hand-written code stays allowed.
- **The page is the agent's toolbox.** Nothing to install besides the bridge.
- **Static site.** No server needed for the core.
- **Small solid core first**, then features.

## Phases

### Phase 1 — Solid core

The foundation everything else builds on: CAAD must be able to *read code back as features*, not just write it.

| Item | What | Design doc |
| :-- | :-- | :-- |
| **Feature model** | Each feature type (sketch, extrude, revolve, fillet, chamfer, hole…) defines its code form, how to read its parameters back, and its dialog. Unknown code stays a "code" feature | [05 — Feature model](05-feature-model.md) |
| **Timeline editing** | Double-click a feature to edit it in its dialog (sketch editor for sketches), with a live preview at its place in the timeline; insert at the rollback bar; delete | 05 |
| **Sketch and extrude as separate features** | A sketch is its own named feature (`sk1`); extrude, revolve etc. refer to it and can reuse it | 05 |
| **Sketches v2** | Free drawing (no grid), then constraints and dimensions like in Onshape; dimensions can use parameters; solved by PlaneGCS in the browser and at rebuild | [06 — Sketches and constraints](06-sketches.md) |
| **Project structure and project browser** | A default folder layout for part studios, assemblies, exports and sliced files, and a browser panel that shows them by type | 07 — Project structure (to write) |
| **Export** | STEP and STL download from the page; an agent tool that exports into the project's export folder | — |
| **Contrast fixes** | Clear marking of the selected/hovered feature in the timeline and the code, stronger colours — the quick part of the visual work | — |
| **Own repository** | **Done 2026-11-25:** [github.com/GustavBorgersen/caad](https://github.com/GustavBorgersen/caad), MIT licence, deployed to [caad.vercel.app](https://caad.vercel.app) by a GitHub Action that also builds the bridge into the site. Still to do: CI running the headless test suites, bridge binaries as GitHub release assets | — |

### Phase 2 — Part studio

| Item | What |
| :-- | :-- |
| **Several parts in one space** | A part studio file can create several parts, shown together with their own colours and visibility (design doc 08 — Part studios and assemblies, to write) |
| **New part or add to part** | Extrude and similar features choose: create a new part, add to / cut from an existing one |
| **Cross-part references** | A feature of one part can use faces and edges of another (e.g. a lid sketched on a box's rim) |
| **Drawing for the agent** | A pen mode draws on the view (circle an area, sketch an arrow); a `get_annotation` tool gives the agent the picture *and* the faces/edges under the strokes with their selectors |

### Phase 3 — Assemblies

| Item | What |
| :-- | :-- |
| **Assembly files** | Place parts from part studios as instances |
| **Mates** | Fastened, revolute, slider, cylindrical… mapped onto build123d's joints |
| **Motion and checks** | Move mates with sliders; interference check; exploded view |

### Phase 4 — Slicing

| Item | What |
| :-- | :-- |
| **Slice in the page** | Embed an open-source browser slicer — first candidate [Kiri:Moto](https://grid.space/kiri) (MIT, runs fully in the browser) |
| **Profiles in the project** | Printer, material and print profiles stored as files in the project, versioned with the parts |
| **Preview and export** | Layer preview; G-code saved into the project's print folder |
| **Agent tool** | `slice` — so the agent can go from an idea to a printable file |

### Alongside all phases

- **Visual design**: a separate brainstorm session (style directions as mock-ups to choose from), then a small design system (colours, type, icons, spacing, dark mode), then implementation. Includes a view cube / standard views, panel resizing and better shading and edges.
- **Tests**: every feature comes with headless tests, like the current smoke, bridge, agent and sketch suites.

## Design documents

| # | Document | Status |
| :-- | :-- | :-- |
| 05 | [Feature model and code round-trip](05-feature-model.md) | Slices 1–2 built; slice 3 next |
| 06 | [Sketches and constraints](06-sketches.md) | 06a, 06b built; converting plain sketches next |
| 07 | Project structure | To write in phase 1 |
| 08 | Part studios and assemblies | To write before phase 2 |
| — | Visual design | Brainstorm session first |

## Future features

Things to remember, not planned yet.

- **Send to printer** — OctoPrint, Moonraker/Klipper, Bambu… through the local bridge, which can reach printers on the local network.
- **Agent connection onboarding** — Chrome's local network access question still pops up as soon as the Agent dialog opens, before the user has read anything. Explain first, then trigger it from an explicit "Connect" step (and guide the user when it's blocked).
- **Messages from the page to the agent** — a Claude Code hook that attaches the page's state (selection, drawing, active part) to each prompt; or a chat in the page with its own agent.
- **GitHub mode** — open a repo and branch directly in the page, working copy in browser storage, atomic commits via the GitHub API (described in the MVP plan as M6).
- **Hosted relay** — zero-install alternative to the bridge; works with claude.ai on the web and any remote-MCP client.
- **Sign in with GitHub** (OAuth via a tiny serverless function).
- **Native kernel via the bridge** — run models natively when build123d is installed locally.
- **Faster start-up** — Pyodide memory snapshots including the OpenCascade library.
- **Firefox and Safari** — need an alternative to the File System Access API.
- **Configurations and variable tables**, **2D drawings**, **sheet metal**, **bill of materials**.
