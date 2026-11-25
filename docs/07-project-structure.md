# CAAD — Project structure

**Date:** 2026-11-25
**Status:** Agreed — ready to build 07a
**Part of:** [04 — Roadmap](04-roadmap.md), phase 1 ("Project structure and project browser"); follows [06 — Sketches](06-sketches.md)

## Problem

A CAAD project is any folder today: the page lists every `.py` file that imports build123d (up to five levels deep) and the kernel runs one file at a time. That was enough for the MVP, but:

- **Parts can't share code.** A part that imports a project file (`from params import wall`) fails in the page: the kernel only has the open file.
- **No place for what isn't a part.** Exports (STEP, STL), assemblies (phase 3) and print files (phase 4) need homes, and the browser should show each kind of file for what it is.
- **No project file.** Nothing records what a project needs (the build123d version) or CAAD's settings, or where one project ends and the next begins.

Working in the browser is the normal way to use CAAD. Running parts outside it must stay possible (everything is code), but needs no features of its own.

## What we verified (2026-11-25)

| Question | Finding |
| :-- | :-- |
| Can the kernel read a project file? | **Yes**: Pyodide's Python 3.14 has `tomllib`, which reads `pyproject.toml` |
| Can parts import other project files in the page? | **Yes**: the project's `.py` files copied into Pyodide's file system, with the project's folder on `sys.path`, import normally; dropping them from `sys.modules` before each build picks up edits (`params.py` changed from 60 to 80 → the next build is 80 wide) |

## Workspace and projects

**The folder you open is a workspace**: any folder on disk (a git repository, part of one, or not). **Each project is a folder in it** with its own `pyproject.toml`, so one workspace (one repository) can hold several projects:

```
my-workspace/              the folder you open
├── minibrewery/           a project
│   ├── pyproject.toml     the project file
│   ├── params.py          shared code: parameters, helpers (any .py without a part in it)
│   ├── parts/             part studios: one part per file (several per file: design doc 08)
│   │   ├── pump_body.py
│   │   └── lid.py
│   ├── assemblies/        phase 3 (design doc 08)
│   ├── exports/           STEP / STL, written by Export, named after the part (exports/lid.step)
│   └── print/             phase 4: profiles (printer, material, print) and G-code
└── fermenter/             another project
    └── …
```

- **A project is a folder with a `pyproject.toml` that has a `[tool.caad]` table.** CAAD looks for them in the workspace (a few levels deep). Opening a folder that is itself a project works too: a workspace with one project.
- **Folder names inside a project are fixed** (not settings): projects look alike, and the agent and the browser know where things go. Files elsewhere in a project still open; the folders are where CAAD *writes*.
- **Each project's folder is its import root.** CAAD runs every file with the project's folder on `sys.path`, like `python -m`: a part imports shared code as `from params import wall`, an assembly a part as `from parts.lid import lid`. Shared code is shared within a project, not across projects.
- **Loose build123d files** (in the workspace but in no project) still open as today. CAAD offers *Make this a CAAD project* for their folder, which only adds a `pyproject.toml` (or the `[tool.caad]` table to an existing one) — it never moves files.
- **New project** (next to *Open folder*): a name → CAAD creates the project's folder in the workspace with `pyproject.toml` and `parts/part.py` (an empty part), and opens it.
- **Git is the user's business**: CAAD reads and writes files in the folder you picked; committing, ignoring and branching are up to you (GitHub mode stays a future feature).

## The project file: `pyproject.toml`

Python's own project file, so it also says what the parts need:

```toml
[project]
name = "minibrewery"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["build123d==0.13.*"]   # the version the page runs

[tool.caad]
format = 1                              # the project layout's version
```

`[tool.caad]` stays small: the layout version now; later settings with a project-wide meaning (default printer profile, units if we ever allow inches).

## The page

- **Project browser**: the parts panel becomes a browser — the workspace's projects, and in each, its files grouped by kind: *Parts* (files with a `BuildPart` block), *Shared code* (other `.py` files), *Assemblies*, *Exports* (download; later a preview), *Print*. Kinds come from the folder and the content, so a part outside `parts/` is still a part.
- **Shared code in the kernel**: when a part opens, the page copies its project's `.py` files into the kernel (under `/project`, which goes on `sys.path`) and keeps them in sync (the existing outside-edit polling, extended to the project's `.py` files); a change to any of them rebuilds the open part. Each build drops the project's modules from `sys.modules` first (verified above).
- **New files go where they belong**: *+ New part* writes to the open project's `parts/`; Export to its `exports/`.
- **The agent**: `list_parts` lists the projects and their files by kind; `write_part` and `open_part` take workspace paths as now (`minibrewery/parts/lid.py`); the guide describes the layout and shared parameters.
- **The bundled examples** become a workspace with one project in this layout (`examples/caad-examples/pyproject.toml`, `…/parts/…`): the reference, and what the tests use.

## Running parts outside CAAD (advanced)

No features for this; it works because everything is plain code. From a project's folder, with Python and `build123d==0.13` installed (the project's `pyproject.toml` lists it):

- Parts without constrained sketches: `python -m parts.lid`.
- Parts with constrained sketches also need the `caad` module: download it from the CAAD site (`https://caad.vercel.app/caad.py` — the exact module the page runs) or the repository (`app/public/caad.py`) into the project's folder. Sketches then build from their stored geometry, with a warning when a parameter changed since CAAD last solved them (design doc 06).

The README describes this. A `caad` package on PyPI (with PlaneGCS for re-solving) is a future feature.

## Export

STEP and STL from the page: *Export* writes `exports/<part>.step` / `.stl` into the open project (or downloads them for the examples), and an `export_part` agent tool does the same. This is the roadmap's *Export* item; it lands here because it needs the `exports/` folder.

## Phases

| Phase | Contents |
| :-- | :-- |
| **07a — Workspace and projects** | Projects found by `pyproject.toml` with `[tool.caad]`; a workspace with several projects; *New project*; *Make this a CAAD project*; shared code in the kernel (each project's folder on `sys.path`); project browser by project and kind; *+ New part* into `parts/`; examples in the layout; agent `list_parts` by project and kind; guide; README section on running parts outside CAAD |
| **07b — Export** | STEP/STL to `exports/` or download; `export_part` agent tool |

## Decided

| Question | Decision |
| :-- | :-- |
| What you open | **A workspace**: any folder; projects are folders in it with a `pyproject.toml` (`[tool.caad]`), so a repository can hold several |
| Project file | **`pyproject.toml` with `[tool.caad]`**, rather than a separate `caad.toml` |
| Inside a project | **Fixed subfolders** (`parts/`, `assemblies/`, `exports/`, `print/`) with **the project's folder as the import root** |
| Git | **Not CAAD's concern** for now: it reads and writes files; the user handles git |
| `caad` outside CAAD | **No features**: advanced users download `caad.py` from the site or repository; a PyPI package is a future feature |
