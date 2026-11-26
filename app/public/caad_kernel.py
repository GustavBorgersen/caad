"""CAAD kernel: runs inside Pyodide next to build123d.

Turns a part file into a timeline, runs it up to a feature (rollback), maps errors to the
failing feature, and tessellates the result per face and edge for the 3D view.
"""

import ast
import enum
import inspect
import math
import sys
import time
import traceback

from build123d import Axis, BuildPart, BuildSketch, CenterOf, GeomType, Part
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRep import BRep_Tool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.GCPnts import GCPnts_TangentialDeflection
from OCP.TopAbs import TopAbs_REVERSED
from OCP.TopLoc import TopLoc_Location

MAX_LABEL = 48
_SKETCH_SHAPES = ("rectangle", "polygon", "circle", "arc", "line", "polyline", "point")  # caad.Constrained


# --- Timeline -------------------------------------------------------------------------------

def _call_name(node):
    """Name of a call like `extrude(...)`, `BuildSketch(...)` or `Plane.XY.offset(...)`."""
    if isinstance(node, ast.Call):
        f = node.func
        if isinstance(f, ast.Name):
            return f.id
        if isinstance(f, ast.Attribute):
            return f.attr
    return None


def _is_buildpart(item):
    return _call_name(item.context_expr) == "BuildPart"


def _find_part_block(tree):
    for node in tree.body:
        if isinstance(node, ast.With) and any(_is_buildpart(i) for i in node.items):
            item = next(i for i in node.items if _is_buildpart(i))
            name = item.optional_vars.id if isinstance(item.optional_vars, ast.Name) else None
            return node, name
    return None, None


def _label(stmt, src):
    """Short, human label for a feature statement."""
    if isinstance(stmt, ast.With):
        names = [_call_name(i.context_expr) or "with" for i in stmt.items]
        kind = names[0]
        nice = {"BuildSketch": "Sketch", "BuildLine": "Line", "Locations": "Locations",
                "GridLocations": "Grid", "PolarLocations": "Polar"}.get(kind, kind)
        if any(isinstance(n, ast.With) and _call_name(n.items[0].context_expr) == "Constrained" for n in ast.walk(stmt)):
            shapes = [_call_name(n) for n in ast.walk(stmt) if isinstance(n, ast.Call) and _call_name(n) in _SKETCH_SHAPES]
            return f"{nice}: {', '.join(dict.fromkeys(shapes))}" if shapes else nice
        inner = [_call_name(n.value) for n in ast.walk(stmt) if isinstance(n, ast.Expr)]
        detail = ", ".join(dict.fromkeys(n for n in inner if n))
        return f"{nice}: {detail}" if detail else nice
    if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
        seg = ast.get_source_segment(src, stmt.value) or _call_name(stmt.value) or "call"
    else:
        seg = ast.get_source_segment(src, stmt) or type(stmt).__name__
    seg = " ".join(seg.split())
    return seg if len(seg) <= MAX_LABEL else seg[: MAX_LABEL - 1] + "…"


def _kind(stmt):
    if isinstance(stmt, ast.With):
        return {"BuildSketch": "sketch", "BuildLine": "sketch"}.get(_call_name(stmt.items[0].context_expr), "group")
    if isinstance(stmt, ast.Expr):
        return (_call_name(stmt.value) or "code").lower()
    return "code"


def analyze(src, filename="part.py"):
    """Timeline of a part file: features with line ranges, kind, tier, name and references."""
    tree = ast.parse(src, filename)
    block, name = _find_part_block(tree)
    if block is None:
        last = max((n.end_lineno for n in tree.body), default=1)
        return {"part": None, "block_line": None,
                "features": [{"index": 0, "line": 1, "end": last, "label": "Custom code", "kind": "code",
                              "tier": "code", "name": None, "refs": []}]}
    feats, names, pending = [], set(), []
    for i, s in enumerate(block.body):
        f = {"index": i, "line": s.lineno, "end": s.end_lineno, "label": _label(s, src), "kind": _kind(s),
             "tier": "code", "name": None,
             "refs": sorted({n.id for n in ast.walk(s) if isinstance(n, ast.Name) and n.id in names})}
        info = _feature_info(s, src)
        if info:
            f.update(tier=info["tier"], name=info.get("name"))
            if info.get("kind"):
                f["kind"] = info["kind"]
            if info.get("implicit"):  # adds its faces to the builder's pending faces
                f["implicit"] = True
                pending.append(info.get("name") or f"sketch {i}")
            if info.get("constrained"):  # opens in the sketch editor; plain sketches are converted first
                f["constrained"] = True
                f["points"] = info["points"]  # drawn points: where points(sketch) puts holes
            if info.get("uses_pending"):  # an extrude/revolve without a sketch takes all pending ones
                f["pending"], pending = pending, []
            if info.get("label"):
                f["label"] = info["label"](f.get("pending", []))
        if f["name"]:
            names.add(f["name"])
        feats.append(f)
    return {"part": name, "block_line": block.lineno, "features": feats}


# --- Features: code read back as editable features (docs/05-feature-model.md) ---------------

def _choices(*pairs):
    return [{"expr": e, "label": l} for e, l in pairs]


_MODES = _choices((None, "Add"), ("Mode.SUBTRACT", "Remove"), ("Mode.INTERSECT", "Intersect"))
_ALL_MODES = _MODES + _choices(("Mode.REPLACE", "Replace"), ("Mode.PRIVATE", "Private"))


def _num(expr):
    """An expression for a label: plain numbers get a unit."""
    try:
        float(expr)
        return f"{expr} mm"
    except (TypeError, ValueError):
        return expr


def _extrude_label(a, pending):
    verb = {"Mode.SUBTRACT": "Cut", "Mode.INTERSECT": "Intersect"}.get(a.get("mode"), "Extrude")
    sketch = (a.get("to_extrude") or "").removesuffix(".sketch") or ", ".join(pending)
    depth = {"Until.LAST": "through all", "Until.NEXT": "up to next"}.get(a.get("until")) or _num(a.get("amount"))
    return ", ".join(x for x in [f"{verb} {sketch}".strip(), depth, "symmetric" if a.get("both") == "True" else None] if x)


# Feature types: tailored dialogs for known build123d calls. Arguments not listed here still show,
# as plain expressions, when they are in the code.
FEATURE_TYPES = {
    "extrude": {
        "fields": [
            {"name": "to_extrude", "label": "Sketch", "type": "sketch"},
            {"name": "until", "label": "End", "type": "choice",
             "options": _choices((None, "Depth"), ("Until.LAST", "Through all"), ("Until.NEXT", "Up to next"))},
            {"name": "amount", "label": "Depth", "type": "number", "show_if": {"until": None}},
            {"name": "both", "label": "Symmetric", "type": "bool"},
            # A sketch on a face has its normal pointing out of the part: cutting into it needs the opposite.
            {"name": "dir", "label": "Opposite direction", "type": "flip", "of": "to_extrude",
             "template": "-{}.faces()[0].normal_at()"},
            {"name": "taper", "label": "Taper angle", "type": "number"},
            {"name": "mode", "label": "Result", "type": "choice", "options": _MODES},
        ],
        "sketch_arg": "to_extrude",
        "label": _extrude_label,
    },
    "revolve": {
        "fields": [
            {"name": "profiles", "label": "Sketch", "type": "sketch"},
            {"name": "axis", "label": "Axis", "type": "choice",
             "options": _choices(("Axis.Z", "Z"), ("Axis.X", "X"), ("Axis.Y", "Y"))},
            {"name": "revolution_arc", "label": "Angle", "type": "number"},
            {"name": "mode", "label": "Result", "type": "choice", "options": _MODES},
        ],
        "sketch_arg": "profiles",
        "label": lambda a, p: ", ".join(x for x in [f"Revolve {(a.get('profiles') or '').removesuffix('.sketch') or ', '.join(p)}".strip(),
                                                    f"{a.get('revolution_arc') or 360}°"] if x),
    },
    "mirror": {
        "fields": [
            {"name": "about", "label": "About", "type": "choice",
             "options": _choices(("Plane.XZ", "XZ (front)"), ("Plane.YZ", "YZ (right)"), ("Plane.XY", "XY (top)"))},
            {"name": "mode", "label": "Result", "type": "choice", "options": _MODES},
        ],
        "label": lambda a, p: f"Mirror about {(a.get('about') or 'Plane.XZ').removeprefix('Plane.')}",
    },
    # `with Locations(...): Hole(...)`: "kind" (the class) and "locations" aren't call arguments (see _patch_hole)
    "hole": {
        "fields": [
            {"name": "kind", "label": "Type", "type": "choice", "pseudo": True,
             "options": _choices(("Hole", "Simple"), ("CounterBoreHole", "Counterbore"), ("CounterSinkHole", "Countersink"))},
            {"name": "locations", "label": "At", "type": "choice", "pseudo": True},  # options: the sketches with points
            {"name": "reverse", "label": "Drill the other way", "type": "bool", "pseudo": True},   # points(sk, reverse=True)
            {"name": "far", "label": "Start at the far side", "type": "bool", "pseudo": True},     # points(sk, far=<part>)
            {"name": "radius", "label": "Radius", "type": "number"},
            {"name": "counter_bore_radius", "label": "Counterbore radius", "type": "number", "show_if": {"kind": "CounterBoreHole"}},
            {"name": "counter_bore_depth", "label": "Counterbore depth", "type": "number", "show_if": {"kind": "CounterBoreHole"}},
            {"name": "counter_sink_radius", "label": "Countersink radius", "type": "number", "show_if": {"kind": "CounterSinkHole"}},
            {"name": "counter_sink_angle", "label": "Countersink angle", "type": "number", "show_if": {"kind": "CounterSinkHole"}},
            {"name": "depth", "label": "Depth", "type": "number", "placeholder": "through all"},
        ],
        "label": lambda a, p: f"{ {'CounterBoreHole': 'Counterbore hole', 'CounterSinkHole': 'Countersink hole'}.get(a.get('kind'), 'Hole')}"
                              f" r = {_num(a.get('radius'))}" + (f", depth {_num(a['depth'])}" if a.get("depth") else "")
                              + (f" at {a['at'][len('*points('):-1]}" if (a.get("at") or "").startswith("*points(") else ""),
    },
    "fillet": {
        "fields": [
            {"name": "objects", "label": "Edges", "type": "edges"},
            {"name": "radius", "label": "Radius", "type": "number"},
        ],
        "label": lambda a, p: f"Fillet r = {_num(a.get('radius'))}",
    },
    "chamfer": {
        "fields": [
            {"name": "objects", "label": "Edges", "type": "edges"},
            {"name": "length", "label": "Distance", "type": "number"},
            {"name": "length2", "label": "Second distance", "type": "number"},
            {"name": "angle", "label": "Angle", "type": "number"},
        ],
        "label": lambda a, p: f"Chamfer {_num(a.get('length'))}",
    },
}


