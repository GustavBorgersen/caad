# CAAD guide to build123d

How to work in CAAD, and a compact guide to build123d. It comes from the page, so it matches the CAAD the user has open; every example is tested against the build123d version the page runs. For exact signatures use `api_help`.

How to work:
- Start with `get_status`; `list_parts` shows the user's projects and where things go.
- Change parts with `write_part` (whole file) or `edit_part` (exact replacement). Both save, rebuild and return the result: check it, and fix errors before you answer. Use `render` to look at the result when shape matters.
- When the user says "this", "these edges", "here": call `get_selection` and use the verified selectors it returns. To show what you mean, use `highlight`.
- Try uncertain code with `run_snippet` first; it changes nothing.
- `export_part` writes STEP or STL into the project's `exports/`.
- Follow the conventions in *Part files* below: the user's timeline and the GUI's dialogs and sketch editor depend on them.

## Part files

One part per file. Parameters first, then one `BuildPart` block. Every statement directly inside the block is one feature in the user's timeline.

```python
from build123d import *

length = 80        # parameters: plain top-level assignments, in mm
width = 40
thickness = 6
hole_d = 8

with BuildPart() as plate:
    Box(length, width, thickness, align=(Align.CENTER, Align.CENTER, Align.MIN))
    with Locations((-25, 0, thickness), (25, 0, thickness)):
        Hole(hole_d / 2)
    fillet(plate.edges().filter_by(Axis.Z), radius=4)
```

- Name the builder after the part (`plate`, `bracket`); selectors refer to it (`plate.edges()`).
- Files live in **projects**: folders with a `pyproject.toml` (`[tool.caad]`). Parts go in `<project>/parts/`. Parameters shared by several parts go in a module of the project, e.g. `<project>/params.py` with `wall = 3`, and parts import them: `from params import wall` — the project's folder is the import root. `list_parts` shows the layout.
- Keep one feature per statement, directly inside the block: a sketch block, an extrude, a fillet, a `Locations` block with holes. A `with BuildSketch()` / `with Locations()` block counts as one feature together with what is inside it. Don't hide features in functions or loops unless the user asks.
- Use parameters for dimensions the user may want to change. Units are millimetres.
- Select geometry with selectors (`part.edges().filter_by(Axis.Z)`), never with fixed indices.
- Don't call `show()`, exporters or viewers — the page shows the part (`export_part` exports).

## Builder mode

Builders collect what is created inside them:

- `BuildPart` — 3D solids. `BuildSketch` — 2D faces. `BuildLine` — 1D curves (turn them into a face with `make_face()`).
- Objects combine with the builder's content according to `mode`: `Mode.ADD` (default), `Mode.SUBTRACT`, `Mode.INTERSECT`, `Mode.PRIVATE` (create without combining).
- `align=(Align.CENTER, Align.CENTER, Align.MIN)` places a primitive so it sits on the XY plane, centred in X and Y. The default for 3D primitives is centred in all three.
- `plate.part` is the resulting solid; `sketch.sketch` the resulting face(s).

```python
from build123d import *

with BuildPart() as block:
    Box(40, 30, 20)
    Cylinder(radius=6, height=20, mode=Mode.SUBTRACT)   # a through-hole
```

## Sketches and extrude

A sketch is drawn on a plane (default `Plane.XY`) or on a face, then extruded.

```python
from build123d import *

with BuildPart() as part:
    with BuildSketch(Plane.XY) as base:
        Rectangle(60, 40)
        fillet(base.vertices(), radius=5)               # round the corners (before adding curves)
        Circle(8, mode=Mode.SUBTRACT)
    extrude(amount=10)
    with BuildSketch(part.faces().sort_by(Axis.Z)[-1]):  # sketch on the top face
        RegularPolygon(radius=12, side_count=6)
    extrude(amount=5)
```

- 2D shapes: `Rectangle(w, h)`, `Circle(r)`, `Ellipse(rx, ry)`, `RegularPolygon(radius, side_count)`, `Polygon((x, y), ...)`, `SlotOverall(length, height)`, `SlotCenterToCenter(distance, height)`, `RectangleRounded(w, h, radius)`, `Trapezoid(w, h, left_side_angle)`, `Text("abc", font_size=10)`.
- Planes: `Plane.XY`, `Plane.XZ`, `Plane.YZ`, `Plane.XY.offset(10)`, or a planar face.
- `extrude(amount=..., mode=Mode.SUBTRACT)` cuts; `extrude(amount=-5)` goes the other way; `both=True` extrudes symmetrically; `until=Until.NEXT` extrudes up to the next face; `taper=5` adds draft (degrees).

