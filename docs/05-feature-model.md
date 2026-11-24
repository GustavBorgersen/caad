# CAAD — Feature model and code round-trip

**Date:** 2026-11-24
**Status:** Draft
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

- A feature has a **kind** (sketch, extrude, fillet, …, or code), **parameters** read from the code, and optionally a **name**.
- **Sketches are named** (`with BuildSketch(...) as sk1:`) and created with `mode=Mode.PRIVATE`, so they add nothing by themselves. Operations refer to them by name. Verified in the page's build123d: private sketches add no material, `extrude(sk1.sketch, …)` works on planes and faces (along the face normal), and one sketch can feed several features.

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

## Parameters are expressions

A parameter's value is kept as **the source text of the expression**, not as a number: `amount=thickness` reads as `"thickness"`, `radius=hole_d / 2` as `"hole_d / 2"`. The dialog shows the expression and, next to it, its evaluated value (from the last build). This gives Onshape-style expressions for free and round-trips exactly: if you don't touch a field, its text doesn't change.

Typed parameter kinds: **number** (expression), **choice** (`Mode.SUBTRACT`, `Axis.Z`), **boolean** (`both=True`), **sketch reference** (`sk1`), **selector** (faces/edges, as an expression — picked in the view using the verified selectors from the selection feature), **plane** (`Plane.XY`, a face selector, an offset plane).

## Feature types

Each feature type is one small Python definition in the kernel (a *registry*):

| Part | What it does |
| :-- | :-- |
| `kind`, label, icon | e.g. `extrude`, "Extrude sk1, 5 mm", ⬆ |
| `match(node)` | Does this statement have this feature's form? |
| `read(node)` | Parameters (as expressions) and their source spans |
| `create(params)` | Canonical code for a *new* feature |
| `fields` | Dialog description: parameters, kinds, defaults, which ones depend on others (e.g. *depth* hidden for *through all*) |
| `refs` | Names it uses (sketches) — for "used by" and safe deletion |

First set of feature types and their canonical forms:

| Kind | Canonical code | Notes |
| :-- | :-- | :-- |
| **Sketch** | `with BuildSketch(<plane>, mode=Mode.PRIVATE) as skN:` + body | The body is edited in the sketch editor; its format is design doc 06 |
| **Extrude** | `extrude(skN.sketch, amount=…, [both=True], [taper=…], [mode=Mode.SUBTRACT/INTERSECT])` | *Through all*: `until=Until.LAST` |
| **Revolve** | `revolve(skN.sketch, axis=…, revolution_arc=…, [mode=…])` | |
| **Fillet / Chamfer** | `fillet(<edges>, radius=…)` / `chamfer(<edges>, length=…, [length2=…])` | Edges as a selector |
| **Hole** | `with Locations(<points or faces>):` + `Hole(…)` / `CounterBoreHole(…)` / `CounterSinkHole(…)` | |
| **Mirror** | `mirror(about=<plane>)` | |
| **Pattern** | `with GridLocations/PolarLocations(...)` + feature | Later |
| **Code** | anything else | Edited as text; still shown, rolled back and error-marked like any feature |

The current code forms (`with BuildSketch(...)` without `PRIVATE`, followed by `extrude(amount=…)`) keep working: they're read as a sketch + extrude pair, but CAAD writes the new form.

## Editing flow

1. **Double-click a feature** in the timeline → the kernel reads it: `read_feature(src, index)` → kind, parameters (expressions + current values), or "code feature".
2. The view **rolls back to just before that feature**; the dialog opens (the sketch editor for sketches).
3. **Live preview**: every change in the dialog builds the part up to this feature with the edited source — without saving.
4. **OK** → `patch_feature(src, index, params)` returns the new source: only the changed argument spans are replaced; new keyword arguments are inserted; removed ones deleted. The file is saved, the rollback bar returns to where it was, the part rebuilds.
5. **Cancel** → nothing is written.

**Inserting** a new feature: at the rollback bar, as today, using `create(params)`. **Deleting**: refused (with an explanation) if a later feature refers to its name; otherwise the statement is removed. **Renaming** a sketch updates its references (phase 1, if cheap; otherwise later).

## Why surgical patching, not regeneration

Regenerating a whole statement from its parameters would lose comments, the user's line breaks and anything the dialog doesn't know about. Python's `ast` gives exact start/end positions (line and column) for every argument, so CAAD can replace just the text of `amount=5` with `amount=8`. Only brand-new features are generated in full. If this ever isn't enough (e.g. moving features with their comments), [LibCST](https://github.com/Instagram/LibCST) is the fallback — it preserves all formatting by design.

## The agent

The agent keeps writing code with `write_part` / `edit_part`. The build123d guide teaches the canonical forms, so the agent's features become GUI-editable automatically. Possible additions: `get_timeline` returns kinds and parameters (not just labels), and an `edit_feature` tool that changes parameters by name — the same `patch_feature` the dialog uses, so the agent can't break formatting either.

## Tests

- **Round trip**: for every feature type and many variations, `read` → `patch` with unchanged parameters gives byte-identical source; `read(create(p)) == p`.
- **Surgical edits**: changing one parameter changes exactly one span; comments around and inside the feature survive.
- **Legacy forms**: existing example files read without changes.
- **End to end**: headless UI tests double-click features, edit them and check the file and the built part.

## Open questions

- **Sketch body format** — how entities, constraints and dimensions look in code: design doc 06.
- **Several parts per studio** — how a feature says which part it adds to: design doc 08. The registry should leave room for a `target` parameter.
- **Suppressing features** — commenting out vs. a marker; and how suppressed features show in code.
- **Features inside loops/functions** — stay code features for now.