def _signature(name):
    """Signature of a build123d function, or of a class's constructor; None if it isn't one."""
    import build123d
    obj = getattr(build123d, name, None)
    if not callable(obj):
        return None
    try:
        if inspect.isclass(obj):
            return inspect.Signature(list(inspect.signature(obj.__init__).parameters.values())[1:])
        return inspect.signature(obj)
    except (TypeError, ValueError):
        return None


def _bind(call, sig):
    """Map a call's arguments to parameter names: {name: (value node, whole node, is keyword)}.
    None if the call can't be edited argument by argument (*args, **kwargs, wrong arguments)."""
    if any(isinstance(a, ast.Starred) for a in call.args) or any(k.arg is None for k in call.keywords):
        return None
    try:
        bound = sig.bind_partial(*range(len(call.args)), **{k.arg: k for k in call.keywords})
    except TypeError:
        return None
    out = {}
    for name, v in bound.arguments.items():
        if sig.parameters[name].kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            return None
        out[name] = (call.args[v], call.args[v], False) if isinstance(v, int) else (v.value, v, True)
    return out


_HOLES = ("Hole", "CounterBoreHole", "CounterSinkHole")


def _hole_parts(stmt):
    """(Locations call, hole call) of a `with Locations(...): Hole(...)` statement, else None."""
    if not (isinstance(stmt, ast.With) and len(stmt.items) == 1 and len(stmt.body) == 1 and not stmt.items[0].optional_vars):
        return None
    loc, inner = stmt.items[0].context_expr, stmt.body[0]
    if not (isinstance(loc, ast.Call) and isinstance(loc.func, ast.Name) and loc.func.id == "Locations" and loc.args and not loc.keywords):
        return None
    if isinstance(inner, ast.Expr) and isinstance(inner.value, ast.Call) and isinstance(inner.value.func, ast.Name) and inner.value.func.id in _HOLES:
        return loc, inner.value
    return None


def _call_of(stmt):
    """The build123d call a statement consists of (a hole's call, for a hole), with its signature and bound arguments."""
    hole = _hole_parts(stmt)
    if hole:
        call = hole[1]
    elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call) and isinstance(stmt.value.func, ast.Name):
        call = stmt.value
    else:
        return None
    sig = _signature(call.func.id)
    args = _bind(call, sig) if sig else None
    return None if args is None else (call, sig, args)


def _is_none(node):
    return node is None or (isinstance(node, ast.Constant) and node.value is None)


def _feature_info(stmt, src):
    """Tier, name and label of a feature statement, or None for plain code."""
    hole = _hole_parts(stmt)
    if isinstance(stmt, ast.With) and not hole:
        item = stmt.items[0]
        if _call_name(item.context_expr) != "BuildSketch":
            return None
        mode = next((k.value for k in item.context_expr.keywords if k.arg == "mode"), None)
        private = isinstance(mode, ast.Attribute) and mode.attr == "PRIVATE"
        name = item.optional_vars.id if isinstance(item.optional_vars, ast.Name) else None
        blocks = [n for n in stmt.body if isinstance(n, ast.With) and _call_name(n.items[0].context_expr) == "Constrained"]
        placed = sum(1 for b in blocks for n in ast.walk(b) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                     and n.func.attr == "point" and isinstance(n.func.value, ast.Name))
        return {"tier": "code", "name": name, "implicit": not private, "constrained": bool(blocks), "points": placed}
    found = _call_of(stmt)
    if not found:
        return None
    call, sig, args = found
    ftype = FEATURE_TYPES.get("hole" if hole else call.func.id)
    if not ftype:
        return {"tier": "call"}
    exprs = {n: ast.get_source_segment(src, v[0]) for n, v in args.items()}
    info = {"tier": "type", "label": lambda pending: ftype["label"](exprs, pending)}
    if hole:
        exprs["kind"] = call.func.id
        t = _Text(src)
        exprs["at"] = src[t.start(hole[0].args[0]):t.end(hole[0].args[-1])]
        info["kind"] = "hole"
    if "sketch_arg" in ftype and _is_none(args.get(ftype["sketch_arg"], (None,))[0]):
        info["uses_pending"] = True
    return info


def _feature_stmt(src, index):
    block, _ = _find_part_block(ast.parse(src))
    if block is None or not 0 <= index < len(block.body):
        raise ValueError(f"There is no feature {index}.")
    return block.body[index]


def _default_expr(value):
    """A parameter default as code, for simple values; None for no default or complex ones."""
    if value is inspect.Parameter.empty or value is None:
        return None
    if isinstance(value, enum.Enum):
        return f"{type(value).__name__}.{value.name}"
    if isinstance(value, (bool, int, float, str)):
        return repr(value)
    return None


def _fields(name, sig, kind=None):
    """Dialog fields for a call: the feature type's fields (`kind` when it isn't the call's name, as for holes),
    or generic ones from the signature."""
    ftype = FEATURE_TYPES.get(kind or name)
    fields = [dict(f) for f in ftype["fields"]] if ftype else []
    listed = {f["name"] for f in fields}
    for p in sig.parameters.values():
        if p.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue
        if p.name not in listed:
            generic = ({"type": "choice", "options": _ALL_MODES} if p.name == "mode"
                       else {"type": "bool"} if isinstance(p.default, bool) else {"type": "expr"})
            fields.append({"name": p.name, "label": p.name.replace("_", " ").capitalize(), "extra": bool(ftype),
                           **generic})
    for f in fields:
        if f.get("pseudo"):
            f["required"], f["default"] = True, None
            continue
        p = sig.parameters.get(f["name"]) or next(
            (s.parameters[f["name"]] for s in map(_signature, _HOLES) if s and f["name"] in s.parameters), None)
        f["required"] = p is not None and p.default is inspect.Parameter.empty and f["name"] in sig.parameters
        f["default"] = _default_expr(p.default) if p is not None else None
    return fields


def _describe_value(v):
    """Short text for an evaluated parameter, shown next to its expression."""
    from build123d import Shape, ShapeList
    if isinstance(v, bool) or v is None:
        return repr(v)
    if isinstance(v, (int, float)):
        return f"{round(v, 4):g}"
    if isinstance(v, enum.Enum):
        return v.name
    if isinstance(v, ShapeList):
        kinds = {type(x).__name__.lower() for x in v}
        what = kinds.pop() if len(kinds) == 1 else "shape"
        return f"{len(v)} {what}{'' if len(v) == 1 else 's'}"
    if isinstance(v, Shape):
        return f"{type(v).__name__} ({len(v.faces())} faces)" if v.faces() else type(v).__name__
    text = repr(v)
    return text if len(text) <= 60 else text[:59] + "…"


def _evaluate(expr, env):
    try:
        return {"value": _describe_value(eval(expr, env)), "error": None}
    except Exception as e:  # noqa: BLE001 - shown in the dialog
        return {"value": None, "error": f"{type(e).__name__}: {e}"}


def read_feature(src, index):
    """A feature with its parameters as expressions, and their values in the latest run (the page
    rolls back to just before the feature first, so values are what the feature sees)."""
    stmt = _feature_stmt(src, index)
    feats = analyze(src)["features"]
    feat = feats[index]
    out = {"index": index, "kind": feat["kind"], "tier": feat["tier"], "label": feat["label"],
           "name": feat["name"], "pending": feat.get("pending", []),
           # named private sketches before this feature: what a sketch field can refer to
           "sketches": [f["name"] for f in feats[:index] if f["kind"] == "sketch" and f["name"] and not f.get("implicit")]}
    found = _call_of(stmt)
    if feat["tier"] == "code" or not found:
        return out
    call, sig, args = found
    hole = _hole_parts(stmt)
    # The model before the feature, kept for feature_values: previews of the edit replace the latest run.
    env = globals()["_edit_env"] = _env()
    out["call"] = call.func.id
    out["fields"] = _fields(call.func.id, sig, "hole" if hole else None)
    for f in out["fields"]:
        if f["name"] == "kind" and hole:
            f.update(expr=call.func.id, value=None, error=None)
            continue
        if f["name"] in ("reverse", "far") and hole:
            at = _hole_points(hole[0])
            f.update(expr=("True" if at and at[f["name"]] else None), value=None, error=None, required=False)
            continue
        if f["name"] == "locations" and hole:
            t = _Text(src)
            at = _hole_points(hole[0])
            f.update(expr=f"*points({at['sketch']})" if at else src[t.start(hole[0].args[0]):t.end(hole[0].args[-1])], value=None, error=None,
                     options=[{"expr": f"*points({g['name']})", "label": f"{g['name']} ({g['points']} point{'' if g['points'] == 1 else 's'})"}
                              for g in feats[:index] if g["kind"] == "sketch" and g["name"] and g.get("points")])
            continue
        arg = args.get(f["name"])
        f["expr"] = ast.get_source_segment(src, arg[0]) if arg else None
        f.update(_evaluate(f["expr"], env) if f["expr"] is not None else {"value": None, "error": None})
    if hole and not _hole_points(hole[0]):  # explicit positions: nothing to turn around
        out["fields"] = [f for f in out["fields"] if f["name"] not in ("reverse", "far")]
    return out


def feature_values(exprs):
    """Values of edited expressions {name: expr}, in the model the last read_feature saw."""
    env = globals().get("_edit_env") or _env()
    return {name: _evaluate(expr, env) for name, expr in dict(exprs).items() if isinstance(expr, str) and expr.strip()}