## Constrained sketches (the form CAAD's sketch editor uses)

For a sketch the user will edit in CAAD, or with design intent (dimensions from parameters, shapes related to each other), write a **named private sketch** with a `Constrained` block, and extrude it by name. CAAD solves it with PlaneGCS at every build.

```python
from build123d import *
from caad import Constrained

width = 60
depth = 40
hole_d = 10

with BuildPart() as plate:
    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:
        with Constrained() as c:
            r = c.rectangle((0, 0), (60, 40))         # geometry: where it is drawn
            h = c.circle((15, 20), 5)
            c.coincident(r.corners[0], c.origin)      # constraints and dimensions: separate calls
            c.length(r.bottom, width)
            c.length(r.left, depth)
            c.radius(h, hole_d / 2)
            c.vdistance(r.corners[0], h.center, depth / 2)
            c.hdistance(r.corners[0], h.center, 15)
    extrude(sk1.sketch, amount=5)
```

- Numbers in entity and shape calls (`c.point`, `c.line`, `c.circle`, `c.arc`, `c.rectangle`, `c.polygon`) are **geometry**: where it is drawn, the solver's starting point. Write sensible positions.
- Constraints and dimensions are separate calls; dimension values are any expression. Shared points are coincident (`c.polyline` and `c.rectangle` share their corners).
- A loop inside a loop is a hole; crossing loops merge. `construction=True` entities only guide.
- The part's own edges: `ref1 = c.project(part.edges().filter_by(Axis.X).sort_by(Axis.Y)[0])` projects one edge (or vertex) of the part as it is before the sketch onto the sketch plane, fixed: then `c.on(p1, ref1)`, `c.coincident(line1.start, ref1.end)`, `c.equal(h, ref2)`… It's a guide; `construction=False` makes it part of the regions. Circles and arcs must be parallel to the sketch plane.
- A fully constrained sketch has 0 degrees of freedom; `get_timeline` reports what's left, and conflicting constraints fail at the sketch, naming them.
- Full API: `api_help("Constrained")`.

## Features the user can edit in dialogs

CAAD reads these forms back as features with a dialog (double-click in the timeline); other code still works but is edited as code. Write them this way when the user will keep working on the part, and change their arguments with `edit_feature` (it keeps the rest of the line as it is).

```python
from build123d import *

radius = 20
height = 12
bolt_r = 2.5

with BuildPart() as hub:
    with BuildSketch(Plane.XZ, mode=Mode.PRIVATE) as sk1:      # the profile, beside the Z axis
        with Locations((radius / 2, height / 2)):
            Rectangle(radius, height)
    revolve(sk1.sketch, axis=Axis.Z)                          # revolve: the sketch, axis, revolution_arc (degrees)
    with Locations((radius + 6, 0, 2)):                       # a lug on one side…
        Box(14, 10, 4)
    mirror(about=Plane.YZ)                                     # …mirrored to the other (adds the mirror image)
    with Locations((radius + 8, 0, 4), (-radius - 8, 0, 4)):  # hole: positions (or a face), then one hole
        CounterBoreHole(radius=bolt_r, counter_bore_radius=2 * bolt_r, counter_bore_depth=1.5)
    fillet(hub.edges().filter_by(GeomType.CIRCLE).sort_by(Axis.Z)[-1:], radius=1)
```

