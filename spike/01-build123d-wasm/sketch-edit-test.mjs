// Test the sketch editor's kernel side (caad_kernel.py: sketch_open / sketch_action, docs/06-sketches.md):
// a constrained sketch read into a model, and every editor action as a small code edit.
import { bootKernel, caller } from "./kernel-env.mjs";

const py = await bootKernel();
const { call, tryCall } = caller(py);
let failures = 0;
const check = (ok, what, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}${!ok && detail ? `\n      ${detail}` : ""}`); if (!ok) failures++; };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;

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

// --- Opening ---
let m = call("sketch_open", src0, 1);
check(m.plane === "part.faces().sort_by(Axis.Z)[-1]" && m.name === "sk1" && m.c === "c" && !m.error, "opens a sketch on a face (the part before it is there)", JSON.stringify(m.error));
check(m.dof === 0 && m.conflicting.length === 0 && !m.problem, `fully constrained (dof ${m.dof})`);
const refs = m.entities.map((e) => e.ref).filter(Boolean);
check(["c.origin", "rect1.corners[0]", "rect1.corners[2]", "rect1.center", "rect1.bottom", "rect1.left"].every((r) => refs.includes(r)), `each entity has an expression (${refs.join(", ")})`);
const c0 = byRef(m, "rect1.corners[0]");
check(near(c0.x, -10) && near(c0.y, -6) && c0.kind === "point", "points carry their solved positions");
const dims = m.constraints.filter((c) => c.dim);
check(JSON.stringify(dims.map((c) => [c.method, c.dim.expr, +c.dim.value.toFixed(3)])) === JSON.stringify([["length", "14", 14], ["length", "12", 12], ["hdistance", "-3", -3], ["vdistance", "0", 0]]),
  "dimensions: method, expression and value", JSON.stringify(dims.map((c) => [c.method, c.dim.expr, c.dim.value])));
check(m.constraints.filter((c) => c.builtin).length === 5 && m.constraints.find((c) => c.method === "length").involves.length === 2, "the rectangle's built-in constraints are marked; constraints list what they involve");
check(m.primitives.length > 15 && m.primitives.some((p) => p.type === "difference"), "PlaneGCS primitives for solving while dragging");
check(/Only constrained sketches/.test(tryCall("sketch_open", "from build123d import *\nwith BuildPart() as p:\n    with BuildSketch() as s:\n        Rectangle(1, 1)\n", 0).error ?? ""), "a plain sketch doesn't open (it's converted later)");
check(/isn't a sketch/.test(tryCall("sketch_open", src0, 0).error ?? ""), "a feature that isn't a sketch doesn't open");

// --- Adding: shared points are coincidence ---
let r = call("sketch_action", src0, 1, [{ op: "add", kind: "line", args: ["rect1.corners[2]", [30, 20]] }]);
check(lineOf(r.src, /line1 =/) === "line1 = c.line(rect1.corners[2], (30, 20))" && JSON.stringify(r.made) === '["line1"]', "add a line from a corner: it uses the corner", lineOf(r.src, /line1 =/));
let line1 = byRef(r.model, "line1");
check(line1.p1 === byRef(r.model, "rect1.corners[2]").id && r.model.dof === 2, `the line shares the corner; its free end adds 2 degrees of freedom (${r.model.dof})`);
r = call("sketch_action", r.src, 1, [{ op: "constrain", kind: "horizontal", refs: ["line1"] }, { op: "constrain", kind: "length", refs: ["line1"], value: "width / 2" }]);
check(r.src.includes("            c.horizontal(line1)\n            c.length(line1, width / 2)\n    extrude") && r.model.dof === 0, `constrain it: horizontal, length = width / 2 (dof ${r.model.dof})`);
check(near(byRef(r.model, "line1.end").x, 34) && near(byRef(r.model, "line1.end").y, 6), "solved: the end is 30 to the right of the corner (4, 6)");
const withLine = r.src;

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

// --- Dimensions: new expressions ---
const len1 = m.constraints.find((c) => c.method === "length");
r = call("sketch_action", src0, 1, [{ op: "dimension", constraint: len1.id, expr: "width / 4" }]);
check(lineOf(r.src, /c\.length\(rect1\.bottom/) === "c.length(rect1.bottom, width / 4)" && near(r.model.constraints.find((c) => c.id === len1.id).dim.value, 15), "change a dimension to an expression (= 15)");
check(near(byRef(r.model, "rect1.corners[1]").x - byRef(r.model, "rect1.corners[0]").x, 15), "and the sketch solves to it");
check(/syntax|invalid/i.test(tryCall("sketch_action", src0, 1, [{ op: "dimension", constraint: len1.id, expr: "width /" }]).error ?? ""), "a broken expression is refused");

// --- Moving: geometry literals follow the editor's positions ---
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
m = call("sketch_open", free, 0);
const id = (ref) => byRef(m, ref).id;
r = call("sketch_action", free, 0, [{ op: "move", points: { [id("rect1.corners[0]")]: [-1.5, 0], [id("rect1.corners[2]")]: [12.3456, 5], [id("circle1.center")]: [20, 2.5], [id("line1.end")]: [16, -6], [id("p1")]: [3.5, 9] },
  circles: { [id("circle1")]: 2.75 } }]);
check(r.src.includes("rect1 = c.rectangle((-1.5, 0), (12.346, 5))") && r.src.includes("circle1 = c.circle((20, 2.5), 2.75)") && r.src.includes("line1 = c.line(rect1.corners[1], (16, -6))"),
  "moved geometry: only the numbers that changed, rounded to 0.001", r.src.split("\n").slice(6, 10).join(" | "));
check(r.src.includes("p1 = c.point(3.5, width_x := 4)"), "an expression in a position is left alone");

// --- Deleting: dependents go with it ---
m = call("sketch_open", withLine, 1);
r = call("sketch_action", withLine, 1, [{ op: "delete", entities: [byRef(m, "line1").id], constraints: [] }]);
check(r.src === src0, "deleting the line removes it and its two constraints", r.src);
r = call("sketch_action", withLine, 1, [{ op: "delete", entities: [], constraints: [m.constraints.find((c) => c.method === "horizontal").id] }]);
check(!r.src.includes("c.horizontal(line1)") && r.src.includes("c.length(line1, width / 2)") && r.model.dof === 1, "deleting a constraint frees a degree");
r = call("sketch_action", withLine, 1, [{ op: "delete", entities: [byRef(m, "rect1.bottom").id], constraints: [] }]);
check(r.src.includes("        with Constrained() as c:\n            pass\n    extrude"), "deleting the rectangle takes its dimensions and the line on its corner, leaving `pass`", r.src.split("\n").slice(8, 11).join(" | "));

// --- Problems show in the model instead of failing ---
r = call("sketch_action", src0, 1, [{ op: "constrain", kind: "length", refs: ["rect1.bottom"], value: "99" }]);
check(r.model.conflicting.length === 2 && /Conflicting constraints: line 11: c\.length\(rect1\.bottom, 14\), line 15: c\.length\(rect1\.bottom, 99\)/.test(r.model.problem), `a conflicting dimension: both named (${r.model.problem})`);
r = call("sketch_action", src0, 1, [{ op: "constrain", kind: "length", refs: ["rect1.center"], value: "3" }]);
check(r.model.error && /Expected a line/.test(r.model.error.message) && r.model.error.line === 15, `a wrong reference: the error and its line (${r.model.error?.line}: ${r.model.error?.message})`);
check(/Unknown sketch action/.test(tryCall("sketch_action", src0, 1, [{ op: "nope" }]).error ?? ""), "unknown actions are refused");

// --- The edited file builds ---
const built = call("run", withLine, "part.py");
check(built.ok && near(built.summary.volume, 80 * 60 * 10 + 14 * 12 * 5, 0.01), `the edited part builds (volume ${built.summary?.volume})`);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