class _Text:
    """Source text with ast positions (line, UTF-8 byte column) turned into string offsets."""

    def __init__(self, src):
        self.src = src
        self.lines = src.splitlines(keepends=True)
        self.starts = [0]
        for line in self.lines:
            self.starts.append(self.starts[-1] + len(line))

    def at(self, line, col):
        return self.starts[line - 1] + len(self.lines[line - 1].encode()[:col].decode(errors="ignore"))

    def start(self, node):
        return self.at(node.lineno, node.col_offset)

    def end(self, node):
        return self.at(node.end_lineno, node.end_col_offset)

    def own_lines(self, node):
        """(start, end) of the whole lines `node` is alone on (apart from a comma and a comment), else None."""
        before = self.src[self.starts[node.lineno - 1]:self.start(node)]
        after = self.src[self.end(node):self.starts[node.end_lineno]].strip()
        rest = after[1:].strip() if after.startswith(",") else after
        if before.strip() or (rest and not rest.startswith("#")):
            return None
        return self.starts[node.lineno - 1], self.starts[node.end_lineno]


def _parses(code):
    try:
        ast.parse(code, mode="eval")
        return True
    except SyntaxError:
        return False


def _is_default(expr, default):
    """Does the expression equal the parameter's default? (Evaluated with build123d names only.)"""
    import build123d
    if default is inspect.Parameter.empty:
        return False
    try:
        return eval(expr, vars(build123d).copy()) == default
    except Exception:  # noqa: BLE001 - uses the part's names, so it can't be a default
        return False


def _hole_points(loc):
    """{"sketch", "reverse", "far"} of a hole at `Locations(*points(sk, reverse=…, far=…))`, else None."""
    if len(loc.args) != 1 or not isinstance(loc.args[0], ast.Starred):
        return None
    call = loc.args[0].value
    if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "points"
            and len(call.args) == 1 and isinstance(call.args[0], ast.Name)):
        return None
    kw = {k.arg: k.value for k in call.keywords}
    reverse = kw.get("reverse")
    return {"sketch": call.args[0].id, "reverse": isinstance(reverse, ast.Constant) and reverse.value is True,
            "far": ast.unparse(kw["far"]) if "far" in kw else None}


def _points_call(sketch, reverse, far):
    return f"*points({sketch}" + (", reverse=True" if reverse else "") + (f", far={far}" if far else "") + ")"


def _patch_hole(src, stmt, name, expr):
    """A hole's "locations" (the Locations arguments) or "kind" (switching the class rewrites just the hole call,
    keeping the arguments the new class takes and giving the ones it needs a start from the radius)."""
    loc, call = _hole_parts(stmt)
    t = _Text(src)
    span = (t.start(loc.args[0]), t.end(loc.args[-1]))
    if name in ("reverse", "far"):  # a flag of points(): rewrite the call
        at = _hole_points(loc)
        if at is None:
            raise ValueError("Only holes at a sketch's points can drill the other way or start at the far side.")
        at[name] = bool(expr and expr != "False")
        if name == "far":
            at["far"] = _find_part_block(ast.parse(src))[1] if at["far"] else None
        return src[:span[0]] + _points_call(at["sketch"], at["reverse"], at["far"]) + src[span[1]:]
    if not expr:
        raise ValueError(f"The hole's {'position' if name == 'locations' else 'type'} is required.")
    if name == "locations":
        at, new = _hole_points(loc), ast.parse(f"f({expr})", mode="eval").body if _parses(f"f({expr})") else None
        if at and new is not None and len(new.args) == 1 and isinstance(new.args[0], ast.Starred):  # another sketch: keep the flags
            target = _hole_points(ast.parse(f"Locations({expr})", mode="eval").body)
            if target:
                return src[:span[0]] + _points_call(target["sketch"], at["reverse"], at["far"]) + src[span[1]:]
        try:
            ast.parse(f"f({expr})", mode="eval")
        except SyntaxError as e:
            raise ValueError(f"At: {e.msg} in {expr!r}") from None
        return src[:t.start(loc.args[0])] + expr + src[t.end(loc.args[-1]):]
    if expr not in _HOLES:
        raise ValueError(f"Unknown hole type {expr!r}.")
    if expr == call.func.id:
        return src
    old = _call_of(stmt)[2]
    exprs = {n: ast.get_source_segment(src, v[0]) for n, v in old.items()}
    try:
        r = float(eval(exprs.get("radius", "1"), globals().get("_edit_env") or _env()))
    except Exception:  # noqa: BLE001 - only a starting value
        r = 1.0
    starts = {"counter_bore_radius": _fmt(2 * r), "counter_bore_depth": _fmt(r), "counter_sink_radius": _fmt(2 * r)}
    sig = _signature(expr)
    keep = {n: e for n, e in exprs.items() if n in sig.parameters}
    for n, p in sig.parameters.items():
        if p.default is inspect.Parameter.empty and n not in keep:
            keep[n] = starts.get(n, "1")
    order = [f["name"] for f in FEATURE_TYPES["hole"]["fields"]] + list(sig.parameters)
    text = f"{expr}(" + ", ".join(f"{n}={keep[n]}" for n in dict.fromkeys(order) if n in keep) + ")"
    return src[:t.start(call)] + text + src[t.end(call):]


def _patch_one(src, index, name, expr):
    """Source with one argument of feature `index` changed, added or removed (expr None)."""
    stmt = _feature_stmt(src, index)
    if _hole_parts(stmt) and name in ("kind", "locations", "reverse", "far"):
        return _patch_hole(src, stmt, name, expr)
    call, sig, args = _call_of(stmt)
    if expr is None and name not in sig.parameters and _hole_parts(stmt):
        return src  # a field of another hole type, hidden in the dialog
    if name not in sig.parameters:
        raise ValueError(f"{call.func.id}() has no argument '{name}'.")
    param = sig.parameters[name]
    if expr is not None:
        expr = expr.strip()
        try:
            ast.parse(expr, mode="eval")
        except SyntaxError as e:
            raise ValueError(f"{name}: {e.msg} in {expr!r}") from None
        if _is_default(expr, param.default):
            expr = None
    t = _Text(src)
    arg = args.get(name)
    items = sorted([a for a in call.args] + list(call.keywords), key=lambda n: (n.lineno, n.col_offset))
    if expr is None:
        if not arg:
            return src
        value, whole, keyword = arg
        later_positional = [a for a in call.args if t.start(a) > t.start(whole)]
        if later_positional:  # removing it would shift the others: write the default instead
            d = _default_expr(param.default) if param.default is not None else "None"
            if d is None:
                raise ValueError(f"'{name}' can't be removed here; give it a value.")
            return src[:t.start(value)] + d + src[t.end(value):]
        if param.default is inspect.Parameter.empty:
            raise ValueError(f"'{name}' is required.")
        i = items.index(whole)
        span = t.own_lines(whole)
        if span and len(items) > 1:
            a, b = span
        elif i > 0:
            a, b = t.end(items[i - 1]), t.end(whole)
        elif len(items) > 1:
            a, b = t.start(whole), t.start(items[1])
        else:
            a, b = t.start(whole), t.end(whole)
        return src[:a] + src[b:]
    if arg:
        value = arg[0]
        return src[:t.start(value)] + expr + src[t.end(value):]
    new = f"{name}={expr}"
    if not items:
        at = src.index("(", t.end(call.func)) + 1
        return src[:at] + new + src[at:]
    last = items[-1]
    end = t.end(last)
    if t.own_lines(last) and last.lineno > call.lineno:  # one argument per line: add a line
        indent = t.lines[last.lineno - 1][: len(t.lines[last.lineno - 1]) - len(t.lines[last.lineno - 1].lstrip())]
        line_end = t.starts[last.end_lineno] - 1  # before the newline
        has_comma = src[end:line_end].lstrip().startswith(",")
        head = src[:end] + ("" if has_comma else ",") + src[end:line_end]
        return head + f"\n{indent}{new}{',' if has_comma else ''}" + src[line_end:]
    return src[:end] + f", {new}" + src[end:]


def patch_feature(src, index, kind, changes):
    """Source with feature `index`'s arguments changed: {name: expression, or None to remove}.
    Only the changed arguments' text is touched. Refuses if the feature is no longer of `kind`."""
    before = analyze(src)["features"]
    if index >= len(before) or before[index]["kind"] != kind or before[index]["tier"] == "code":
        raise ValueError("The file changed: this feature isn't there any more. Close the dialog and try again.")
    out = src
    changes = dict(changes)
    for name in sorted(changes, key=lambda n: n != "kind"):  # a hole's type first: the other fields follow it
        expr = changes[name]
        expr = expr if isinstance(expr, str) else None  # JS null arrives as JsNull

        out = _patch_one(out, index, name, expr)
    try:
        after = analyze(out)["features"]
    except SyntaxError as e:
        raise ValueError(f"The change would break the code ({e.msg}); nothing was written.") from None
    if len(after) != len(before) or after[index]["kind"] != kind:
        raise ValueError("The change would alter other features; nothing was written.")
    return out


def _free_sketch_name(src):
    used = {n.id for n in ast.walk(ast.parse(src)) if isinstance(n, ast.Name)}
    return next(f"sk{i}" for i in range(1, 10000) if f"sk{i}" not in used)


def _create(kind, params):
    """Canonical code for a new call feature: the sketch or edges positional, the rest as keywords
    in the order of the dialog's fields; arguments at their defaults are left out."""
    sig = _signature(kind)
    if sig is None:
        raise ValueError(f"Unknown feature type '{kind}'.")
    fields = _fields(kind, sig)
    params = {k: v for k, v in dict(params).items() if isinstance(v, str) and v.strip()}
    for name in params:
        if name not in sig.parameters:
            raise ValueError(f"{kind}() has no argument '{name}'.")
    first = fields[0]["name"] if fields and fields[0]["type"] in ("sketch", "edges", "faces") else None
    args = [params[first]] if first in params else []
    for f in fields:
        v = params.get(f["name"])
        if f["name"] != first and v is not None and not _is_default(v, sig.parameters[f["name"]].default):
            args.append(f"{f['name']}={v}")
    return [f"{kind}({', '.join(args)})"]


def _ensure_import(src, module, name):
    """Source with `from module import name`: added to the file's `from module import …` line if it has one,
    else as a new line after the file's first imports."""
    tree = ast.parse(src)
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and n.module == module and any(a.name in (name, "*") for a in n.names):
            return src
    line = next((n for n in tree.body if isinstance(n, ast.ImportFrom) and n.module == module and n.lineno == n.end_lineno), None)
    if line is not None:
        t = _Text(src)
        names = ", ".join([ast.get_source_segment(src, a) for a in line.names] + [name])
        return src[:t.start(line)] + f"from {module} import {names}" + src[t.end(line):]
    imports = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]
    lines = src.splitlines(True)
    at = imports[-1].end_lineno if imports else 0
    if at and not lines[at - 1].endswith("\n"):
        lines[at - 1] += "\n"
    lines.insert(at, f"from {module} import {name}\n")
    return "".join(lines)


