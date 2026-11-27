// What the GUI sketcher relies on: BuildSketch(face) uses sketch_plane()'s axes, Polygon(align=None) keeps
// its coordinates, and Until.LAST cuts through everything.
import { describe, test } from "node:test";
import { call, check, example, near, pyval } from "./env.mjs";

const bracket = example("bracket.py");
const sel = "bracket.faces().filter_by(Axis.Y).sort_by(Axis.Z)[-1]"; // the wall's front face
const withCut = (sketch, extrude) => bracket.replace("    fillet(", `    with BuildSketch(${sketch}):\n${extrude}\n    fillet(`);

describe("sketch planes", () => {
  test("sketch_plane: a face's plane and the standard ones", () => {
    call("run", bracket, "bracket.py");
    const pl = call("sketch_plane", sel);
    check(JSON.stringify(pl) === JSON.stringify({ origin: [0, 12, 26], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] }), "the wall's front face", pl);
    check(JSON.stringify(call("sketch_plane", "Plane.XY")) === JSON.stringify({ origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }), "Plane.XY");
  });

  test("a circle at local (10, 5) on the face lands where sketch_plane says", () => {
    const v0 = call("run", bracket, "bracket.py").summary.volume;
    const pl = call("sketch_plane", sel);
    const r = call("run", withCut(sel, "        with Locations((10, 5)):\n            Circle(3)\n    extrude(amount=-3, mode=Mode.SUBTRACT)"), "t.py");
    check(r.ok && near(v0 - r.summary.volume, Math.PI * 9 * 3, 0.01), `a 3 mm deep hole (volume ${r.summary?.volume})`, r.error?.message);
    const expected = pl.origin.map((o, i) => o + 10 * pl.x[i] + 5 * pl.y[i] - 1.5 * pl.z[i]); // half the depth into the face
    const hole = pyval(`fs=[f for f in _current["shape"].faces() if f.geom_type.name=="CYLINDER" and abs(f.radius-3)<1e-6]; [round(c,3) for c in tuple(fs[0].center(CenterOf.MASS))] if fs else None`);
    check(hole && hole.every((c, i) => near(c, expected[i])), `the hole's centre ${JSON.stringify(hole)} is at ${JSON.stringify(expected)}`);
  });

  test("Polygon(align=None) and Until.LAST: a cut through everything", () => {
    const poly = "        Polygon((-20, -10), (0, -10), (-10, 5), align=None)";
    const through = call("run", withCut("Plane.XY", `${poly}\n    extrude(until=Until.LAST, mode=Mode.SUBTRACT)`), "t.py");
    const both = call("run", withCut("Plane.XY", `${poly}\n    extrude(amount=-30, mode=Mode.SUBTRACT, both=True)`), "t.py");
    check(through.ok && both.ok, "both build", through.error?.message ?? both.error?.message);
    check(near(through.summary.volume, both.summary.volume) && through.summary.volume < call("run", bracket, "bracket.py").summary.volume,
      `through all removes what a long cut both ways does (${through.summary.volume}, ${both.summary.volume})`);
  });
});
