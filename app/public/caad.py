"""CAAD's constrained sketches for build123d (docs/06-sketches.md).

    from caad import Constrained

    with BuildSketch(Plane.XY) as sk1:
        with Constrained() as c:
            r = c.rectangle((0, 0), (60, 40))     # geometry: where it is drawn
            c.length(r.bottom, width)             # dimensions: any expression
            c.coincident(r.center, c.origin)

Numbers in entity and shape calls are geometry: the last solved positions, which are the solver's
starting point and the fallback without a solver. Constraints and dimensions are separate calls.
`c.project(edge)` brings the part's own edges and vertices in as fixed references to constrain to.
Leaving the block solves the sketch with PlaneGCS and adds its regions to the enclosing BuildSketch:
loops inside loops alternate between material and hole; loops that cross are merged.

PlaneGCS runs in the CAAD page (WebAssembly). Outside CAAD the sketch is built from its stored
geometry, with a warning when that doesn't satisfy the constraints.
"""

import json
import math
import sys
import warnings

__all__ = ["Constrained", "axis", "points"]

TOLERANCE = 1e-3  # stored geometry is rounded to 0.001 mm
solves = []  # per solved sketch: {"line", "dof", "solver", "message"}; CAAD shows it in the timeline


# --- Entities ---------------------------------------------------------------------------------

class _Entity:
    reference = False  # part geometry projected with c.project: fixed

    def __init__(self, sketch, construction):
        self.id = f"{type(self).__name__.lower()}{len(sketch._entities)}"
        self.construction = construction
        self.line = _caller()[0]  # the statement that made it (for CAAD's sketch editor)
        sketch._entities.append(self)


class Point(_Entity):
    """A point; `x`, `y` are its position (after leaving the block: the solved one)."""

    def __init__(self, sketch, x, y, fixed=False, placed=False):
        super().__init__(sketch, True)
        self.x, self.y, self.fixed = _number(x, "x"), _number(y, "y"), fixed
        self.placed = placed  # drawn as a point (c.point), not a corner or an end: where points() puts holes

    def __repr__(self):
        return f"Point({self.x:g}, {self.y:g})"

    def _primitives(self):
        return [{"id": self.id, "type": "point", "x": self.x, "y": self.y, "fixed": self.fixed}]


class Line(_Entity):
    """A line from `start` to `end` (points)."""

    def __init__(self, sketch, start, end, construction=False):
        super().__init__(sketch, construction)
        self.start, self.end = start, end

    @property
    def length(self):
        return math.dist((self.start.x, self.start.y), (self.end.x, self.end.y))

    def __repr__(self):
        return f"Line({self.start!r}, {self.end!r})"

    def _primitives(self):
        return [{"id": self.id, "type": "line", "p1_id": self.start.id, "p2_id": self.end.id}]

    def _edge(self):
        from build123d import Edge
        return Edge.make_line((self.start.x, self.start.y), (self.end.x, self.end.y))


class Circle(_Entity):
    """A circle around `center` (a point) with radius `r`."""

    fixed = False  # a reference's radius is fixed too

    def __init__(self, sketch, center, r, construction=False):
        super().__init__(sketch, construction)
        self.center, self.r = center, _number(r, "r")

    def __repr__(self):
        return f"Circle({self.center!r}, {self.r:g})"

    def _primitives(self):
        out = [{"id": self.id, "type": "circle", "c_id": self.center.id, "radius": self.r}]
        if self.fixed:
            out.append({"id": f"{self.id}_r", "type": "circle_radius", "c_id": self.id, "radius": self.r})
        return out

    def _edge(self):
        from build123d import Edge, Location, Plane
        return Edge.make_circle(self.r, Plane.XY.move(Location((self.center.x, self.center.y))))