def _drills_away(src, after, sketch, filename="part.py"):
    """Would a hole at the sketch's first point drill away from the part (so it should drill the other way)?
    Checked against the part as it is at `after`: is the material on the drilling side or the other one?"""
    try:
        import caad
        from build123d import Plane
        ns = {"__name__": "__caad__", "__file__": filename}
        upto = None if after is None else after
        exec(compile(_truncate(src, filename, upto), filename, "exec"), ns)
        part = ns[_find_part_block(ast.parse(src))[1]].part
        plane = Plane(caad.points(ns[sketch])[0])
        step = 0.01
        into = part.is_inside(plane.origin - plane.z_dir * step)
        other = part.is_inside(plane.origin + plane.z_dir * step)
        return other and not into
    except Exception:  # noqa: BLE001 - only a default: keep the plain direction
        return False


def insert_feature(src, after, kind, params):
    """Source with a new feature after feature `after` (None: at the end, -1: first), in canonical form.
    A sketch gets the next free name `skN`; params are {"plane": expr, "body": [lines]} for a sketch,
    else the call's arguments as expressions. Returns {src, index, name}."""
    tree = ast.parse(src)
    block, _ = _find_part_block(tree)
    if block is None:
        raise ValueError("This file has no `with BuildPart()` block to add to.")
    params = dict(params)
    after = after if isinstance(after, int) else None  # JS null arrives as JsNull
    name = None
    if kind == "sketch" and any("Constrained()" in line for line in params.get("body") or []):
        src = _ensure_import(src, "caad", "Constrained")
        tree = ast.parse(src)
        block, _ = _find_part_block(tree)
    if kind == "sketch":
        name = _free_sketch_name(src)
        body = list(params.get("body") or ["pass"])
        lines = [f"with BuildSketch({params.get('plane') or 'Plane.XY'}, mode=Mode.PRIVATE) as {name}:"]
        lines += ["    " + line for line in body]
    elif kind == "hole":
        cls, at = params.pop("kind", None) or "Hole", params.pop("locations", None)
        if not at:
            raise ValueError("A hole needs a position (locations).")
        target = _hole_points(ast.parse(f"Locations({at})", mode="eval").body)
        if target and _drills_away(src, after, target["sketch"]):
            at = _points_call(target["sketch"], True, None)
        lines = [f"with Locations({at}):", "    " + _create(cls, params)[0]]
        if "points(" in at:
            src = _ensure_import(src, "caad", "points")
            tree = ast.parse(src)
            block, _ = _find_part_block(tree)
    else:
        lines = _create(kind, params)
    t = _Text(src)
    first = block.body[0]
    indent = t.lines[first.lineno - 1][:first.col_offset]
    text = "".join(indent + line + "\n" for line in lines)
    n = len(block.body)
    only_pass = n == 1 and isinstance(first, ast.Pass)
    if only_pass:
        a, b, index = t.starts[first.lineno - 1], t.starts[first.end_lineno], 0
    elif after is not None and after < 0:
        a = b = t.starts[first.lineno - 1]
        index = 0
    else:
        stmt = block.body[n - 1 if after is None else min(after, n - 1)]
        a = b = t.starts[stmt.end_lineno]
        index = (n - 1 if after is None else min(after, n - 1)) + 1
    if a == len(src) and src and not src.endswith("\n"):
        text = "\n" + text
    return {"src": src[:a] + text + src[b:], "index": index, "name": name}


def delete_feature(src, index):
    """Source without feature `index`. Refused while a later feature uses it."""
    feats = analyze(src)["features"]
    if not 0 <= index < len(feats):
        raise ValueError(f"There is no feature {index}.")
    f = feats[index]
    key = f["name"] or f"sketch {index}"
    users = [g for g in feats[index + 1:] if (f["name"] and f["name"] in g["refs"]) or key in g.get("pending", [])]
    if users:
        names = "; ".join(f"{g['index'] + 1}. {g['label']}" for g in users)
        raise ValueError(f"'{f['name'] or f['label']}' is used by {names}. Change or delete {'that' if len(users) == 1 else 'those'} first.")
    block, _ = _find_part_block(ast.parse(src))
    stmt = block.body[index]
    t = _Text(src)
    a, b = t.starts[stmt.lineno - 1], t.starts[stmt.end_lineno]
    if src[a:t.start(stmt)].strip() or src[t.end(stmt):b].split("#")[0].strip():
        raise ValueError("This feature shares its line with other code: delete it in the code.")
    if len(block.body) == 1:
        return src[:a] + t.lines[stmt.lineno - 1][:stmt.col_offset] + "pass\n" + src[b:]
    return src[:a] + src[b:]


# --- Sketch editor: constrained sketches read into a model and edited as code (docs/06-sketches.md) ---

_DIMENSIONS = ("distance", "hdistance", "vdistance", "length", "radius", "diameter", "angle")
_NAME_PREFIX = {"point": "p", "line": "line", "polyline": "line", "circle": "circle", "arc": "arc",
                "rectangle": "rect", "polygon": "poly"}


def _constrained_block(src, index):
    """(sketch statement, `with Constrained() as c` statement, c's name) of feature `index`, or a reason why
    the sketch editor can't open it."""
    stmt = _feature_stmt(src, index)
    if not (isinstance(stmt, ast.With) and _call_name(stmt.items[0].context_expr) == "BuildSketch"):
        raise ValueError("This feature isn't a sketch.")
    inner = [n for n in stmt.body if isinstance(n, ast.With) and _call_name(n.items[0].context_expr) == "Constrained"]
    if len(stmt.body) != 1 or len(inner) != 1 or not isinstance(inner[0].items[0].optional_vars, ast.Name):
        raise ValueError("Only constrained sketches (one `with Constrained() as c:` block) open in the sketch editor; "
                         "edit this one in the code.")
    return stmt, inner[0], inner[0].items[0].optional_vars.id


def sketch_open(src, index, filename="part.py"):
    """Start editing sketch `index`: keep the part's names as they are before it (parameters, the builder for a
    face the sketch is on) and return the sketch's model (see _sketch_model)."""
    stmt, _, _ = _constrained_block(src, index)
    ns = {"__name__": "__caad__", "__file__": filename}
    exec(compile(_truncate(src, filename, index - 1), filename, "exec"), ns)
    globals()["_sketch_session"] = {"env": ns, "filename": filename}
    model = _sketch_model(src, index)
    model["plane"] = ast.get_source_segment(src, stmt.items[0].context_expr.args[0]) if stmt.items[0].context_expr.args else "Plane.XY"
    model["name"] = stmt.items[0].optional_vars.id if isinstance(stmt.items[0].optional_vars, ast.Name) else None
    # the part's numeric parameters, offered when typing a dimension
    model["params"] = [{"name": n.targets[0].id, "value": ns[n.targets[0].id]} for n in ast.parse(src).body
                       if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name)
                       and isinstance(ns.get(n.targets[0].id), (int, float)) and not isinstance(ns.get(n.targets[0].id), bool)]
    return model


def _sketch_run(src, index):
    """Run the sketch's block on its own in the saved names: (block, c's name, the Constrained, error)."""
    import caad
    import linecache
    session = globals()["_sketch_session"]
    filename = session["filename"]
    linecache.cache[filename] = (len(src), None, src.splitlines(True), filename)
    _, block, cname = _constrained_block(src, index)
    env = dict(session["env"])
    sk = caad.Constrained()
    sk._line = block.lineno
    env[cname] = sk
    error = None
    try:
        exec(compile(ast.Module(body=block.body, type_ignores=[]), filename, "exec"), env)
        sk._build(strict=False)
    except Exception as e:  # noqa: BLE001 - shown in the editor
        error = {"line": _error_line(e, filename), "message": f"{type(e).__name__}: {e}"}
    return block, cname, sk, env, error


def _sketch_refs(block, cname, env, sk):
    """How the code can refer to each entity: {python id of the entity: expression}, shortest first."""
    import caad
    names = []
    for st in block.body:
        targets = st.targets if isinstance(st, ast.Assign) else []
        for t in targets:
            names += [t.id] if isinstance(t, ast.Name) else [e.id for e in getattr(t, "elts", []) if isinstance(e, ast.Name)]
    # c.origin and the axes are made when first used: only refer to them if the sketch did
    exprs = ([f"{cname}.origin"] if sk._origin is not None else []) + ([f"{cname}.x_axis", f"{cname}.y_axis"] if sk._axes else [])
    for n in names:
        exprs += [n, f"{n}.start", f"{n}.end", f"{n}.center", *[f"{n}.corners[{i}]" for i in range(4)],
                  f"{n}.bottom", f"{n}.right", f"{n}.top", f"{n}.left"]
        obj = env.get(n)
        for attr in ("lines", "points"):
            for i in range(len(getattr(obj, attr, []) or [])):
                exprs += [f"{n}.{attr}[{i}]", f"{n}.{attr}[{i}].start", f"{n}.{attr}[{i}].end"]
        if isinstance(obj, (list, tuple)):
            for i in range(len(obj)):
                exprs += [f"{n}[{i}]", f"{n}[{i}].start", f"{n}[{i}].end"]
    refs = {}
    for e in exprs:
        if f"{cname}." in e and not e.startswith(cname):
            continue
        try:
            obj = eval(e, env)
        except Exception:  # noqa: BLE001 - not every candidate exists
            continue
        if isinstance(obj, caad._Entity) and id(obj) not in refs:
            refs[id(obj)] = e
    return refs


def _involves(prim):
    """Entity ids a PlaneGCS constraint uses."""
    ids = [v for k, v in prim.items() if k.endswith("_id") and k != "id"]
    return ids + [prim[k]["o_id"] for k in ("param1", "param2") if isinstance(prim.get(k), dict)]


