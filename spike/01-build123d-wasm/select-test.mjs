// Test selection info and selector suggestions in app/public/caad_kernel.py (Node + lean wheels).
import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";
const py = await loadPyodide();
const site = py.runPython("import site; site.getsitepackages()[0]");
for (const w of JSON.parse(readFileSync("wheels/list.json"))) py.unpackArchive(new Uint8Array(readFileSync("wheels/" + w)), "zip", { extractDir: site });
py.runPython(readFileSync("snapshot2.mjs", "utf8").match(/const STUB_FINDER = `([\s\S]*?)`;/)[1]);
py.runPython(readFileSync("../../app/public/caad_kernel.py", "utf8"));
const js = (r) => { const j = r.toJs({ dict_converter: Object.fromEntries }); r.destroy?.(); return j; };
const test = (title, file, pickCode) => { try {
  py.globals.get("run")(readFileSync(`../../examples/${file}`, "utf8"), file).destroy();
  const [kind, idx] = js(py.runPython(pickCode));
  const t = performance.now();
  const r = js(py.globals.get("select")(kind, py.toPy(idx)));
  console.log(`\n== ${title}: ${kind}s ${JSON.stringify(idx)} (${(performance.now() - t).toFixed(0)} ms)`);
  for (const it of r.items) console.log("   ", JSON.stringify(it));
  for (const s of r.selectors) console.log(`    ${s.fragile ? "(fragile) " : ""}${s.expr}`);
  if (r.selectors[0]) console.log("    resolve(best) ->", JSON.stringify(js(py.globals.get("resolve")(kind, r.selectors[0].expr))));
} catch (e) { console.log(`\n== ${title}: ERROR`, String(e.message).split("\n").slice(-6).join("\n")); } };
const S = `_current["shape"]`;
test("highest face", "bracket.py", `fs=${S}.faces(); ["face", [max(range(len(fs)), key=lambda i: fs[i].center().Z)]]`);
test("front vertical edges (2)", "bracket.py", `es=${S}.edges(); ["edge", [i for i,e in enumerate(es) if e.geom_type.name=="LINE" and abs(e.tangent_at(0).Z)>0.99 and e.center().Y < -19]]`);
test("hole wall", "bracket.py", `fs=${S}.faces(); ["face", [i for i,f in enumerate(fs) if f.geom_type.name=="CYLINDER" and f.area < 300]]`);
test("a bolt-hole circle on top", "pump_body.py", `es=${S}.edges(); c=[i for i,e in enumerate(es) if e.geom_type.name=="CIRCLE" and abs(e.radius-2.25)<0.01 and e.center().Z>34]; ["edge", c[:1]]`);
test("all 4 bolt holes (faces)", "pump_body.py", `fs=${S}.faces(); ["face", [i for i,f in enumerate(fs) if f.geom_type.name=="CYLINDER" and f.area < 600]]`);
