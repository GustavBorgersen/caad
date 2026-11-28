# CAAD — Parts and mates

**Date:** 2026-11-28
**Status:** Agreed in a discussion (the workflow first, then checked in the kernel); naming, the `designs/` folder, export and import added the same day; not built
**Part of:** [04 — Roadmap](04-roadmap.md), phase 2 ("Parts and mates"), which replaces the separate *part studio* and *assembly* phases; builds on [05 — Feature model](05-feature-model.md) and [09 — Design goals](09-design-and-workflow.md)

## Problem

Onshape and SolidWorks split the work into parts, part studios and assemblies. Each is its own kind of file with its own view, and tools behave differently in each: you model in one place, switch to another to mate and move, then switch back to change a part. That goes against goal 1 (one clear workflow) and goal 7 (one way to do each thing).

The workflow we want, without changing view:

1. Draw a part.
2. Draw a second part directly on the first, referencing it.
3. Add a mate between them, and move the second part in the directions the mate leaves free.
4. Keep going: draw a third part on the moved one, change the first part, and so on.

## The model

**There is one kind of file, a *design*: it holds one or more parts and the mates between them.** A design with one part is simply the smallest case. Designs live in the project's `designs/` folder (doc 07 called it `parts/`; the name no longer fits files with several parts). Nothing "becomes an assembly", there is no assembly object, and there is no mode switch. Parts, mates and moves are timeline rows in the same file, made with the same select → command → dialog → confirm loop (doc 09).

### Rules

1. **Moving never changes a part's shape.** Every part is built where it was drawn ("as drawn"). Mates and dragging only change *where* parts are, never their geometry. A part drawn on the lid keeps its shape when the lid opens.
2. **A part drawn on another part is attached to it.** CAAD writes a *Fastened* mate for you: a visible timeline row that you can delete or replace with another mate. "Drawn on" means its first sketch is on that part's face. A part that also uses other parts (sketched on the box, extruded up to the lid) is still attached only to the part its first sketch is on, and it keeps its as-drawn shape wherever the others move.
3. **Parts follow what they're attached to.** Mates form a tree. Moving a part moves every part attached to it, through any number of levels.
4. **Fixed or free.** By default the first part is fixed where it was drawn, and every other part without a mate is free. Any part can be released, and fixed again somewhere else. A fixed part can't be dragged.
5. **Dragging writes code.** On release, the new angle, position or placement goes into the code, as one undo step.

### The walk-through

| Step | You do | CAAD writes | You see |
| :-- | :-- | :-- | :-- |
| 1 | Sketch and extrude a box | `with BuildPart() as box:` … | The box; it is fixed |
| 2 | *New part* on the box's top face: sketch, extrude | `with BuildPart() as lid:` … then `m1 = fastened(box, lid)` | A second part in its own colour, attached to the box |
| 3 | Select the box's rear edge and the lid's rear edge, <kbd>M</kbd>, choose *Revolute*, range 0–110° | `m1 = revolute(box, <edge>, lid, <edge>, angle=0, range=(0, 110))` (replaces the Fastened mate) | The lid stays where it is: the edges already coincide |
| 4 | Drag the lid open | `angle=60` in `m1` | The lid swings about the hinge, live; written when you let go |
| 5 | Sketch a knob on the open lid's top face | `with BuildPart() as knob:` … then `m2 = fastened(lid, knob)` | You sketch on the face where you see it |
| 6 | Drag the lid closed | `angle=0` in `m1` | The knob rides along on the lid, unchanged |
| 7 | Make the box taller | Its dimension changes | Lid and knob rebuild and land on the new top: their sketches reference the box's face, and the mates place them again |

### The code