def _sketch_model(src, index):
    """The sketch as the editor sees it: entities (with the expression code uses for each), constraints
    (dimensions with their expressions and values), PlaneGCS primitives for solving while dragging,
    degrees of freedom, conflicts, and the block's statements."""
    import caad
    block, cname, sk, env, error = _sketch_run(src, index)
    refs = _sketch_refs(block, cname, env, sk)
    stmt_of = lambda line: next((i for i, st in enumerate(block.body) if line and st.lineno <= line <= st.end_lineno), None)  # noqa: E731
    entities = []
    for e in sk._entities:
        item = {"id": e.id, "kind": type(e).__name__.lower(), "ref": refs.get(id(e)), "stmt": stmt_of(e.line),
                "construction": e.construction}
        if isinstance(e, caad.Point):
            item.update(x=e.x, y=e.y, fixed=e.fixed)
        elif isinstance(e, caad.Line):
            item.update(p1=e.start.id, p2=e.end.id)
        elif isinstance(e, caad.Circle):
            item.update(c=e.center.id, r=e.r)
        elif isinstance(e, caad.Arc):
            item.update(c=e.center.id, s=e.start.id, e=e.end.id, r=e.r)
        entities.append(item)
    constraints = []
    for prim, line, text in sk._constraints:
        i = stmt_of(line)
        st = block.body[i] if i is not None else None
        call = st.value if isinstance(st, ast.Expr) and isinstance(st.value, ast.Call) else None
        method = call.func.attr if call is not None and isinstance(call.func, ast.Attribute) else None
        item = {"id": prim["id"], "type": prim["type"], "method": method, "stmt": i, "text": text,
                "builtin": method is None, "involves": _involves(prim)}
        if method in _DIMENSIONS and call.args:
            value = next(prim[k] for k in ("distance", "difference", "radius", "diameter", "angle") if k in prim)
            item["dim"] = {"expr": ast.get_source_segment(src, call.args[-1]),
                           "value": math.degrees(value) if method == "angle" else value}
        constraints.append(item)
    return {"entities": entities, "constraints": constraints, "primitives": sk._primitives(),
            "dof": sk.dof, "conflicting": sk.conflicting, "problem": sk.problem, "error": error, "c": cname,
            "statements": [{"line": st.lineno, "end": st.end_lineno, "text": ast.get_source_segment(src, st)} for st in block.body]}


def _free_name(src, prefix, taken=()):
    used = {n.id for n in ast.walk(ast.parse(src)) if isinstance(n, ast.Name)} | set(taken)
    return next(f"{prefix}{i}" for i in range(1, 100000) if f"{prefix}{i}" not in used)


def _fmt(v):
    """A number for sketch code: up to 3 decimals, no trailing zeros."""
    v = round(float(v), 3) + 0.0
    return str(int(v)) if v == int(v) else f"{v:.3f}".rstrip("0")


def _point_arg(p, made):
    """An action's point: [x, y] for a new point, or an expression for an existing one ("$k" = made by action k)."""
    if isinstance(p, str):
        for k in sorted(range(len(made)), reverse=True):
            p = p.replace(f"${k}", made[k])
        return p
    x, y = p
    return f"({_fmt(x)}, {_fmt(y)})"


def _block_append(src, block, lines):
    """Source with statements added at the end of the Constrained block (replacing a lone `pass`)."""
    t = _Text(src)
    indent = t.lines[block.body[0].lineno - 1][: block.body[0].col_offset]
    text = "".join(indent + line + "\n" for line in lines)
    if len(block.body) == 1 and isinstance(block.body[0], ast.Pass):
        st = block.body[0]
        return src[: t.starts[st.lineno - 1]] + text + src[t.starts[st.end_lineno]:]
    at = t.starts[block.body[-1].end_lineno]
    if at == len(src) and not src.endswith("\n"):
        text = "\n" + text
    return src[:at] + text + src[at:]


def _literal(node):
    """The number in a literal (5, -3.5), else None."""
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        v = _literal(node.operand)
        return -v if v is not None else None
    return None


def _sketch_moves(src, index, points, circles):
    """Source with the geometry literals of the block's entity statements set to the editor's positions:
    {point id: [x, y]}, {circle id: r}. Expressions are left alone; only numbers that change are touched."""
    import caad
    block, cname, sk, env, _ = _sketch_run(src, index)
    t = _Text(src)
    made = {}  # statement index -> entities it made, in order
    for e in sk._entities:
        for i, st in enumerate(block.body):
            if e.line and st.lineno <= e.line <= st.end_lineno:
                made.setdefault(i, []).append(e)
    edits = []

    def set_num(node, value):
        if node is not None and _literal(node) is not None and _fmt(_literal(node)) != _fmt(value):
            edits.append((t.start(node), t.end(node), _fmt(value)))

    def set_pair(node, pt):
        if isinstance(node, ast.Tuple) and len(node.elts) == 2 and pt.id in points:
            x, y = points[pt.id]
            set_num(node.elts[0], x)
            set_num(node.elts[1], y)

    for i, st in enumerate(block.body):
        call = st.value if isinstance(st, (ast.Assign, ast.Expr)) else None
        if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name)
                and call.func.value.id == cname):
            continue
        kind, args, ents = call.func.attr, call.args, made.get(i, [])
        pts = [e for e in ents if isinstance(e, caad.Point)]
        if kind == "point" and len(args) == 2 and pts and pts[0].id in points:
            set_num(args[0], points[pts[0].id][0])
            set_num(args[1], points[pts[0].id][1])
        elif kind == "rectangle" and len(args) >= 2 and len(pts) >= 3:
            set_pair(args[0], pts[0])
            set_pair(args[1], pts[2])
        elif kind in ("line", "polyline", "polygon", "circle", "arc"):
            new_pts = iter(pts)  # each (x, y) argument made one new point, in order
            for a in args:
                if isinstance(a, ast.Tuple):
                    pt = next(new_pts, None)
                    if pt is not None:
                        set_pair(a, pt)
            if kind == "circle" and len(args) >= 2:
                circle = next((e for e in ents if isinstance(e, caad.Circle)), None)
                if circle is not None and circle.id in circles:
                    set_num(args[1], circles[circle.id])
    for a, b, text in sorted(edits, reverse=True):
        src = src[:a] + text + src[b:]
    return src


def _sketch_delete(src, index, entity_ids, constraint_ids):
    """Source without the given entities and constraints, and everything that depends on them."""
    model = _sketch_model(src, index)
    _, block, _ = _constrained_block(src, index)
    ents = {e["id"]: e for e in model["entities"]}
    stmts = {c["stmt"] for c in model["constraints"] if c["id"] in constraint_ids and c["stmt"] is not None}
    gone = set(entity_ids)
    while True:  # an entity's statement goes, with all it made; then whatever uses those
        stmts |= {ents[i]["stmt"] for i in gone if i in ents and ents[i]["stmt"] is not None}
        gone_now = {e["id"] for e in model["entities"] if e["stmt"] in stmts}
        gone_now |= {e["id"] for e in model["entities"] if {e.get("p1"), e.get("p2"), e.get("c"), e.get("s"), e.get("e")} & gone}
        stmts |= {c["stmt"] for c in model["constraints"] if set(c["involves"]) & gone_now and c["stmt"] is not None}
        if gone_now <= gone:
            break
        gone |= gone_now
    t = _Text(src)
    if len(stmts) == len(block.body):  # nothing left: the block keeps a `pass`
        first, last = block.body[0], block.body[-1]
        return src[: t.starts[first.lineno - 1]] + t.lines[first.lineno - 1][: first.col_offset] + "pass\n" + src[t.starts[last.end_lineno]:]
    for i in sorted(stmts, reverse=True):
        st = block.body[i]
        src = src[: t.starts[st.lineno - 1]] + src[t.starts[st.end_lineno]:]
    return src


_PLAIN_SHAPES = ("Rectangle", "Circle", "Polygon")


