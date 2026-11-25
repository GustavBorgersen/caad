"""CAAD kernel: runs inside Pyodide next to build123d.

Turns a part file into a timeline, runs it up to a feature (rollback), maps errors to the
failing feature, and tessellates the result per face and edge for the 3D view.
"""

import ast
import enum
import inspect
import time
import traceback

from build123d import Axis, BuildPart, CenterOf, GeomType, Part
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRep import BRep_Tool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.GCPnts import GCPnts_TangentialDeflection
from OCP.TopAbs import TopAbs_REVERSED
from OCP.TopLoc import TopLoc_Location

MAX_LABEL = 48


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
            if info.get("implicit"):  # adds its faces to the builder's pending faces
                f["implicit"] = True
                pending.append(info.get("name") or f"sketch {i}")
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
            {"name": "taper", "label": "Taper angle", "type": "number"},
            {"name": "mode", "label": "Result", "type": "choice", "options": _MODES},
        ],
        "sketch_arg": "to_extrude",
        "label": _extrude_label,
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


def _call_of(stmt):
    """The build123d call a statement consists of, with its signature and bound arguments."""
    if not (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call) and isinstance(stmt.value.func, ast.Name)):
        return None
    call = stmt.value
    sig = _signature(call.func.id)
    args = _bind(call, sig) if sig else None
    return None if args is None else (call, sig, args)


def _is_none(node):
    return node is None or (isinstance(node, ast.Constant) and node.value is None)


def _feature_info(stmt, src):
    """Tier, name and label of a feature statement, or None for plain code."""
    if isinstance(stmt, ast.With):
        item = stmt.items[0]
        if _call_name(item.context_expr) != "BuildSketch":
            return None
        mode = next((k.value for k in item.context_expr.keywords if k.arg == "mode"), None)
        private = isinstance(mode, ast.Attribute) and mode.attr == "PRIVATE"
        name = item.optional_vars.id if isinstance(item.optional_vars, ast.Name) else None
        return {"tier": "code", "name": name, "implicit": not private}
    found = _call_of(stmt)
    if not found:
        return None
    call, sig, args = found
    ftype = FEATURE_TYPES.get(call.func.id)
    if not ftype:
        return {"tier": "call"}
    exprs = {n: ast.get_source_segment(src, v[0]) for n, v in args.items()}
    info = {"tier": "type", "label": lambda pending: ftype["label"](exprs, pending)}
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


def _fields(name, sig):
    """Dialog fields for a call: the feature type's fields, or generic ones from the signature."""
    ftype = FEATURE_TYPES.get(name)
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
        p = sig.parameters[f["name"]]
        f["required"] = p.default is inspect.Parameter.empty
        f["default"] = _default_expr(p.default)
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
    # The model before the feature, kept for feature_values: previews of the edit replace the latest run.
    env = globals()["_edit_env"] = _env()
    out["call"] = call.func.id
    out["fields"] = _fields(call.func.id, sig)
    for f in out["fields"]:
        arg = args.get(f["name"])
        f["expr"] = ast.get_source_segment(src, arg[0]) if arg else None
        f.update(_evaluate(f["expr"], env) if f["expr"] is not None else {"value": None, "error": None})
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


def _is_default(expr, default):
    """Does the expression equal the parameter's default? (Evaluated with build123d names only.)"""
    import build123d
    if default is inspect.Parameter.empty:
        return False
    try:
        return eval(expr, vars(build123d).copy()) == default
    except Exception:  # noqa: BLE001 - uses the part's names, so it can't be a default
        return False


def _patch_one(src, index, name, expr):
    """Source with one argument of feature `index` changed, added or removed (expr None)."""
    stmt = _feature_stmt(src, index)
    call, sig, args = _call_of(stmt)
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
    for name, expr in changes.items():
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
    if kind == "sketch":
        name = _free_sketch_name(src)
        body = list(params.get("body") or ["pass"])
        lines = [f"with BuildSketch({params.get('plane') or 'Plane.XY'}, mode=Mode.PRIVATE) as {name}:"]
        lines += ["    " + line for line in body]
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


# --- Running ---------------------------------------------------------------------------------

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
        return {"ok": False, "timeline": None, "mesh": None,
                "error": {"feature": None, "line": e.lineno, "message": f"SyntaxError: {e.msg}"},
                "times": {"build": 0, "mesh": 0}}
    feats = info["features"]
    n = len(feats)
    last = n - 1 if upto is None else max(-1, min(upto, n - 1))
    ns = {"__name__": "__caad__", "__file__": filename}
    error = None
    try:
        exec(compile(_truncate(src, filename, last), filename, "exec"), ns)
    except Exception as e:  # noqa: BLE001 - any error in user code is reported, not raised
        line = _error_line(e, filename)
        fi = next((f["index"] for f in feats if line and f["line"] <= line <= f["end"]), None)
        error = {"feature": fi, "line": line, "message": f"{type(e).__name__}: {e}"}
    t1 = time.perf_counter()

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
            "summary": _summary(shape) if mesh else None,
            "times": {"build": round(t1 - t0, 3), "mesh": round(t2 - t1, 3)}}


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


def api_help(name):
    """Signature and docs of a build123d name, from the build123d the page runs."""
    import inspect
    import build123d
    name = name.strip().removeprefix("build123d.")
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