```python
# designs/box.py
from build123d import *
from caad import fastened, revolute

with BuildPart() as box:
    Box(40, 30, 20)
    offset(amount=-2, openings=box.faces().sort_by(Axis.Z)[-1])

with BuildPart() as lid:
    with BuildSketch(box.faces().sort_by(Axis.Z)[-1], mode=Mode.PRIVATE) as sk1:
        Rectangle(40, 30)
    extrude(sk1.sketch, amount=3)

m1 = revolute(box, box.edges().filter_by(Axis.X).group_by(Axis.Z)[-1].sort_by(Axis.Y)[-1],
              lid, lid.edges().filter_by(Axis.X).group_by(Axis.Z)[0].sort_by(Axis.Y)[-1],
              angle=60, range=(0, 110))

with BuildPart() as knob:
    with BuildSketch(lid.faces().sort_by(Axis.Z)[-1], mode=Mode.PRIVATE) as sk2:
        Circle(4)
    extrude(sk2.sketch, amount=6)

m2 = fastened(lid, knob)
```

- **Each part is a top-level `with BuildPart() as <name>:` block.** Its name is the part's name in the timeline, the parts list and exports.
- **Adding to an earlier part later in the file** re-enters its block: `with box:` followed by the new features (verified). The timeline stays in file order, so the features of different parts can interleave, as in an Onshape part studio.
- **A mate is one statement** (`mN = …`), so it is one timeline row (doc 05: one statement, one feature). build123d's own joints need three statements per mate (a joint on each part, then `connect_to`), and `connect_to` moves the part immediately. That would make later features see the moved part, which breaks rule 1. caad's helpers record the mate instead.
- **Selectors are evaluated on the parts as drawn.** `lid.faces().sort_by(Axis.Z)[-1]` means the lid's top face as drawn, even while the lid is shown open. A face picked in the view maps to the same face of the part as drawn (placing is only a transform, so faces keep their identity).
- **A free part that has been moved** gets one `place(part, Location(…))` row. Later drags patch that same row instead of adding new ones. Releasing a part is `place(box, fixed=False)`; fixing it somewhere else is `place(box, Location(…), fixed=True)`. The defaults (first part fixed, others free, both where drawn) need no code.

### Names

**A part's name is its block's name**: `with BuildPart() as lid:` is the part `lid`. It is the one name used everywhere: the timeline, the parts list, the Files tree, mates, exports and imports in other designs (goal 9). Nothing else stores a name.

- **New parts are named when they are made.** *New part* in the Extrude or Revolve dialog has a name field, prefilled with the lowest free `partN`. Typing "Lid hinge" gives `lid_hinge`: names are Python names, so spaces become `_` and invalid characters are refused while you type.
- **Rename** (<kbd>F2</kbd>, or the context menu on a part in the parts list, the Files tree or the view) renames the block and every reference to it in the design (selectors, mates, `with lid:`). It also renames the `from designs.box import lid` lines in the project's other designs. This is doc 09's rename, applied to parts.
- **Names are unique within a design.** Two designs can both have a `lid`.
- **The Files tree shows a design's parts under it**, so a part can be exported, inserted elsewhere or renamed from there.

### Mates

| Mate | Free | Values in the code | build123d's equivalent |
| :-- | :-- | :-- | :-- |
| **Fastened** | nothing | none: keeps the relative position as drawn | `RigidJoint` |
| **Revolute** | one turn | `angle`, `range` | `RevoluteJoint` |
| **Slider** | one direction | `position`, `range` | `LinearJoint` |
| **Cylindrical** | a turn and a slide on one axis | `angle`, `position`, ranges | `CylindricalJoint` |
| **Ball** | three turns | `angles` | `BallJoint` |

Enough for now. Planar and pin-in-slot can come later, when needed.

- **What you pick defines the mate's frame on each part:**
  - a straight edge, a circular edge or a cylindrical face gives an axis;
  - a flat face gives a frame at its centre, the second part's frame facing against the first's.