def sketch_convert(src, index, filename="part.py"):
    """Source with plain sketch `index` (Rectangle, Circle, Polygon, at Locations, added or subtracted) written as a
    constrained sketch, keeping its expressions: `Rectangle(width, depth)` gets lengths `width` and `depth`, positions
    become distances from the origin. Checked by building both and comparing their regions; ValueError (the reason)
    when it can't be converted. The sketch's own line stays, so an extrude that takes its pending faces still works."""
    stmt = _feature_stmt(src, index)
    if not (isinstance(stmt, ast.With) and _call_name(stmt.items[0].context_expr) == "BuildSketch"):
        raise ValueError("This feature isn't a sketch.")
    if any(isinstance(n, ast.With) and _call_name(n.items[0].context_expr) == "Constrained" for n in stmt.body):
        raise ValueError("This sketch is already constrained.")
    ns = {"__name__": "__caad__", "__file__": filename}
    exec(compile(_truncate(src, filename, index - 1), filename, "exec"), ns)
    value = lambda node: float(eval(compile(ast.Expression(node), filename, "eval"), ns))  # noqa: E731
    text = lambda node: ast.get_source_segment(src, node)  # noqa: E731
    refuse = lambda node, why="": ValueError(  # noqa: E731
        f"Can't convert line {node.lineno} (`{' '.join(text(node).split())[:60]}`){why}; only Rectangle, Circle and Polygon, "
        "optionally at Locations, convert. Edit this sketch in the code.")

    shapes = []  # (call, locations: [((x expr, y expr), (x, y))] or [None] for the origin)
    for st in stmt.body:
        if isinstance(st, ast.Expr) and isinstance(st.value, ast.Call):
            shapes.append((st.value, [None]))
        elif isinstance(st, ast.With) and len(st.items) == 1 and _call_name(st.items[0].context_expr) == "Locations":
            loc = st.items[0].context_expr
            locs = []
            for a in loc.args:
                if loc.keywords or not (isinstance(a, ast.Tuple) and len(a.elts) in (2, 3)) or (len(a.elts) == 3 and value(a.elts[2]) != 0):
                    raise refuse(st, " (locations must be (x, y) points)")
                locs.append(((text(a.elts[0]), text(a.elts[1])), (value(a.elts[0]), value(a.elts[1]))))
            for inner in st.body:
                if not (isinstance(inner, ast.Expr) and isinstance(inner.value, ast.Call)):
                    raise refuse(inner)
                shapes.append((inner.value, locs))
        else:
            raise refuse(st)

    lines, taken = [], set()
    name = lambda prefix: _free_name(src, prefix, taken)  # noqa: E731

    def place(point, loc):
        if loc is None:
            return [f"c.coincident({point}, c.origin)"]
        (xe, ye), _ = loc
        return [f"c.hdistance(c.origin, {point}, {xe})", f"c.vdistance(c.origin, {point}, {ye})"]

    for call, locs in shapes:
        kind = _call_name(call)
        if kind not in _PLAIN_SHAPES or not isinstance(call.func, ast.Name):
            raise refuse(call)
        kw = {k.arg: k.value for k in call.keywords}
        mode = kw.pop("mode", None)
        if mode is not None and not (isinstance(mode, ast.Attribute) and mode.attr in ("ADD", "SUBTRACT")):
            raise refuse(call, " (only added or subtracted shapes)")
        align = kw.pop("align", None) if kind == "Polygon" else None
        if kw or any(isinstance(a, ast.Starred) for a in call.args):
            raise refuse(call, f" ({', '.join(kw) or '*args'} isn't supported)")
        for loc in locs:
            x, y = loc[1] if loc else (0.0, 0.0)
            if kind == "Rectangle" and len(call.args) == 2:
                w, h = value(call.args[0]), value(call.args[1])
                n = name("rect")
                taken.add(n)
                lines += [f"{n} = c.rectangle(({_fmt(x - w / 2)}, {_fmt(y - h / 2)}), ({_fmt(x + w / 2)}, {_fmt(y + h / 2)}))",
                          f"c.length({n}.bottom, {text(call.args[0])})", f"c.length({n}.left, {text(call.args[1])})",
                          *place(f"{n}.center", loc)]
            elif kind == "Circle" and len(call.args) == 1:
                n = name("circle")
                taken.add(n)
                lines += [f"{n} = c.circle(({_fmt(x)}, {_fmt(y)}), {_fmt(value(call.args[0]))})",
                          f"c.radius({n}, {text(call.args[0])})", *place(f"{n}.center", loc)]
            elif kind == "Polygon" and len(call.args) >= 3:
                pts = call.args
                if not all(isinstance(p, ast.Tuple) and len(p.elts) == 2 for p in pts):
                    raise refuse(call, " (points must be (x, y) pairs)")
                # build123d 0.13 keeps a polygon's points as written by default (Align.NONE); other alignments move it
                if align is not None and ast.unparse(align) not in ("None", "Align.NONE", "(Align.NONE, Align.NONE)"):
                    raise refuse(call, " (an aligned polygon)")
                xy = [(value(p.elts[0]) + x, value(p.elts[1]) + y) for p in pts]
                n = name("poly")
                taken.add(n)
                lines += [f"{n} = c.polygon({', '.join(f'({_fmt(a)}, {_fmt(b)})' for a, b in xy)})", f"c.fix(*{n}.points)"]
            else:
                raise refuse(call, " (unexpected arguments)")

    t = _Text(src)
    first, last = stmt.body[0], stmt.body[-1]
    indent = t.lines[first.lineno - 1][: first.col_offset]
    body = indent + "with Constrained() as c:\n" + "".join(f"{indent}    {l}\n" for l in lines)
    out = src[: t.starts[first.lineno - 1]] + body + src[t.starts[last.end_lineno]:]
    out = _ensure_import(out, "caad", "Constrained")

    # Same regions? Build the sketch both ways on its own, in the part's names.
    import copy
    def regions(code, idx):
        node = copy.deepcopy(_feature_stmt(code, idx))
        node.items[0].optional_vars = ast.Name(id="__caad_sketch", ctx=ast.Store())
        import caad
        env = {**ns, "Constrained": caad.Constrained}  # the import the converted file gets
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), filename, "exec"), env)
        return env["__caad_sketch"].sketch
    before, after = regions(src, index), regions(out, index)
    diff = (before - after).area + (after - before).area
    if diff > 1e-6 * max(before.area, 1.0):
        raise ValueError("Converting would change this sketch: build123d adds and subtracts shapes in order, the "
                         "sketch editor nests them (a loop inside a loop is a hole). Edit this sketch in the code.")
    return out


def sketch_action(src, index, actions):
    """Apply editor actions to sketch `index` and return {src, model, made}. Actions, in order:
      {"op": "add", "kind": point|line|polyline|circle|arc|rectangle|polygon, "args": [...], "construction": bool}
         points are [x, y] (new) or expressions of existing ones ("p1", "rect1.corners[0]", "$0.end": made by
         action 0); a circle's radius is a number
      {"op": "constrain", "kind": method name, "refs": [expressions], "value": expression or None}
      {"op": "dimension", "constraint": id, "expr": expression}   - a dimension's new value
      {"op": "move", "points": {id: [x, y]}, "circles": {id: r}}  - geometry after dragging
      {"op": "delete", "entities": [ids], "constraints": [ids]}
    `made` lists the expression each add created (its name)."""
    made = []
    for a in actions:
        a = dict(a)
        op = a["op"]
        _, block, cname = _constrained_block(src, index)
        if op == "add":
            kind = a["kind"]
            args = list(a.get("args") or [])
            if kind == "circle":
                parts = [_point_arg(args[0], made), _fmt(args[1])]
            elif kind == "point":
                parts = [_fmt(args[0]), _fmt(args[1])]
            else:
                parts = [_point_arg(p, made) for p in args]
            if kind == "polyline" and a.get("close"):
                parts.append("close=True")
            if a.get("construction"):
                parts.append("construction=True")
            if kind == "polyline":
                n = len(args) - (0 if a.get("close") else 1)
                names = []
                for _ in range(n):
                    names.append(_free_name(src, "line", names))
                target = ", ".join(names) + ("," if n == 1 else "")
                made.append(names[0] if n == 1 else f"[{', '.join(names)}]")
            else:
                target = _free_name(src, _NAME_PREFIX[kind])
                made.append(target)
            src = _block_append(src, block, [f"{target} = {cname}.{kind}({', '.join(parts)})"])
        elif op == "constrain":
            refs = [_point_arg(r, made) for r in a.get("refs") or []]
            value = a.get("value")
            if isinstance(value, str) and value.strip():
                ast.parse(value, mode="eval")
                refs.append(value.strip())
            elif isinstance(value, (int, float)) and not isinstance(value, bool):
                refs.append(_fmt(value))
            src = _block_append(src, block, [f"{cname}.{a['kind']}({', '.join(refs)})"])
        elif op == "dimension":
            model = _sketch_model(src, index)
            c = next((c for c in model["constraints"] if c["id"] == a["constraint"] and "dim" in c), None)
            if c is None:
                raise ValueError("That dimension isn't in the sketch any more.")
            expr = a["expr"].strip()
            try:
                ast.parse(expr, mode="eval")
            except SyntaxError as e:
                raise ValueError(f"{e.msg} in {expr!r}") from None
            node = block.body[c["stmt"]].value.args[-1]
            t = _Text(src)
            src = src[: t.start(node)] + expr + src[t.end(node):]
        elif op == "move":
            src = _sketch_moves(src, index, {k: v for k, v in dict(a.get("points") or {}).items()},
                                {k: v for k, v in dict(a.get("circles") or {}).items()})
        elif op == "delete":
            src = _sketch_delete(src, index, set(a.get("entities") or []), set(a.get("constraints") or []))
        else:
            raise ValueError(f"Unknown sketch action '{op}'.")
    ast.parse(src)
    return {"src": src, "model": _sketch_model(src, index), "made": made}


# --- Running ---------------------------------------------------------------------------------

_PROJECT_DIR = "/project"  # the open part's project: its .py files, importable from its parts (docs/07)


def set_project(files):
    """The open part's project, as {path in the project: source} for its .py files: parts import shared code from
    it (`from params import wall`), with the project's folder as the import root, like `python -m`."""
    import os
    import shutil
    shutil.rmtree(_PROJECT_DIR, ignore_errors=True)
    os.makedirs(_PROJECT_DIR, exist_ok=True)
    for rel, text in dict(files).items():
        path = os.path.join(_PROJECT_DIR, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)
    if _PROJECT_DIR not in sys.path:
        sys.path.insert(0, _PROJECT_DIR)
    _forget_project_modules()


def _forget_project_modules():
    """Drop the project's modules, so the next import reads their current files."""
    import importlib
    for name, mod in list(sys.modules.items()):
        if (getattr(mod, "__file__", None) or "").startswith(_PROJECT_DIR + "/"):
            del sys.modules[name]
    importlib.invalidate_caches()


def _truncate(src, filename, upto):
    """AST of the file with the part block cut after feature `upto` (inclusive)."""
    tree = ast.parse(src, filename)
    block, _ = _find_part_block(tree)
    if block is not None and upto is not None and upto < len(block.body) - 1:
        block.body = block.body[: upto + 1] or [ast.copy_location(ast.Pass(), block.body[0])]  # upto -1: nothing
    return tree


def _last_part(ns):
    parts = [v for k, v in ns.items() if not k.startswith("_") and isinstance(v, Part)]
    return parts[-1] if parts else None


def _error_line(exc, filename):
    line = None
    for frame in traceback.extract_tb(exc.__traceback__):
        if frame.filename == filename:
            line = frame.lineno  # keep the innermost frame inside the part file
    if line is None and isinstance(exc, SyntaxError) and exc.filename == filename:
        line = exc.lineno
    return line


