"""CAAD kernel: runs inside Pyodide next to build123d.

Turns a part file into a timeline, runs it up to a feature (rollback), maps errors to the
failing feature, and tessellates the result per face and edge for the 3D view.
"""

import ast
import time
import traceback

from build123d import BuildPart, GeomType, Part
from OCP.BRepAdaptor import BRepAdaptor_Curve
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
    """Timeline of a part file: list of features with line ranges, plus the part's name."""
    tree = ast.parse(src, filename)
    block, name = _find_part_block(tree)
    if block is None:
        last = max((n.end_lineno for n in tree.body), default=1)
        return {"part": None, "block_line": None,
                "features": [{"index": 0, "line": 1, "end": last, "label": "Custom code", "kind": "code"}]}
    feats = [{"index": i, "line": s.lineno, "end": s.end_lineno, "label": _label(s, src), "kind": _kind(s)}
             for i, s in enumerate(block.body)]
    return {"part": name, "block_line": block.lineno, "features": feats}


# --- Running ---------------------------------------------------------------------------------

def _truncate(src, filename, upto):
    """AST of the file with the part block cut after feature `upto` (inclusive)."""
    tree = ast.parse(src, filename)
    block, _ = _find_part_block(tree)
    if block is not None and upto is not None and upto < len(block.body) - 1:
        block.body = block.body[: upto + 1]
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
    last = n - 1 if upto is None else min(upto, n - 1)
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
            "times": {"build": round(t1 - t0, 3), "mesh": round(t2 - t1, 3)}}


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