- **Picked geometry that already coincides gives no movement.** B's frame is oriented from A's: same direction along the axis, origin at the nearest point. So a part drawn in place stays in place when it is mated (verified: without this, the lid jumped). The dialog has *Flip*, for faces mating the other way, and the value fields.
- **Limits** are checked: a value outside its range is an error at the mate, like any feature error.
- **One parent per part.** Mates form a tree with the fixed parts as roots, and a mate works whichever way round the two parts are written. A mate that would close a loop (a part reached by two paths, as in a four-bar linkage) is an error at that mate: "closes a loop; not supported yet". Loops need a real solver, which is a later item.

### Placing after the run

The kernel runs the file as today. Every part is built as drawn and the caad helpers only record mates and placements. After the run, the kernel walks the mate tree from the roots: each part's placement is its parent's placement × A's frame × the motion (angle, position) × B's frame⁻¹.

- **Rolling back** to before a mate shows the parts it moves where they were drawn.
- **The order of mates in the file doesn't change any geometry**, only which mates exist at the rollback bar.
- **Changing a part** rebuilds the parts that reference it, then places everything again (step 7 of the walk-through).

### Dragging

- **What moves:** the part under the mouse moves by the nearest link up its branch of the mate tree that still has a free direction. For a free part, that link is its own placement. A part fastened to the lid drags the lid's hinge. If nothing up the branch can move (only Fastened mates up to a fixed part), a message says so.
- **No rebuild while dragging.** The kernel sends the mate tree to the view: per part, its parent, both frames, the mate type, ranges and current values. The view computes placements itself (the same formula) and moves the meshes of the dragged branch at 60 fps.
- **On release** the value is written into the mate or `place` row (rule 5), and the file rebuilds in the background as after any edit.

### The view and the panels

- **Each part has its own colour**, from a small palette of tokens (doc 10). The selection and hover colours stay the same for all parts (goal 8).
- **The Timeline tab** lists the parts above the features: name, colour, visibility, and a pin for fixed. Each feature row has a stripe in its part's colour; mate rows have a link icon and read `m1 · Revolute box ↔ lid · 60°`.
- **Sketching on a moved part:** the sketch editor shows the sketch where the part is now, while the sketch itself is stored relative to the part as drawn. Sketches, planes and previews are drawn with their part's placement.
- **New part, or add to a part.** *Extrude* (and *Revolve*) get a *Part* field: *New part*, or one of the file's parts. Along with *Add* / *Remove* / *Intersect*, this answers the roadmap's "new part or add to part":
  - *New part* writes a new block;
  - adding to an earlier part writes `with <part>:`;
  - a new part drawn on another part gets its Fastened mate (rule 2).

## Outside CAAD