def run(src, filename="part.py", upto=None):
    """Run the part (up to feature `upto`), return timeline status, mesh and timing."""
    t0 = time.perf_counter()
    try:
        info = analyze(src, filename)
    except SyntaxError as e:
        return {"ok": False, "timeline": None, "mesh": None, "sketches": [],
                "error": {"feature": None, "line": e.lineno, "message": f"SyntaxError: {e.msg}"},
                "times": {"build": 0, "mesh": 0}}
    feats = info["features"]
    n = len(feats)
    last = n - 1 if upto is None else max(-1, min(upto, n - 1))
    ns = {"__name__": "__caad__", "__file__": filename}
    error = None
    import linecache
    linecache.cache[filename] = (len(src), None, src.splitlines(True), filename)  # caad quotes the user's lines
    caad = sys.modules.get("caad")
    if caad is not None:
        caad.solves.clear()
    _forget_project_modules()  # shared code may have changed
    try:
        exec(compile(_truncate(src, filename, last), filename, "exec"), ns)
    except Exception as e:  # noqa: BLE001 - any error in user code is reported, not raised
        line = _error_line(e, filename)
        fi = next((f["index"] for f in feats if line and f["line"] <= line <= f["end"]), None)
        error = {"feature": fi, "line": line, "message": f"{type(e).__name__}: {e}"}
    t1 = time.perf_counter()
    caad = sys.modules.get("caad")
    for s in caad.solves if caad is not None else []:  # constrained sketches: degrees of freedom, warnings
        f = next((f for f in feats if f["kind"] == "sketch" and f["line"] <= (s["line"] or 0) <= f["end"]), None)
        if f is not None:
            f["sketch"] = {"dof": s["dof"], "message": s["message"]}

    builder = ns.get(info["part"]) if info["part"] else None
    shape = None
    if isinstance(builder, BuildPart):
        shape = builder.part  # on error: the part as it was before the failing feature
    if shape is None:
        shape = _last_part(ns)
    for f in feats:
        if f["index"] > last:
            f["status"] = "rolled-back"
        elif error and error["feature"] is not None and f["index"] > error["feature"]:
            f["status"] = "skipped"
        elif error and f["index"] == error["feature"]:
            f["status"] = "error"
        else:
            f["status"] = "ok"
    mesh = tessellate(shape) if shape is not None and not shape.is_null else None
    t2 = time.perf_counter()
    globals()["_current"] = {"ns": ns, "shape": shape, "part": info["part"]}
    return {"ok": error is None, "timeline": info, "upto": last, "error": error, "mesh": mesh,
            "sketches": _sketch_outlines(ns, feats, last),
            "summary": _summary(shape) if mesh else None,
            "times": {"build": round(t1 - t0, 3), "mesh": round(t2 - t1, 3)}}


def export_part(src, filename, fmt):
    """The whole part (all its features, even when the view is rolled back) as a STEP or STL file:
    {"data": bytes, "summary": ...}. The view's model is left as it was."""
    from build123d import export_step, export_stl
    writers = {"step": export_step, "stl": export_stl}
    if fmt not in writers:
        raise ValueError(f"Can't export as '{fmt}': use step or stl.")
    before = globals().get("_current")
    try:
        r = run(src, filename)
        if not r["ok"]:
            raise ValueError(f"The part doesn't build, so it can't be exported: {r['error']['message']}")
        shape = globals()["_current"]["shape"]
        if shape is None:
            raise ValueError("The part has no shape to export yet.")
        path = f"/tmp/caad-export.{fmt}"
        writers[fmt](shape, path)
        with open(path, "rb") as f:
            return {"data": f.read(), "summary": r["summary"]}
    finally:
        globals()["_current"] = before


def _summary(shape):
    bb = shape.bounding_box()
    out = {"type": type(shape).__name__, "faces": len(shape.faces()), "edges": len(shape.edges()),
           "bbox": [_r(bb.min.X), _r(bb.min.Y), _r(bb.min.Z), _r(bb.max.X), _r(bb.max.Y), _r(bb.max.Z)]}
    try:
        out["volume"] = _r(shape.volume)
    except Exception:  # noqa: BLE001 - e.g. a 2D result
        pass
    return out


# --- Tessellation ----------------------------------------------------------------------------

def _edge_points(edge, tol, angular):
    """Polyline along an edge, sampled by OpenCascade (one call per edge)."""
    if edge.geom_type == GeomType.LINE:
        a, b = edge.position_at(0), edge.position_at(1)
        return [a.X, a.Y, a.Z, b.X, b.Y, b.Z]
    sampler = GCPnts_TangentialDeflection(BRepAdaptor_Curve(edge.wrapped), angular, tol)
    out = []
    for i in range(1, sampler.NbPoints() + 1):
        p = sampler.Value(i)
        out += [p.X(), p.Y(), p.Z()]
    return out


def _sketch_outlines(ns, feats, last, tol=0.05, angular=0.2):
    """Outlines of the named sketches up to feature `last` that no feature up to there uses yet,
    for the view: a private sketch adds no material, so it would be invisible otherwise."""
    out = []
    for f in feats[: last + 1]:
        name = f["name"]
        if f["kind"] != "sketch" or not name or not isinstance(ns.get(name), BuildSketch):
            continue
        if any(name in g["refs"] or name in g.get("pending", []) for g in feats[f["index"] + 1: last + 1]):
            continue
        try:
            sketch = ns[name].sketch
        except Exception:  # noqa: BLE001 - no regions (only points), or a sketch that failed half-way
            sketch = None
        placed = []
        c = getattr(ns[name], "_caad_sketch", None)
        if c is not None:
            from build123d import Location
            for p in (e for e in c._entities if getattr(e, "placed", False)):
                for pl in ns[name].output_placements:
                    v = (pl * Location((p.x, p.y))).position
                    placed += [v.X, v.Y, v.Z]
        if sketch is not None or placed:
            out.append({"name": name, "index": f["index"], "points": placed,
                        "edges": [{"points": _edge_points(e, tol, angular)} for e in sketch.edges()] if sketch is not None else []})
    return out


def tessellate(shape, tol=0.05, angular=0.2):
    """Per-face triangles and per-edge polylines, as flat lists, plus face/edge ids."""
    BRepMesh_IncrementalMesh(shape.wrapped, tol, True, angular, True)  # whole shape: faces share edge points
    positions, indices, face_ranges, face_types = [], [], [], []
    for face in shape.faces():
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face.wrapped, loc)
        start = len(indices)
        if tri is not None:
            trsf = loc.Transformation()
            base = len(positions) // 3
            for i in range(1, tri.NbNodes() + 1):  # vertices are per face: the viewer smooths per face
                p = tri.Node(i).Transformed(trsf)
                positions += [p.X(), p.Y(), p.Z()]
            flip = face.wrapped.Orientation() == TopAbs_REVERSED
            for i in range(1, tri.NbTriangles() + 1):
                a, b, c = tri.Triangle(i).Get()
                indices += [base + a - 1, base + c - 1, base + b - 1] if flip else [base + a - 1, base + b - 1, base + c - 1]
        face_ranges.append([start, len(indices) - start])
        face_types.append(face.geom_type.name)
    edges = [{"points": _edge_points(e, tol, angular), "type": e.geom_type.name} for e in shape.edges()]
    bb = shape.bounding_box()
    return {"positions": positions, "indices": indices,
            "faces": face_ranges, "face_types": face_types, "edges": edges,
            "bbox": [bb.min.X, bb.min.Y, bb.min.Z, bb.max.X, bb.max.Y, bb.max.Z]}


# --- Selection -------------------------------------------------------------------------------

def _r(v, n=3):
    return round(float(v), n)


def _vec(v):
    return [_r(v.X), _r(v.Y), _r(v.Z)]


def _face_info(face):
    info = {"type": face.geom_type.name, "area": _r(face.area), "center": _vec(face.center(CenterOf.MASS))}
    surf = BRepAdaptor_Surface(face.wrapped)
    if face.geom_type == GeomType.PLANE:
        info["normal"] = _vec(face.normal_at())
    elif face.geom_type == GeomType.CYLINDER:
        cyl = surf.Cylinder()
        d, o = cyl.Axis().Direction(), cyl.Axis().Location()
        info.update(radius=_r(cyl.Radius()), axis=[_r(d.X()), _r(d.Y()), _r(d.Z())], axis_point=[_r(o.X()), _r(o.Y()), _r(o.Z())])
    elif face.geom_type == GeomType.SPHERE:
        info["radius"] = _r(surf.Sphere().Radius())
    return info


def _edge_info(edge):
    info = {"type": edge.geom_type.name, "length": _r(edge.length),
            "start": _vec(edge.position_at(0)), "end": _vec(edge.position_at(1))}
    if edge.geom_type == GeomType.CIRCLE:
        info.update(radius=_r(edge.radius), center=_vec(edge.arc_center))
    elif edge.geom_type == GeomType.LINE:
        d = edge.tangent_at(0)
        info["direction"] = _vec(d)
    return info


def _same_set(a, b):
    return len(a) == len(b) and all(any(x.is_same(y) for y in b) for x in a)


def _env():
    import build123d
    cur = globals().get("_current") or {}
    return {**vars(build123d), **cur.get("ns", {})}


def _base_name():
    """Name to start selectors from: the BuildPart builder, or the variable holding the shown part."""
    cur = globals()["_current"]
    if cur["part"]:
        return cur["part"]
    for k, v in cur["ns"].items():
        if v is cur["shape"] and not k.startswith("_"):
            return k
    return None


def _candidates(kind, targets, objs, base):
    """Readable selector expressions that might pick exactly `targets` from `objs`."""
    coll = [(f"{base}.{kind}s()", objs)]
    types = {t.geom_type for t in targets}
    if len(types) == 1:
        gt = types.pop()
        coll.append((f"{base}.{kind}s().filter_by(GeomType.{gt.name})", objs.filter_by(gt)))
        # Lines along an axis, or flat faces facing along an axis: build123d's filter_by(Axis.*)
        if gt == GeomType.LINE or gt == GeomType.PLANE:
            direction = (lambda t: t.tangent_at(0)) if gt == GeomType.LINE else (lambda t: t.normal_at())
            for ax in ("X", "Y", "Z"):
                axis = getattr(Axis, ax)
                if all(abs(abs(direction(t).dot(axis.direction)) - 1) < 1e-6 for t in targets):
                    coll.append((f"{base}.{kind}s().filter_by(Axis.{ax})", objs.filter_by(axis)))
    keys = ["Axis.Z", "Axis.X", "Axis.Y", "SortBy.AREA" if kind == "face" else "SortBy.LENGTH"]
    if any(t.geom_type in (GeomType.CIRCLE, GeomType.CYLINDER, GeomType.SPHERE) for t in targets):
        keys.append("SortBy.RADIUS")
    env = _env()
    single = len(targets) == 1

    out = []
    for cexpr, cobjs in coll:
        if not single and _same_set(cobjs, targets):
            out.append((cexpr, False))
        for key in keys:
            try:  # some keys don't apply to every collection (e.g. radius of a plane)
                groups = cobjs.group_by(eval(key, env))
            except Exception:  # noqa: BLE001
                continue
            for i, g in enumerate(groups):
                if _same_set(g, targets):
                    if single:
                        end = 0 if i == 0 else -1 if i == len(groups) - 1 else None
                        out.append((f"{cexpr}.sort_by({key})[{end}]", False) if end is not None
                                   else (f"{cexpr}.group_by({key})[{i}][0]", True))
                    else:
                        end = 0 if i == 0 else -1 if i == len(groups) - 1 else i
                        out.append((f"{cexpr}.group_by({key})[{end}]", end not in (0, -1)))
                elif len(g) > len(targets) and all(any(t.is_same(x) for x in g) for t in targets):
                    gi = 0 if i == 0 else -1 if i == len(groups) - 1 else i
                    for key2 in keys:
                        if key2 == key:
                            continue
                        try:
                            sub = g.group_by(eval(key2, env))
                        except Exception:  # noqa: BLE001
                            continue
                        for j, h in enumerate(sub):
                            if _same_set(h, targets) and j in (0, len(sub) - 1):
                                je = 0 if j == 0 else -1
                                tail = f".sort_by({key2})[{je}]" if single else f".group_by({key2})[{je}]"
                                out.append((f"{cexpr}.group_by({key})[{gi}]{tail}", gi not in (0, -1)))
    return out