class Arc(_Entity):
    """An arc around `center` from `start` to `end`, counter-clockwise (points)."""

    def __init__(self, sketch, center, start, end, construction=False):
        super().__init__(sketch, construction)
        self.center, self.start, self.end = center, start, end

    @property
    def r(self):
        return math.dist((self.center.x, self.center.y), (self.start.x, self.start.y))

    def _angles(self):
        a = math.atan2(self.start.y - self.center.y, self.start.x - self.center.x)
        b = math.atan2(self.end.y - self.center.y, self.end.x - self.center.x)
        return a, b if b > a else b + 2 * math.pi

    def __repr__(self):
        return f"Arc({self.center!r}, {self.start!r}, {self.end!r})"

    def _primitives(self):
        a, b = self._angles()
        return [{"id": self.id, "type": "arc", "c_id": self.center.id, "start_id": self.start.id, "end_id": self.end.id,
                 "radius": self.r, "start_angle": a, "end_angle": b},
                {"id": f"{self.id}_rules", "type": "arc_rules", "a_id": self.id}]

    def _edge(self):
        from build123d import Edge
        a, b = self._angles()
        m = (a + b) / 2
        mid = (self.center.x + self.r * math.cos(m), self.center.y + self.r * math.sin(m))
        return Edge.make_three_point_arc((self.start.x, self.start.y), mid, (self.end.x, self.end.y))


# --- Shapes -------------------------------------------------------------------------------------