Running the file with plain Python builds every part as drawn. `caad.assembly()` returns the placed parts as a build123d `Compound` (children labelled with the parts' names), for a STEP export or any viewer. This keeps doc 07's promise that designs build without CAAD.

## Export

Export is a context-menu command (plus the top bar's *Export*, which acts on the open design):

| Right-click | *Export* gives | Into |
| :-- | :-- | :-- |
| **A part** (parts list, Files tree, view) | That part alone, as drawn, as STEP or STL | `exports/<design>/<part>.step` / `.stl` |
| **A design** (Files tree; or the top bar) | Everything: **STEP** as one assembly file, the parts placed and labelled with their names; **STL** as one file per part, as drawn | `exports/<design>.step`; `exports/<design>/<part>.stl` |

- **STL per part**, because STL can't keep parts apart or name them, and each part is printed on its own (slicing lays it down anyway, doc 11).
- **A design with one part** exports the same either way: that part.
- **Without a project folder** (downloads instead of `exports/`), a design's STLs come as one zip.
- **Outside CAAD**, `caad.assembly()` returns the same placed and labelled `Compound` the design's STEP is made from.

## Import

**An imported part is a part like any other**: its own block, name, colour and mates. It is exported, mated and dragged the same way. Using it as is means the block holds only the import. Building on it means more features follow in the block, which work on its faces and edges as usual (verified: a hole cut into an imported STEP).

```python
from designs.gearbox import shaft              # with the other imports at the top

with BuildPart() as motor:                     # Import: imports/nema17.step
    insert(import_step("imports/nema17.step"))
    with BuildSketch(motor.faces().sort_by(Axis.Z)[-1], mode=Mode.PRIVATE) as sk1:
        Circle(2.5)
    extrude(sk1.sketch, amount=-8, mode=Mode.SUBTRACT)   # built on it

with BuildPart() as shaft1:                    # Import: shaft from gearbox
    insert(shaft.part)
```

| From | How | Stays linked? |
| :-- | :-- | :-- |
| **A part of another design** in the project | `from designs.<design> import <part>` + `insert(<part>.part)` | **Yes**: the other design is imported on every build (doc 07), so its changes show up here |
| **A STEP file** from outside CAAD | `insert(import_step("imports/<file>.step"))`; the file is copied into the project's `imports/` folder, so the project stays self-contained and versioned | With the copy in `imports/`; replacing that file updates every design using it |

- **One command, *Insert part***, opens a list:
  - the parts of the project's other designs;
  - the STEP files in `imports/`;
  - *From your computer…*, which copies a STEP file into `imports/`.

  It adds a new part block at the rollback bar, named after the source (`shaft1`, `nema17`) and free (rule 4) until it is mated. The same command is in the context menu of a part or STEP file in the Files tree: *Insert into <open design>*. Several instances are several blocks.
- **An imported design's mates stay in that design.** `insert(shaft.part)` brings the part as drawn in its own design, and you mate it here. caad's helpers record each mate with the design it was written in, so importing a design never places parts in the importing one.
- **Assembly STEP files** keep their parts as labelled children (verified: a box and lid exported as one STEP read back as `Compound` children `box` and `lid`). Inserting one asks: *one part*, or *one part per body*, the parts named from the STEP's labels.

## The agent## The agent

- **`get_timeline`** lists the parts, the mates (type, parts, values, ranges) and each feature's part.
- **`edit_feature`** works on mates like any feature: `angle=60` is a parameter. This is also how the agent "drags".
- **`export_part`** takes an optional part name: without one it exports the whole design, as the context menu does.
- **The guide** teaches one block per part, `with <part>:` for adding to a part later, and the mate helpers with the selectors they take.

## What we verified (2026-11-28)

In the page's kernel (build123d 0.13 in Node, as the tests boot it):

| Question | Finding |
| :-- | :-- |
| Several parts in one file, the second drawn on the first? | **Yes**: two `BuildPart` blocks; a lid sketched on the box's top face sits exactly on it |
| Adding to the first part after the second exists? | **Yes**: `with box:` re-enters its builder and adds to it (a cylinder cut later in the file changed the box's volume) |
| build123d's joints | `RigidJoint`, `RevoluteJoint`, `LinearJoint` work inside builders. `connect_to(…, angle=30)` / `position=25` places the second part. Ranges are enforced (`ValueError` outside them). Copies of a part keep their joints |
| Is `connect_to` a live constraint? | **No**: it places once. Moving the arm of a chain afterwards left the tip where it was, so placements have to be recomputed in tree order. That is why CAAD places after the run |
| Speed | 100 `connect_to` calls take 3 ms; placing is just matrices |
| Mating faces | A plain face-to-face rigid joint turned the lid upside down into the box, because both normals point out of their parts. Face mates need one frame flipped, by default |
| STEP import | `import_step` works in Pyodide. An imported STEP inserted into a `BuildPart` (`insert()`; `add()` is deprecated) can be built on (a hole cut: 24000 → 23215 mm³) and the source stays unchanged, so it can be inserted twice. An assembly STEP (`Compound(children=[box, lid])`) reads back as a `Compound` with children labelled `box` and `lid` |
| Record, then place (a prototype of the helpers) | With box, lid (revolute on the rear edges) and knob (fastened to the lid): at angle 0 the lid stays exactly as drawn; at +60° it opens upwards; the knob follows with the same volume, still touching the lid. The parts as drawn are unchanged, so selectors keep working. Orienting B's frame from A's was needed: with each edge's own direction and start point, the lid jumped at angle 0 |

## Decided

| Question | Decision |
| :-- | :-- |
| **Part studio vs assembly** | One kind of file with any number of parts and mates; no assembly object in the code |
| **Moving and shape** | Moving never changes shape; parts are built as drawn, mates and moves only place them |
| **Drawing on another part** | Attaches it with a Fastened mate (a visible row), to the part its first sketch is on |
| **Dragging** | Writes code on release (the mate's value, or the free part's `place` row) |
| **Fixed parts** | The first part by default; any part can be released, and fixed elsewhere |
| **Free parts** | Drag freely; the move is written as `place(…)` |
| **Mate types** | Fastened, Revolute, Slider, Cylindrical, Ball |
| **Closed loops** | Not supported yet: an error at the mate that closes one |
| **Kind of file** | A *design*, in the project's `designs/` folder (was `parts/`) |
| **Old projects** | Not supported: CAAD is in early development. `parts/` folders aren't read as designs and nothing is migrated. The bundled examples are rewritten from scratch in the new conventions |
| **Sub-assemblies** | Later: for now an imported part comes as drawn and is mated in the importing design; bringing a whole design in with its mates is a future item |
| **Part names** | The block's name, the only name; asked for when a part is made; <kbd>F2</kbd> renames it everywhere, also in designs that import it |
| **Export** | Right-click a part: that part, as drawn. Right-click a design: everything, STEP as one assembly, STL one per part |
| **Import** | One *Insert part* command for parts of other designs (linked) and STEP files (copied into `imports/`); an imported part is a part like any other, used as is or built on |
| **Our own placement maths** | caad computes placements itself rather than calling `connect_to`: it must record instead of moving, and the view needs the same formula for dragging |

## Open

| Question | Options |
| :-- | :-- |
| **Mate syntax** | Its own brainstorm before 08c: how a mate reads in the code, how it names the geometry on each part, and how its values look. The `revolute(box, <edge>, lid, <edge>, …)` lines in this doc are placeholders |
| **Interference, exploded views, motion** | Phase 3 items; the mate tree and placements are what they need |

## Build order

| Slice | Contents |
| :-- | :-- |
| **08a — Several parts** | `analyze`/`run` with several part blocks and `with <part>:`. Per-part meshes and colours, the parts list with visibility, part stripes in the timeline. *Part* field in Extrude/Revolve (*New part* with its name, add to a part). Rename. Selection knows its part. Export of a part and of a design. The `designs/` folder (guide, CLAUDE.md, doc 07, `project.ts`, `files.ts`, tests; the Files tab's *Assemblies* group and `assemblies/` go); parts under their design in the Files tree. **The examples rewritten from scratch** in `designs/`: a design with several parts drawn on each other, besides single-part designs |
| **08b — Import** | *Insert part*: parts of other designs and STEP files (`imports/`, copied in; STEP files in the kernel's file system); assembly STEP as one part or one per body. The examples get an `imports/` STEP file and a design that inserts it and a part of another design |
| **08c — Mates** | caad's `fastened`, `revolute`, `slider`, `cylindrical`, `ball`, `place`, `assembly()`, recorded per design. Placing after the run, loops and ranges as errors. The Fastened mate written when drawing on a part. The mate dialog (<kbd>M</kbd>) with preview and *Flip*. Placed parts, sketches and planes in the view; sketching on a moved part. Assembly STEP. The examples' multi-part design gets its mates (a hinge, a slider) |
| **08d — Dragging** | The mate tree to the view, dragging within the free directions, writing on release; fix and release |
| **08e — Agent** | `get_timeline` with parts and mates, `export_part` per part, the guide |

Each slice comes with kernel tests (`app/tests/kernel/`) and a UI suite (`app/tests/full/`), like every feature.
