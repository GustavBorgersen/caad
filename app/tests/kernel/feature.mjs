// The feature model in caad_kernel.py (docs/05-feature-model.md): tiers, the sketch + extrude form,
// read_feature values, surgical patch_feature edits, inserting and deleting features, holes, revolve,
// mirror, plane features, revolve axes from sketches, shared project code and export.
import { describe, test } from "node:test";
import { call, check, example, py, read, tryCall } from "./env.mjs";

const features = (src) => call("analyze", src).features;
const patch = (src, index, changes) => call("patch_feature", src, index, features(src)[index].kind, changes);
const field = (rf, name) => rf.fields.find((x) => x.name === name);
const vol = (src) => call("run", src, "part.py").summary?.volume;
/** The changed region between two sources: [removed, added]. */
const diff = (a, b) => {
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return [a.slice(i, a.length - j), b.slice(i, b.length - j)];
};

const bracket = example("bracket.py");
const named = `from build123d import *

with BuildPart() as p:
    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:
        Rectangle(40, 20)
    with BuildSketch(Plane.XY.offset(30)) as loose:
        Circle(3)
    extrude(sk1.sketch, amount=5)
    extrude(amount=2)
`;
const empty = "from build123d import *\n\nwith BuildPart() as part:\n    pass\n";
let inserted; // a box from sk1 with a cut from sk2, made in "inserting"

