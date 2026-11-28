# CAAD — Parts and mates

**Date:** 2026-11-28
**Status:** Agreed in a discussion (the workflow first, then checked in the kernel); not built
**Part of:** [04 — Roadmap](04-roadmap.md), phase 2 ("Parts and mates"), which replaces the separate *part studio* and *assembly* phases; builds on [05 — Feature model](05-feature-model.md) and [09 — Design goals](09-design-and-workflow.md)

## Problem

Onshape and SolidWorks split the work into parts, part studios and assemblies. Each is its own kind of file with its own view, and tools behave differently in each: you model in one place, switch to another to mate and move, then switch back to change a part. That goes against goal 1 (one clear workflow) and goal 7 (one way to do each thing).

The workflow we want, without changing view:

1. Draw a part.
2. Draw a second part directly on the first, referencing it.
3. Add a mate between them, and move the second part in the directions the mate leaves free.
4. Keep going: draw a third part on the moved one, change the first part, and so on.

## The model

**There is one kind of file: it holds one or more parts and the mates between them.** A file with one part is simply the smallest case. Nothing "becomes an assembly", there is no assembly object, and there is no mode switch. Parts, mates and moves are timeline rows in the same file, made with the same select → command → dialog → confirm loop (doc 09).

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

Running the file with plain Python builds every part as drawn. `caad.assembly()` returns the placed parts as a build123d `Compound` (children labelled with the parts' names), for a STEP export or any viewer. This keeps doc 07's promise that part files build without CAAD.

## Export

- **STEP** of a file with several parts is an assembly: the placed parts as labelled children.
- **STL** is per part, as drawn: it is for printing, and slicing lays the part down anyway (doc 11).

## The agent

- **`get_timeline`** lists the parts, the mates (type, parts, values, ranges) and each feature's part.
- **`edit_feature`** works on mates like any feature: `angle=60` is a parameter. This is also how the agent "drags".
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
| **Our own placement maths** | caad computes placements itself rather than calling `connect_to`: it must record instead of moving, and the view needs the same formula for dragging |

## Open

| Question | Options |
| :-- | :-- |
| **Mate syntax** | Positional `revolute(box, <edge>, lid, <edge>, …)` as above, or keywords (`a=box, on_a=…`) for readability; settle while building 08b |
| **Reuse across files** | *Insert part* from another file (`from bolt import bolt` and a copy per instance), mated like any part; what a copy's name and colour are, and how its file is shown |
| **The `parts/` folder** | Files now hold several parts: keep the name, or call the files *designs*; doc 11's print file then needs a part within a file (`file = "parts/box.py"`, `part = "lid"`) |
| **Interference, exploded views, motion** | Phase 3 items; the mate tree and placements are what they need |

## Build order

| Slice | Contents |
| :-- | :-- |
| **08a — Several parts** | `analyze`/`run` with several part blocks and `with <part>:`. Per-part meshes and colours, the parts list with visibility, part stripes in the timeline. *Part* field in Extrude/Revolve (*New part*, add to a part). Selection knows its part. STL per part. The Files tab's *Assemblies* group and `assemblies/` folder go (`project.ts`, `files.ts`) |
| **08b — Mates** | caad's `fastened`, `revolute`, `slider`, `cylindrical`, `ball`, `place`, `assembly()`. Placing after the run, loops and ranges as errors. The Fastened mate written when drawing on a part. The mate dialog (<kbd>M</kbd>) with preview and *Flip*. Placed parts, sketches and planes in the view; sketching on a moved part. Assembly STEP |
| **08c — Dragging** | The mate tree to the view, dragging within the free directions, writing on release; fix and release |
| **08d — Agent** | `get_timeline` with parts and mates, the guide |

Each slice comes with kernel tests (`app/tests/kernel/`) and a UI suite (`app/tests/full/`), like every feature.
