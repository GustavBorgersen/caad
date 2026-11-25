// Test the feature model in app/public/caad_kernel.py (docs/05-feature-model.md): tiers, the current
// sketch + extrude form, read_feature values, and surgical patch_feature edits. Node + lean wheels.
import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";
const py = await loadPyodide();
const site = py.runPython("import site; site.getsitepackages()[0]");
for (const w of JSON.parse(readFileSync("wheels/list.json"))) py.unpackArchive(new Uint8Array(readFileSync("wheels/" + w)), "zip", { extractDir: site });
py.runPython(readFileSync("snapshot2.mjs", "utf8").match(/const STUB_FINDER = `([\s\S]*?)`;/)[1]);
py.runPython(readFileSync("../../app/public/caad_kernel.py", "utf8"));

let failures = 0;
const check = (ok, what, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}: ${what}${!ok && detail ? `\n      ${detail}` : ""}`); if (!ok) failures++; };
const js = (r) => { if (r?.toJs) { const j = r.toJs({ dict_converter: Object.fromEntries }); r.destroy(); return j; } return r; };
const call = (fn, ...args) => {
  try { return js(py.globals.get(fn)(...args.map((a) => py.toPy(a)))); }
  catch (e) { throw new Error(`${fn}: ${String(e.message).split("\n").filter(Boolean).at(-1)}`); } // Pyodide's own stack is huge
};
const tryCall = (fn, ...args) => { try { return { value: call(fn, ...args) }; } catch (e) { return { error: e.message.replace(`${fn}: `, "") }; } };
const example = (f) => readFileSync(`../../examples/${f}`, "utf8");
const features = (src) => call("analyze", src).features;
const patch = (src, index, changes) => {
  const r = tryCall("patch_feature", src, index, features(src)[index].kind, changes);
  if (r.error) console.log(`      patch ${JSON.stringify(changes)}: ${r.error}`);
  return r.value;
};
/** The changed region between two sources: [removed, added]. */
const diff = (a, b) => {
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return [a.slice(i, a.length - j), b.slice(i, b.length - j)];
};

// --- Tiers and the current sketch + extrude form ---
const bracket = example("bracket.py");
let f = features(bracket);
check(JSON.stringify(f.map((x) => `${x.kind}/${x.tier}`)) === JSON.stringify(["sketch/code", "extrude/type", "sketch/code", "extrude/type", "group/code", "fillet/type"]),
  "bracket: kinds and tiers", JSON.stringify(f.map((x) => `${x.kind}/${x.tier}`)));
check(f[0].implicit && f[0].name === "base" && f[2].name === "wall", "implicit sketches with their names");
check(JSON.stringify(f[1].pending) === '["base"]' && JSON.stringify(f[3].pending) === '["wall"]', "each extrude takes the pending sketch before it");
check(f[1].label === "Extrude base, thickness" && f[5].label === "Fillet r = 5 mm", `labels: "${f[1].label}", "${f[5].label}"`);
check(f[5].refs.length === 0 && features(bracket.replace("Rectangle(width, 40)", "Rectangle(width, 40)\n    extrude(base.sketch, amount=1)"))[3].refs.includes("base"), "refs name earlier features");
const pump = features(example("pump_body.py"));
check(JSON.stringify(pump.map((x) => x.tier)) === JSON.stringify(["call", "call", "code", "code", "code", "type"]), "pump body: primitives are call features", JSON.stringify(pump.map((x) => x.tier)));

const named = `from build123d import *

with BuildPart() as p:
    with BuildSketch(Plane.XY, mode=Mode.PRIVATE) as sk1:
        Rectangle(40, 20)
    with BuildSketch(Plane.XY.offset(30)) as loose:
        Circle(3)
    extrude(sk1.sketch, amount=5)
    extrude(amount=2)
