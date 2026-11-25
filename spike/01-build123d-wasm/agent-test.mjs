// Test the agent helpers in caad_kernel.py and every code example in app/public/agent/guide.md.
import { readFileSync } from "node:fs";
import { bootKernel } from "./kernel-env.mjs";
const py = await bootKernel(); // with PlaneGCS and caad.py: the guide has a constrained sketch
const js = (r) => (r?.toJs ? r.toJs({ dict_converter: Object.fromEntries }) : r);
const run = py.globals.get("run");

const guide = readFileSync("../../app/public/agent/guide.md", "utf8");
const blocks = [...guide.matchAll(/```python\n([\s\S]*?)```/g)].map((m) => m[1]);
for (const [i, code] of blocks.entries()) {
  const r = js(run(code, `guide_${i}.py`));
  console.log(`guide example ${i + 1}: ${r.ok ? "OK" : "FAIL"} ${r.summary ? `${r.summary.type} vol=${r.summary.volume} bbox=${r.summary.bbox}` : ""} ${r.error ? JSON.stringify(r.error) : ""}`);
}

run(readFileSync("../../examples/bracket.py", "utf8"), "bracket.py");
const snip = py.globals.get("snippet");
console.log("\nsnippet 1:", JSON.stringify(js(snip("print('hi')\nlen(bracket.edges().filter_by(Axis.Z))"))));
console.log("snippet 2:", JSON.stringify(js(snip("bracket.faces().sort_by(Axis.Z)[-1]"))).slice(0, 300));
console.log("snippet 3:", JSON.stringify(js(snip("width * 2 + undefined_name"))));
const help = py.globals.get("api_help");
console.log("\napi_help('fillet'):\n" + js(help("fillet")).slice(0, 400));
console.log("\napi_help('ShapeList.sort_by'):\n" + js(help("ShapeList.sort_by")).slice(0, 300));
console.log("\napi_help('Cone'):\n" + js(help("Cone")).split("\n\n")[1]);
console.log("\napi_help('CounterBoreHole'):\n" + js(help("CounterBoreHole")).split("\n\n")[1]);
console.log("\napi_help('Mode'):\n" + js(help("Mode")).slice(-200));
console.log("\napi_help('counterbore'):\n" + js(help("counterbore")).slice(0, 400));
const hl = py.globals.get("highlight_indices");
console.log("\nhighlight:", JSON.stringify(js(hl("bracket.edges().filter_by(Axis.Z)"))), JSON.stringify(js(hl("bracket.part"))), JSON.stringify(js(hl("bracket.nonsense()"))));
