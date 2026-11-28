# CAAD — Feature model and code round-trip

**Date:** 2026-11-24, decisions added 2026-11-25
**Status:** Slices 1–3 built (sketch planes and revolving about a sketch line 2026-11-27)
**Part of:** [04 — Roadmap](04-roadmap.md), phase 1

## Problem

Today CAAD writes code (the sketcher inserts a sketch and an extrude) but can't read it back: the timeline shows statements, not editable features. For Onshape-like work CAAD must be able to:

- **edit a feature from the timeline** — double-click an extrude and change its depth, reopen a sketch in the sketch editor;
- **keep sketches and operations separate** — one sketch, several features using it;
- **add to or cut from a chosen part** (phase 2) and **reference other features by name**;

…while the code stays the source of truth, readable and editable by hand and by the agent.

## Principles

1. **Code is the truth.** The GUI's model of a feature is always read from the code; nothing is stored elsewhere.
2. **Recognise, don't require.** Code that matches a known feature form is editable in a dialog. Anything else is a *code feature*: shown in the timeline, edited as text. Hand-written code is never rejected or reformatted.
3. **Change only what changed.** Editing a parameter replaces only that argument's text in the file. Comments, formatting and everything else stay byte-for-byte the same.
4. **One implementation.** Reading and writing features happens in Python, in the kernel, with Python's own parser (`ast`). The UI, the tests and the agent tools all use the same code.

## What a feature is

As today: **each statement directly inside the part's `with BuildPart()` block is one feature.** New in this model:

- A feature has a **kind** (sketch, extrude, fillet, …, call or code), **parameters** read from the code, and optionally a **name**.
- **Sketches are named** (`with BuildSketch(...) as sk1:`) and created with `mode=Mode.PRIVATE`, so they add nothing by themselves. Operations refer to them by name. Verified in the page's build123d: private sketches add no material and leave nothing pending, `extrude(sk1.sketch, …)` works on planes and faces (along the face normal), one sketch can feed several features, and the bracket example built this way is identical to the current form (same volume and faces).

```python
from build123d import *

thickness = 5

with BuildPart() as plate:
    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:      # Sketch "sk1"
        Rectangle(40, 20)
    extrude(sk1.sketch, amount=thickness)                       # Extrude sk1, 5 mm
    with BuildSketch(plate.faces().sort_by(Axis.Z)[-1], mode=Mode.PRIVATE) as sk2:   # Sketch on top face
        Circle(4)
    extrude(sk2.sketch, amount=-thickness, mode=Mode.SUBTRACT)  # Cut sk2 through the plate
    fillet(plate.edges().filter_by(Axis.Z), radius=3)           # Fillet 4 edges, r = 3
```

New sketches are named `skN` with the lowest free N. Existing names (`as base`, `as wall`) are kept and shown as they are.

## Parameters are expressions

A parameter's value is kept as **the source text of the expression**, not as a number: `amount=thickness` reads as `"thickness"`, `radius=hole_d / 2` as `"hole_d / 2"`. The dialog shows the expression and, next to it, its evaluated value. This gives Onshape-style expressions for free and round-trips exactly: if you don't touch a field, its text doesn't change.

Values are evaluated in the namespace of the latest run. The editing flow first rolls back to just before the feature, so that namespace is the model as the feature sees it: `thickness / 2` → 4, `bracket.edges().filter_by(Axis.Z).group_by(Axis.Y)[0]` → "2 edges" (verified). A value that fails to evaluate shows its error instead.

Typed parameter kinds: **number** (expression), **choice** (`Mode.SUBTRACT`, `Axis.Z`), **boolean** (`both=True`), **sketch reference** (`sk1`), **selector** (faces/edges, as an expression — picked in the view using the verified selectors from the selection feature), **plane** (`Plane.XY`, a face selector, an offset plane), and plain **expression** for anything else.

## Three tiers of features

| Tier | What | Editing |
| :-- | :-- | :-- |
| **Feature types** | Statements matching a registered form (table below) | Tailored dialog: labelled fields, dependent fields, selection picking |
| **Call features** | Any other statement that is a single build123d call: `Box(…)`, `Cylinder(…, mode=Mode.SUBTRACT)`, `mirror(…)` before it has a type | Generic dialog built from the call's signature: the arguments present, plus "add argument" for the others |
| **Code features** | Everything else: `with Locations(…): Box(…)`, loops, assignments, calls of the user's own functions | The code panel, scrolled to the feature |

