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

  test("the edited file builds", () => {
    const built = call("run", withLine, "part.py");
    check(built.ok && near(built.summary.volume, 80 * 60 * 10 + 14 * 12 * 5, 0.01), `the edited part builds (volume ${built.summary?.volume})`);
  });
});
