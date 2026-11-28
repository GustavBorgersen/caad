# CAAD — Sketches and constraints

**Date:** 2026-11-25
**Status:** 06a and 06b built (2026-11-25); 06c and 06d built 2026-11-27 (part edges in sketches; trim, fillet, mirror and patterns; choosing regions; Onshape-like dimensions, points and axes)
**Part of:** [04 — Roadmap](04-roadmap.md), phase 1 ("Sketches v2"); builds on [05 — Feature model](05-feature-model.md)

## Problem

Sketches are named features now, but:

- **A sketch can't be reopened.** The sketch editor creates sketches; double-clicking one only shows its code.
- **No constraints.** Shapes are placed by numbers (`Rectangle(14, 12)` at `Locations((-3, 0))`). Nothing says "this circle is centred on that edge" or "these lines are perpendicular", so nothing keeps the design intent when something changes.
- **Dimensions can't use parameters** from the editor, only by editing the code.

The goal is Onshape-like sketching: free drawing (no grid), constraints and dimensions, dimensions that are expressions of the part's parameters, and sketches you can reopen — with everything stored as readable code that the agent can write too, and that builds outside CAAD.

## What we verified (2026-11-25)

| Question | Finding |
| :-- | :-- |
| Can the kernel solve sketches at rebuild, in the browser? | **Yes.** Python in the kernel worker calls PlaneGCS (WebAssembly, `@salusoft89/planegcs`) synchronously through a module registered with Pyodide. The spike's sketch solves to the same result (corner (60, 40), centre (18.333333, 16.996732)) in ~28 ms including setup |
| Diagnostics for the editor? | **Yes**, from the same call: degrees of freedom (2 for the sketch without its circle's two distances) and the ids of conflicting constraints (`w`, `w2` for two different widths) |
| PlaneGCS in Python inside Pyodide? | **No.** The PyPI package (`planegcs` 0.9.6) is a compiled extension with wheels for Linux x86-64 and Windows only — no Pyodide, **no macOS** |
| Turning solved geometry into faces? | **Yes.** `Wire.combine` gives the closed loops; nesting them even-odd gives regions with holes and islands (a rectangle with a circle and a smaller circle inside → a plate with a hole plus an island). `add()` in a `BuildSketch` on `Plane.XZ` puts them on that plane |
| Licences | PlaneGCS is LGPL (npm: 2.0+, PyPI: 2.1+). CAAD loads them as separate, unmodified packages; CAAD's own code stays MIT |

## One sketch form

Every sketch the editor makes or edits is a **constrained sketch**: entities, constraints and dimensions in a block from CAAD's small `caad` module, solved by PlaneGCS whenever the part builds.

```python
from build123d import *
from caad import Constrained

width = 60
depth = 40
hole_d = 10

with BuildPart() as plate:
    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:
        with Constrained() as c:
            r = c.rectangle((0, 0), (60, 40))        # 4 lines; horizontal and vertical sides built in
            h = c.circle((18.333, 16.997), 5)
            c.fix(r.corners[0])
            c.length(r.bottom, width)
            c.length(r.left, depth)
            c.radius(h, hole_d / 2)
            c.distance(r.corners[0], h.center, 25)
            c.distance(r.corners[1], h.center, 45)
    extrude(sk1.sketch, amount=5)
```

One rule for numbers, everywhere in the block:

- **Numbers in entity and shape calls are geometry** — where it is drawn: `c.rectangle((0, 0), (60, 40))`, `c.circle((18.333, 16.997), 5)`. They are the last solved values, rounded to 0.001 mm: the solver's starting point (which of several solutions you get) and the fallback geometry when no solver is available.
- **Constraints and dimensions are separate calls.** Dimensions are plain Python expressions, evaluated before solving: `width`, `hole_d / 2`, `2 * depth + 3`.
- **Shared points are coincidence**: lines that use the same point meet without a constraint.
- **Regions** are the closed loops of non-construction entities, nested even-odd: a loop inside a loop is a hole, a loop inside that is material again (Onshape-like). `sk1.sketch` is all of it. To use only some, `regions(sk1, (x, y), …)` (`from caad import regions`) takes the single areas — every area the lines enclose, crossings included — that contain the given points, fused: `extrude(regions(sk1, (0, 0)), amount=5)` extrudes only the area around the origin (a circle's disc, not the ring around it). In the extrude and revolve dialogs the sketch's areas show in the view; clicking one adds or removes it (the code becomes `regions(sk1, …)` with a point well inside each).

### The API

Small, one line per call, so the agent writes it as easily as the editor:

| Kind | Calls |
| :-- | :-- |
| Entities | `point(x, y)` (`construction=True`: a guide point, not where `points(sketch)` puts holes), `line(a, b)`, `polyline(*points, close=False)` → lines, `circle(center, r)`, `arc(center, start, end)` (counter-clockwise). A point argument can be a point or an `(x, y)` pair (makes a new point). `construction=True` on any entity: used by constraints, not part of the regions |
| Shapes | `rectangle(corner, opposite)` → `.bottom` `.right` `.top` `.left` lines, `.corners` (from the first corner, counter-clockwise), `.center` (construction point); horizontal and vertical sides built in. `polygon(*points)` → a closed polyline, `.lines`, `.points` |
| Constraints | `coincident(a, b)`, `horizontal(*lines)`, `vertical(*lines)`, `parallel(a, b)`, `perpendicular(a, b)`, `tangent(a, b)`, `equal(*entities)`, `fix(*points)`, `on(point, line_or_circle)`, `midpoint(point, line)`, `symmetric(a, b, about)` |
| Dimensions | `distance(a, b, d)`, `hdistance(a, b, d)`, `vdistance(a, b, d)`, `length(line, d)`, `radius(circle_or_arc, r)`, `diameter(…, d)`, `angle(line_a, line_b, degrees)`: the angle between the lines as drawn, 0–180° (the sign is ignored) — between their sides away from where they meet, turning the way it turns now, so the lines keep their arrangement when the value changes |
| References | `c.origin` (the sketch plane's origin, fixed), `c.x_axis`, `c.y_axis` (construction lines); `line.start` / `.end`, `circle.center`, `arc.center` / `.start` / `.end` |
| The part | `project(edge_or_vertex, construction=True)`: an edge or vertex of the part (a selector; a ShapeList of one is fine) projected onto the sketch plane as fixed geometry: a line, a circle or arc (parallel to the plane), or a point (a vertex, or an edge seen end-on). Constrain to it like anything else; a guide by default, `construction=False` makes it part of the regions. Re-projected at every build, so it follows the part |
| Regions | `regions(sketch, *at)` (module-level, not `c.`): the single areas of a named sketch containing the points `at`, on the sketch's plane; for `extrude` / `revolve`. A point on a line or outside every area is an error at the feature |
| Operations | `fillet(corner, r)`: rounds the corner where exactly two lines end → the arc (`.corner` is the old corner, kept as a point to dimension to; `r` is a dimension). `mirror(about, *items)` → copies of points, lines, circles and arcs mirrored about a line, kept symmetric. `linear_pattern(items, count, dx, dy=0)` and `circular_pattern(items, count, center, angle=360)` → `[copy][item]` (the original is copy 0; 360°: spread all round, else from the first copy to the last); copies follow the originals. Their helpers (radius spokes) aren't drawn |

Each call maps to PlaneGCS primitives (`p2p_distance`, `horizontal_l`, `tangent_lc`…). The mapping lives in one place — the `caad` module — and the page's editor uses the same primitive format.

### Plain sketches: built as they are, converted when edited

Plain build123d sketches — `Rectangle`, `Circle`, `Polygon` at `Locations`, as in the examples, older files and much hand-written code — **still build as normal build123d**; nothing changes for them. Double-clicking one offers to **convert it once** to the constrained form:

- `Rectangle(w, h)` at `(x, y)` → `c.rectangle(…)` with `c.length` for `w` and `h`; `Circle(r)` → `c.circle(…)` with `c.radius`; `Polygon(…)` → `c.polygon(…)` with its points fixed. Expressions stay expressions (`width` stays `width`); positions become `c.hdistance` / `c.vdistance` from `c.origin`, so a sketch at `Locations((x_off, 0))` still moves with `x_off`.
- **The conversion is checked**: CAAD builds both forms and compares the regions. build123d's modes (shapes added together, `mode=Mode.SUBTRACT`) and even-odd nesting usually agree, but not always (a circle *added* inside a rectangle is no hole in build123d). If they differ, the sketch isn't converted and stays a code feature, with the reason.
- Anything else in the body (`GridLocations`, `Text`, a loop…) stays a code feature: edit it in the code.

## Building constrained sketches

- Leaving `with Constrained()` collects the entities and constraints, solves, turns the result into edges, loops and regions, and adds the regions to the enclosing `BuildSketch`.
- **In CAAD**: PlaneGCS WebAssembly, through a module the kernel worker registers with Pyodide (verified above). The `caad` module is served with the page (`app/public/caad.py`, like `caad_kernel.py`) and importable in the kernel.
- **Outside CAAD** (`python part.py`): the sketch is built from the stored geometry, with a warning naming the constraints it doesn't satisfy (e.g. a parameter changed since the last solve) — the module checks every constraint type itself. The file always builds. Re-solving with PyPI's `planegcs` where it's installed (Linux x86-64, Windows; its Python API needs a mapping per constraint type) is a later step. How a project carries `caad` outside CAAD (a pip package or a copy in the project) is decided in design doc 07.
- **Errors** show at the sketch feature, naming the constraints: "c.length(r.bottom, 70) conflicts with c.length(r.bottom, width)". An under-constrained sketch is fine; it solves near its stored geometry.

## The sketch editor

- **Reopen**: double-click a sketch in the timeline. The view rolls back to just before it; the kernel opens a session (`sketch_open(src, index)`): it keeps the part's names as they are before the sketch and returns the sketch's model — plane, entities with the expression code uses for each (`rect1.corners[0]`), constraints, dimensions as expressions with their values, PlaneGCS primitives, degrees of freedom and conflicts. New sketches open the same way, as an empty `with Constrained() as c: pass` that is only saved on Done.
- **Tools**: line / polyline, rectangle, circle, arc, point, *Trim* (click the piece of a line, circle or arc to cut away, between the nearest crossings: a line or arc gets shorter or splits in two, a circle becomes an arc, a curve with no crossings goes; the new ends are kept on what crossed there with `c.on`; a rectangle, polygon or polyline is first rewritten as single lines with its built-in constraints), *Use* (click an edge of the part: `ref1 = c.project(<its selector>)`, drawn dashed purple, can't be dragged); construction toggle. **No grid snapping** — snapping to existing points and edges instead, with inferred constraints shown while drawing (coincident, horizontal, vertical, on-edge), as in Onshape.
- **Constraints**: select entities, then a constraint button; only the ones that apply to the selection are enabled.
- **Operations**, after the constraint buttons: *fillet* for a corner point (its radius opens for typing), *mirror* about the last selected line, *linear pattern* of the selection, *circular pattern* around the last selected point. Selecting a copy shows its pattern's count, spacing or angle as fields.
- **Dimensions**: the *Dimension* tool, Onshape-like — click a line, circle or arc, then beside it: its length, diameter or radius; or click two of points, lines and circles (a circle stands for its centre): the angle between two lines, a point's distance to a line, the distance between two points (with the cursor above or below them a horizontal distance, left or right a vertical one, from left to right and bottom to top). The dimension and its value are previewed as the cursor moves; the next click makes it and opens its value. Dimensions also come from the buttons for a selection. The value field takes expressions, offers the part's parameters, and shows the evaluated value; it keeps its focus as the view redraws. A label shows the value, or `expression = value`.
- **How it looks**, Onshape-like: points made on their own (the point tool, and their mirrored or patterned copies) are rings, unlike line ends, centres and reference points (the origin, a rectangle's centre). **Labels sit beside the geometry, never on it**, so lines and points stay clickable (crowded at a small zoom: zoom in) ([#12](https://github.com/GustavBorgersen/caad/issues/12)): a line's length gets a dimension line beside the line, on its open side (away from the lines that share its ends: outside a rectangle), with extension lines; other distances get a dimension line with arrows to what they measure — from a point to the foot on a line (the line extended out to it when it stops short), between two points, horizontal and vertical ones above or right of their points with extension lines; radii (fillets too) and diameters a leader through the circle, labelled `R` / `Ø` past its end; angles the arc between the two lines from where they meet (extended to it), labelled in degrees outside the arc. Labels are tight chips in the panel colour, which breaks the dimension line under the text. A line's own constraint glyphs (horizontal, vertical) go on its inner side, opposite its length. Arrows keep their size on screen. The sketch's own X (red) and Y (green) are arrows at its origin.
- **Live solving**: PlaneGCS WebAssembly in the page solves on every drag (milliseconds for sketch-sized problems). Constraints already implied by others (a line horizontal and perpendicular to a vertical side) are left out while dragging: with the drag's temporary constraints PlaneGCS would call them conflicting and move nothing.
- **Status colours**: fully constrained geometry dark, under-constrained blue, conflicting constraints red with a message; the degrees of freedom left are shown in the panel.
- **Every action is a code edit** (`sketch_action(src, index, actions)`), done by the kernel so the code generation lives in Python: *add* appends a statement (`line1 = c.line(rect1.corners[2], (30, 20))` — snapping to a point uses its expression, so shared points are coincidence); *constrain* appends a constraint or dimension; *dimension* replaces a dimension's expression; *move* sets the geometry numbers of the statements to the solved positions after a drag (only numbers that change; expressions are left alone); *delete* removes statements and everything that depends on them; *arg* changes one argument of a statement (a pattern's count); *trim* rewrites the statements of the curve it cuts. The kernel re-runs just the sketch's block in the saved names and returns the new model, problems included instead of raised. Dragging itself solves in the page, with the model's primitives. **Done** saves the edited source; **Cancel** drops it.

## The agent

- The build123d guide gets a section on constrained sketches; `api_help("Constrained")` documents the API from the module itself.
- `get_timeline` tells per sketch whether it is fully or under-constrained (degrees of freedom left) or failing.
- Sketches the agent writes this way are editable in the GUI with their design intent; plain build123d sketches keep working as before.

## Phases

| Phase | Contents |
| :-- | :-- |
| **06a — Constrained sketches in code** (done) | The `caad` module: entities, shapes, constraints, dimensions, regions; PlaneGCS at build in the page (WebAssembly bridge) and outside (PyPI or stored geometry); errors at the sketch feature; the sketcher writes the constrained form (its rectangles, circles and polygons as shapes, with their sizes as dimensions); outlines and `get_timeline` status; guide and `api_help`. Node tests against the page's build123d |
| **06b — The sketch editor** (done) | sketch sessions in the kernel (`sketch_open` / `sketch_action`); reopening sketches by double-click, new sketches in the same editor; line (chains), rectangle, circle, arc and point tools; snapping to points and the origin, with horizontal/vertical inferred for new lines; dragging with live solving (only what has to move moves); constraint and dimension buttons for the selection (a distance goes from the first selected point to the second), a new dimension opening for its expression with the part's parameters offered, double-click a label to change it; constraints shown as glyphs (select, delete); conflicts in red; degrees of freedom. Converting plain sketches on first edit (`sketch_convert`: checked by comparing regions; polygons keep their points as written — build123d 0.13's default alignment) |
| **06c — References and tools** (done) | **Done:** a point placed on the origin is tied to it (#7); the part's edges in a sketch (`c.project(selector)`, the *Use* tool; fixed, a guide unless `construction=False`), constrained to like any entity; trim (a code edit: shorter, split, circle to arc, shapes into lines), `c.fillet`, `c.mirror`, `c.linear_pattern` / `c.circular_pattern` with editor buttons and pattern fields; choosing individual regions to extrude or revolve (`regions(sk1, (x, y), …)`, clicked in the view in the feature dialog) |
| **06d — Sketch visuals** (done) | Drawn points as small circles (unlike the origin and a rectangle's centre); Onshape-like dimensions: extension lines and arrows for distances between entities, the arc of an angle; the sketch's local X/Y axes in the sketch and on plane features |

## Decided

| Question | Decision |
| :-- | :-- |
| One form or two? | **One** — the constrained form, with shape helpers so simple sketches stay short. Plain build123d sketches build as before and are converted (checked) when first edited in the editor |
| Numbers in the block | **Geometry in entity and shape calls, dimensions as separate calls** — one rule everywhere |
| Module and import | **`from caad import Constrained`**; served with the page; outside CAAD per design doc 07 |
| Outside CAAD | **Build from the stored geometry and warn** when it doesn't satisfy the constraints, rather than fail; re-solving with PyPI's `planegcs` later |
| Regions | **Even-odd nesting** (holes and islands), like Onshape |