Call features make most build123d code editable without a dialog per class — the pump body example is almost all primitives. Signatures come from the installed build123d with `inspect.signature` (functions directly, classes via `__init__`); verified for `extrude`, `revolve`, `fillet`, `chamfer`, `mirror`, `Hole`, `CounterBoreHole`, `Box`, `Cylinder`, `Rectangle` and `Circle`, with real names and defaults. The same signatures map **positional arguments** to their names (`extrude(None, 5)` → `to_extrude`, `amount`), for every tier.

## Feature types

Each feature type is one small Python definition in the kernel (a *registry*):

| Part | What it does |
| :-- | :-- |
| `kind`, label, icon | e.g. `extrude`, "Extrude sk1, 5 mm", ⬆ |
| `match(node)` | Does this statement have this feature's form? |
| `read(node)` | Parameters (as expressions) and their source spans |
| `create(params)` | Canonical code for a *new* feature |
| `fields` | Dialog description (format below) |
| `refs` | Names it uses (sketches) — for "used by" and safe deletion |

First set of feature types and their canonical forms:

| Kind | Canonical code | Notes |
| :-- | :-- | :-- |
| **Sketch** | `with BuildSketch(<plane>, mode=Mode.PRIVATE) as skN:` + body | The body is edited in the sketch editor; its format is design doc 06 |
| **Extrude** | `extrude(skN.sketch, amount=…, [both=True], [dir=…], [taper=…], [mode=Mode.SUBTRACT/INTERSECT])`, or the part's own faces: `extrude(part.faces().sort_by(Axis.Z)[-1], amount=…)` | *Through all*: `until=Until.LAST`. *Opposite direction*: `dir=-skN.sketch.faces()[0].normal_at()` — a sketch on a face has its normal pointing out of the part, so cutting into it needs this (verified: without it build123d finds no intersection). *Faces*: faces selected in the view when *+ Extrude* is pressed (or *Use selection* in the dialog) are extruded instead of a sketch, kept as their selector; labelled "Extrude face" (a selector ending in an index) or "faces". Their normals point out of the part, so choosing *Remove* or *Intersect* ticks *Opposite direction* (from the first face's normal: faces facing different ways need a negative depth instead) |
| **Revolve** | `revolve(skN.sketch, axis=…, revolution_arc=…, [mode=…])` | *Axis* offers X, Y, Z and the lines of the constrained sketches (the profile's own first): `axis=axis(sk1, line1)`, caad's `axis()` turning a line — usually a construction line — into a build123d `Axis` on the sketch's plane |
| **Plane** | `plN = <base>[.offset(d)][.rotated((rx, ry, rz))]` | *On*: `Plane.XY/XZ/YZ`, an earlier plane feature, or the face selected in the view (`Plane(<face selector>)`); offset along its normal; tilts about its own x and y and a turn about the normal (`rotated` uses the plane's local axes). Drawn in the view (a translucent square with its own X and Y as red and green arrows) until a later feature uses it; *✎ Sketch* offers it, and a sketch on it is `BuildSketch(plN, …)`. *Mirror*'s *About* offers the plane features too |
| **Fillet / Chamfer** | `fillet(<edges>, radius=…)` / `chamfer(<edges>, length=…, [length2=…])` | Edges as a selector |
| **Hole** | `with Locations(<points or faces>):` + `Hole(…)` / `CounterBoreHole(…)` / `CounterSinkHole(…)` | |
| **Mirror** | `mirror(about=<plane>)` | |
| **Pattern** | `with GridLocations/PolarLocations(...)` + feature | Later |
| **Call** | any other single build123d call | Generic, from the signature |
| **Code** | anything else | Edited as text; still shown, rolled back and error-marked like any feature |

Dialog fields are plain data, sent to the page as JSON, so the page has one generic dialog renderer:

```json
{ "name": "amount", "label": "Depth", "type": "number", "default": null,
  "show_if": { "until": null } }
```

`type` is one of `number`, `choice` (with `options`: expression + label), `bool`, `sketch`, `edges`, `faces`, `plane`, `expr`.

## The current code form

The code the sketcher writes today, and the examples, have no named sketches:

```python
with BuildSketch(bracket.faces().sort_by(Axis.Y)[-1]) as wall:   # adds its faces to "pending"
    Rectangle(width, 40)
extrude(amount=-thickness)                                        # extrudes everything pending
```

- A `BuildSketch` block without `mode=Mode.PRIVATE` is a **sketch feature**, marked *implicit*.
- An `extrude`/`revolve` without a sketch argument uses **all pending sketches**: every implicit sketch since the previous such operation (verified: two sketches followed by one `extrude()` make two solids). Its sketch field shows them read-only ("pending: wall").
- Editing such a feature changes only its parameters; it is **not** migrated to the named form (principle 3). A later, explicit "Name this sketch" action may rewrite the pair.
- New features are always written in the named form.

## Kernel interface

All in `caad_kernel.py`, called through the worker like `select` and `resolve` today:

| Function | Returns |
| :-- | :-- |
| `analyze(src)` (exists, extended) | Per feature also `kind`, `tier` (`type` / `call` / `code`), `name` (the `as` name) and `refs`. AST only, runs on every build |
| `read_feature(src, index)` | `kind`, `label`, `fields`, and per parameter: `expr` (source text or `null`), `value` (evaluated, see above), `error` |
| `run(…)` (exists, extended) | Also `sketches`: outlines of the named sketches up to the rollback bar that no feature there uses yet — a private sketch adds no material, so the view draws these as lines |
| `feature_values(exprs)` | Values of edited expressions, in the model `read_feature` saw (previews replace the latest run) |
| `patch_feature(src, index, kind, changes)` | New source. `changes` maps a parameter to a new expression, or to `null` to remove it. Fails if the feature at `index` is no longer of `kind` — the file changed while the dialog was open (e.g. the agent edited it) |
| `insert_feature(src, after, kind, params)` | `{src, index, name}`: the canonical code of a new feature after feature `after` (the rollback bar; `None` = at the end, `-1` = first). A sketch takes `{plane, body}` and gets the next free `skN` |
| `delete_feature(src, index)` | New source without the feature; refused while a later feature refers to its name or takes it as a pending sketch, or when it shares its line with other code |

`read_feature` also lists the named sketches before the feature, for the sketch field. Turning a drawn sketch into code moves into the kernel with design doc 06; until then `sketch-code.ts` generates the sketch body and the extrude's arguments, and the kernel writes both features.

## Patching rules

- **Change**: replace the text span of the argument's value; nothing else in the statement moves.
- **Validate** every new expression with `ast.parse(expr, mode="eval")` before writing; a field with a syntax error can't be applied.
- **Positional stays positional**: an argument written positionally is replaced in place.
- **Add**: a new keyword argument goes after the last argument — on the same line, or on its own line with the same indentation when the call already has one argument per line.
- **Remove** (`null`, or a field set back to its default when it was written as a keyword): delete the argument and its separating comma. A field at its default that isn't in the code isn't added.
- **Safety net**: the patched source must parse and have the same number of features, else the patch is refused with an error, never written.

## Editing flow

1. **Double-click a feature** in the timeline (a single click still rolls back, after a short wait so a double-click doesn't roll back first). Code features scroll the code panel to the feature; call features and feature types open a dialog (the sketch editor for sketches, from slice 2).
2. The view **rolls back to just before that feature**; the kernel reads it with `read_feature`.
3. **Live preview**: every change builds the part up to this feature with the patched source — without saving. Errors show in the dialog.
4. **OK** → `patch_feature` → the file is saved, the rollback bar returns to where it was, the part rebuilds. OK is allowed even when the preview has an error — like typing in the code panel, the code may be broken for a while; the error shows at the feature as usual.
5. **Cancel** → nothing is written.

**Sketching is its own step.** The sketch editor's *Done* adds only the named sketch; the view draws it as an outline until a feature uses it. *+ Extrude* at the rollback bar then opens the extrude dialog on the latest sketch before the bar (preferring one nothing uses yet), where depth, through all, symmetric, opposite direction and add/remove/intersect are chosen. A field another field hides (depth when *through all* is chosen) is not written.

**Inserting** a new feature: at the rollback bar, with `insert_feature`. **Deleting**: refused (with an explanation) if a later feature refers to its name; otherwise the statement is removed. **Renaming** a sketch updates its references (planned in [09](09-design-and-workflow.md), phase 1.5).

## Why surgical patching, not regeneration

Regenerating a whole statement from its parameters would lose comments, the user's line breaks and anything the dialog doesn't know about. Python's `ast` gives exact start/end positions (line and column) for every argument, so CAAD can replace just the text of `amount=5` with `amount=8`. Only brand-new features are generated in full. If this ever isn't enough (e.g. moving features with their comments), [LibCST](https://github.com/Instagram/LibCST) is the fallback — it preserves all formatting by design.

## The agent

The agent keeps writing code with `write_part` / `edit_part`. The build123d guide teaches the canonical forms, so the agent's features become GUI-editable automatically. `get_timeline` returns kinds, names and refs (slice 1). An `edit_feature` tool that changes parameters by name — the same `patch_feature` the dialog uses, so the agent can't break formatting either — follows once the dialogs work (slice 3).

## Decided for now

| Question | Decision |
| :-- | :-- |
| **Sketch body format** | Design doc 06. Until then the sketch editor can create sketches but not reopen them; double-clicking a sketch shows its code |
| **Several parts per file** | [08](08-parts-and-mates.md): one block per part, `with <part>:` to add to an earlier one, a *Part* field in Extrude and Revolve |
| **Suppressing features** | Not in phase 1. Constraint for later: a suppressed feature must stay a statement, so indices and references stay stable — which rules out commenting it out. Leading candidate: `if False:` around it, which extends to configurations (`if variant == "long":`) |
| **Features inside loops/functions** | Code features |
| **Top-level parameters** | Expression fields offer the parameter names; a parameter table (edited the same surgical way) is a separate, later item |

## Build order

| Slice | Contents |
| :-- | :-- |
| **1 — Read and patch** (done) | Registry with extrude, fillet and chamfer; call and code tiers; `analyze` extension, `read_feature`, `patch_feature`; Node tests; generic dialog in the page with live preview, opened by double-click |
| **2 — Named sketches** (done) | Sketcher writes the named form; extrude's sketch field; `insert_feature` and a "+" at the rollback bar (fillet/chamfer from the selected edges); refs and safe delete |
| **3 — More types, agent** | Revolve, hole (`with Locations(…): Hole/CounterBoreHole/CounterSinkHole(…)`: its type and position are dialog fields that aren't call arguments; switching the type rewrites just the hole call), mirror; *+ Revolve*, *+ Hole* (on the selected face), *+ Mirror* at the rollback bar; `edit_feature` tool; guide teaches the canonical forms (all done). Holes go at a sketch's points (`with Locations(*points(sk1)): Hole(…)`), with *Drill the other way* and *Start at the far side*. **Free placement (done 2026-11-27):** *sketch planes*: a plane feature (`pl1 = Plane.XZ.offset(20)`, rotated, or from a face; *+ Plane* at the rollback bar) shown in the view, that sketches can be drawn on — so a sketch can sit anywhere, not only on the base planes and the part's faces; and *revolving about a sketch line*: `revolve(sk1.sketch, axis=axis(sk1, line1))`, with caad's `axis()` turning a (construction) line of the sketch into the axis, and the dialog's *Axis* offering the sketch's lines next to X, Y and Z. Together they give revolves (and sketches) full freedom of position and angle |

## Tests

- **Round trip**: for every feature type and many variations, `read` → `patch` with unchanged parameters gives byte-identical source; `read(create(p)) == p`.
- **Surgical edits**: changing one parameter changes exactly one span; comments around and inside the feature survive; adding and removing keywords keeps the call's layout.
- **Current forms**: the examples read without changes; implicit sketches pair with the right extrudes.
- **Concurrent edits**: `patch_feature` refuses when the feature at the index changed kind.
- **Kernel tests** in Node: `app/tests/kernel/feature.mjs`. **End to end**: `app/tests/full/feature.test.mjs` double-clicks features, edits them and checks the file and the built part.