class Rectangle:
    """Four lines with horizontal and vertical sides. `corners` start at the first corner given and go
    (x0, y0), (x1, y0), (x1, y1), (x0, y1); `center` is a construction point in the middle."""

    def __init__(self, sketch, corner, opposite, construction):
        (x0, y0), (x1, y1) = _pair(corner), _pair(opposite)
        self.corners = [Point(sketch, x, y) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
        self.lines = sketch.polyline(*self.corners, close=True, construction=construction)
        self.bottom, self.right, self.top, self.left = self.lines
        self.center = Point(sketch, (x0 + x1) / 2, (y0 + y1) / 2)
        sketch.horizontal(self.bottom, self.top)
        sketch.vertical(self.left, self.right)
        sketch.symmetric(self.corners[0], self.corners[2], self.center)


class Polygon:
    """A closed polyline through `points`; `lines[i]` goes from `points[i]` to the next one."""

    def __init__(self, sketch, points, construction):
        self.points = [sketch._point(p) for p in points]
        self.lines = sketch.polyline(*self.points, close=True, construction=construction)


# --- The sketch -----------------------------------------------------------------------------------

class Constrained:
    """A constrained sketch. Use inside `with BuildSketch(...)`; see the module's docstring."""

    def __init__(self):
        self._entities = []
        self._constraints = []  # (primitive, source line, source text)
        self._origin = self._axes = None
        self._plane = None  # the sketch's plane in 3D (for c.project); None: Plane.XY
        self.faces = None  # after the block: the regions that were added
        self.dof = None  # after the block: degrees of freedom left (None without a solver)
        self.conflicting, self.problem = [], None  # see _build(strict=False)

    def __enter__(self):
        self._line = _caller()[0]
        from build123d import BuildSketch, Plane
        sketch = BuildSketch._get_context(log=False)
        if sketch is not None and sketch.output_placements:
            self._plane = Plane(sketch.output_placements[0])
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self._build()
        return False

    # Entities and shapes. Numbers here are geometry: where it is drawn.

    def point(self, x, y):
        """A point at (x, y). Points drawn this way are where `points(sketch)` puts holes."""
        return Point(self, x, y, placed=True)

    def line(self, start, end, construction=False):
        """A line between two points (points or (x, y) pairs)."""
        return Line(self, self._point(start), self._point(end), construction)

    def polyline(self, *points, close=False, construction=False):
        """Lines through the points, sharing their ends; `close` adds the line back to the first."""
        pts = [self._point(p) for p in points]
        pairs = list(zip(pts, pts[1:])) + ([(pts[-1], pts[0])] if close else [])
        return [Line(self, a, b, construction) for a, b in pairs]

    def circle(self, center, r, construction=False):
        """A circle around `center` (a point or (x, y)) with radius `r`."""
        return Circle(self, self._point(center), r, construction)

    def arc(self, center, start, end, construction=False):
        """An arc around `center` from `start` to `end`, counter-clockwise; keeps its ends on the circle."""
        return Arc(self, self._point(center), self._point(start), self._point(end), construction)

    def rectangle(self, corner, opposite, construction=False):
        """A rectangle between two opposite corners; horizontal and vertical sides built in."""
        return Rectangle(self, corner, opposite, construction)

    def polygon(self, *points, construction=False):
        """A closed polygon through the points."""
        return Polygon(self, points, construction)

    def project(self, item, construction=True):
        """Part geometry in the sketch, to constrain to: an edge (a line, circle or arc) or a vertex of the part,
        projected onto the sketch plane as fixed geometry, e.g. `ref1 = c.project(part.edges().sort_by(Axis.Z)[-1])`.
        The selector runs on every build, so the reference follows the part. Only a guide (construction) unless
        construction=False, which makes it part of the sketch's regions."""
        from build123d import Edge, GeomType, Plane, Vector, Vertex
        if isinstance(item, (list, tuple)):
            if len(item) != 1:
                raise ValueError(f"project() takes one edge or vertex; the selector gave {len(item)}.")
            item = item[0]
        plane = self._plane or Plane.XY
        def local(v):
            v = plane.to_local_coords(Vector(v))
            return (v.X, v.Y)

        def point(xy):
            p = Point(self, xy[0], xy[1], fixed=True)
            p.reference = True
            return p

        def made(e):
            e.reference = True
            return e

        if isinstance(item, Vertex):
            return point(local((item.X, item.Y, item.Z)))
        if not isinstance(item, Edge):
            raise TypeError(f"project() takes an edge or a vertex of the part, not {item!r}.")
        if item.geom_type == GeomType.LINE:
            a, b = local(item.position_at(0)), local(item.position_at(1))
            if math.dist(a, b) < TOLERANCE:  # straight through the plane: a point
                return point(a)
            return made(Line(self, point(a), point(b), construction))
        if item.geom_type != GeomType.CIRCLE:
            raise ValueError(f"project() takes lines, circles and arcs; this edge is a {item.geom_type.name.lower()}.")
        if abs(abs(item.normal().dot(plane.z_dir)) - 1) > 1e-6:
            raise ValueError("project() takes circles and arcs parallel to the sketch plane; this one is tilted.")
        center = local(item.arc_center)
        if item.is_closed:
            circle = made(Circle(self, point(center), item.radius, construction))
            circle.fixed = True
            return circle
        s, m, e = (local(item.position_at(t)) for t in (0, 0.5, 1))
        if (s[0] - center[0]) * (m[1] - center[1]) - (s[1] - center[1]) * (m[0] - center[0]) < 0:
            s, e = e, s  # arcs go counter-clockwise
        return made(Arc(self, point(center), point(s), point(e), construction))

    @property
    def origin(self):
        """The sketch plane's origin: a fixed point."""
        if self._origin is None:
            self._origin = Point(self, 0, 0, fixed=True)
        return self._origin

    @property
    def x_axis(self):
        """The sketch's x axis: a fixed construction line through the origin."""
        return self._axis()[0]

    @property
    def y_axis(self):
        """The sketch's y axis: a fixed construction line through the origin."""
        return self._axis()[1]

    # Constraints

    def coincident(self, a, b):
        """Two points at the same place."""
        self._add({"type": "p2p_coincident", "p1_id": _p(a).id, "p2_id": _p(b).id})

    def horizontal(self, *items):
        """Lines horizontal; or two points at the same height."""
        self._each_line_or_pair(items, "horizontal")

    def vertical(self, *items):
        """Lines vertical; or two points above each other."""
        self._each_line_or_pair(items, "vertical")

    def parallel(self, a, b):
        """Two lines parallel."""
        self._add({"type": "parallel", "l1_id": _l(a).id, "l2_id": _l(b).id})

    def perpendicular(self, a, b):
        """Two lines perpendicular."""
        self._add({"type": "perpendicular_ll", "l1_id": _l(a).id, "l2_id": _l(b).id})

    def tangent(self, a, b):
        """A line, circle or arc tangent to a circle or arc (or a line)."""
        kinds = {Line: "l", Circle: "c", Arc: "a"}
        if type(a) not in kinds or type(b) not in kinds:
            raise TypeError("tangent() takes lines, circles and arcs.")
        ka, kb = kinds[type(a)], kinds[type(b)]
        if ka + kb in ("cl", "al", "ac"):
            a, b, ka, kb = b, a, kb, ka
        if ka + kb == "ll":
            raise TypeError("tangent() needs a circle or arc; for two lines use parallel() or coincident ends.")
        keys = {"lc": ("l_id", "c_id"), "la": ("l_id", "a_id"), "cc": ("c1_id", "c2_id"),
                "aa": ("a1_id", "a2_id"), "ca": ("c_id", "a_id")}[ka + kb]
        self._add({"type": f"tangent_{ka}{kb}", keys[0]: a.id, keys[1]: b.id})

    def equal(self, *items):
        """Lines of equal length, or circles and arcs of equal radius."""
        first = items[0]
        for other in items[1:]:
            if isinstance(first, Line) and isinstance(other, Line):
                self._add({"type": "equal_length", "l1_id": first.id, "l2_id": other.id})
            elif isinstance(first, (Circle, Arc)) and isinstance(other, (Circle, Arc)):
                a, b = (first, other) if not (isinstance(first, Arc) and isinstance(other, Circle)) else (other, first)
                kind = {(Circle, Circle): "cc", (Circle, Arc): "ca", (Arc, Arc): "aa"}[(type(a), type(b))]
                keys = {"cc": ("c1_id", "c2_id"), "ca": ("c1_id", "a2_id"), "aa": ("a1_id", "a2_id")}[kind]
                self._add({"type": f"equal_radius_{kind}", keys[0]: a.id, keys[1]: b.id})
            else:
                raise TypeError("equal() takes lines, or circles and arcs.")

    def fix(self, *points):
        """Points fixed where they are now."""
        for pt in points:
            pt = _p(pt)
            self._add({"type": "coordinate_x", "p_id": pt.id, "x": pt.x}, {"type": "coordinate_y", "p_id": pt.id, "y": pt.y})

    def on(self, point, target):
        """A point on a line (its infinite extension), a circle or an arc."""
        key = {Line: ("point_on_line_pl", "l_id"), Circle: ("point_on_circle", "c_id"), Arc: ("point_on_arc", "a_id")}
        if type(target) not in key:
            raise TypeError("on() takes a line, circle or arc.")
        kind, k = key[type(target)]
        self._add({"type": kind, "p_id": _p(point).id, k: target.id})

    def midpoint(self, point, line):
        """A point in the middle of a line."""
        line = _l(line)
        self._add({"type": "p2p_symmetric_ppp", "p1_id": line.start.id, "p2_id": line.end.id, "p_id": _p(point).id})

    def symmetric(self, a, b, about):
        """Two points symmetric about a line or a point."""
        if isinstance(about, Line):
            self._add({"type": "p2p_symmetric_ppl", "p1_id": _p(a).id, "p2_id": _p(b).id, "l_id": about.id})
        else:
            self._add({"type": "p2p_symmetric_ppp", "p1_id": _p(a).id, "p2_id": _p(b).id, "p_id": _p(about).id})

    # Dimensions: any expression

    def distance(self, a, b, d):
        """Distance between two points, or between a point and a line."""
        d = _number(d, "distance")
        if isinstance(a, Line) or isinstance(b, Line):
            pt, line = (b, a) if isinstance(a, Line) else (a, b)
            self._add({"type": "p2l_distance", "p_id": _p(pt).id, "l_id": line.id, "distance": d})
        else:
            self._add({"type": "p2p_distance", "p1_id": _p(a).id, "p2_id": _p(b).id, "distance": d})

    def hdistance(self, a, b, d):
        """Horizontal distance from point a to point b (b.x - a.x, signed)."""
        self._difference(a, b, "x", _number(d, "hdistance"))

    def vdistance(self, a, b, d):
        """Vertical distance from point a to point b (b.y - a.y, signed)."""
        self._difference(a, b, "y", _number(d, "vdistance"))

    def length(self, line, d):
        """Length of a line."""
        line = _l(line)
        self._add({"type": "p2p_distance", "p1_id": line.start.id, "p2_id": line.end.id, "distance": _number(d, "length")})

    def radius(self, item, r):
        """Radius of a circle or arc."""
        self._add({"type": _round_kind(item, "radius"), _round_key(item): item.id, "radius": _number(r, "radius")})

    def diameter(self, item, d):
        """Diameter of a circle or arc."""
        self._add({"type": _round_kind(item, "diameter"), _round_key(item): item.id, "diameter": _number(d, "diameter")})

    def angle(self, a, b, degrees):
        """Angle from line a to line b, counter-clockwise, in degrees."""
        self._add({"type": "l2l_angle_ll", "l1_id": _l(a).id, "l2_id": _l(b).id, "angle": math.radians(_number(degrees, "angle"))})

    # Internals

    def _point(self, p):
        if isinstance(p, Point):
            return p
        x, y = _pair(p)
        return Point(self, x, y)

    def _axis(self):
        if self._axes is None:
            o = self.origin
            self._axes = (Line(self, o, Point(self, 1, 0, fixed=True), True), Line(self, o, Point(self, 0, 1, fixed=True), True))
        return self._axes

    def _each_line_or_pair(self, items, kind):
        if len(items) == 2 and all(isinstance(i, Point) for i in items):
            self._add({"type": f"{kind}_pp", "p1_id": items[0].id, "p2_id": items[1].id})
            return
        for item in items:
            self._add({"type": f"{kind}_l", "l_id": _l(item).id})

    def _difference(self, a, b, prop, d):
        self._add({"type": "difference", "param1": {"o_id": _p(a).id, "prop": prop},
                   "param2": {"o_id": _p(b).id, "prop": prop}, "difference": d})

    def _add(self, *primitives):
        line, text = _caller()
        for p in primitives:
            p["id"] = f"k{len(self._constraints)}"
            self._constraints.append((p, line, text))

    def _primitives(self):
        return [p for e in self._entities for p in e._primitives()] + [c[0] for c in self._constraints]

    def _build(self, strict=True):
        """Solve and add the regions. CAAD's sketch editor builds with strict=False: problems are kept in
        `conflicting` (constraint ids) and `problem` instead of raised, and no regions are made."""
        from build123d import BuildSketch
        sketch = BuildSketch._get_context(log=False)
        if sketch is not None:
            sketch._caad_sketch = self  # for points(sketch)
        self.conflicting, self.problem = [], None
        result = _solver()(self._primitives())
        info = {"line": self._line, "dof": None, "solver": None, "message": None}
        solves.append(info)
        if result is None:  # no solver: the stored geometry, checked against the constraints
            bad = [c for c in self._constraints if _residual(c[0], self._by_id()) > TOLERANCE]
            if bad:
                info["message"] = "Built from the stored geometry, which doesn't satisfy " + _describe(bad) + \
                    ". Open the part in CAAD (or install planegcs) to solve the sketch."
                warnings.warn(info["message"], stacklevel=3)
        else:
            info["solver"] = "planegcs"
            texts = {c[0]["id"]: c for c in self._constraints}
            conflicting = [texts[i] for i in result["conflicting"] if i in texts]
            if conflicting:
                self.conflicting = [c[0]["id"] for c in conflicting]
                self.problem = "Conflicting constraints: " + _describe(conflicting) + "."
            elif result["status"] not in (0, 1):
                self.problem = ("The sketch's constraints can't be solved from its stored geometry; "
                                "check the dimensions (a size of 0 or a length that can't be reached?).")
            if self.problem:
                if strict:
                    raise ValueError(self.problem)
                return
            self._apply(result["primitives"])
            self.dof = info["dof"] = result["dof"]
            redundant = [texts[i] for i in result["redundant"] if i in texts]
            if redundant:
                info["message"] = "Redundant constraints (already implied by others): " + _describe(redundant) + "."
        if not strict:
            return
        self.faces = _regions([e._edge() for e in self._entities if not e.construction and hasattr(e, "_edge")])
        if self.faces is not None:
            from build123d import BuildSketch, add
            if BuildSketch._get_context(log=False) is not None:
                add(self.faces)

    def _by_id(self):
        return {e.id: e for e in self._entities}

    def _apply(self, primitives):
        entities = self._by_id()
        for p in primitives:
            e = entities.get(p["id"])
            if isinstance(e, Point):
                e.x, e.y = p["x"], p["y"]
            elif isinstance(e, Circle):
                e.r = p["radius"]


def points(sketch, reverse=False, far=None):
    """Where the points drawn in a constrained sketch (with c.point) are, as locations turned like the sketch:
    `with Locations(*points(sk1)): Hole(radius=2.5)` makes a hole at each point. A hole starts at its location and
    drills against the sketch plane's normal: into the face the sketch is on.

    reverse: drill the other way (along the normal) — for a sketch on a plane under the part, or between two extrudes.
    far: the part (its builder, e.g. `far=plate`): start each hole where its line leaves the part on the far side and
         drill back toward the sketch, so a counterbore or countersink is on that face."""
    from build123d import Axis, Location, Plane
    c = getattr(sketch, "_caad_sketch", None)
    if c is None:
        raise TypeError(f"points() takes a sketch with a Constrained block (`with BuildSketch(...) as sk1:`), not {sketch!r}.")
    placed = [e for e in c._entities if isinstance(e, Point) and e.placed]
    if not placed:
        raise ValueError("The sketch has no points to use: draw them with c.point(x, y) (the point tool).")
    locations = [pl * Location((p.x, p.y)) for pl in sketch.output_placements for p in placed]
    if reverse:  # turned over: the hole's -Z (its drilling direction) flips
        locations = [loc * Location((0, 0, 0), (180, 0, 0)) for loc in locations]
    if far is None:
        return locations
    shape = getattr(far, "part", far)
    out = []
    for loc in locations:
        plane = Plane(loc)
        drill = -plane.z_dir
        ahead = [pt for pt, _ in shape.find_intersection_points(Axis(plane.origin, drill)) if (pt - plane.origin).dot(drill) > 1e-6]
        if not ahead:
            raise ValueError(f"A hole at ({plane.origin.X:g}, {plane.origin.Y:g}, {plane.origin.Z:g}) doesn't go through the part, "
                             "so it has no far side: drill the other way, or leave out far=.")
        exit_ = max(ahead, key=lambda pt: (pt - plane.origin).dot(drill))
        out.append(Location(Plane(origin=exit_, x_dir=plane.x_dir, z_dir=drill)))  # drills back (its -Z) toward the sketch
    return out


def axis(sketch, line):
    """The 3D axis along a line of a constrained sketch, from its start to its end:
    `revolve(sk1.sketch, axis=axis(sk1, line1))` turns the sketch about that line. Draw the line as a
    construction line (it is then no edge of the profile); it may be in another sketch than the profile."""
    from build123d import Axis, Location
    c = getattr(sketch, "_caad_sketch", None)
    if c is None:
        raise TypeError(f"axis() takes a sketch with a Constrained block (`with BuildSketch(...) as sk1:`), not {sketch!r}.")
    if not isinstance(line, Line) or not any(e is line for e in c._entities):
        raise TypeError(f"axis() takes a line of that sketch (such as line1 or rect1.left), not {line!r}.")
    pl = sketch.output_placements[0]
    a, b = ((pl * Location((p.x, p.y))).position for p in (line.start, line.end))
    if (b - a).length < TOLERANCE:
        raise ValueError("The axis line has no length.")
    return Axis(a, b - a)


# --- Solving ------------------------------------------------------------------------------------

def _solver():
    """PlaneGCS: the CAAD page's WebAssembly (module `caad_gcs`), else None (build the stored geometry)."""
    try:
        import caad_gcs  # registered by the CAAD page's kernel
    except ImportError:
        return lambda primitives: None
    return lambda primitives: json.loads(caad_gcs.solve(json.dumps(primitives)))


def _residual(c, entities):
    """How far the stored geometry is from satisfying constraint `c` (mm, or radians for angles)."""
    e = lambda key: entities[c[key]]  # noqa: E731
    t = c["type"]
    if t == "p2p_coincident":
        return math.dist(_xy(e("p1_id")), _xy(e("p2_id")))
    if t in ("horizontal_l", "vertical_l"):
        line = e("l_id")
        a, b = line.start, line.end
        return abs(a.y - b.y) if t == "horizontal_l" else abs(a.x - b.x)
    if t in ("horizontal_pp", "vertical_pp"):
        a, b = e("p1_id"), e("p2_id")
        return abs(a.y - b.y) if t == "horizontal_pp" else abs(a.x - b.x)
    if t in ("parallel", "perpendicular_ll", "l2l_angle_ll"):
        d1, d2 = _direction(e("l1_id")), _direction(e("l2_id"))
        cross, dot = d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]
        if t == "parallel":
            return abs(cross)
        if t == "perpendicular_ll":
            return abs(dot)
        diff = math.atan2(cross, dot) - c["angle"]
        return abs(math.atan2(math.sin(diff), math.cos(diff)))
    if t == "coordinate_x":
        return abs(e("p_id").x - c["x"])
    if t == "coordinate_y":
        return abs(e("p_id").y - c["y"])
    if t == "point_on_line_pl":
        return _point_line(e("p_id"), e("l_id"))
    if t in ("point_on_circle", "point_on_arc"):
        target = e("c_id") if t == "point_on_circle" else e("a_id")
        return abs(math.dist(_xy(e("p_id")), _xy(target.center)) - target.r)
    if t == "p2p_symmetric_ppp":
        a, b, m = e("p1_id"), e("p2_id"), e("p_id")
        return math.dist(((a.x + b.x) / 2, (a.y + b.y) / 2), _xy(m))
    if t == "p2p_symmetric_ppl":
        a, b, line = e("p1_id"), e("p2_id"), e("l_id")
        mid = Point.__new__(Point)
        mid.x, mid.y = (a.x + b.x) / 2, (a.y + b.y) / 2
        d = _direction(line)
        return _point_line(mid, line) + abs((b.x - a.x) * d[0] + (b.y - a.y) * d[1])
    if t == "p2p_distance":
        return abs(math.dist(_xy(e("p1_id")), _xy(e("p2_id"))) - c["distance"])
    if t == "p2l_distance":
        return abs(_point_line(e("p_id"), e("l_id")) - c["distance"])
    if t == "difference":
        p1, p2 = entities[c["param1"]["o_id"]], entities[c["param2"]["o_id"]]
        prop = c["param1"]["prop"]
        return abs(getattr(p2, prop) - getattr(p1, prop) - c["difference"])
    if t in ("circle_radius", "arc_radius"):
        return abs(e("c_id" if t == "circle_radius" else "a_id").r - c["radius"])
    if t in ("circle_diameter", "arc_diameter"):
        return abs(2 * e("c_id" if t == "circle_diameter" else "a_id").r - c["diameter"])
    if t == "equal_length":
        return abs(e("l1_id").length - e("l2_id").length)
    if t.startswith("equal_radius_"):
        keys = [k for k in c if k.endswith("_id") and k != "id"]
        return abs(entities[c[keys[0]]].r - entities[c[keys[1]]].r)
    if t == "tangent_lc" or t == "tangent_la":
        round_ = e("c_id") if t == "tangent_lc" else e("a_id")
        return abs(_point_line(round_.center, e("l_id")) - round_.r)
    if t.startswith("tangent_"):
        keys = [k for k in c if k.endswith("_id") and k != "id"]
        a, b = entities[c[keys[0]]], entities[c[keys[1]]]
        d = math.dist(_xy(a.center), _xy(b.center))
        return min(abs(d - (a.r + b.r)), abs(d - abs(a.r - b.r)))
    return 0.0


