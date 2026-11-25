// The page's kernel in Node: Pyodide with the lean build123d wheels and placeholders, PlaneGCS registered as
// `caad_gcs` (as the page's worker does), caad.py and caad_kernel.py. Run from this folder.
import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";
import { loadSolver } from "../../app/src/gcs-solve.ts";

/** `solver: false` leaves PlaneGCS out: sketches build from their stored geometry, as outside CAAD. */
export async function bootKernel({ solver = true } = {}) {
  const py = await loadPyodide();
  const site = py.runPython("import site; site.getsitepackages()[0]");
  for (const w of JSON.parse(readFileSync("wheels/list.json"))) py.unpackArchive(new Uint8Array(readFileSync("wheels/" + w)), "zip", { extractDir: site });
  py.runPython(readFileSync("snapshot2.mjs", "utf8").match(/const STUB_FINDER = `([\s\S]*?)`;/)[1]);
  if (solver) py.registerJsModule("caad_gcs", await loadSolver());
  py.FS.writeFile(`${site}/caad.py`, readFileSync("../../app/public/caad.py", "utf8"));
  py.runPython(readFileSync("../../app/public/caad_kernel.py", "utf8"));
  return py;
}

/** Call a kernel function with JS values; Python errors become short JS errors. */
export function caller(py) {
  const js = (r) => { if (r?.toJs) { const j = r.toJs({ dict_converter: Object.fromEntries }); r.destroy(); return j; } return r; };
  const call = (fn, ...args) => {
    try { return js(py.globals.get(fn)(...args.map((a) => py.toPy(a)))); }
    catch (e) { throw new Error(`${fn}: ${String(e.message).split("\n").filter(Boolean).at(-1)}`); } // Pyodide's own stack is huge
  };
  const tryCall = (fn, ...args) => { try { return { value: call(fn, ...args) }; } catch (e) { return { error: e.message.replace(`${fn}: `, "") }; } };
  return { call, tryCall };
}
