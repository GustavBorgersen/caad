# CAAD — Slicing

**Date:** 2026-11-27
**Status:** Stub: the shape agreed in a discussion, so the layout (doc 10) keeps room for it. Details, verification and phases come before phase 4
**Part of:** [04 — Roadmap](04-roadmap.md), phase 4 ("Slicing"); builds on [07 — Project structure](07-project-structure.md) (the `print/` folder) and [09 — Design goals](09-design-and-workflow.md) (modes of one layout)

## Decided

**Slicing is not a timeline feature.** A part's timeline is its modelling history: every row changes the geometry, maps to code (goal 9) and can be rolled back. A slice step would change nothing, have no code, and tie one part to one print, while the same part is printed in several ways (materials, printers) and one plate holds several parts or copies. In the middle of the timeline it would even be wrong: later features change the part after it was sliced.

**A print job is its own file**, in the project's `print/` folder (doc 07): which parts go on the plate, which way up, and with which profiles. Opening one enters **slice mode**, just as opening a part enters part mode.

## The print file

Plain data, so TOML rather than Python. It is readable text the agent can edit, and it is versioned with the parts:

```toml
# minibrewery/print/hub-petg.toml
printer  = "profiles/prusa-mk4.toml"
material = "profiles/petg.toml"
quality  = "profiles/0.2mm-strong.toml"

[[part]]
file  = "parts/hub.py"
count = 4
down  = "hub.faces().sort_by(Axis.Z)[0]"   # the face on the bed: a selector, so it survives edits to the part

[overrides]          # the few settings that differ from the profiles
infill = 30
supports = false
```

- **Profiles** (printer, material, quality) are their own files in the project, shared by its print jobs (the roadmap's *Profiles in the project*).
- **The face on the bed is a selector**, like every reference to geometry in CAAD, so the part lands the right way up after edits.
- **Output**: `print/hub-petg.gcode`, generated like the STEP exports and marked *out of date* when a part or profile changes after slicing.

## Slice mode

Slice mode is one more mode of the same layout (doc 09). Only the commands and the left rail's second tab change:

| Place | In slice mode |
| :-- | :-- |
| Top bar | Add part, Lay flat (pick a face), Arrange, Slice, Layers, Export G-code |
| Left rail | *Files* as always; the *Timeline* tab becomes *Plate*: the parts on the plate (count, face down) and the profiles in use |
| Docked dialog | Print settings: only what people change often (quality preset, infill, walls, supports, brim); the rest lives in the profile files (goal 7: leave options out) |
| View | The build plate with the parts on it; after slicing, the layers with a slider |

**Ways into it:**
- **From a part:** right-click a part (in the Files tree or the view) and choose **Print…**. This opens the part's print jobs, or creates `print/<part>.toml` with the last profiles used, and enters slice mode.
- **From the Files tree:** open a print file. Print files are listed under a *Print* group in the project.
- **Back from the part:** a quiet line under the last timeline row, *Printed in hub-petg · out of date*, links the part to its print jobs. It is not a timeline row.

**The agent** gets a `slice` tool that takes a print file. It uses the same file and the same concepts as the person, so "make it printable" ends in G-code in the project.

## Open

| Question | Options |
| :-- | :-- |
| **Profile format** | Our own small TOML (clean for people and the agent; needs a mapping to the slicer) or the slicer's own format kept as is (e.g. Kiri:Moto's JSON; no mapping, but slicer-specific) |
| **Parts per plate at first** | One part per print job first, or several from the start (the file format allows both) |
| **The slicer** | Kiri:Moto (MIT, runs in the browser) is the roadmap's first candidate; verify its engine runs in a worker with our meshes and settings, offline |
| **Supports and modifiers** | Painted support areas, per-region settings: left out until someone needs them |
| **Arranging** | The slicer's automatic arrangement, positions stored in the file, or both |