# --- Regions -----------------------------------------------------------------------------------

def _regions(edges):
    """Faces from the closed loops: loops inside loops alternate between material and hole; loops
    that cross are merged. All face up (+Z), so the sketch extrudes along its plane's normal."""
    edges = _prune(edges)
    if not edges:
        return None
    from build123d import Face, Wire
    faces = [Face(w) for w in Wire.combine(edges) if w.is_closed]
    faces = [-f if f.normal_at().Z < 0 else f for f in faces]
    if not faces:
        return None

    def inside(small, big):
        if small is big or big.area <= small.area:
            return False
        rest = small.cut(big)
        return rest.area < 1e-6 * small.area if rest is not None else True

    depth = [sum(inside(f, g) for g in faces) for f in faces]
    result = None
    for d in sorted(set(depth)):
        for f, fd in zip(faces, depth):
            if fd == d:
                result = f if result is None else (result.fuse(f) if d % 2 == 0 else result.cut(f))
    return result.clean() if result is not None else None


def _prune(edges):
    """Edges without the ones that have a free end (repeatedly): those can't be part of a loop, and a line
    hanging off a corner would otherwise keep that loop from closing."""
    key = lambda v: (round(v.X, 6), round(v.Y, 6))  # noqa: E731
    while True:
        ends = [None if e.is_closed else (key(e.position_at(0)), key(e.position_at(1))) for e in edges]
        count = {}
        for end in filter(None, ends):
            for k in end:
                count[k] = count.get(k, 0) + 1
        keep = [e for e, end in zip(edges, ends) if end is None or (count[end[0]] > 1 and count[end[1]] > 1)]
        if len(keep) == len(edges):
            return keep
        edges = keep