def select(kind, indices):
    """Describe the selected faces/edges and suggest verified build123d selectors for them."""
    cur = globals().get("_current")
    if not cur or cur["shape"] is None:
        return {"items": [], "selectors": []}
    objs = cur["shape"].faces() if kind == "face" else cur["shape"].edges()
    targets = [objs[i] for i in indices]
    items = [{"kind": kind, "index": i, **(_face_info(t) if kind == "face" else _edge_info(t))} for i, t in zip(indices, targets)]
    base = _base_name()
    selectors = []
    if base:
        env = _env()
        seen = set()
        for expr, fragile in _candidates(kind, targets, objs, base):
            if expr in seen:
                continue
            seen.add(expr)
            try:  # verify: the expression must give exactly the selection
                got = eval(expr, env)
            except Exception:  # noqa: BLE001
                continue
            got = got if isinstance(got, list) else [got]
            if _same_set(got, targets):
                selectors.append({"expr": expr, "fragile": fragile})
        selectors.sort(key=lambda s: (s["fragile"], len(s["expr"])))
        robust = [s for s in selectors if not s["fragile"]]
        selectors = (robust or selectors)[:3]  # show fragile ones only when nothing better exists
        if not selectors and len(indices) > 1:
            # No common selector: a list of each item's own best selector.
            singles = [select(kind, [i])["selectors"][0] for i in indices]
            selectors.append({"expr": "[" + ", ".join(x["expr"] for x in singles) + "]",
                              "fragile": any(x["fragile"] for x in singles)})
        if not selectors:
            selectors.append({"expr": f"{base}.{kind}s()[{indices[0]}]", "fragile": True})
    return {"items": items, "selectors": selectors}


def resolve(kind, expr):
    """Indices that a selector picks in the current shape (to keep a selection across rebuilds)."""
    cur = globals().get("_current")
    if not cur or cur["shape"] is None:
        return []
    try:
        got = eval(expr, _env())
    except Exception:  # noqa: BLE001
        return []
    got = got if isinstance(got, list) else [got]
    objs = cur["shape"].faces() if kind == "face" else cur["shape"].edges()
    return [i for i, o in enumerate(objs) if any(o.is_same(g) for g in got)]


# --- Agent helpers ---------------------------------------------------------------------------

def _describe(value, depth=0):
    """Short, readable description of a snippet result."""
    from build123d import Shape
    if isinstance(value, Shape):
        kind = type(value).__name__
        if kind == "Face":
            return {"shape": "Face", **_face_info(value)}
        if kind == "Edge":
            return {"shape": "Edge", **_edge_info(value)}
        d = _summary(value)
        d["shape"] = d.pop("type")
        return d
    if isinstance(value, list) and depth == 0 and value and all(isinstance(v, Shape) for v in value):
        return {"count": len(value), "items": [_describe(v, 1) for v in value[:12]],
                **({"note": f"{len(value) - 12} more not shown"} if len(value) > 12 else {})}
    text = repr(value)
    return text if len(text) <= 4000 else text[:4000] + "…"


def snippet(code):
    """Run code against the open part's namespace (a copy) without touching files or the view."""
    import contextlib
    import io
    env = _env()
    cur = globals().get("_current") or {}
    env["part"] = cur.get("shape")
    out = io.StringIO()
    value, error = None, None
    try:
        tree = ast.parse(code, "<snippet>")
        last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        with contextlib.redirect_stdout(out):
            exec(compile(tree, "<snippet>", "exec"), env)
            if last is not None:
                value = eval(compile(ast.Expression(last.value), "<snippet>", "eval"), env)
    except Exception as e:  # noqa: BLE001
        line = _error_line(e, "<snippet>")
        error = f"{type(e).__name__}: {e}" + (f" (line {line})" if line else "")
    return {"output": out.getvalue()[-8000:], "value": None if value is None else _describe(value), "error": error}


_API_CLASSES = ["Shape", "ShapeList", "Part", "Sketch", "Curve", "Solid", "Face", "Edge", "Wire", "Vertex",
                "Vector", "Plane", "Location", "Axis", "BuildPart", "BuildSketch", "BuildLine"]


def _caad_help(name):
    """api_help for CAAD's own module: constrained sketches (caad.Constrained and its methods)."""
    import caad
    parts = name.removeprefix("caad.").split(".")
    obj = caad
    for part in parts:
        obj = getattr(obj, part, None)
        if obj is None:
            return f"caad has no '{name}'. See api_help('Constrained')."
    if obj is caad.Constrained:
        methods = [f"  c.{m}{inspect.signature(f)} — {(inspect.getdoc(f) or '').splitlines()[0]}".replace("(self, ", "(").replace("(self)", "()")
                   for m, f in vars(caad.Constrained).items() if not m.startswith("_") and callable(f)]
        props = [f"  c.{m} — {inspect.getdoc(f)}" for m, f in vars(caad.Constrained).items() if isinstance(f, property)]
        return "\n\n".join([f"caad.Constrained (from caad import Constrained)", inspect.getdoc(caad),
                             "Methods:\n" + "\n".join(methods), "References:\n" + "\n".join(props)])
    sig = str(inspect.signature(obj)).replace("(self, ", "(").replace("(self)", "()") if callable(obj) else ""
    return f"caad.{name.removeprefix('caad.')}{sig}\n\n{inspect.getdoc(obj) or ''}"


def api_help(name):
    """Signature and docs of a build123d name, from the build123d the page runs (and CAAD's caad module)."""
    import inspect
    import build123d
    name = name.strip().removeprefix("build123d.")
    if name.split(".")[0] in ("Constrained", "caad"):
        return _caad_help(name)
    obj = build123d
    try:
        for part in name.split("."):
            obj = getattr(obj, part)
    except AttributeError:
        obj = None
    if obj is not None and obj is not build123d:
        out = [f"build123d {build123d.__version__}: {name}"]
        try:
            sig = inspect.signature(obj)
            if inspect.isclass(obj) and "*args" in str(sig):  # build123d wraps classes: read __init__
                init = inspect.signature(obj.__init__)
                sig = init.replace(parameters=[p for n, p in init.parameters.items() if n != "self"])
            out.append(f"{name}{sig}")
        except (TypeError, ValueError):
            pass
        doc = inspect.getdoc(obj) or "(no docstring)"
        out.append(doc[:6000] + ("…" if len(doc) > 6000 else ""))
        if inspect.isclass(obj):
            if issubclass(obj, __import__("enum").Enum):
                out.append("Members: " + ", ".join(m.name for m in obj))
            else:
                members = sorted(m for m in dir(obj) if not m.startswith("_"))
                out.append("Members: " + ", ".join(members)[:3000])
        return "\n\n".join(out)
    q = name.lower().split(".")[-1]
    hits = [n for n in dir(build123d) if not n.startswith("_") and q in n.lower()]
    for cls in _API_CLASSES:
        c = getattr(build123d, cls, None)
        hits += [f"{cls}.{m}" for m in dir(c) if not m.startswith("_") and q in m.lower()] if c else []
    if not hits:
        return f"No build123d name matches '{name}'."
    lines = []
    for h in hits[:40]:
        o = build123d
        for part in h.split("."):
            o = getattr(o, part, None)
        first = (inspect.getdoc(o) or "").split("\n")[0][:100] if o is not None else ""
        lines.append(f"- {h}: {first}")
    more = f"\n({len(hits) - 40} more)" if len(hits) > 40 else ""
    return f"'{name}' is not an exact name. Matches:\n" + "\n".join(lines) + more


def highlight_indices(expr):
    """Face and edge indices that a selector expression picks in the shown shape."""
    from build123d import Edge, Face
    cur = globals().get("_current")
    if not cur or cur["shape"] is None:
        return {"error": "No part is shown."}
    try:
        got = eval(expr, _env())
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}
    got = got if isinstance(got, list) else [got]
    faces = [f for f in got if isinstance(f, Face)]
    edges = [e for e in got if isinstance(e, Edge)]
    if len(faces) + len(edges) < len(got):
        others = {type(g).__name__ for g in got if not isinstance(g, (Face, Edge))}
        return {"error": f"The selector returned {', '.join(sorted(others))}; select faces or edges."}
    shape = cur["shape"]
    return {"faces": [i for i, f in enumerate(shape.faces()) if any(f.is_same(g) for g in faces)],
            "edges": [i for i, e in enumerate(shape.edges()) if any(e.is_same(g) for g in edges)]}


# --- Sketching ---------------------------------------------------------------------------------

def sketch_plane(expr):
    """The plane a sketch on `expr` (a Plane or a planar face) uses: origin and axes, as BuildSketch places it."""
    from build123d import Face, Plane
    try:
        obj = eval(expr, _env())
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}
    if isinstance(obj, list):
        if len(obj) != 1:
            return {"error": f"The selector returned {len(obj)} faces; select one flat face."}
        obj = obj[0]
    if isinstance(obj, Face) and obj.geom_type != GeomType.PLANE:
        return {"error": "Sketches need a flat face."}
    try:
        plane = obj if isinstance(obj, Plane) else Plane(obj)
    except Exception as e:  # noqa: BLE001
        return {"error": f"Can't sketch on that: {e}"}
    v = lambda d: [round(d.X, 9), round(d.Y, 9), round(d.Z, 9)]  # noqa: E731
    return {"origin": v(plane.origin), "x": v(plane.x_dir), "y": v(plane.y_dir), "z": v(plane.z_dir)}
