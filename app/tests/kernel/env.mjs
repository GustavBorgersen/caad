// The page's kernel in Node, booted once per process (importing this waits for it): Pyodide from the npm
// package, the wheels in kernel-lock.json (public/kernel/, fetched when missing), the worker's placeholder
// modules, PlaneGCS registered as `caad_gcs`, caad.py and caad_kernel.py: as src/kernel.worker.ts does.
import { readFileSync } from "node:fs";
import { loadPyodide } from "pyodide";
import { fetchKernel } from "../../scripts/kernel-fetch.mjs";
import { loadSolver } from "../../src/gcs-solve.ts";
import { STUBS } from "../../src/kernel-stubs.ts";

const APP = new URL("../../", import.meta.url);
/** A file's text, by its path from the repository root. */
export const read = (path) => readFileSync(new URL(`../${path}`, APP), "utf8");
export const example = (f) => read(`examples/caad-examples/parts/${f}`);

await fetchKernel({ log: (m) => console.error(m) });
const lock = JSON.parse(readFileSync(new URL("kernel-lock.json", APP), "utf8"));
export const py = await loadPyodide();
const site = py.runPython("import site; site.getsitepackages()[0]");
for (const w of lock.wheels) py.unpackArchive(new Uint8Array(readFileSync(new URL(`public/kernel/wheels/${w.file}`, APP))), "zip", { extractDir: site });
py.runPython(STUBS);
export const solver = await loadSolver();
py.registerJsModule("caad_gcs", solver);
py.FS.writeFile(`${site}/caad.py`, read("app/public/caad.py"));
py.runPython(read("app/public/caad_kernel.py"));

/** A Python result as JS (dicts as objects). */
export const js = (r) => { if (r?.toJs) { const j = r.toJs({ dict_converter: Object.fromEntries }); r.destroy(); return j; } return r; };
/** Call a kernel function with JS values; Python errors become short JS errors. */
export const call = (fn, ...args) => {
  try { return js(py.globals.get(fn)(...args.map((a) => py.toPy(a)))); }
  catch (e) { throw new Error(`${fn}: ${String(e.message).split("\n").filter(Boolean).at(-1)}`); } // Pyodide's own stack is huge
};
export const tryCall = (fn, ...args) => { try { return { value: call(fn, ...args) }; } catch (e) { return { error: e.message.replace(`${fn}: `, "") }; } };
export const pyval = (expr) => js(py.runPython(expr));
export const near = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;
export { check } from "../common.mjs";