# --- Helpers -----------------------------------------------------------------------------------

def _number(v, what):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise TypeError(f"{what} must be a number, not {v!r}.")
    return float(v)


def _pair(p):
    try:
        x, y = p
        return _number(x, "x"), _number(y, "y")
    except (TypeError, ValueError):
        raise TypeError(f"Expected a point or an (x, y) pair, not {p!r}.") from None


def _p(p):
    if not isinstance(p, Point):
        raise TypeError(f"Expected a point, not {p!r}.")
    return p


def _l(line):
    if not isinstance(line, Line):
        raise TypeError(f"Expected a line, not {line!r}.")
    return line


def _round_kind(item, what):
    if isinstance(item, Circle):
        return f"circle_{what}"
    if isinstance(item, Arc):
        return f"arc_{what}"
    raise TypeError(f"{what}() takes a circle or an arc.")


def _round_key(item):
    return "c_id" if isinstance(item, Circle) else "a_id"


def _xy(p):
    return (p.x, p.y)


def _direction(line):
    dx, dy = line.end.x - line.start.x, line.end.y - line.start.y
    n = math.hypot(dx, dy) or 1.0
    return dx / n, dy / n


def _point_line(p, line):
    d = _direction(line)
    return abs((p.x - line.start.x) * d[1] - (p.y - line.start.y) * d[0])


def _caller():
    """(line, source text) of the call in the user's file that led here."""
    import linecache
    f = sys._getframe(1)
    while f is not None and f.f_code.co_filename == __file__:
        f = f.f_back
    if f is None:
        return None, ""
    return f.f_lineno, linecache.getline(f.f_code.co_filename, f.f_lineno).strip()


def _describe(constraints):
    seen, out = set(), []
    for _, line, text in constraints:
        if (line, text) not in seen:
            seen.add((line, text))
            out.append(f"line {line}: {text}" if text else f"line {line}")
    return ", ".join(out)
