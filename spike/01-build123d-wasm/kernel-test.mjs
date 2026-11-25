// Test app/public/caad_kernel.py in Node with the lean install from snapshot2.mjs's wheels.
import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";
const py = await loadPyodide();
const site = py.runPython("import site; site.getsitepackages()[0]");
for (const w of JSON.parse(readFileSync("wheels/list.json"))) py.unpackArchive(new Uint8Array(readFileSync("wheels/" + w)), "zip", { extractDir: site });
py.runPython(readFileSync("snapshot2.mjs", "utf8").match(/const STUB_FINDER = `([\s\S]*?)`;/)[1]);
py.runPython(readFileSync("../../app/public/caad_kernel.py", "utf8"));
const run = py.globals.get("run");
const show = (title, r) => {
  const j = r.toJs({ dict_converter: Object.fromEntries }); r.destroy();
  console.log(`\n== ${title}: ok=${j.ok} upto=${j.upto} build=${j.times.build}s mesh=${j.times.mesh}s` +
    (j.mesh ? ` faces=${j.mesh.faces.length} edges=${j.mesh.edges.length} tris=${j.mesh.indices.length / 3}` : " no mesh"));
  if (j.error) console.log("   error:", j.error);
  for (const f of j.timeline?.features ?? []) console.log(`   ${String(f.index).padStart(2)} L${f.line}-${f.end} ${f.status.padEnd(11)} ${f.kind.padEnd(10)} ${f.label}`);
};
const bracket = readFileSync("../../examples/caad-examples/parts/bracket.py", "utf8");
const pump = readFileSync("../../examples/caad-examples/parts/pump_body.py", "utf8");
show("bracket", run(bracket, "bracket.py"));
show("bracket rolled back to feature 1", run(bracket, "bracket.py", 1));
show("pump", run(pump, "pump_body.py"));
show("pump, bad fillet", run(pump.replace("radius=1)", "radius=20)"), "pump_body.py"));
show("syntax error", run(pump.replace("Cylinder(outer_r", "Cylinder((outer_r"), "pump_body.py"));
show("no builder", run("from build123d import *\nresult = Box(10, 20, 30) - Cylinder(4, 30)\n", "algebra.py"));
