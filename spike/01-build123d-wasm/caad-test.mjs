// Test constrained sketches (app/public/caad.py, docs/06-sketches.md) in the page's kernel, in Node:
// solving with PlaneGCS, dimensions as expressions, conflicts, regions, the fallback without a solver.
import { bootKernel, caller } from "./kernel-env.mjs";

const py = await bootKernel();
const { call, tryCall } = caller(py);
let failures = 0;
const check = (ok, what, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}${!ok && detail ? `\n      ${detail}` : ""}`); if (!ok) failures++; };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;
const pyval = (expr) => { const r = py.runPython(expr); return r?.toJs ? r.toJs({ dict_converter: Object.fromEntries }) : r; };

/** A part file with a constrained sketch (the body lines go inside `with Constrained() as c:`), extruded 5. */
const part = (body, { params = "width = 60\ndepth = 40\nhole_d = 10", plane = "Plane.XY" } = {}) => `from build123d import *
from caad import Constrained

${params}

with BuildPart() as p:
    with BuildSketch(${plane}, mode=Mode.PRIVATE) as sk1:
        with Constrained() as c:
${body.trim().split("\n").map((l) => "            " + l.trim()).join("\n")}
    extrude(sk1.sketch, amount=5)
`;
const doc06 = `
r = c.rectangle((0, 0), (60, 40))
h = c.circle((18.333, 16.997), 5)
c.fix(r.corners[0])
c.length(r.bottom, width)
c.length(r.left, depth)
c.radius(h, hole_d / 2)
c.distance(r.corners[0], h.center, 25)
c.distance(r.corners[1], h.center, 45)`;

// --- Solving: the design doc's example ---
let src = part(doc06);
let r = call("run", src, "part.py");
check(r.ok, "the design doc's example builds", JSON.stringify(r.error));
check(near(r.summary.volume, (2400 - Math.PI * 25) * 5, 0.01), `a plate with a hole (volume ${r.summary.volume})`);
check(near(pyval("_current['ns']['h'].center.x"), 18.333333) && near(pyval("_current['ns']['h'].center.y"), 16.996732), "the hole's centre is where PlaneGCS puts it (as in spike 2)");
let sk = r.timeline.features[0];
check(sk.label === "Sketch: rectangle, circle" && sk.sketch?.dof === 0 && !sk.sketch.message, `fully constrained, labelled by its shapes ("${sk.label}", dof ${sk.sketch?.dof})`);
check(r.sketches.length === 0, "a used sketch draws no outline");

r = call("run", src.replace("width = 60", "width = 65"), "part.py"); // the hole is 25 and 45 from the corners: at most 70 apart
check(r.ok && near(r.summary.bbox[3] - r.summary.bbox[0], 65), `dimensions are expressions: width = 65 re-solves the sketch`, r.error?.message ?? r.summary?.bbox);
r = call("run", src.replace("width = 60", "width = 80"), "part.py");
check(!r.ok && /can't be solved/.test(r.error.message), "an impossible dimension (corners 80 apart, hole 25 and 45 from them) is an error", r.error?.message);

r = call("run", src.replace("            c.fix(r.corners[0])\n", ""), "part.py");
check(r.ok && r.timeline.features[0].sketch.dof === 2, `without the fixed corner, 2 degrees of freedom are left (${r.timeline.features[0].sketch.dof})`);

// --- Conflicts and mistakes: errors at the sketch, naming the lines ---
r = call("run", part(doc06 + "\nc.length(r.bottom, 70)"), "part.py");
check(!r.ok && r.error.feature === 0 && /Conflicting constraints: .*line 1[0-9]: c\.length\(r\.bottom, width\).*line 1[0-9]: c\.length\(r\.bottom, 70\)/.test(r.error.message),
  "conflicting dimensions: an error at the sketch naming both", r.error?.message);
r = call("run", part(doc06 + "\nc.length(h, 3)"), "part.py");
check(!r.ok && /Expected a line/.test(r.error.message) && r.error.line === 19, `a wrong argument: TypeError at its line (${r.error?.line}: ${r.error?.message})`);
r = call("run", part(doc06 + "\nc.radius(h, depth > 3)"), "part.py");
check(!r.ok && /must be a number/.test(r.error.message), "a dimension that isn't a number");

// --- Positions: signed horizontal and vertical distances from the origin ---
r = call("run", part(`
r = c.rectangle((0, 0), (10, 10))
c.length(r.bottom, 10)
c.length(r.left, 10)
c.hdistance(c.origin, r.center, -15)
c.vdistance(c.origin, r.center, 20)`), "part.py");
check(r.ok && near(r.summary.bbox[0], -20) && near(r.summary.bbox[3], -10) && near(r.summary.bbox[1], 15) && near(r.summary.bbox[4], 25) && r.timeline.features[0].sketch.dof === 0,
  `hdistance/vdistance are signed: centre at (-15, 20) (bbox ${r.summary?.bbox?.slice(0, 2)})`);

// --- Regions: nested loops alternate, crossing loops merge, everything faces up ---
const vol = (body) => { const x = call("run", part(body), "part.py"); return x.ok ? x.summary.volume : `error: ${x.error?.message}`; };
check(near(vol("c.rectangle((0, 0), (60, 40))\nc.circle((30, 20), 10)\nc.circle((30, 20), 4)"), (2400 - Math.PI * 100 + Math.PI * 16) * 5, 0.01), "a hole with an island in it");
check(near(vol("c.rectangle((0, 0), (20, 10))\nc.rectangle((10, 5), (30, 15))"), (200 + 200 - 50) * 5, 0.01), "crossing rectangles merge");
check(near(vol("c.circle((0, 0), 5)\nc.circle((30, 0), 5)"), 2 * Math.PI * 25 * 5, 0.01), "separate loops are separate regions");
check(near(vol("r = c.rectangle((0, 0), (20, 10))\nl = c.line(r.corners[2], (30, 20))\nc.line(l.end, (40, 20))"), 200 * 5, 0.01), "lines hanging off a loop don't keep it from closing");
r = call("run", part("c.polygon((0, 0), (0, 10), (10, 10), (10, 0))"), "part.py");
check(r.ok && near(r.summary.bbox[2], 0) && near(r.summary.bbox[5], 5), `a clockwise polygon still extrudes up (z ${r.summary?.bbox?.[2]}…${r.summary?.bbox?.[5]})`);
r = call("run", part("c.line((0, 0), (10, 0))\nc.circle((30, 0), 2, construction=True)"), "part.py");
check(!r.ok && r.timeline.features[0].status === "ok", "open lines and construction circles make no region (the extrude has nothing)");
const xz = call("run", part("c.rectangle((0, 0), (20, 10))", { plane: "Plane.XZ" }), "part.py");
const plain = call("run", "from build123d import *\nwith BuildPart() as p:\n    with BuildSketch(Plane.XZ, mode=Mode.PRIVATE) as s:\n        with Locations((10, 5)):\n            Rectangle(20, 10)\n    extrude(s.sketch, amount=5)\n", "part.py");
check(xz.ok && JSON.stringify(xz.summary.bbox.map((v) => +v.toFixed(3))) === JSON.stringify(plain.summary.bbox.map((v) => +v.toFixed(3))), `on Plane.XZ it lands where a plain build123d sketch does (${xz.summary?.bbox})`);

// --- Arcs and tangency: a slot ---
r = call("run", part(`
a, b, e, f = c.point(0, 0), c.point(30, 0), c.point(30, 10), c.point(0, 10)
bottom = c.line(a, b)
top = c.line(e, f)
right = c.arc((30, 5), b, e)
left = c.arc((0, 5), f, a)
c.horizontal(bottom, top)
c.tangent(bottom, right)
c.tangent(top, left)
c.fix(a)
c.length(bottom, 30)
c.radius(right, 5)
c.radius(left, 5)`), "part.py");
check(r.ok && near(r.summary.volume, (300 + Math.PI * 25) * 5, 0.01), `a slot from lines and tangent arcs (volume ${r.summary?.volume ?? r.error?.message})`);

// --- Every constraint and dimension once: PlaneGCS's solution satisfies the fallback's own check ---
r = call("run", part(`
o = c.origin
p1, p2, p3, p4 = c.point(0, 0), c.point(40, 1), c.point(41, 30), c.point(-1, 29)
l1, l2, l3, l4 = c.polyline(p1, p2, p3, p4, close=True)
k = c.circle((20, 15), 6)
k2 = c.circle((60, 15), 4)
m = c.point(20, 0)
s1, s2 = c.point(50, 40), c.point(70, 41)
c.coincident(p1, o)
c.horizontal(l1)
c.vertical(l2)
c.parallel(l1, l3)
c.perpendicular(l1, l4)
c.equal(k, k2)
c.on(m, l1)
c.midpoint(m, l1)
c.symmetric(s1, s2, c.point(60, 40))
c.horizontal(s1, s2)
c.distance(s1, s2, 20)
c.vertical(c.point(60, 40), k2.center)
c.tangent(l3, k2)
c.distance(k.center, l1, 15)
c.hdistance(o, k.center, 20)
c.length(l1, width)
c.diameter(k, 12)
c.angle(l1, l2, 90)`, { params: "width = 40" }), "part.py");
const resid = pyval(`[(c[0]["type"], caad._residual(c[0], _current['ns']['c']._by_id())) for c in _current['ns']['c']._constraints]` .replace("caad.", "__import__('caad')."));
const bad = resid.filter(([, v]) => v > 1e-6);
check(r.ok && resid.length === 18 && !bad.length, `${resid.length} constraints solved, all satisfied by the residual check`, JSON.stringify(bad) + (r.error?.message ?? ""));

// --- The kernel: inserting a constrained sketch adds the import once ---
const empty = "from build123d import *\n\nwith BuildPart() as part:\n    pass\n";
let ins = call("insert_feature", empty, null, "sketch", { plane: "Plane.XY", body: ["with Constrained() as c:", "    c.rectangle((0, 0), (10, 10))"] });
check(ins.src.startsWith("from build123d import *\nfrom caad import Constrained\n\nwith BuildPart() as part:\n    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:\n        with Constrained() as c:\n            c.rectangle((0, 0), (10, 10))\n"),
  "insert_feature adds `from caad import Constrained`", ins.src);
ins = call("insert_feature", ins.src, null, "sketch", { plane: "Plane.XZ", body: ["with Constrained() as c:", "    c.circle((0, 0), 3)"] });
check(ins.src.split("from caad import").length === 2 && ins.name === "sk2", "only once");
r = call("run", ins.src, "part.py");
check(r.ok && JSON.stringify(r.sketches.map((s) => s.name)) === '["sk1","sk2"]', "unused constrained sketches draw their outlines");

// --- Help for the agent ---
const help = call("api_help", "Constrained");
check(/c\.rectangle\(corner, opposite, construction=False\)/.test(help) && /c\.origin — /.test(help) && /Numbers in entity and shape calls are geometry/.test(help), "api_help('Constrained') lists methods and references");
check(/hdistance\(a, b, d\)[\s\S]*signed/.test(call("api_help", "Constrained.hdistance")), "api_help('Constrained.hdistance')");

// --- Outside CAAD: no solver, the stored geometry ---
py.unregisterJsModule("caad_gcs");
py.runPython("import sys; sys.modules.pop('caad_gcs', None)");
r = call("run", src, "part.py");
check(r.ok && near(r.summary.volume, (2400 - Math.PI * 25) * 5, 0.05) && !r.timeline.features[0].sketch.message && r.timeline.features[0].sketch.dof === undefined,
  "without a solver, the stored geometry builds; it satisfies the constraints: no warning");
r = call("run", src.replace("width = 60", "width = 65"), "part.py");
const msg = r.timeline.features[0].sketch?.message ?? "";
check(r.ok && near(r.summary.bbox[3] - r.summary.bbox[0], 60) && /doesn't satisfy line 1[0-9]: c\.length\(r\.bottom, width\)/.test(msg) && /install planegcs|Open the part in CAAD/.test(msg),
  `a changed parameter: built from the stored geometry, with a warning naming the constraint`, msg);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
