// The sketch editor's kernel side (caad_kernel.py: sketch_open, sketch_action, sketch_convert;
// docs/06-sketches.md): a constrained sketch read into a model, and every editor action as a small code edit.
import { describe, test } from "node:test";
import { call, check, example, near, tryCall } from "./env.mjs";

// What the sketcher writes for a 14 x 12 rectangle centred at (-3, 0), then an extrude.
const src0 = `from build123d import *
from caad import Constrained

width = 60

with BuildPart() as part:
    Box(80, 60, 10)
    with BuildSketch(part.faces().sort_by(Axis.Z)[-1], mode=Mode.PRIVATE) as sk1:
        with Constrained() as c:
            rect1 = c.rectangle((-10, -6), (4, 6))
            c.length(rect1.bottom, 14)
            c.length(rect1.left, 12)
            c.hdistance(c.origin, rect1.center, -3)
            c.vdistance(c.origin, rect1.center, 0)
    extrude(sk1.sketch, amount=5)
`;
const byRef = (m, ref) => m.entities.find((e) => e.ref === ref);
const lineOf = (src, re) => src.split("\n").find((l) => re.test(l))?.trim();
let withLine; // src0 with a line from a corner, made in "adding"

describe("sketch editing", () => {
  test("opening", () => {
    const m = call("sketch_open", src0, 1);
    check(m.plane === "part.faces().sort_by(Axis.Z)[-1]" && m.name === "sk1" && m.c === "c" && !m.error, "opens a sketch on a face (the part before it is there)", m.error);
    check(m.dof === 0 && m.conflicting.length === 0 && !m.problem, `fully constrained (dof ${m.dof})`);
    const refs = m.entities.map((e) => e.ref).filter(Boolean);
    check(["c.origin", "rect1.corners[0]", "rect1.corners[2]", "rect1.center", "rect1.bottom", "rect1.left"].every((r) => refs.includes(r)), `each entity has an expression (${refs.join(", ")})`);
    const c0 = byRef(m, "rect1.corners[0]");
    check(near(c0.x, -10) && near(c0.y, -6) && c0.kind === "point", "points carry their solved positions");
    const dims = m.constraints.filter((c) => c.dim);
    check(JSON.stringify(dims.map((c) => [c.method, c.dim.expr, +c.dim.value.toFixed(3)])) === JSON.stringify([["length", "14", 14], ["length", "12", 12], ["hdistance", "-3", -3], ["vdistance", "0", 0]]),
      "dimensions: method, expression and value", dims.map((c) => [c.method, c.dim.expr, c.dim.value]));
    check(m.constraints.filter((c) => c.builtin).length === 5 && m.constraints.find((c) => c.method === "length").involves.length === 2, "the rectangle's built-in constraints are marked; constraints list what they involve");
    check(m.primitives.length > 15 && m.primitives.some((p) => p.type === "difference"), "PlaneGCS primitives for solving while dragging");
    check(/Only constrained sketches/.test(tryCall("sketch_open", "from build123d import *\nwith BuildPart() as p:\n    with BuildSketch() as s:\n        Rectangle(1, 1)\n", 0).error ?? ""), "a plain sketch doesn't open (it's converted later)");
    check(/isn't a sketch/.test(tryCall("sketch_open", src0, 0).error ?? ""), "a feature that isn't a sketch doesn't open");
  });

  test("adding: shared points are coincidence", () => {
    let r = call("sketch_action", src0, 1, [{ op: "add", kind: "line", args: ["rect1.corners[2]", [30, 20]] }]);
    check(lineOf(r.src, /line1 =/) === "line1 = c.line(rect1.corners[2], (30, 20))" && JSON.stringify(r.made) === '["line1"]', "add a line from a corner: it uses the corner", lineOf(r.src, /line1 =/));
    const line1 = byRef(r.model, "line1");
    check(line1.p1 === byRef(r.model, "rect1.corners[2]").id && r.model.dof === 2, `the line shares the corner; its free end adds 2 degrees of freedom (${r.model.dof})`);
    r = call("sketch_action", r.src, 1, [{ op: "constrain", kind: "horizontal", refs: ["line1"] }, { op: "constrain", kind: "length", refs: ["line1"], value: "width / 2" }]);
    check(r.src.includes("            c.horizontal(line1)\n            c.length(line1, width / 2)\n    extrude") && r.model.dof === 0, `constrain it: horizontal, length = width / 2 (dof ${r.model.dof})`);
    check(near(byRef(r.model, "line1.end").x, 34) && near(byRef(r.model, "line1.end").y, 6), "solved: the end is 30 to the right of the corner (4, 6)");
    withLine = r.src;

    r = call("sketch_action", src0, 1, [{ op: "add", kind: "line", args: [[0, 0], [10, 0]] }, { op: "constrain", kind: "horizontal", refs: ["$0"] }, { op: "add", kind: "line", args: ["$0.end", [10, 10]] }]);
    check(r.src.includes("line1 = c.line((0, 0), (10, 0))\n            c.horizontal(line1)\n            line2 = c.line(line1.end, (10, 10))"), "$k refers to what action k made", r.src.split("\n").slice(14, 17).join(" | "));
    r = call("sketch_action", src0, 1, [
      { op: "add", kind: "circle", args: [[20, 10], 3.25] },
      { op: "add", kind: "polyline", args: [[0, 20], [10, 20], [5, 28]], close: true },
      { op: "add", kind: "rectangle", args: [[-30, -20], [-20, -10]], construction: true },
      { op: "add", kind: "arc", args: [[0, 0], [5, 0], [0, 5]] },
      { op: "add", kind: "point", args: [7, 7.5] },
    ]);
    check(["circle1 = c.circle((20, 10), 3.25)", "line1, line2, line3 = c.polyline((0, 20), (10, 20), (5, 28), close=True)",
      "rect2 = c.rectangle((-30, -20), (-20, -10), construction=True)", "arc1 = c.arc((0, 0), (5, 0), (0, 5))", "p1 = c.point(7, 7.5)"].every((l) => r.src.includes(l)),
      "add a circle, a closed polyline, a construction rectangle, an arc and a point", r.src.split("\n").slice(14, 20).join(" | "));
    check(r.model.entities.filter((e) => e.kind === "line" && e.ref?.startsWith("line")).length === 3 && byRef(r.model, "rect2.bottom").construction, "the polyline's lines are named; construction is kept");
    const empty = src0.replace(/            rect1[\s\S]*?vdistance\(c\.origin, rect1\.center, 0\)\n/, "            pass\n");
    r = call("sketch_action", empty, 1, [{ op: "add", kind: "rectangle", args: [[0, 0], [10, 5]] }]);
    check(r.src.includes("        with Constrained() as c:\n            rect1 = c.rectangle((0, 0), (10, 5))\n    extrude") && !r.src.includes("pass"), "the first shape replaces `pass`");
  });

  test("dimensions: new expressions", () => {
    const len1 = call("sketch_open", src0, 1).constraints.find((c) => c.method === "length");
    const r = call("sketch_action", src0, 1, [{ op: "dimension", constraint: len1.id, expr: "width / 4" }]);
    check(lineOf(r.src, /c\.length\(rect1\.bottom/) === "c.length(rect1.bottom, width / 4)" && near(r.model.constraints.find((c) => c.id === len1.id).dim.value, 15), "change a dimension to an expression (= 15)");
    check(near(byRef(r.model, "rect1.corners[1]").x - byRef(r.model, "rect1.corners[0]").x, 15), "and the sketch solves to it");
    check(/syntax|invalid/i.test(tryCall("sketch_action", src0, 1, [{ op: "dimension", constraint: len1.id, expr: "width /" }]).error ?? ""), "a broken expression is refused");
  });

  test("moving: geometry literals follow the editor's positions", () => {
    const free = `from build123d import *
from caad import Constrained

with BuildPart() as part:
    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:
        with Constrained() as c:
            rect1 = c.rectangle((0, 0), (10, 5))
            circle1 = c.circle((20, 2.5), 2)
            line1 = c.line(rect1.corners[1], (15, -5))
            p1 = c.point(3, width_x := 4)
    extrude(sk1.sketch, amount=2)
`;
    const m = call("sketch_open", free, 0);
    const id = (ref) => byRef(m, ref).id;
    const r = call("sketch_action", free, 0, [{ op: "move", points: { [id("rect1.corners[0]")]: [-1.5, 0], [id("rect1.corners[2]")]: [12.3456, 5], [id("circle1.center")]: [20, 2.5], [id("line1.end")]: [16, -6], [id("p1")]: [3.5, 9] },
      circles: { [id("circle1")]: 2.75 } }]);
    check(r.src.includes("rect1 = c.rectangle((-1.5, 0), (12.346, 5))") && r.src.includes("circle1 = c.circle((20, 2.5), 2.75)") && r.src.includes("line1 = c.line(rect1.corners[1], (16, -6))"),
      "moved geometry: only the numbers that changed, rounded to 0.001", r.src.split("\n").slice(6, 10).join(" | "));
    check(r.src.includes("p1 = c.point(3.5, width_x := 4)"), "an expression in a position is left alone");
  });

  test("deleting: dependents go with it", () => {
    const m = call("sketch_open", withLine, 1);
    let r = call("sketch_action", withLine, 1, [{ op: "delete", entities: [byRef(m, "line1").id], constraints: [] }]);
    check(r.src === src0, "deleting the line removes it and its two constraints", r.src);
    r = call("sketch_action", withLine, 1, [{ op: "delete", entities: [], constraints: [m.constraints.find((c) => c.method === "horizontal").id] }]);
    check(!r.src.includes("c.horizontal(line1)") && r.src.includes("c.length(line1, width / 2)") && r.model.dof === 1, "deleting a constraint frees a degree");
    r = call("sketch_action", withLine, 1, [{ op: "delete", entities: [byRef(m, "rect1.bottom").id], constraints: [] }]);
    check(r.src.includes("        with Constrained() as c:\n            pass\n    extrude"), "deleting the rectangle takes its dimensions and the line on its corner, leaving `pass`", r.src.split("\n").slice(8, 11).join(" | "));
  });

  test("problems show in the model instead of failing", () => {
    let r = call("sketch_action", src0, 1, [{ op: "constrain", kind: "length", refs: ["rect1.bottom"], value: "99" }]);
    check(r.model.conflicting.length === 2 && /Conflicting constraints: line 11: c\.length\(rect1\.bottom, 14\), line 15: c\.length\(rect1\.bottom, 99\)/.test(r.model.problem), `a conflicting dimension: both named (${r.model.problem})`);
    r = call("sketch_action", src0, 1, [{ op: "constrain", kind: "length", refs: ["rect1.center"], value: "3" }]);
    check(r.model.error && /Expected a line/.test(r.model.error.message) && r.model.error.line === 15, `a wrong reference: the error and its line (${r.model.error?.line}: ${r.model.error?.message})`);
    check(/Unknown sketch action/.test(tryCall("sketch_action", src0, 1, [{ op: "nope" }]).error ?? ""), "unknown actions are refused");
  });

  test("converting plain sketches: expressions kept, regions checked", () => {
    const bracket = example("bracket.py");
    const volumeOf = (src) => call("run", src, "part.py").summary?.volume;
    let conv = call("sketch_convert", bracket, 0);
    check(conv.includes("from build123d import *\nfrom caad import Constrained\n") &&
      conv.includes("    with BuildSketch() as base:\n        with Constrained() as c:\n            rect1 = c.rectangle((-30, -20), (30, 20))\n            c.length(rect1.bottom, width)\n            c.length(rect1.left, depth)\n            c.coincident(rect1.center, c.origin)\n    extrude(amount=thickness)"),
      "the bracket's base: Rectangle(width, depth) -> a rectangle with lengths width and depth, centred on the origin", conv.split("\n").slice(9, 17).join(" | "));
    check(Math.abs(volumeOf(conv) - volumeOf(bracket)) < 1e-6, "the part is the same (the extrude still takes the pending sketch)");
    check(call("sketch_open", conv, 0).dof === 0 && call("run", conv, "part.py").timeline.features[0].constrained, "and it opens in the editor, fully constrained");
    conv = call("sketch_convert", conv, 2);
    check(conv.includes("rect2 = c.rectangle((-30, -40), (30, 0))\n            c.length(rect2.bottom, width)\n            c.length(rect2.left, 40)\n            c.hdistance(c.origin, rect2.center, 0)\n            c.vdistance(c.origin, rect2.center, -20)") &&
      conv.split("from caad import").length === 2 && Math.abs(volumeOf(conv) - volumeOf(bracket)) < 1e-6,
      "the wall at Locations((0, -20)): its position from the origin; one import; still the same part", conv.split("\n").slice(18, 25).join(" | "));
    const plain = (body) => `from build123d import *\n\nw = 20\n\nwith BuildPart() as p:\n    with BuildSketch(Plane.XZ) as s:\n${body.split("\n").map((l) => "        " + l).join("\n")}\n    extrude(amount=3)\n`;
    const holes = "Rectangle(w * 2, 30)\nwith Locations((5, 0), (-5, 0)):\n    Circle(2, mode=Mode.SUBTRACT)";
    conv = call("sketch_convert", plain(holes), 0);
    check(conv.includes("circle1 = c.circle((5, 0), 2)") && conv.includes("circle2 = c.circle((-5, 0), 2)") && conv.includes("c.length(rect1.bottom, w * 2)") &&
      Math.abs(volumeOf(conv) - volumeOf(plain(holes))) < 1e-6,
      "subtracted circles at two locations become holes; `w * 2` stays an expression");
    for (const [label, body] of [["a polygon with align=None", "Polygon((0, 0), (20, 0), (10, 15), align=None)"], ["a polygon with build123d's default alignment (as written)", "Polygon((0, 0), (20, 0), (10, 15))"]]) {
      conv = call("sketch_convert", plain(body), 0);
      check(/poly1 = c\.polygon\(/.test(conv) && conv.includes("c.fix(*poly1.points)") && Math.abs(volumeOf(conv) - volumeOf(plain(body))) < 1e-6, `${label}: same region`, conv.match(/poly1 = .*/)?.[0]);
    }
    const refused = (body) => tryCall("sketch_convert", plain(body), 0).error ?? "";
    check(/Can't convert line 8 \(`fillet/.test(refused("Rectangle(30, 20)\nfillet(s.vertices(), radius=2)")), `a fillet in the sketch: refused, naming the line (${refused("Rectangle(30, 20)\nfillet(s.vertices(), radius=2)").slice(0, 60)}…)`);
    check(/Can't convert/.test(refused("with GridLocations(10, 10, 2, 2):\n    Circle(2)")), "GridLocations: refused");
    check(/an aligned polygon/.test(refused("Polygon((0, 0), (20, 0), (10, 15), align=(Align.CENTER, Align.CENTER))")), "a centred polygon: refused rather than guessed");
    check(/would change this sketch/.test(refused("Rectangle(30, 20)\nCircle(4)")), "a circle added inside a rectangle (no hole in build123d, a hole when nested): refused");
    check(/already constrained/.test(tryCall("sketch_convert", src0, 1).error ?? ""), "a constrained sketch isn't converted again");
  });

  test("references: the part's edges in the sketch (c.project)", () => {
    // A plate with a hole and a rounded corner (40, 30); the sketch on its top face, empty for now.
    const srcRef = (plane, body = "pass") => `from build123d import *
from caad import Constrained

with BuildPart() as part:
    Box(80, 60, 10)
    Cylinder(5, 10, mode=Mode.SUBTRACT)
    fillet(part.edges().filter_by(Axis.Z).group_by(Axis.X)[-1].sort_by(Axis.Y)[-1], radius=4)
    with BuildSketch(${plane}) as sk1:
        with Constrained() as c:
${body.split("\n").map((l) => "            " + l).join("\n")}
    extrude(amount=2)
`;
    const top = srcRef("Plane.XY.offset(5)");
    check(!call("sketch_open", top, 3).error, "a sketch on the plate's top opens");
    const top_edge = "part.edges().filter_by(Axis.X).group_by(Axis.Z)[-1].sort_by(Axis.Y)[-1]";
    let r = call("sketch_action", top, 3, [
      { op: "add", kind: "project", args: [top_edge] },
      { op: "add", kind: "project", args: ["part.edges().filter_by(GeomType.CIRCLE).group_by(Axis.Z)[-1].sort_by(SortBy.RADIUS)[-1]"] },
      { op: "add", kind: "point", args: [0, 20] },
      { op: "constrain", kind: "on", refs: ["$2", "$0"] },
      { op: "add", kind: "circle", args: [[20, 0], 3] },
      { op: "constrain", kind: "equal", refs: ["$3", "$1"] },
    ]);
    check(r.src.includes(`ref1 = c.project(${top_edge})`) && JSON.stringify(r.made.slice(0, 2)) === '["ref1","ref2"]', "Use writes `ref1 = c.project(<selector>)`", lineOf(r.src, /ref1 =/));
    const ref1 = byRef(r.model, "ref1"), ref2 = byRef(r.model, "ref2");
    const ys = [byRef(r.model, "ref1.start"), byRef(r.model, "ref1.end")];
    check(ref1.kind === "line" && ref1.reference && ref1.construction && ys.every((p) => p.fixed && p.reference && near(p.y, 30)) && near(Math.abs(ys[0].x - ys[1].x), 76),
      "the top edge: a fixed construction line at y = 30 (76 long: up to the rounded corner)", ys.map((p) => [p.x, p.y]));
    check(ref2.kind === "circle" && ref2.reference && near(ref2.r, 5) && near(byRef(r.model, "ref2.center").x, 0), "the hole: a fixed circle of radius 5 at the origin");
    check(near(byRef(r.model, "p1").y, 30) && near(byRef(r.model, "circle1").r, 5) && !r.model.problem, "a point on the edge goes to y = 30; a circle equal to the hole gets radius 5 (the reference doesn't move)");
    check(r.model.dof === 3, `references add no degrees of freedom (${r.model.dof}: the point's x, the circle's centre)`);

    const arc = call("sketch_action", top, 3, [{ op: "add", kind: "project", args: ["part.edges().filter_by(GeomType.CIRCLE).group_by(Axis.Z)[-1].sort_by(SortBy.RADIUS)[-1].edges()"] }]);
    check(arc.model.entities.some((e) => e.kind === "circle"), "a ShapeList of one edge is fine");
    const a = call("sketch_action", top, 3, [{ op: "add", kind: "project", args: ["part.edges().filter_by(GeomType.CIRCLE).group_by(Axis.Z)[-1].sort_by(SortBy.RADIUS)[0]"] }]).model;
    const [ac, as, ae] = ["ref1.center", "ref1.start", "ref1.end"].map((x) => byRef(a, x));
    check(byRef(a, "ref1").kind === "arc" && near(ac.x, 36) && near(ac.y, 26) && near(as.x, 40) && near(as.y, 26) && near(ae.x, 36) && near(ae.y, 30),
      "the rounded corner: an arc around (36, 26), counter-clockwise from (40, 26) to (36, 30)", [ac, as, ae].map((p) => [p.x, p.y]));
    const v = call("sketch_action", top, 3, [
      { op: "add", kind: "project", args: ["part.vertices().group_by(Axis.Z)[-1].group_by(Axis.X)[0].sort_by(Axis.Y)[-1]"] },
      { op: "add", kind: "project", args: ["part.edges().filter_by(Axis.Z).group_by(Axis.X)[0].sort_by(Axis.Y)[0]"] },
    ]).model;
    check(byRef(v, "ref1").kind === "point" && byRef(v, "ref1").fixed && near(byRef(v, "ref1").x, -40) && near(byRef(v, "ref1").y, 30), "a vertex: a fixed point");
    check(byRef(v, "ref2").kind === "point" && near(byRef(v, "ref2").x, -40) && near(byRef(v, "ref2").y, -30), "an edge straight through the sketch plane: a point");

    const side = srcRef("Plane.XZ");
    call("sketch_open", side, 3);
    const tilted = call("sketch_action", side, 3, [{ op: "add", kind: "project", args: ["part.edges().filter_by(GeomType.CIRCLE)[0]"] }]).model;
    check(/parallel to the sketch plane/.test(tilted.error?.message ?? ""), "a circle seen from the side is refused", tilted.error?.message);
    const face = call("sketch_action", side, 3, [{ op: "add", kind: "project", args: ["part.faces()[0]"] }]).model;
    check(/takes an edge or a vertex/.test(face.error?.message ?? ""), "so is a face", face.error?.message);
    check(/one edge/.test(call("sketch_action", side, 3, [{ op: "add", kind: "project", args: ["part.edges()"] }]).model.error?.message ?? ""), "and several edges");

    call("sketch_open", top, 3);
    const m = call("sketch_action", top, 3, [{ op: "add", kind: "project", args: [top_edge] }, { op: "add", kind: "point", args: [0, 20] }, { op: "constrain", kind: "on", refs: ["$1", "$0"] }]);
    const del = call("sketch_action", m.src, 3, [{ op: "delete", entities: [byRef(m.model, "ref1").id], constraints: [] }]);
    check(!del.src.includes("c.project") && !del.src.includes("c.on(") && del.src.includes("p1 = c.point(0, 20)"), "deleting a reference takes the constraints on it");

    // The whole part: the sketch's plane comes from BuildSketch (here a face), and construction=False makes a region.
    const faceTop = srcRef("part.faces().sort_by(Axis.Z)[-1]", "ref1 = c.project(part.edges().filter_by(GeomType.CIRCLE).group_by(Axis.Z)[-1].sort_by(SortBy.RADIUS)[-1], construction=False)");
    const built = call("run", faceTop, "part.py");
    const plate = call("run", srcRef("Plane.XY", "pass").replace("    extrude(amount=2)\n", ""), "part.py");
    check(built.ok && near(built.summary.volume - plate.summary.volume, Math.PI * 25 * 2, 0.05) && near(built.summary.bbox[5], 7),
      `projecting the hole's edge with construction=False: a disc on the hole, extruded 2 up (${built.error?.message ?? (built.summary.volume - plate.summary.volume).toFixed(2)})`);
  });

  // A sketch on XY with `body` as its block (feature 0), extruded 5.
  const onXY = (body) => `from build123d import *
from caad import Constrained

with BuildPart() as part:
    with BuildSketch(Plane.XY) as sk1:
        with Constrained() as c:
${body.trim().split("\n").map((l) => "            " + l).join("\n")}
    extrude(sk1.sketch, amount=5)
`;
  const block = (src) => src.split("\n").filter((l) => l.startsWith("            ")).map((l) => l.trim());
  const rect = onXY("rect1 = c.rectangle((0, 0), (20, 10))\nc.coincident(rect1.corners[0], c.origin)\nc.length(rect1.bottom, 20)\nc.length(rect1.left, 10)");

  test("operations: fillet, mirror and patterns as code", () => {
    call("sketch_open", rect, 0);
    let r = call("sketch_action", rect, 0, [{ op: "add", kind: "fillet", args: ["rect1.corners[2]", 3] }]);
    check(block(r.src).at(-1) === "fillet1 = c.fillet(rect1.corners[2], 3)" && r.model.dof === 0 && !r.model.problem, `a fillet: one line, still fully constrained (dof ${r.model.dof}, ${r.model.problem})`);
    const fd = r.model.constraints.find((c) => c.method === "fillet");
    check(fd?.dim?.expr === "3" && near(fd.dim.value, 3), "its radius is a dimension");
    check(r.model.entities.filter((e) => e.hidden).length === 2, "the radius spokes are hidden helpers");
    r = call("sketch_action", r.src, 0, [{ op: "dimension", constraint: fd.id, expr: "4" }]);
    const built = call("run", r.src, "part.py");
    check(built.ok && near(built.summary.volume, (200 - 16 + 4 * Math.PI) * 5, 0.01), `a 4 mm fillet: the corner rounded (volume ${built.summary?.volume})`);
    check(/two lines meet/.test(call("sketch_action", rect, 0, [{ op: "add", kind: "fillet", args: ["rect1.center", 3] }]).model.error?.message ?? ""), "a point that isn't a corner: an error in the model");

    r = call("sketch_action", rect, 0, [{ op: "add", kind: "line", args: [[25, -5], [25, 15]], construction: true }, { op: "add", kind: "mirror", args: ["$0", "rect1.bottom", "rect1.right", "rect1.top", "rect1.left"] }]);
    check(block(r.src).at(-1) === "mirror1 = c.mirror(line1, rect1.bottom, rect1.right, rect1.top, rect1.left)" && byRef(r.model, "mirror1[0]") && near(byRef(r.model, "mirror1[0].start").x, 50),
      "mirror: the copies are mirror1[i], across the line");

    r = call("sketch_action", rect, 0, [{ op: "add", kind: "circle", args: [[5, 5], 1] }, { op: "add", kind: "linear_pattern", args: [["$0"], 3, 5, 0] }]);
    check(block(r.src).at(-1) === "pattern1 = c.linear_pattern([circle1], 3, 5, 0)" && near(byRef(r.model, "pattern1[1][0]")?.r, 1) && !r.model.problem, "a linear pattern: copies as pattern1[copy][item]");
    const lin = r.model.statements.findIndex((s) => s.call?.method === "linear_pattern");
    check(r.model.statements[lin].call.args[1] === "3", "statements carry their call's arguments (the editor's fields)");
    r = call("sketch_action", r.src, 0, [{ op: "arg", stmt: lin, arg: 1, expr: "4" }]);
    check(block(r.src).at(-1) === "pattern1 = c.linear_pattern([circle1], 4, 5, 0)" && byRef(r.model, "pattern1[2][0]"), "changing an argument: one more copy");

    r = call("sketch_action", rect, 0, [{ op: "add", kind: "circle", args: [[10, 2], 1] }, { op: "add", kind: "circular_pattern", args: [["$0"], 4, "rect1.center"] }]);
    const circ = r.model.statements.findIndex((s) => s.call?.method === "circular_pattern");
    r = call("sketch_action", r.src, 0, [{ op: "arg", stmt: circ, arg: "angle", expr: "180" }]);
    check(block(r.src).at(-1) === "pattern1 = c.circular_pattern([circle1], 4, rect1.center, angle=180)" && near(byRef(r.model, "pattern1[2][0].center")?.y, 8, 1e-3),
      "a circular pattern; a keyword left out is added (4 copies over 180°: the last opposite)", byRef(r.model, "pattern1[2][0].center"));
  });

  test("trimming: the piece between crossings goes", () => {
    const trim = (src, ref, at) => {
      const m = call("sketch_open", src, 0);
      return tryCall("sketch_action", src, 0, [{ op: "trim", entity: byRef(m, ref).id, at }]);
    };
    const lines = onXY("line1 = c.line((0, 0), (20, 0))\nline2 = c.line((10, -5), (10, 5))\nline3 = c.line(line1.end, (20, 10))\nc.length(line1, 20)");
    let r = trim(lines, "line1", [15, 0]).value;
    check(JSON.stringify(block(r.src)) === JSON.stringify(["line1 = c.line((0, 0), (10, 0))", "line2 = c.line((10, -5), (10, 5))", "line3 = c.line((20, 0), (20, 10))", "c.on(line1.end, line2)"]),
      "a line's end piece: it ends at the crossing (on the other line); the line that started there keeps the point; its length goes", block(r.src));
    r = trim(lines, "line3", [20, 5]).value;
    check(!r.src.includes("line3"), "nothing crossing: the whole line goes");

    r = trim(onXY("line1 = c.line((0, 0), (30, 0))\nline2 = c.line((10, -5), (10, 5))\nline3 = c.line((20, -5), (20, 5))"), "line1", [15, 0]).value;
    check(block(r.src).slice(0, 2).join("|") === "line1 = c.line((0, 0), (10, 0))|line4 = c.line((20, 0), (30, 0))" && r.src.includes("c.parallel(line1, line4)") && r.model.entities.filter((e) => e.kind === "line").length === 4,
      "a piece in the middle: split in two lines, kept in line", block(r.src));

    r = trim(onXY("circle1 = c.circle((0, 0), 10)\nline1 = c.line((-20, 0), (20, 0))\nc.radius(circle1, 10)"), "circle1", [0, -10]).value;
    check(block(r.src)[0] === "arc1 = c.arc((0, 0), (10, 0), (-10, 0))" && block(r.src).includes("c.radius(arc1, 10)"), "a circle: the arc that's left (counter-clockwise), its constraints renamed", block(r.src));

    r = trim(onXY("arc1 = c.arc((0, 0), (15, 0), (0, 15))\nline1 = c.line((0, 0), (20, 20))\nline2 = c.line((0, 0), (20, 5))"), "arc1", [15 * Math.cos(0.5), 15 * Math.sin(0.5)]).value;
    check(block(r.src)[1] === "arc2 = c.arc(arc1.center, (10.607, 10.607), (0, 15))" && r.src.includes("c.equal(arc1, arc2)"), "an arc split: two arcs on one circle", block(r.src));

    r = trim(onXY("rect1 = c.rectangle((0, 0), (20, 10))\nline9 = c.line((5, -5), (5, 15))\nc.length(rect1.bottom, 20)\nl = c.line(rect1.center, (30, 30))"), "rect1.top", [3, 10]).value;
    const b = block(r.src);
    check(b[0] === "line1 = c.line((0, 0), (20, 0))" && b[2] === "line3 = c.line(line2.end, (5, 10))" && b.includes("c.horizontal(line1, line3)") && b.includes("c.length(line1, 20)") && b.includes("l = c.line(p1, (30, 30))"),
      "a rectangle's side: the rectangle becomes lines (its constraints and names carried over), then that side is trimmed", b);
    check(!r.model.error && !r.model.problem, "and the sketch still solves", r.model.error ?? r.model.problem);

    check(/mirror makes can't be trimmed/.test(trim(onXY("ax = c.line((0, -10), (0, 10), construction=True)\nline1 = c.line((2, 0), (5, 5))\nm1 = c.mirror(ax, line1)"), "m1[0]", [-4, 4]).error ?? ""), "copies can't be trimmed");
    check(/would break the sketch/.test(trim(onXY("rect1 = c.rectangle((0, 0), (20, 10))\nf = c.fillet(rect1.corners[2], 3)\nline9 = c.line((5, -5), (5, 15))"), "rect1.top", [10, 10]).error ?? ""),
      "a trim that would break the sketch (a filleted corner's line) is refused");
  });

  test("the edited file builds", () => {
    const built = call("run", withLine, "part.py");
    check(built.ok && near(built.summary.volume, 80 * 60 * 10 + 14 * 12 * 5, 0.01), `the edited part builds (volume ${built.summary?.volume})`);
  });
});