`;
f = features(named);
check(!f[0].implicit && f[1].implicit && f[2].pending === undefined && JSON.stringify(f[3].pending) === '["loose"]',
  "a private sketch isn't pending; an extrude with a sketch doesn't consume pending ones");
check(f[2].label === "Extrude sk1, 5 mm" && f[2].refs.includes("sk1"), `named sketch label and ref: "${f[2].label}"`);

// --- read_feature: fields, expressions and values in the rolled-back model ---
call("run", bracket, "bracket.py", 4); // rolled back to just before the fillet
let r = call("read_feature", bracket, 5);
const field = (rf, name) => rf.fields.find((x) => x.name === name);
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
check(before.ok && before.upto === -1 && !before.mesh && before.timeline.features.every((x) => x.status === "rolled-back"), "roll back to before the first feature (to edit it)", JSON.stringify(before.error));

// --- Round trip: unchanged fields give byte-identical source ---
for (const [name, src] of [["bracket", bracket], ["pump", example("pump_body.py")], ["named", named]]) {
  call("run", src, "part.py");
  for (const ft of features(src)) {
    if (ft.tier === "code") continue;
    const rf = call("read_feature", src, ft.index);
    const unchanged = Object.fromEntries(rf.fields.filter((x) => x.expr != null).map((x) => [x.name, x.expr]));
    check(patch(src, ft.index, unchanged) === src, `round trip: ${name} feature ${ft.index} (${ft.kind})`);
  }
}

// --- Surgical edits ---
let out = patch(bracket, 1, { amount: "12" });
check(JSON.stringify(diff(bracket, out)) === JSON.stringify(["thickness", "12"]), "change one argument: only its text changes", JSON.stringify(diff(bracket, out)));
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

// --- Refusals: nothing is written ---
check(/no longer|isn't there/.test(tryCall("patch_feature", bracket, 1, "fillet", { radius: "2" }).error ?? ""), "refuses when the feature at the index changed kind");
check(/isn't there/.test(tryCall("patch_feature", bracket, 0, "sketch", { x: "1" }).error ?? ""), "refuses code features");
check(/radius/.test(tryCall("patch_feature", bracket, 5, "fillet", { radius: "5 +" }).error ?? ""), "refuses a syntax error in an expression");
check(/required/.test(tryCall("patch_feature", bracket, 5, "fillet", { radius: null }).error ?? ""), "refuses removing a required argument");
check(/no argument/.test(tryCall("patch_feature", bracket, 5, "fillet", { depth: "1" }).error ?? ""), "refuses unknown arguments");
check(/radius/.test(tryCall("patch_feature", bracket, 5, "fillet", { radius: "5)\n    Box(1, 1, 1" }).error ?? ""), "refuses an expression that tries to add a statement");

// --- Inserting features in canonical form ---
const empty = "from build123d import *\n\nwith BuildPart() as part:\n    pass\n";
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
let ins2 = call("insert_feature", bracket, 2, "fillet", { objects: "bracket.edges().filter_by(Axis.Z)", radius: "1" });
check(ins2.index === 3 && features(ins2.src)[3].kind === "fillet" && ins2.src.split("\n")[15] === "    fillet(bracket.edges().filter_by(Axis.Z), radius=1)",
  "insert after a feature (at the rollback bar)", ins2.src.split("\n")[15]);
ins2 = call("insert_feature", bracket, -1, "chamfer", { objects: "bracket.edges()", length: "1" });
check(ins2.index === 0 && features(ins2.src)[0].kind === "chamfer", "insert before the first feature");
check(call("insert_feature", named, null, "sketch", { plane: "Plane.XZ", body: [] }).name === "sk2", "sketch names skip names already in the file");
check(/no argument/.test(tryCall("insert_feature", bracket, null, "fillet", { objects: "bracket.edges()", size: "1" }).error ?? ""), "refuses unknown arguments");
r = call("read_feature", ins.src, 3);
check(JSON.stringify(r.sketches) === '["sk1","sk2"]', `an extrude can use the named sketches before it: ${JSON.stringify(r.sketches)}`);
check(JSON.stringify(call("read_feature", bracket, 3).sketches) === "[]", "implicit sketches aren't offered by name");

// --- Sketch outlines for the view: named sketches no feature uses yet ---
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

// --- Deleting features ---
let del = tryCall("delete_feature", ins.src, 0);
check(/used by 2\. Extrude sk1/.test(del.error ?? ""), `refuses deleting a sketch an extrude uses: ${del.error}`);
del = tryCall("delete_feature", bracket, 2);
check(/used by 4\. Extrude wall/.test(del.error ?? ""), `refuses deleting an implicit sketch an extrude takes: ${del.error}`);
out = call("delete_feature", bracket, 5);
check(out === bracket.replace("    fillet(bracket.edges().filter_by(Axis.Z).group_by(Axis.Y)[0], radius=5)\n", ""), "deletes the fillet's line only");
out = call("delete_feature", call("delete_feature", ins.src, 3), 2);
check(features(out).length === 2 && call("run", out, "part.py").ok, "delete the cut, then its sketch");
out = call("delete_feature", "from build123d import *\n\nwith BuildPart() as part:\n    Box(1, 1, 1)  # cube\n", 0);
check(out === "from build123d import *\n\nwith BuildPart() as part:\n    pass\n", "deleting the only feature leaves pass", out);
check(/shares its line/.test(tryCall("delete_feature", "from build123d import *\n\nwith BuildPart() as part:\n    Box(1, 1, 1); Box(2, 2, 2)\n", 0).error ?? ""), "refuses a feature sharing its line");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
