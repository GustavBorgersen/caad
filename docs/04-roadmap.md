# CAAD — Roadmap

**Date:** 2026-11-24, updated 2026-11-28
**Replaces:** [03 — MVP plan](03-mvp-plan.md) (completed)

## Where we are

Phase 1 is done. You open a folder (a workspace of projects) and see a part with its timeline; rollback, errors at the failing feature and editing all work, and edits from you or the agent rebuild in about a second. Features are read back from the code into dialogs with a live preview and patched surgically; sketches are constrained (PlaneGCS) and edited in a sketch editor with dimensions, part edges, trim, fillet, mirror and patterns; planes, revolve axes and extruding the part's own faces are in. Parts export to STEP and STL. An agent (Claude Code) connects through a small bridge program and gets everything else from the page: docs, API lookup, running code, editing parts and features, selection, highlight and render.

Phase 1.5 is done too (2026-11-28): one designed tool, with a command registry behind the toolbar, keys and context menus, CAAD's own dialogs and messages, undo for every change, light and dark themes, the new layout and view, and code and timeline that map one to one (names, rename, a paragraph per feature, cross-highlighting). Next is phase 2, parts and mates ([08](08-parts-and-mates.md)).

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
| **Feature model** | **Done 2026-11-26:** typed features with dialogs (extrude, revolve, hole, fillet, chamfer, mirror), generic dialogs for any build123d call, everything else stays code; surgical patching; `edit_feature` for the agent | [05](05-feature-model.md) |
| **Timeline editing** | **Done:** double-click a feature to edit it with a live preview (the sketch editor for sketches); add features at the rollback bar; delete (refused while used) | 05 |
| **Sketch and extrude as separate features** | **Done:** named private sketches (`sk1`); Done in the sketch editor adds only the sketch; *+ Extrude* / *+ Revolve* refer to it | 05 |
| **Sketches v2** | **Done (06a–06d):** constrained sketches in code, solved by PlaneGCS in the page; the sketch editor with free drawing, snapping, constraints and dimensions (expressions); plain sketches converted when first edited. 06c done: part edges in sketches (`c.project`, the *Use* tool), trim, sketch fillet, mirror and patterns, choosing regions to extrude (`regions(sk1, …)`, clicked in the view); 06d done: Onshape-like dimensions (arrows, extension lines, angle arcs), drawn points as rings, the sketch's X/Y axes | [06](06-sketches.md) |
| **Project structure and project browser** | **Done 2026-11-25:** a workspace with several projects (`pyproject.toml` with `[tool.caad]`), a browser by project and kind, shared code between a project's parts, *New project* | [07 — Project structure](07-project-structure.md) |
| **Export** | **Done 2026-11-25:** STEP and STL into the project's `exports/` (or a download), and an `export_part` agent tool ([07](07-project-structure.md)) | 07 |
| **Sketch planes and revolve axes** | **Done 2026-11-27:** a plane feature (`pl1 = Plane.XY.offset(10)`, rotated, or from the selected face; *+ Plane*) shown in the view and offered by *✎ Sketch*; revolve about a (construction) line of a sketch (`axis(sk1, line1)`, offered in the dialog's *Axis*): full freedom of position and angle. The rest of feature-model slice 3 | [05](05-feature-model.md) |
| **Extrude and remove from faces** | **Done 2026-11-27:** extrude, cut or intersect the part's own faces (selected in the view, kept as a selector), not only sketches: `extrude(part.faces().sort_by(Axis.Z)[-1], amount=5)`. *+ Extrude* takes the selected faces; *Remove* and *Intersect* go into the part | 05 |
| **Fast tests** | **Done 2026-11-27:** `npm test` runs the quick set in about 30 s (all the kernel tests in Node, the kernel booted once and shared, beside a UI smoke test); `npm run test:all` adds every UI suite and the bridge, each file with its own server and browser, in parallel (about 1.5 min). The Tests workflow runs the complete set on pull requests and releases | — |
| **Own repository** | **Done 2026-11-25:** [github.com/GustavBorgersen/caad](https://github.com/GustavBorgersen/caad), MIT licence, deployed to [caad.vercel.app](https://caad.vercel.app) by a GitHub Action that also builds the bridge into the site; each GitHub release gets a self-hosting zip with the site and the bridge for every system | — |

### Phase 1.5 — Layout, visuals and workflow

A serious iteration on how CAAD looks and works, before more features pile on. Design goals: one coherent workflow from sketches to slicing (for the agent too), good-looking and fun, light and dark themes, no clutter with the part as the main character, no system popups, shortcuts — see [09](09-design-and-workflow.md).

| Item | What | Design doc |
| :-- | :-- | :-- |
| **Design goals and workflow** | **Done 2026-11-27:** the goals, one loop (select → command → dialog with preview → confirm) in every mode, commands, context menus, first shortcuts, undo, code ↔ timeline | [09](09-design-and-workflow.md) |
| **Mock-ups and visual system** | **Done 2026-11-27:** three style directions as static pages in both themes (`design/mockups/`); direction A ("Studio") chosen, with a Files \| Timeline switch in the left rail and project and file management mocked up; doc 10 written (tokens checked for WCAG AA, type, icons, states, layout, 3D look) | 09, [10](10-visual-system.md) |
| **Commands and keys** | **Done 2026-11-28:** a command registry behind the toolbar, the shortcuts, the tooltips, the <kbd>?</kbd> sheet and the context menus (faces, edges, the empty view, timeline rows, sketch geometry, files); CAAD's own messages, menus and docked questions instead of `prompt`/`confirm`/`alert` (the UI tests fail on any native popup) | 09 |
| **Code ↔ timeline** | **Done 2026-11-28:** names in the timeline (`sk1 · Sketch: Rectangle`); <kbd>F2</kbd> (or *Rename* in the row's menu) renames a feature and every later use of it; each new feature is its own paragraph (a blank line around it; the examples and the agent guide too); hovering a row marks its code, the cursor in the code marks its row; <kbd>Delete</kbd> on a focused row deletes its feature | 09 |
| **Undo** | **Done 2026-11-28:** undo/redo for every change (dialogs, sketches, deletes, parameters, typing, the agent, edits from outside), as each file's history; the agent's changes marked in the timeline and the code until you change the file; deleting features and files happens at once, with Undo in the message | 09 |
| **Themes and layout** | **Done 2026-11-28:** doc 10's tokens, light and dark (system or chosen in settings); the top bar with the mode's commands, the rail with Files \| Timeline, dialogs and the code docked on the right, the status line, the selection chip, the start page (remembering the last workspace), the Files tab's project and file management, editable parameters | 09, 10 |
| **The view** | **Done 2026-11-28:** the view's gradient, colours from the tokens, preview colouring only what the dialog changes, the faded part while sketching, the view cube, standard views, fit, view normal, smooth camera moves | 10 |
| **Start-up** | **Done 2026-11-28:** the part is built once at start-up ([#3](https://github.com/GustavBorgersen/caad/issues/3)) | — |

### Phase 2 — Parts and mates

One kind of file with any number of parts and the mates between them: no separate part studios and assemblies, no switching views. Moving never changes a part's shape; a part drawn on another is attached to it; dragging writes the new position into the code ([08](08-parts-and-mates.md)).

| Item | What |
| :-- | :-- |
| **Several parts in one file** (08a) | A *design*: one `with BuildPart() as <name>:` block per part, `with <part>:` to add to it later; the block's name is the part's name (asked for, renamed with <kbd>F2</kbd>); own colours and visibility; *New part* or add to a part in Extrude and Revolve; the `designs/` folder (was `parts/`); right-click a part to export it, a design to export everything |
| **Import** (08b) | *Insert part*: parts of other designs (linked) and STEP files from outside CAAD (copied into `imports/`), used as is or built on |
| **Mates** (08c) | Fastened, Revolute, Slider, Cylindrical, Ball as one-line `caad` helpers; placed after the run along the mate tree; a Fastened mate written when a part is drawn on another; the mate dialog (<kbd>M</kbd>); assembly STEP |
| **Dragging** (08d) | Drag parts within their free directions, live in the view; the value written on release; fix and release parts |
| **Agent** (08e) | Parts and mates in `get_timeline`, mates edited with `edit_feature`, `export_part` per part, the guide |
| **Drawing for the agent** | A pen mode draws on the view (circle an area, sketch an arrow); a `get_annotation` tool gives the agent the picture *and* the faces/edges under the strokes with their selectors |

### Phase 3 — Motion

| Item | What |
| :-- | :-- |
| **Motion and checks** | Interference check; exploded view; closed loops (four-bar linkages) with a solver |

### Phase 4 — Slicing

A print job is its own file in the project's `print/` folder, opened in a slice mode; slicing is not a timeline feature ([11](11-slicing.md)).

| Item | What |
| :-- | :-- |
| **Slice in the page** | Embed an open-source browser slicer — first candidate [Kiri:Moto](https://grid.space/kiri) (MIT, runs fully in the browser) |
| **Profiles in the project** | Printer, material and print profiles stored as files in the project, versioned with the parts |
| **Preview and export** | Layer preview; G-code saved into the project's print folder |
| **Agent tool** | `slice` — so the agent can go from an idea to a printable file |

### Alongside all phases

- **Design goals**: every UI change is checked against the goals in [09](09-design-and-workflow.md).
- **Tests**: every feature comes with tests: kernel tests in `app/tests/kernel/` and a headless UI suite in `app/tests/full/` (see Tests in `app/README.md`).

## Design documents

| # | Document | Status |
| :-- | :-- | :-- |
| 05 | [Feature model and code round-trip](05-feature-model.md) | Built |
| 06 | [Sketches and constraints](06-sketches.md) | 06a–06d built |
| 07 | [Project structure](07-project-structure.md) | Built |
| 08 | [Parts and mates](08-parts-and-mates.md) | Agreed; not built |
| 09 | [Design goals, layout and workflow](09-design-and-workflow.md) | Agreed |
| 10 | [Visual system](10-visual-system.md) | Agreed (direction A); built in 1.5e and 1.5f |
| 11 | [Slicing](11-slicing.md) | Stub; details before phase 4 |

## Future features

Things to remember, not planned yet.

- **Send to printer** — OctoPrint, Moonraker/Klipper, Bambu… through the local bridge, which can reach printers on the local network.
- **Agent connection onboarding** — Chrome's local network access question still pops up as soon as the Agent dialog opens, before the user has read anything. Explain first, then trigger it from an explicit "Connect" step (and guide the user when it's blocked).
- **Messages from the page to the agent** — a Claude Code hook that attaches the page's state (selection, drawing, active part) to each prompt; or a chat in the page with its own agent.
- **`caad` on PyPI** — the `caad` module as a pip package (with PlaneGCS for re-solving sketches where it has wheels), published by a GitHub Action, so parts run outside CAAD after `pip install caad`. Until then advanced users download `caad.py` (design doc 07).
- **GitHub mode** — open a repo and branch directly in the page, working copy in browser storage, atomic commits via the GitHub API (described in the MVP plan as M6).
- **Hosted relay** — zero-install alternative to the bridge; works with claude.ai on the web and any remote-MCP client.
- **Sign in with GitHub** (OAuth via a tiny serverless function).
- **Native kernel via the bridge** — run models natively when build123d is installed locally.
- **Faster start-up** — Pyodide memory snapshots including the OpenCascade library.
- **Watch mode for tests** — a kernel kept warm that re-runs the tests a change affects within seconds.
- **Firefox and Safari** — need an alternative to the File System Access API.
- **Sub-assemblies** — insert a whole design with its mates into another design, moving as one ([08](08-parts-and-mates.md)).
- **Configurations and variable tables**, **2D drawings**, **sheet metal**, **bill of materials**.