- **Extrude** `extrude(sk1.sketch, amount=…, both=True, until=Until.LAST, mode=Mode.SUBTRACT, dir=…)`; **revolve** `revolve(sk1.sketch, axis=Axis.Z, revolution_arc=90)`: refer to a named private sketch. To revolve about a line of a constrained sketch, draw it with `construction=True` (so it isn't part of the profile) and use `revolve(sk1.sketch, axis=axis(sk1, line1))` (`from caad import Constrained, axis`); the line may be in another sketch than the profile.
- **Plane** `pl1 = Plane.XZ.offset(20).rotated((15, 0, 0))` in the part block: a named plane to sketch on (`with BuildSketch(pl1, mode=Mode.PRIVATE) as sk2:`) or to mirror about (`mirror(about=pl1)`). It is on `Plane.XY`/`XZ`/`YZ`, a flat face (`Plane(<face selector>)`) or an earlier plane; `.offset(d)` moves it along its normal and `.rotated((x, y, z))` turns it about its own x axis, y axis and normal (degrees, in that order). Write offset before rotated.
- **Hole** at the points of a sketch: draw the positions as points in a constrained sketch on the face (`p1 = c.point(10, 5)`, dimensioned like anything else), then `with Locations(*points(sk2)): Hole(radius=…, depth=…)` (`from caad import Constrained, points`; no depth: through all). Each hole drills into the face the sketch is on (against the sketch plane's normal); `points(sk2, reverse=True)` drills the other way (a sketch on a plane under the part, or between two extrudes), and `points(sk2, far=<the part's builder>)` starts each hole where it leaves the part on the far side, so a counterbore or countersink is on that face. Also `CounterBoreHole(radius, counter_bore_radius, counter_bore_depth)` and `CounterSinkHole(radius, counter_sink_radius, counter_sink_angle=82)`; explicit positions `with Locations((x, y, z), …)` work too.
- **Fillet / chamfer** `fillet(<edges selector>, radius=…)`, `chamfer(<edges>, length=…)`; **mirror** `mirror(about=Plane.YZ)` adds the mirror image of everything so far (so mirror before the features that should stay on one side only).
- Any other single build123d call (`Box(…)`, `Cylinder(…)`) gets a generic dialog from its signature.

```python
from build123d import *
from caad import Constrained, axis

with BuildPart() as ring:
    with BuildSketch(Plane.XZ, mode=Mode.PRIVATE) as sk1:
        with Constrained() as c:
            r = c.rectangle((10, 0), (14, 4))
            line1 = c.line((0, 0), (0, 10), construction=True)  # the axis: a construction line
            c.coincident(line1.start, c.origin)
            c.vertical(line1)
            c.hdistance(line1.start, r.corners[0], 10)
    revolve(sk1.sketch, axis=axis(sk1, line1))                # a ring about that line
    pl1 = Plane.XY.offset(4)                                   # a plane on the ring's top
    with BuildSketch(pl1, mode=Mode.PRIVATE) as sk2:
        with Locations((12, 0)):
            Circle(1.5)
    extrude(sk2.sketch, amount=3)                              # a peg on it
```

## Lines and profiles

```python
from build123d import *

with BuildPart() as handle:
    with BuildSketch(Plane.XZ) as profile:
        with BuildLine() as outline:
            Polyline((0, 0), (30, 0), (30, 5), (5, 5), (5, 20), (0, 20), close=True)
        make_face()
    revolve(axis=Axis.Z)                                 # revolve the profile around Z
```

- Curves: `Line(a, b)`, `Polyline(a, b, c, ..., close=True)`, `ThreePointArc(a, b, c)`, `CenterArc(center, radius, start_angle, arc_size)`, `TangentArc(a, b, tangent=(dx, dy))`, `Spline(points...)`, `RadiusArc(a, b, radius)`.
- `make_face()` turns the closed outline into a face in the enclosing `BuildSketch`.
- `revolve(axis=Axis.Z, revolution_arc=360)`; `sweep(path=...)`; `loft()` between several sketches on different planes (each created with `mode=Mode.PRIVATE` or in one `BuildSketch` per plane).

## Primitives

`Box(length, width, height)`, `Cylinder(radius, height)`, `Cone(bottom_radius, top_radius, height)`, `Sphere(radius)`, `Torus(major_radius, minor_radius)`, `Wedge(...)`. All take `align`, `rotation=(rx, ry, rz)` in degrees, and `mode`.

## Edge and face operations

```python
from build123d import *

with BuildPart() as cup:
    Cylinder(radius=30, height=40, align=(Align.CENTER, Align.CENTER, Align.MIN))
    offset(amount=-2, openings=cup.faces().sort_by(Axis.Z)[-1])   # shell: 2 mm wall, open top
    fillet(cup.edges().group_by(Axis.Z)[0], radius=1)             # round the bottom outside edge
    chamfer(cup.edges().group_by(Axis.Z)[-1], length=0.5)         # break the top rim
```

- `fillet(edges, radius)`, `chamfer(edges, length, length2=None)`. A too-large radius fails with "Failed creating a fillet" — use a smaller value; `part.part.max_fillet(edges)` gives the limit.
- `offset(amount=-t, openings=face_or_faces)` makes a shell with wall thickness `t`.
- `mirror(about=Plane.YZ)` mirrors everything in the builder; `split(bisect_by=Plane.XZ)` keeps one side.
- Holes on a face or point (they cut downwards along the location's −Z): `Hole(radius, depth=None)`, `CounterBoreHole(radius, counter_bore_radius, counter_bore_depth)`, `CounterSinkHole(radius, counter_sink_radius)`.

## Selectors

Select geometry by properties, never by fixed index — indices change when the model changes.

```python
from build123d import *

with BuildPart() as p:
    Box(40, 30, 10)
    top = p.faces().sort_by(Axis.Z)[-1]                    # highest face
    bottom_edges = p.edges().group_by(Axis.Z)[0]           # all edges at the lowest Z
    vertical = p.edges().filter_by(Axis.Z)                 # edges parallel to Z
    side_faces = p.faces().filter_by(Axis.X)               # planar faces facing ±X
    with Locations(top):
        Hole(4)
    round_edges = p.edges().filter_by(GeomType.CIRCLE)     # the hole's circular edges
    biggest = p.faces().sort_by(SortBy.AREA)[-1]
    new_edges = p.edges(Select.LAST)                       # edges made by the last operation
```

- `sort_by(key)` orders (lowest first, so `[-1]` is the highest/largest); `group_by(key)` makes groups of equal value (`[0]` lowest group, `[-1]` highest); `filter_by(Axis.Z | GeomType.X | lambda s: ...)` keeps matches.
- Keys: `Axis.X/Y/Z` (position along an axis), `SortBy.AREA`, `SortBy.LENGTH`, `SortBy.RADIUS`, `SortBy.VOLUME`, `SortBy.DISTANCE`.
- Geometry types: `GeomType.PLANE`, `CYLINDER`, `CONE`, `SPHERE`, `TORUS`, `BSPLINE` for faces; `LINE`, `CIRCLE`, `ELLIPSE`, `BSPLINE` for edges.
- `Select.ALL` (default), `Select.LAST` (from the last operation), `Select.NEW` (new in the last operation).
- In CAAD, `get_selection` returns verified selectors for what the user clicked — use them.

## Positioning

```python
from build123d import *

with BuildPart() as plate:
    Box(100, 60, 5)
    with GridLocations(80, 40, 2, 2):                      # 4 holes in a 80 x 40 grid
        Hole(3)
    with PolarLocations(radius=15, count=6):               # 6 holes on a circle
        Hole(1.5)
    with Locations((0, 0, 2.5)):
        Cylinder(radius=8, height=10, align=(Align.CENTER, Align.CENTER, Align.MIN))
```

- `Locations((x, y, z), ...)`, also faces/planes/`Location((x, y, z), (rx, ry, rz))`.
- `GridLocations(x_spacing, y_spacing, x_count, y_count)`, `PolarLocations(radius, count, start_angle=0)`, `HexLocations(...)`.
- Nested location blocks multiply; locations apply to objects created directly inside them.
- In algebra style (outside builders) `Pos(x, y, z) * Box(1, 2, 3)` and `Rot(0, 0, 45) * shape` move shapes.

## Common mistakes

- **Fillet fails**: radius too big for the adjacent faces, or the edges were already changed by a cut. Try a smaller radius, fillet earlier in the timeline, or select fewer edges.
- **Nothing happens / wrong side**: extrude direction follows the sketch plane's normal; use a negative `amount`, `both=True`, or a flipped plane (`Plane.XY.reverse()`). Holes drill along −Z of their location.
- **Selector picks the wrong thing**: check it with `run_snippet` (e.g. `len(part.edges().filter_by(Axis.Z))`) or show it to the user with `highlight` before using it.
- **Sketch on a face is rotated unexpectedly**: a face's local X axis may not match the global one; position with `Locations` inside the sketch and check with `render`.
- **Sketch fillet fails with "Vertex must connect exactly two edges"**: `vertices()` also returned a circle's seam point. Fillet the corners before adding circles, or select only the corners.
- **Units** are millimetres; angles are degrees.
