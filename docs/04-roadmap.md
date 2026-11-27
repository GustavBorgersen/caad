# CAAD — Roadmap

**Date:** 2026-11-24, updated 2026-11-27
**Replaces:** [03 — MVP plan](03-mvp-plan.md) (completed)

## Where we are

Phase 1 is done. You open a folder (a workspace of projects) and see a part with its timeline; rollback, errors at the failing feature and editing all work, and edits from you or the agent rebuild in about a second. Features are read back from the code into dialogs with a live preview and patched surgically; sketches are constrained (PlaneGCS) and edited in a sketch editor with dimensions, part edges, trim, fillet, mirror and patterns; planes, revolve axes and extruding the part's own faces are in. Parts export to STEP and STL. An agent (Claude Code) connects through a small bridge program and gets everything else from the page: docs, API lookup, running code, editing parts and features, selection, highlight and render.

What's missing is the feel of one designed tool: the layout, the looks and the workflow grew one feature at a time. That is phase 1.5.

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
| **Commands and keys** | A command registry behind the toolbar, shortcuts, tooltips and context menus; CAAD's own dialogs and messages instead of `prompt`/`confirm`/`alert` | 09 |
| **Code ↔ timeline** | Names in the timeline (`sk1 · Sketch: Rectangle`), rename, a blank line between new features, cross-highlighting (replaces "contrast fixes") | 09 |
| **Undo** | Undo/redo for every change, as a history of the code; agent edits marked | 09 |
| **Themes and layout** | Light and dark; the view fills the window, panels slide in or float | 09, 10 |
| **The view** | Shading, edges, selection colours, view cube and standard views, smooth camera moves | 10 |
| **Start-up** | Build once at start-up ([#3](https://github.com/GustavBorgersen/caad/issues/3)) | — |

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
| 08 | Part studios and assemblies | To write before phase 2 |
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
- **Configurations and variable tables**, **2D drawings**, **sheet metal**, **bill of materials**.