describe("feature model", () => {
  test("tiers and the sketch + extrude form", () => {
    let f = features(bracket);
    check(JSON.stringify(f.map((x) => `${x.kind}/${x.tier}`)) === JSON.stringify(["sketch/code", "extrude/type", "sketch/code", "extrude/type", "hole/type", "fillet/type"]),
      "bracket: kinds and tiers", f.map((x) => `${x.kind}/${x.tier}`));
    check(f[0].implicit && f[0].name === "base" && f[2].name === "wall", "implicit sketches with their names");
    check(JSON.stringify(f[1].pending) === '["base"]' && JSON.stringify(f[3].pending) === '["wall"]', "each extrude takes the pending sketch before it");
    check(f[1].label === "Extrude base, thickness" && f[5].label === "Fillet r = 5 mm", `labels: "${f[1].label}", "${f[5].label}"`);
    check(f[5].refs.length === 0 && features(bracket.replace("Rectangle(width, 40)", "Rectangle(width, 40)\n    extrude(base.sketch, amount=1)"))[3].refs.includes("base"), "refs name earlier features");
    const pump = features(example("pump_body.py"));
    check(JSON.stringify(pump.map((x) => x.tier)) === JSON.stringify(["call", "call", "code", "code", "code", "type"]), "pump body: primitives are call features", pump.map((x) => x.tier));
    f = features(named);
    check(!f[0].implicit && f[1].implicit && f[2].pending === undefined && JSON.stringify(f[3].pending) === '["loose"]',
      "a private sketch isn't pending; an extrude with a sketch doesn't consume pending ones");
    check(f[2].label === "Extrude sk1, 5 mm" && f[2].refs.includes("sk1"), `named sketch label and ref: "${f[2].label}"`);
  });

  test("read_feature: fields, expressions and values in the rolled-back model", () => {
    call("run", bracket, "bracket.py", 4); // rolled back to just before the fillet
    let r = call("read_feature", bracket, 5);
    check(r.tier === "type" && r.call === "fillet" && field(r, "radius").expr === "5" && field(r, "radius").value === "5", "fillet radius: expression and value");
    check(field(r, "objects").value === "2 edges", `fillet edges evaluate in the rolled-back model: ${field(r, "objects").value}`);
    call("run", bracket, "bracket.py", 0);
    r = call("read_feature", bracket, 1);
    check(field(r, "amount").expr === "thickness" && field(r, "amount").value === "8", "extrude depth: 'thickness' = 8");
    check(field(r, "to_extrude").expr == null && JSON.stringify(r.pending) === '["base"]', "extrude without a sketch shows the pending one");
    check(field(r, "mode").default === "Mode.ADD" && field(r, "both").default === "False" && field(r, "taper").default === "0.0", "defaults from the signature");
    check(field(r, "clean").extra && !field(r, "amount").extra, "arguments the type doesn't list are extra fields");
    check(field(r, "dir").type === "flip" && field(r, "dir").of === "to_extrude" && field(r, "dir").template === "-{}.faces()[0].normal_at()", "Opposite direction flips the sketch's normal");
    r = call("read_feature", example("pump_body.py"), 0);
    check(r.tier === "call" && ["radius", "height", "arc_size", "rotation", "align", "mode"].every((n) => field(r, n)) && field(r, "radius").required && !field(r, "mode").required,
      "call feature: generic fields from Cylinder's signature");
    check(field(r, "mode").type === "choice" && field(r, "mode").options.length === 5, "generic mode is a choice");
    check(call("read_feature", bracket, 0).fields === undefined, "a sketch (code tier for now) has no fields");
    const before = call("run", bracket, "bracket.py", -1);
    check(before.ok && before.upto === -1 && !before.mesh && before.timeline.features.every((x) => x.status === "rolled-back"), "roll back to before the first feature (to edit it)", before.error);
  });

  test("round trip: unchanged fields give byte-identical source", () => {
    for (const [name, src] of [["bracket", bracket], ["pump", example("pump_body.py")], ["named", named]]) {
      call("run", src, "part.py");
      for (const ft of features(src)) {
        if (ft.tier === "code") continue;
        const rf = call("read_feature", src, ft.index);
        const unchanged = Object.fromEntries(rf.fields.filter((x) => x.expr != null).map((x) => [x.name, x.expr]));
        check(patch(src, ft.index, unchanged) === src, `round trip: ${name} feature ${ft.index} (${ft.kind})`);
      }
    }
  });

  test("surgical edits", () => {
    let out = patch(bracket, 1, { amount: "12" });
    check(JSON.stringify(diff(bracket, out)) === JSON.stringify(["thickness", "12"]), "change one argument: only its text changes", diff(bracket, out));
    out = patch(bracket, 1, { both: "True" });
    check(out.includes("extrude(amount=thickness, both=True)"), "add a keyword on the same line");
    check(patch(out, 1, { both: null }) === bracket, "remove it again: back to the original");
    check(patch(out, 1, { both: "False" }) === bracket, "setting a default removes the argument");
    check(patch(bracket, 1, { mode: "Mode.ADD" }) === bracket, "a default that isn't in the code isn't added");
    out = patch(bracket, 5, { radius: "hole_d / 4", objects: "bracket.edges().filter_by(Axis.Z)" });
    check(out.includes("fillet(bracket.edges().filter_by(Axis.Z), radius=hole_d / 4)"), "change two arguments at once");

    const multi = `from build123d import *

with BuildPart() as p:
    Box(10, 10, 10)
    # the cut
    extrude(
        amount=-3,  # depth
        mode=Mode.SUBTRACT,
    )  # end
    chamfer(p.edges(), 1)
`;
    out = patch(multi, 1, { both: "True" });
    check(out.includes("        mode=Mode.SUBTRACT,\n        both=True,\n    )  # end"), "one argument per line: a new line, same style", out);
    check(patch(out, 1, { both: null }) === multi, "and removing it restores the layout");
    out = patch(multi, 1, { mode: null });
    check(out.includes("        amount=-3,  # depth\n    )  # end") && out.includes("# the cut"), "removing a line keeps the other lines and comments", out);
    out = patch(multi, 1, { amount: "-thickness" });
    check(out.includes("amount=-thickness,  # depth"), "comments next to a changed argument stay");
    out = patch(multi, 2, { length: "2.5" });
    check(out.includes("chamfer(p.edges(), 2.5)"), "positional arguments stay positional");
    out = patch(multi, 2, { length2: "1" });
    check(out.includes("chamfer(p.edges(), 1, length2=1)"), "a new argument after positional ones is a keyword");
    const pos = named.replace("extrude(sk1.sketch, amount=5)", "extrude(sk1.sketch, 5)");
    out = patch(pos, 2, { to_extrude: null });
    check(out.includes("extrude(None, 5)"), "removing a positional argument with others after it writes its default", out.split("\n")[7]);
    const uni = `from build123d import *

with BuildPart() as p:
    Box(10, 10, 10)
    Text("Øø ×", font_size=5)  # größe
`;
    out = patch(uni, 1, { font_size: "8" });
    check(out.includes('Text("Øø ×", font_size=8)  # größe'), "non-ASCII text before an argument on the same line", out.split("\n")[4]);
  });

  test("refusals: nothing is written", () => {
    check(/no longer|isn't there/.test(tryCall("patch_feature", bracket, 1, "fillet", { radius: "2" }).error ?? ""), "refuses when the feature at the index changed kind");
    check(/isn't there/.test(tryCall("patch_feature", bracket, 0, "sketch", { x: "1" }).error ?? ""), "refuses code features");
    check(/radius/.test(tryCall("patch_feature", bracket, 5, "fillet", { radius: "5 +" }).error ?? ""), "refuses a syntax error in an expression");
    check(/required/.test(tryCall("patch_feature", bracket, 5, "fillet", { radius: null }).error ?? ""), "refuses removing a required argument");
    check(/no argument/.test(tryCall("patch_feature", bracket, 5, "fillet", { depth: "1" }).error ?? ""), "refuses unknown arguments");
    check(/radius/.test(tryCall("patch_feature", bracket, 5, "fillet", { radius: "5)\n    Box(1, 1, 1" }).error ?? ""), "refuses an expression that tries to add a statement");
  });

  test("inserting features in canonical form", () => {
    let ins = call("insert_feature", empty, null, "sketch", { plane: "Plane.XY", body: ["Rectangle(40, 20)"] });
    check(ins.index === 0 && ins.name === "sk1" && ins.src.includes("    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:\n        Rectangle(40, 20)\n") && !ins.src.includes("pass"),
      "a sketch replaces the pass of an empty part", ins.src);
    ins = call("insert_feature", ins.src, ins.index, "extrude", { to_extrude: "sk1.sketch", amount: "5", both: "False", mode: null });
    check(ins.index === 1 && ins.src.includes("    extrude(sk1.sketch, amount=5)\n"), "an extrude: sketch positional, defaults left out", ins.src);
    let built = call("run", ins.src, "part.py");
    check(built.ok && Math.abs(built.summary.volume - 4000) < 1e-6, `the inserted sketch + extrude build (volume ${built.summary?.volume})`);
    ins = call("insert_feature", ins.src, null, "sketch", { plane: "part.faces().sort_by(Axis.Z)[-1]", body: ["Circle(3)"] });
    check(ins.name === "sk2" && ins.index === 2, "the next sketch is sk2, at the end");
    ins = call("insert_feature", ins.src, 2, "extrude", { to_extrude: "sk2.sketch", until: "Until.LAST", dir: "-sk2.sketch.faces()[0].normal_at()", mode: "Mode.SUBTRACT", clean: "False" });
    check(ins.src.includes("extrude(sk2.sketch, until=Until.LAST, dir=-sk2.sketch.faces()[0].normal_at(), mode=Mode.SUBTRACT, clean=False)"), "keywords in the dialog's order, extra ones after", ins.src.split("\n").at(-2));
    built = call("run", ins.src, "part.py");
    check(built.ok && Math.abs(built.summary.volume - (4000 - Math.PI * 9 * 5)) < 0.01, `cut through all from a face, into the part (volume ${built.summary?.volume?.toFixed(2)})`);
    inserted = ins.src;
    let ins2 = call("insert_feature", bracket, 2, "fillet", { objects: "bracket.edges().filter_by(Axis.Z)", radius: "1" });
    check(ins2.index === 3 && features(ins2.src)[3].kind === "fillet" && ins2.src.split("\n")[15] === "    fillet(bracket.edges().filter_by(Axis.Z), radius=1)",
      "insert after a feature (at the rollback bar)", ins2.src.split("\n")[15]);
    ins2 = call("insert_feature", bracket, -1, "chamfer", { objects: "bracket.edges()", length: "1" });
    check(ins2.index === 0 && features(ins2.src)[0].kind === "chamfer", "insert before the first feature");
    check(call("insert_feature", named, null, "sketch", { plane: "Plane.XZ", body: [] }).name === "sk2", "sketch names skip names already in the file");
    check(/no argument/.test(tryCall("insert_feature", bracket, null, "fillet", { objects: "bracket.edges()", size: "1" }).error ?? ""), "refuses unknown arguments");
    check(JSON.stringify(call("read_feature", ins.src, 3).sketches) === '["sk1","sk2"]', "an extrude can use the named sketches before it");
    check(JSON.stringify(call("read_feature", bracket, 3).sketches) === "[]", "implicit sketches aren't offered by name");
  });

  test("sketch outlines for the view: named sketches no feature uses yet", () => {
    const sketchOnly = call("insert_feature", empty, null, "sketch", { plane: "Plane.XZ", body: ["Circle(4)"] }).src;
    let run1 = call("run", sketchOnly, "part.py");
    check(run1.ok && !run1.mesh && run1.sketches.length === 1 && run1.sketches[0].name === "sk1" && run1.sketches[0].edges.length === 1,
      "a part with only a sketch: no solid, one outline");
    const ys = run1.sketches[0].edges[0].points.filter((_, i) => i % 3 === 1);
    check(ys.every((y) => Math.abs(y) < 1e-9) && run1.sketches[0].edges[0].points.length > 30, "the outline lies in its plane (XZ: y = 0), as a polyline");
    run1 = call("run", named, "part.py");
    check(run1.sketches.length === 0, "used sketches aren't drawn (one by name, one pending)");
    run1 = call("run", named, "part.py", 1);
    check(JSON.stringify(run1.sketches.map((x) => x.name)) === '["sk1","loose"]', "rolled back before their extrudes, both are drawn again");
    check(call("run", bracket, "bracket.py").sketches.length === 0 && call("run", bracket, "bracket.py", 0).sketches[0]?.name === "base", "the bracket's base sketch shows when rolled back to it");
  });

  test("deleting features", () => {
    let del = tryCall("delete_feature", inserted, 0);
    check(/used by 2\. Extrude sk1/.test(del.error ?? ""), `refuses deleting a sketch an extrude uses: ${del.error}`);
    del = tryCall("delete_feature", bracket, 2);
    check(/used by 4\. Extrude wall/.test(del.error ?? ""), `refuses deleting an implicit sketch an extrude takes: ${del.error}`);
    let out = call("delete_feature", bracket, 5);
    check(out === bracket.replace("    fillet(bracket.edges().filter_by(Axis.Z).group_by(Axis.Y)[0], radius=5)\n", ""), "deletes the fillet's line only");
    out = call("delete_feature", call("delete_feature", inserted, 3), 2);
    check(features(out).length === 2 && call("run", out, "part.py").ok, "delete the cut, then its sketch");
    out = call("delete_feature", "from build123d import *\n\nwith BuildPart() as part:\n    Box(1, 1, 1)  # cube\n", 0);
    check(out === "from build123d import *\n\nwith BuildPart() as part:\n    pass\n", "deleting the only feature leaves pass", out);
    check(/shares its line/.test(tryCall("delete_feature", "from build123d import *\n\nwith BuildPart() as part:\n    Box(1, 1, 1); Box(2, 2, 2)\n", 0).error ?? ""), "refuses a feature sharing its line");
  });

  const withPoints = bracket.replace("from build123d import *\n", "from build123d import *\nfrom caad import Constrained\n") + `    with BuildSketch(bracket.faces().filter_by(Axis.Z).sort_by(Axis.Z)[0], mode=Mode.PRIVATE) as sk1:
        with Constrained() as c:
            p1 = c.point(-20, -5)
            p2 = c.point(20, -5)
`;

  test("holes: kinds, depth, positions, a sketch's points", () => {
    check(features(bracket)[4].label === "Hole r = hole_d / 2", `the bracket's hole is a hole feature: "${features(bracket)[4].label}"`);
    call("run", bracket, "bracket.py", 3);
    const r = call("read_feature", bracket, 4);
    check(field(r, "kind").expr === "Hole" && field(r, "locations").expr === "(0, -6, thickness)" && field(r, "radius").value === "5" && field(r, "depth").expr == null && field(r, "depth").placeholder === "through all",
      "its fields: type, position, radius = 5, depth empty (through all)");
    check(field(r, "counter_bore_radius").show_if.kind === "CounterBoreHole" && !field(r, "counter_bore_radius").required, "counterbore fields only show for a counterbore hole");
    let out = patch(bracket, 4, { depth: "4" });
    check(out.includes("        Hole(hole_d / 2, depth=4)") && vol(out) > vol(bracket), "a depth: Hole(hole_d / 2, depth=4), less removed");
    out = patch(bracket, 4, { kind: "CounterBoreHole" });
    check(out.includes("        CounterBoreHole(radius=hole_d / 2, counter_bore_radius=10, counter_bore_depth=5)") && vol(out) < vol(bracket),
      "switching to a counterbore keeps the radius and starts its own sizes from it", out.split("\n")[17]);
    out = patch(out, 4, { kind: "Hole", counter_bore_radius: null, counter_bore_depth: null });
    check(out.includes("        Hole(radius=hole_d / 2)\n") && Math.abs(vol(out) - vol(bracket)) < 1e-6, "and back to a simple hole (its hidden fields dropped)");
    out = patch(bracket, 4, { locations: "(0, -6, thickness), (20, -6, thickness)" });
    check(out.includes("with Locations((0, -6, thickness), (20, -6, thickness)):") && Math.abs(vol(bracket) - vol(out) - Math.PI * 25 * 8) < 0.01, "two positions: two holes");
    check(/required/.test(tryCall("patch_feature", bracket, 4, "hole", { locations: null }).error ?? ""), "a hole needs a position");
    check(features(withPoints)[6].points === 2, "a sketch counts its drawn points");
    const ins = call("insert_feature", withPoints, null, "hole", { kind: "Hole", locations: "*points(sk1)", radius: "2.5" });
    check(ins.src.includes("\nfrom build123d import *\nfrom caad import Constrained, points\n") && ins.src.endsWith("    with Locations(*points(sk1)):\n        Hole(radius=2.5)\n"),
      "+ Hole at a sketch's points: with Locations(*points(sk1)): Hole(radius=2.5), and the import grows", ins.src.split("\n").slice(0, 3).join(" | "));
    check(features(ins.src)[7].label === "Hole r = 2.5 mm at sk1" && features(ins.src)[7].refs.includes("sk1") && Math.abs(vol(withPoints) - vol(ins.src) - 2 * Math.PI * 6.25 * 8) < 0.01,
      `two holes through the base ("${features(ins.src)[7].label}")`);
    call("run", ins.src, "bracket.py", 6);
    check(JSON.stringify(field(call("read_feature", ins.src, 7), "locations").options) === JSON.stringify([{ expr: "*points(sk1)", label: "sk1 (2 points)" }]), "At offers the sketches with points");
    const onlyPoints = call("run", withPoints, "bracket.py");
    check(onlyPoints.sketches[0]?.name === "sk1" && onlyPoints.sketches[0].points.length === 6 && onlyPoints.sketches[0].edges.length === 0, "a sketch of points shows them (no edges)");
  });

  test("holes: direction flags in the points() call", () => {
    // Read from and written to the points() call; + Hole drills toward the part by default.
    const xyPart = `from build123d import *\nfrom caad import Constrained\n\nwith BuildPart() as plate:\n    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:\n        with Constrained() as c:\n            c.rectangle((-30, -20), (30, 20))\n            p1 = c.point(10, 5)\n    extrude(sk1.sketch, amount=10)\n`;
    const ins = call("insert_feature", xyPart, null, "hole", { kind: "Hole", locations: "*points(sk1)", radius: "2" });
    check(ins.src.includes("    with Locations(*points(sk1, reverse=True)):\n        Hole(radius=2)\n"), "+ Hole with the sketch on XY under the part: drills up into it (reverse=True)", ins.src.split("\n").slice(-3).join(" | "));
    check(call("insert_feature", withPoints, null, "hole", { kind: "Hole", locations: "*points(sk1)", radius: "2" }).src.endsWith("    with Locations(*points(sk1)):\n        Hole(radius=2)\n"),
      "a sketch on a face: the plain direction (into the face)");
    call("run", ins.src, "plate.py", 1);
    const r = call("read_feature", ins.src, 2);
    check(field(r, "locations").expr === "*points(sk1)" && field(r, "reverse").expr === "True" && field(r, "far").expr == null, "the dialog reads: At sk1, Drill the other way, not from the far side");
    let out = patch(ins.src, 2, { kind: "CounterBoreHole", far: "True" });
    check(out.includes("    with Locations(*points(sk1, reverse=True, far=plate)):\n        CounterBoreHole(radius=2, counter_bore_radius=4, counter_bore_depth=2)\n"), "Start at the far side: far=plate (the part)", out.split("\n").slice(-3).join(" | "));
    out = patch(out, 2, { reverse: null, far: null });
    check(out.includes("    with Locations(*points(sk1)):\n"), "and both off again");
    check(!call("read_feature", bracket, 4).fields.some((x) => x.name === "reverse"), "a hole at explicit positions has no direction checkboxes");
  });

  test("revolve and mirror", () => {
    const ring = `from build123d import *\n\nwith BuildPart() as p:\n    with BuildSketch(Plane.XZ, mode=Mode.PRIVATE) as sk1:\n        with Locations((12.5, 2.5)):\n            Rectangle(5, 5)\n`;
    let ins = call("insert_feature", ring, null, "revolve", { profiles: "sk1.sketch", axis: "Axis.Z" });
    check(ins.src.endsWith("    revolve(sk1.sketch)\n") && features(ins.src)[1].label === "Revolve sk1, 360°" && Math.abs(vol(ins.src) - Math.PI * (225 - 100) * 5) < 0.01,
      "+ Revolve: revolve(sk1.sketch) (Z is the default axis), a ring");
    let out = patch(ins.src, 1, { revolution_arc: "90" });
    check(out.endsWith("    revolve(sk1.sketch, revolution_arc=90)\n") && features(out)[1].label === "Revolve sk1, 90°" && Math.abs(vol(out) - Math.PI * 125 * 5 / 4) < 0.01, "90°: a quarter ring");
    const r = call("read_feature", out, 1);
    check(field(r, "profiles").type === "sketch" && field(r, "axis").options.map((o) => o.expr).join() === "Axis.Z,Axis.X,Axis.Y", "revolve fields: sketch, axis (Z, X, Y), angle");
    const box = `from build123d import *\n\nwith BuildPart() as p:\n    with Locations((10, 0, 0)):\n        Box(4, 4, 4)\n`;
    ins = call("insert_feature", box, null, "mirror", { about: "Plane.YZ" });
    check(ins.src.endsWith("    mirror(about=Plane.YZ)\n") && features(ins.src)[1].label === "Mirror about YZ" && Math.abs(vol(ins.src) - 128) < 1e-6, "+ Mirror about YZ: mirror(about=Plane.YZ), twice the volume");
    out = patch(ins.src, 1, { about: "Plane.XZ" });
    check(out.endsWith("    mirror()\n") && features(out)[1].label === "Mirror about XZ", "XZ is the default: mirror()");
  });

  test("plane features: read, patched from their parts, inserted, sketched on, used by mirror", () => {
    const src = `from build123d import *\n\nwith BuildPart() as p:\n    Box(10, 10, 10)\n    pl1 = Plane.XZ.offset(-5).rotated((0, 0, 15))\n    a = 3\n`;
    let f = features(src);
    check(f[1].kind === "plane" && f[1].tier === "type" && f[1].name === "pl1" && f[1].label === "Plane pl1 on XZ, offset -5 mm, 15° about its normal" && f[2].tier === "code",
      "pl1 = Plane.XZ.offset(-5).rotated(…) is a plane feature (other assignments stay code)", f[1].label);
    call("run", src, "part.py", 0);
    const r = call("read_feature", src, 1);
    check(r.fields.map((x) => `${x.name}=${x.expr ?? ""}`).join() === "base=Plane.XZ,offset=-5,rx=,ry=,rz=15" && field(r, "base").pick === "face"
      && field(r, "base").value === "at (0, 0, 0), normal (0, -1, 0)", "fields: base (with face picking), offset and three angles; 0 reads as none", r.fields.map((x) => x.value));
    let out = patch(src, 1, { rz: "0", rx: "30", base: "Plane(p.faces().sort_by(Axis.Z)[-1])" });
    check(out.includes("    pl1 = Plane(p.faces().sort_by(Axis.Z)[-1]).offset(-5).rotated((30, 0, 0))\n"), "patched: the expression is rewritten from its parts", out);
    out = patch(out, 1, { rx: null, offset: "0" });
    check(out.includes("    pl1 = Plane(p.faces().sort_by(Axis.Z)[-1])\n") && features(out)[1].label === "Plane pl1 on a face", "no offset and no angles: just the base");
    check(/its offset and rotation are fields/.test(tryCall("patch_feature", src, 1, "plane", { base: "Plane.XY.offset(2)" }).error) &&
      /earlier plane/.test(tryCall("patch_feature", src, 1, "plane", { base: "a" }).error), "the base must be a plane, a face or an earlier plane");

    const ins = call("insert_feature", src, 1, "plane", { base: "pl1", offset: "5", rx: "0" });
    check(ins.name === "pl2" && ins.index === 2 && ins.src.includes("    pl1 = Plane.XZ.offset(-5).rotated((0, 0, 15))\n    pl2 = pl1.offset(5)\n") && features(ins.src)[2].refs.includes("pl1"),
      "+ Plane on pl1: pl2 = pl1.offset(5), using pl1");
    check(/used by 3\. Plane pl2/.test(tryCall("delete_feature", ins.src, 1).error), "a plane in use can't be deleted");
    check(call("insert_feature", empty, null, "plane", {}).src.includes("    pl1 = Plane.XY\n"), "+ Plane without parameters: on XY");

    // A sketch on a tilted plane, extruded along its normal; the plane is drawn until something uses it.
    const tilted = `from build123d import *\n\nwith BuildPart() as p:\n    pl1 = Plane.XY.offset(20).rotated((90, 0, 0))\n    with BuildSketch(pl1, mode=Mode.PRIVATE) as sk1:\n        Rectangle(4, 6)\n    extrude(sk1.sketch, amount=2)\n`;
    let run = call("run", tilted, "part.py", 0);
    check(run.planes.length === 1 && run.planes[0].name === "pl1" && run.planes[0].corners.length === 12 && run.planes[0].corners.filter((v, i) => i % 3 === 1).every((y) => Math.abs(y) < 1e-9)
      && Math.max(...run.planes[0].corners.filter((v, i) => i % 3 === 2)) > 20, "rolled back to the plane: a square in it (y = 0: it turns about its own x axis, up from z = 20)", run.planes[0]?.corners);
    run = call("run", tilted, "part.py");
    const [x0, y0, z0, x1, y1, z1] = run.summary.bbox;
    check(run.planes.length === 0 && Math.abs(x1 - x0 - 4) < 1e-6 && Math.abs(y1 - y0 - 2) < 1e-6 && Math.abs(z1 - z0 - 6) < 1e-6 && Math.abs(z0 - 17) < 1e-6,
      "the sketch on pl1 stands up (4 × 2 × 6, around z = 20); a used plane isn't drawn", run.summary.bbox);

    const mirrored = `from build123d import *\n\nwith BuildPart() as p:\n    with Locations((10, 0, 0)):\n        Box(4, 4, 4)\n    pl1 = Plane.YZ.offset(5)\n    mirror(about=pl1)\n`;
    call("run", mirrored, "part.py", 1);
    check(call("read_feature", mirrored, 2).fields.find((x) => x.name === "about").options.at(-1).expr === "pl1" && features(mirrored)[2].label === "Mirror about pl1"
      && call("run", mirrored, "part.py").summary.bbox[0] === -2, "mirror offers the planes before it; about x = 5 the copy is at x = -2…2", call("run", mirrored, "part.py").summary.bbox);
  });

  test("revolve about a line of a constrained sketch: axis(sk1, line1)", () => {
    const src = `from build123d import *\nfrom caad import Constrained\n\nwith BuildPart() as p:\n    with BuildSketch(Plane.XZ, mode=Mode.PRIVATE) as sk1:\n        with Constrained() as c:\n            rect1 = c.rectangle((10, 0), (14, 4))\n            line1 = c.line((20, 0), (20, 10), construction=True)\n    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk2:\n        with Constrained() as c:\n            line2 = c.line((0, 0), (5, 0))\n    revolve(sk1.sketch)\n`;
    call("run", src, "part.py", 1);
    const r = call("read_feature", src, 2);
    const opts = field(r, "axis").options.map((o) => `${o.expr}|${o.label}`);
    check(opts.slice(3).join() === ["bottom", "right", "top", "left"].map((s) => `axis(sk1, rect1.${s})|sk1: rect1.${s}`).join() + ",axis(sk1, line1)|sk1: line1 (construction),axis(sk2, line2)|sk2: line2",
      "axis options: Z, X, Y, then the lines of the sketches (the profile's first)", opts);
    const out = patch(src, 2, { axis: "axis(sk1, line1)" });
    check(out.includes("from caad import Constrained, axis\n") && out.endsWith("    revolve(sk1.sketch, axis=axis(sk1, line1))\n") && features(out)[2].label === "Revolve sk1, 360°, about line1",
      "patched: axis=axis(sk1, line1), imported from caad", out);
    check(Math.abs(vol(out) - Math.PI * (100 - 36) * 4) < 0.01, "a ring about x = 20: inner radius 6, outer 10, 4 high");
    check(Math.abs(vol(patch(src, 2, { axis: "axis(sk2, line2)" })) - Math.PI * 16 * 4) < 0.01, "about a line of another sketch (on the X axis): a cylinder of radius 4, 4 long");
    check(/a line of that sketch/.test(call("run", src.replace("revolve(sk1.sketch)", "revolve(sk1.sketch, axis=axis(sk2, line1))").replace("from caad import Constrained", "from caad import Constrained, axis"), "part.py").error?.message ?? ""),
      "axis() refuses a line of another sketch");
  });

  test("extruding chosen regions: sketch_regions for the view, regions(sk1, ...) in the code", () => {
    const src = `from build123d import *\nfrom caad import Constrained\n\nwith BuildPart() as p:\n    with BuildSketch(Plane.XY.offset(3), mode=Mode.PRIVATE) as sk1:\n        with Constrained() as c:\n            rect1 = c.rectangle((0, 0), (60, 40))\n            circle1 = c.circle((30, 20), 10)\n    extrude(sk1.sketch, amount=5)\n`;
    call("run", src, "part.py");
    let r = call("sketch_regions", "sk1.sketch");
    const ring = r.regions.findIndex((g) => !g.selected), disc = 1 - ring;
    check(r.name === "sk1" && r.regions.length === 2 && r.regions[disc].selected && JSON.stringify(r.regions[ring].at) === "[30,20]",
      "two regions; for sk1.sketch the ring is material, the disc (a hole) isn't", r.regions.map((g) => [g.at, g.selected]));
    check(r.regions.every((g) => g.triangles.length >= 9 && g.triangles.length % 9 === 0 && g.lines.length % 6 === 0 && g.triangles[2] === 3),
      "each has triangles and outline segments on the sketch's plane (z = 3)");
    const [x, y] = r.regions[ring].at;
    const out = patch(src, 1, { to_extrude: `regions(sk1, (${x}, ${y}))` });
    check(out.includes("from caad import Constrained, regions\n") && out.includes(`extrude(regions(sk1, (${x}, ${y})), amount=5)`) && features(out)[1].label === "Extrude sk1 (1 region), 5 mm",
      "patched: imported from caad, labelled by the sketch and the number of regions", features(out)[1].label);
    check(features(out)[1].refs.includes("sk1"), "the extrude still uses sk1");
    check(Math.abs(vol(out) - Math.PI * 100 * 5) < 0.01, "only the disc is extruded");
    call("run", out, "part.py");
    r = call("sketch_regions", `regions(sk1, (${x}, ${y}))`);
    check(r.regions[ring].selected && !r.regions[disc].selected, "the regions the points pick are the selected ones");
    check(call("sketch_regions", "nothing.sketch").name == null && call("sketch_regions", "Rectangle(3, 3)").regions.length === 0, "no sketch: no regions");
  });

  test("extruding the part's own faces: added, cut and intersected; labelled face or faces", () => {
    const box = "from build123d import *\n\nwith BuildPart() as part:\n    Box(20, 20, 10)\n";
    const top = "part.faces().sort_by(Axis.Z)[-1]", sides = "part.faces().filter_by(Axis.X)";
    let ins = call("insert_feature", box, 0, "extrude", { to_extrude: top, amount: "5" });
    check(ins.index === 1 && ins.src.includes(`    extrude(${top}, amount=5)\n`) && features(ins.src)[1].label === "Extrude face, 5 mm",
      "the top face, extruded: its selector in the code, labelled as a face", features(ins.src)[1].label);
    check(Math.abs(vol(ins.src) - 20 * 20 * 15) < 1e-6, "adds a 5 mm slab on top");
    const rf = call("read_feature", ins.src, 1);
    check(field(rf, "to_extrude").expr === top && field(rf, "to_extrude").label === "Sketch or faces",
      "the dialog's sketch field holds the selector");
    check(JSON.stringify(field(rf, "dir").inward) === '{"mode":["Mode.SUBTRACT","Mode.INTERSECT"]}', "opposite direction goes inward for removing and intersecting");
    const flip = `-${top}.faces()[0].normal_at()`;
    const cut = patch(ins.src, 1, { amount: "4", dir: flip, mode: "Mode.SUBTRACT" });
    check(features(cut)[1].label === "Cut face, 4 mm" && Math.abs(vol(cut) - 20 * 20 * 6) < 1e-6, "removing goes into the part from its top face", features(cut)[1].label);
    const inter = patch(cut, 1, { mode: "Mode.INTERSECT" });
    check(Math.abs(vol(inter) - 20 * 20 * 4) < 1e-6, "intersecting keeps the 4 mm under the face");
    const both = box.replace("    Box(20, 20, 10)\n", `    Box(20, 20, 10)\n    extrude(${sides}, amount=-3, mode=Mode.SUBTRACT)\n`);
    check(features(both)[1].label === "Cut faces, -3 mm" && Math.abs(vol(both) - 14 * 20 * 10) < 1e-6,
      "several faces (both sides): a negative depth goes into the part from each", features(both)[1].label);
  });

  test("shared code: the open part's project is importable (set_project, docs/07)", () => {
    const plateSrc = example("plate.py");
    const paramsSrc = read("examples/caad-examples/params.py");
    try {
      call("set_project", { "params.py": paramsSrc, "parts/plate.py": plateSrc });
      let shared = call("run", plateSrc, "caad-examples/parts/plate.py");
      check(shared.ok && Math.abs(shared.summary.bbox[3] - shared.summary.bbox[0] - 50) < 1e-6, "a part imports the project's params.py (50 wide)", shared.error?.message);
      call("set_project", { "params.py": paramsSrc.replace("plate_w = 50", "plate_w = 80"), "parts/plate.py": plateSrc });
      shared = call("run", plateSrc, "caad-examples/parts/plate.py");
      check(shared.ok && Math.abs(shared.summary.bbox[3] - shared.summary.bbox[0] - 80) < 1e-6, "an edited params.py is picked up on the next build (80 wide)");
      call("set_project", {});
      shared = call("run", plateSrc, "caad-examples/parts/plate.py");
      check(!shared.ok && /No module named 'params'/.test(shared.error.message), "another project's (or no) shared code isn't importable");
    } finally {
      call("set_project", {});
    }
  });

  test("export: the whole part as STEP or STL; the view's model stays as it was", () => {
    call("run", bracket, "bracket.py", 2); // the view is rolled back
    const exported = call("export_part", bracket, "bracket.py", "step");
    const stepText = new TextDecoder().decode(exported.data);
    const fullVolume = call("run", bracket, "bracket.py").summary.volume;
    call("run", bracket, "bracket.py", 2);
    check(stepText.startsWith("ISO-10303-21;") && exported.data.length > 10000 && Math.abs(exported.summary.volume - fullVolume) < 1e-6, `STEP: ${exported.data.length} bytes, the whole part (volume ${exported.summary.volume})`);
    py.FS.writeFile("/tmp/back.step", exported.data);
    check(Math.abs(py.runPython(`from build123d import import_step\nimport_step("/tmp/back.step").volume`) - fullVolume) < 1e-3, "read back, it has the same volume");
    const stl = call("export_part", bracket, "bracket.py", "stl");
    check(new TextDecoder().decode(stl.data.slice(0, 40)).startsWith("STL Exported") || stl.data.length > 1000, `STL: ${stl.data.length} bytes`);
    check(py.runPython("len(_current['shape'].faces())") === call("run", bracket, "bracket.py", 2).summary.faces, "the view's (rolled-back) model is left as it was");
    check(/doesn't build/.test(tryCall("export_part", bracket.replace("radius=5)", "radius=50)"), "bracket.py", "step").error ?? ""), "a part that doesn't build isn't exported");
    check(/use step or stl/.test(tryCall("export_part", bracket, "bracket.py", "obj").error ?? ""), "unknown formats are refused");
  });
});
