// Check the assumptions the GUI sketcher relies on: BuildSketch(face) uses sketch_plane()'s axes,
// Polygon(align=None) keeps coordinates, and Until.LAST cuts through everything.
import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";
const py = await loadPyodide();
const site = py.runPython("import site; site.getsitepackages()[0]");
for (const w of JSON.parse(readFileSync("wheels/list.json"))) py.unpackArchive(new Uint8Array(readFileSync("wheels/" + w)), "zip", { extractDir: site });
py.runPython(readFileSync("snapshot2.mjs", "utf8").match(/const STUB_FINDER = `([\s\S]*?)`;/)[1]);
py.runPython(readFileSync("../../app/public/caad_kernel.py", "utf8"));
const js = (r) => (r?.toJs ? r.toJs({ dict_converter: Object.fromEntries }) : r);
const run = (src) => js(py.globals.get("run")(src, "t.py"));
const bracket = readFileSync("../../examples/caad-examples/parts/bracket.py", "utf8");
run(bracket);
const sel = "bracket.faces().filter_by(Axis.Y).sort_by(Axis.Z)[-1]"; // the wall's front face
const pl = js(py.globals.get("sketch_plane")(sel));
console.log("wall front plane:", JSON.stringify(pl));
console.log("XY plane:", JSON.stringify(js(py.globals.get("sketch_plane")("Plane.XY"))));
// A circle at local (10, 5) on that face, cut 3 mm deep: where does the hole end up?
const withHole = bracket.replace("    fillet(", `    with BuildSketch(${sel}):\n        with Locations((10, 5)):\n            Circle(3)\n    extrude(amount=-3, mode=Mode.SUBTRACT)\n    fillet(`);
let r = run(withHole);
console.log("cut on face:", r.ok, r.error?.message ?? "", "volume", r.summary?.volume);
const expected = pl.origin.map((o, i) => o + 10 * pl.x[i] + 5 * pl.y[i]);
const hole = js(py.runPython(`fs=[f for f in _current["shape"].faces() if f.geom_type.name=="CYLINDER" and abs(f.radius-3)<1e-6]; [round(c,3) for c in tuple(fs[0].center(CenterOf.MASS))] if fs else None`));
console.log("expected hole axis through", expected.map((v) => +v.toFixed(3)), "-> hole centre", hole);
r = run(bracket.replace("    fillet(", `    with BuildSketch(Plane.XY):\n        Polygon((-20, -10), (0, -10), (-10, 5), align=None)\n    extrude(until=Until.LAST, mode=Mode.SUBTRACT)\n    fillet(`));
console.log("polygon through-all cut:", r.ok, r.error?.message ?? "", "volume", r.summary?.volume);
r = run(bracket.replace("    fillet(", `    with BuildSketch(Plane.XY):\n        Polygon((-20, -10), (0, -10), (-10, 5), align=None)\n    extrude(amount=-30, mode=Mode.SUBTRACT, both=True)\n    fillet(`));
console.log("polygon both-ways cut:", r.ok, r.error?.message ?? "", "volume", r.summary?.volume);
