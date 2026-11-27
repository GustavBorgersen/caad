// Constrained sketches (app/public/caad.py, docs/06-sketches.md): solving with PlaneGCS, dimensions as
// expressions, conflicts, regions, points for holes, and the fallback without a solver.
import { describe, test } from "node:test";
import { call, check, near, py, pyval, solver } from "./env.mjs";

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
const src = part(doc06);

describe("constrained sketches", () => {
  test("solving: the design doc's example", () => {
    let r = call("run", src, "part.py");
    check(r.ok, "the design doc's example builds", r.error);
    check(near(r.summary.volume, (2400 - Math.PI * 25) * 5, 0.01), `a plate with a hole (volume ${r.summary.volume})`);
    check(near(pyval("_current['ns']['h'].center.x"), 18.333333) && near(pyval("_current['ns']['h'].center.y"), 16.996732), "the hole's centre is where PlaneGCS puts it (as in spike 2)");
    const sk = r.timeline.features[0];
    check(sk.label === "Sketch: rectangle, circle" && sk.sketch?.dof === 0 && !sk.sketch.message, `fully constrained, labelled by its shapes ("${sk.label}", dof ${sk.sketch?.dof})`);
    check(r.sketches.length === 0, "a used sketch draws no outline");

    r = call("run", src.replace("width = 60", "width = 65"), "part.py"); // the hole is 25 and 45 from the corners: at most 70 apart
    check(r.ok && near(r.summary.bbox[3] - r.summary.bbox[0], 65), "dimensions are expressions: width = 65 re-solves the sketch", r.error?.message ?? r.summary?.bbox);
    r = call("run", src.replace("width = 60", "width = 80"), "part.py");
    check(!r.ok && /can't be solved/.test(r.error.message), "an impossible dimension (corners 80 apart, hole 25 and 45 from them) is an error", r.error?.message);

    r = call("run", src.replace("            c.fix(r.corners[0])\n", ""), "part.py");
    check(r.ok && r.timeline.features[0].sketch.dof === 2, `without the fixed corner, 2 degrees of freedom are left (${r.timeline.features[0].sketch.dof})`);
  });

  test("conflicts and mistakes: errors at the sketch, naming the lines", () => {
    let r = call("run", part(doc06 + "\nc.length(r.bottom, 70)"), "part.py");
    check(!r.ok && r.error.feature === 0 && /Conflicting constraints: .*line 1[0-9]: c\.length\(r\.bottom, width\).*line 1[0-9]: c\.length\(r\.bottom, 70\)/.test(r.error.message),
      "conflicting dimensions: an error at the sketch naming both", r.error?.message);
    r = call("run", part(doc06 + "\nc.length(h, 3)"), "part.py");
    check(!r.ok && /Expected a line/.test(r.error.message) && r.error.line === 19, `a wrong argument: TypeError at its line (${r.error?.line}: ${r.error?.message})`);
    r = call("run", part(doc06 + "\nc.radius(h, depth > 3)"), "part.py");
    check(!r.ok && /must be a number/.test(r.error.message), "a dimension that isn't a number");
  });

  test("angles: between the lines as drawn, whichever way they were drawn", () => {
    // A V at the origin: l1 out along x, l2 drawn from its far end into the corner (its direction points away).
    const vee = (deg) => part(`
l1 = c.line((0, 0), (10, 0))
l2 = c.line((8.66, 5), (0, 0))
c.fix(l1.start, l1.end)
c.coincident(l2.end, l1.start)
c.length(l2, 10)
c.line(l1.end, l2.start)
c.angle(l1, l2, ${deg})`);
    const far = () => pyval("(_current['ns']['l2'].start.x, _current['ns']['l2'].start.y)");
    for (const [deg, x, y] of [[30, 8.660254, 5], [-30, 8.660254, 5], [45, 7.071068, 7.071068], [120, -5, 8.660254]]) {
      const r = call("run", vee(deg), "part.py");
      const [px, py_] = far();
      check(r.ok && near(px, x) && near(py_, y), `c.angle(l1, l2, ${deg}): l2 ${Math.abs(deg)}° up from l1, on its side (${px.toFixed(3)}, ${py_.toFixed(3)})`, r.error?.message);
    }
    const m = call("sketch_open", vee(-30), 0);
    check(m.constraints.find((c) => c.method === "angle")?.dim.value === 30, "the editor's value is the angle as drawn (30, not -30 or 150)");
  });

  test("positions: signed horizontal and vertical distances from the origin", () => {
    const r = call("run", part(`
r = c.rectangle((0, 0), (10, 10))
c.length(r.bottom, 10)
c.length(r.left, 10)
c.hdistance(c.origin, r.center, -15)
c.vdistance(c.origin, r.center, 20)`), "part.py");
    check(r.ok && near(r.summary.bbox[0], -20) && near(r.summary.bbox[3], -10) && near(r.summary.bbox[1], 15) && near(r.summary.bbox[4], 25) && r.timeline.features[0].sketch.dof === 0,
      `hdistance/vdistance are signed: centre at (-15, 20) (bbox ${r.summary?.bbox?.slice(0, 2)})`);
  });

  test("regions: nested loops alternate, crossing loops merge, everything faces up", () => {
    const vol = (body) => { const x = call("run", part(body), "part.py"); return x.ok ? x.summary.volume : `error: ${x.error?.message}`; };
    check(near(vol("c.rectangle((0, 0), (60, 40))\nc.circle((30, 20), 10)\nc.circle((30, 20), 4)"), (2400 - Math.PI * 100 + Math.PI * 16) * 5, 0.01), "a hole with an island in it");
    check(near(vol("c.rectangle((0, 0), (20, 10))\nc.rectangle((10, 5), (30, 15))"), (200 + 200 - 50) * 5, 0.01), "crossing rectangles merge");
    check(near(vol("c.circle((0, 0), 5)\nc.circle((30, 0), 5)"), 2 * Math.PI * 25 * 5, 0.01), "separate loops are separate regions");
    check(near(vol("r = c.rectangle((0, 0), (20, 10))\nl = c.line(r.corners[2], (30, 20))\nc.line(l.end, (40, 20))"), 200 * 5, 0.01), "lines hanging off a loop don't keep it from closing");
    let r = call("run", part("c.polygon((0, 0), (0, 10), (10, 10), (10, 0))"), "part.py");
    check(r.ok && near(r.summary.bbox[2], 0) && near(r.summary.bbox[5], 5), `a clockwise polygon still extrudes up (z ${r.summary?.bbox?.[2]}…${r.summary?.bbox?.[5]})`);
    r = call("run", part("c.line((0, 0), (10, 0))\nc.circle((30, 0), 2, construction=True)"), "part.py");
    check(!r.ok && r.timeline.features[0].status === "ok", "open lines and construction circles make no region (the extrude has nothing)");
    const xz = call("run", part("c.rectangle((0, 0), (20, 10))", { plane: "Plane.XZ" }), "part.py");
    const plain = call("run", "from build123d import *\nwith BuildPart() as p:\n    with BuildSketch(Plane.XZ, mode=Mode.PRIVATE) as s:\n        with Locations((10, 5)):\n            Rectangle(20, 10)\n    extrude(s.sketch, amount=5)\n", "part.py");
    check(xz.ok && JSON.stringify(xz.summary.bbox.map((v) => +v.toFixed(3))) === JSON.stringify(plain.summary.bbox.map((v) => +v.toFixed(3))), `on Plane.XZ it lands where a plain build123d sketch does (${xz.summary?.bbox})`);
  });

  test("regions(sketch, *at): single areas, by a point inside each", () => {
    const at = (body, pts, plane = "Plane.XY") => part(body, { plane }).replace("from caad import Constrained", "from caad import Constrained, regions")
      .replace("extrude(sk1.sketch, amount=5)", `extrude(regions(sk1, ${pts}), amount=5)`);
    const vol = (body, pts, plane) => { const x = call("run", at(body, pts, plane), "part.py"); return x.ok ? x.summary.volume : `error: ${x.error?.message}`; };
    const ring = "c.rectangle((0, 0), (60, 40))\nc.circle((30, 20), 10)";
    check(near(vol(ring, "(30, 20)"), Math.PI * 100 * 5, 0.01), "the disc inside a rectangle is a region of its own (sk1.sketch makes it a hole)");
    check(near(vol(ring, "(5, 5)"), (2400 - Math.PI * 100) * 5, 0.01), "the ring around it");
    check(near(vol(ring, "(5, 5), (30, 20), (50, 30)"), 2400 * 5, 0.01), "both (a point twice picks it once): merged into one plate");
    const split = "r = c.rectangle((0, 0), (60, 40))\nc.line((20, 0), (20, 40))\nc.line((40, 20), (50, 20))";
    check(near(vol(split, "(10, 20)"), 800 * 5, 0.01), "a line across a rectangle splits it; a line with a free end doesn't");
    check(near(vol("c.circle((0, 0), 10)\nc.circle((10, 0), 10)", "(5, 0)"), (2 * 100 * Math.acos(0.5) - 5 * Math.sqrt(300)) * 5, 0.01), "crossing circles: the lens between them");
    let r = call("run", at(ring, "(30, 20)", "Plane.XZ"), "part.py");
    check(r.ok && near(r.summary.bbox[0], 20) && near(r.summary.bbox[2], 10) && near(r.summary.bbox[1], -5) && near(r.summary.bbox[4], 0),
      `on Plane.XZ: located like sk1.sketch, extruded along the plane's normal (bbox ${r.summary?.bbox})`);
    r = call("run", at(ring, "(80, 0)"), "part.py");
    check(!r.ok && /No region of the sketch contains \(80, 0\)/.test(r.error.message) && r.error.feature === 1, "a point outside: a clear error at the extrude", r.error?.message);
    r = call("run", at(ring, "(0, 20)"), "part.py");
    check(!r.ok && /on a line/.test(r.error.message), "a point on a line picks nothing");
    check(/Choose at least one region/.test(call("run", at(ring, "").replace("regions(sk1, )", "regions(sk1)"), "part.py").error?.message ?? ""), "no points: an error");
    const plain = "from build123d import *\nfrom caad import regions\nwith BuildPart() as p:\n    with BuildSketch(mode=Mode.PRIVATE) as s:\n        Rectangle(20, 20)\n        Circle(5, mode=Mode.SUBTRACT)\n    extrude(regions(s, (0, 0)), amount=2)\n";
    r = call("run", plain, "part.py");
    check(r.ok && near(r.summary.volume, Math.PI * 25 * 2, 0.01), "a plain build123d sketch: its edges' regions (the hole is one)", r.error?.message);
  });

  test("points(sketch): where holes go", () => {
    const holes = (body, hole = "Hole(radius=2)") => `from build123d import *
from caad import Constrained, points

with BuildPart() as p:
    Box(40, 30, 10)
    with BuildSketch(p.faces().sort_by(Axis.Z)[-1], mode=Mode.PRIVATE) as sk1:
        with Constrained() as c:
${body.trim().split("\n").map((l) => "            " + l.trim()).join("\n")}
    with Locations(*points(sk1)):
        ${hole}
`;
    let r = call("run", holes("p1 = c.point(10, 5)\np2 = c.point(-10, 5)\nc.rectangle((-15, -10), (-5, -2), construction=True)"), "part.py");
    check(r.ok && near(40 * 30 * 10 - r.summary.volume, 2 * Math.PI * 4 * 10, 0.01), `two drawn points: two holes through the top (rectangle corners and centre don't count) (${r.error?.message ?? ""})`);
    r = call("run", holes("p1 = c.point(10, 5)", "Hole(radius=2, depth=3)"), "part.py");
    check(r.ok && near(40 * 30 * 10 - r.summary.volume, Math.PI * 4 * 3, 0.01), "drilled into the face the sketch is on (depth 3)");
    check(call("run", holes("p1 = c.point(10, 5)"), "part.py").timeline.features[2].refs.includes("sk1"), "the hole refers to the sketch (it shows it's used)");
    r = call("run", holes("c.rectangle((-15, -10), (-5, -2))"), "part.py");
    check(!r.ok && /no points to use/.test(r.error.message) && r.error.feature === 2, "a sketch without points: a clear error at the hole");
    r = call("run", "from build123d import *\nfrom caad import points\nwith BuildPart() as p:\n    Box(4, 4, 4)\n    with Locations(*points(p)):\n        Hole(1)\n", "part.py");
    check(!r.ok && /takes a sketch with a Constrained block/.test(r.error.message), "points() of something that isn't a constrained sketch: a clear error");
  });

  test("points(sketch): drilling direction (reverse, far)", () => {
    // A sketch on XY under a part drills away from it; reverse drills into it; far starts on the far side.
    const under = (args, hole) => `from build123d import *
from caad import Constrained, points

with BuildPart() as p:
    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:
        with Constrained() as c:
            p1 = c.point(10, 5)
    Box(40, 30, 10, align=(Align.CENTER, Align.CENTER, Align.MIN))
    with Locations(*points(sk1${args})):
        ${hole}
`;
    const cb = "CounterBoreHole(radius=2, counter_bore_radius=4, counter_bore_depth=2)";
    const removedBy = (args, hole) => { const x = call("run", under(args, hole), "part.py"); return x.ok ? 40 * 30 * 10 - x.summary.volume : x.error.message; };
    const through = Math.PI * 4 * 10, recess = Math.PI * 12 * 2;
    check(!near(removedBy("", cb), through + recess), `on XY under the part, the plain direction drills away from it: no proper counterbore (${(+removedBy("", cb)).toFixed(2)} removed)`);
    check(near(removedBy(", reverse=True", cb), through + recess), "reverse=True: drilled up into the part, the counterbore on the bottom face");
    check(near(removedBy(", reverse=True, far=p", cb), through + recess), "far=p: started at the top face, the counterbore there");
    const capAt = (args) => { call("run", under(args, cb), "part.py"); return pyval("round(max(f.center().Z for f in _current['shape'].faces() if f.geom_type.name == 'CYLINDER' and abs(f.radius - 4) < 1e-6), 3)"); };
    check(capAt(", reverse=True") < 5 && capAt(", reverse=True, far=p") > 5, `the counterbore is at the bottom (${capAt(", reverse=True")}) or the top (${capAt(", reverse=True, far=p")})`);
    check(/no far side/.test(removedBy(", far=p", cb)), "far side when drilling away from the part: a clear error");
  });

  test("arcs and tangency: a slot", () => {
    const r = call("run", part(`
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
  });

  test("every constraint and dimension once: PlaneGCS's solution satisfies the fallback's own check", () => {
    const r = call("run", part(`
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
    const resid = pyval("[(c[0]['type'], __import__('caad')._residual(c[0], _current['ns']['c']._by_id())) for c in _current['ns']['c']._constraints]");
    const bad = resid.filter(([, v]) => v > 1e-6);
    check(r.ok && resid.length === 18 && !bad.length, `${resid.length} constraints solved, all satisfied by the residual check`, JSON.stringify(bad) + (r.error?.message ?? ""));
  });

  test("the kernel: inserting a constrained sketch adds the import once", () => {
    const empty = "from build123d import *\n\nwith BuildPart() as part:\n    pass\n";
    let ins = call("insert_feature", empty, null, "sketch", { plane: "Plane.XY", body: ["with Constrained() as c:", "    c.rectangle((0, 0), (10, 10))"] });
    check(ins.src.startsWith("from build123d import *\nfrom caad import Constrained\n\nwith BuildPart() as part:\n    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:\n        with Constrained() as c:\n            c.rectangle((0, 0), (10, 10))\n"),
      "insert_feature adds `from caad import Constrained`", ins.src);
    ins = call("insert_feature", ins.src, null, "sketch", { plane: "Plane.XZ", body: ["with Constrained() as c:", "    c.circle((0, 0), 3)"] });
    check(ins.src.split("from caad import").length === 2 && ins.name === "sk2", "only once");
    const r = call("run", ins.src, "part.py");
    check(r.ok && JSON.stringify(r.sketches.map((s) => s.name)) === '["sk1","sk2"]', "unused constrained sketches draw their outlines");
  });

  test("help for the agent", () => {
    const help = call("api_help", "Constrained");
    check(/c\.rectangle\(corner, opposite, construction=False\)/.test(help) && /c\.origin — /.test(help) && /Numbers in entity and shape calls are geometry/.test(help), "api_help('Constrained') lists methods and references");
    check(/hdistance\(a, b, d\)[\s\S]*signed/.test(call("api_help", "Constrained.hdistance")), "api_help('Constrained.hdistance')");
  });

  test("outside CAAD: no solver, the stored geometry", () => {
    py.unregisterJsModule("caad_gcs");
    py.runPython("import sys; sys.modules.pop('caad_gcs', None)");
    try {
      let r = call("run", src, "part.py");
      check(r.ok && near(r.summary.volume, (2400 - Math.PI * 25) * 5, 0.05) && !r.timeline.features[0].sketch.message && r.timeline.features[0].sketch.dof === undefined,
        "without a solver, the stored geometry builds; it satisfies the constraints: no warning");
      r = call("run", src.replace("width = 60", "width = 65"), "part.py");
      const msg = r.timeline.features[0].sketch?.message ?? "";
      check(r.ok && near(r.summary.bbox[3] - r.summary.bbox[0], 60) && /doesn't satisfy line 1[0-9]: c\.length\(r\.bottom, width\)/.test(msg) && /install planegcs|Open the part in CAAD/.test(msg),
        "a changed parameter: built from the stored geometry, with a warning naming the constraint", msg);
    } finally {
      py.registerJsModule("caad_gcs", solver); // for the tests after this one
    }
  });
});
