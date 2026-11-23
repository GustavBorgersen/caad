// Spike 1: can build123d run in WebAssembly (Pyodide + OCP.wasm), and how fast?
// Runs Pyodide under Node.js — the same wasm build a browser would load.
import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";

const t = () => performance.now();
const ms = (a, b) => `${((b - a) / 1000).toFixed(1)} s`;

const t0 = t();
const pyodide = await loadPyodide();
const t1 = t();
console.log(`Pyodide ${pyodide.version} loaded: ${ms(t0, t1)}`);

await pyodide.loadPackage("micropip");
pyodide.runPython(readFileSync(new URL("./bootstrap.py", import.meta.url), "utf8"));
await pyodide.runPythonAsync("await bootstrap()");
const t2 = t();
console.log(`build123d + OCP.wasm installed: ${ms(t1, t2)}`);

await pyodide.runPythonAsync("import build123d");
const t3 = t();
console.log(`import build123d: ${ms(t2, t3)}  (version ${pyodide.runPython("build123d.__version__")})`);

// The MiniBrewery pump body: Ø100 x 35 ring with bore, recess, groove, two tube slots, four bolt holes.
const model = `
from build123d import *
import time
t = time.perf_counter()
with BuildPart() as body:
    Cylinder(50, 35, align=(Align.CENTER, Align.CENTER, Align.MIN))
    Cylinder(35, 35, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    Cylinder(40, 6, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    with Locations((0, 0, 18)):
        Cylinder(39.5, 17, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    with Locations((-33.5, 25, 26.5), (33.5, 25, 26.5)):
        Box(13, 50, 17, mode=Mode.SUBTRACT)
    with PolarLocations(45, 4):
        Cylinder(2.25, 35, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    fillet(body.edges().filter_by(GeomType.CIRCLE).group_by(Axis.Z)[0].sort_by(SortBy.RADIUS)[-1:], radius=1)
build_s = time.perf_counter() - t
part = body.part
t = time.perf_counter()
verts, tris = part.tessellate(0.05, 0.2)
tess_s = time.perf_counter() - t
f"faces={len(part.faces())} volume={part.volume:.0f} mm3 build={build_s:.2f}s tessellate={tess_s:.2f}s ({len(tris)} triangles)"
`;
const t4 = t();
let result;
try {
  result = await pyodide.runPythonAsync(model);
} catch (e) {
  console.log("MODEL ERROR:\n" + String(e.message).split("\n").slice(-12).join("\n"));
  process.exit(1);
}
const t5 = t();
console.log(`pump body: ${result}`);
console.log(`total model step: ${ms(t4, t5)}`);

// Second run: the realistic "edit and rebuild" loop once everything is warm.
const t6 = t();
await pyodide.runPythonAsync(model);
console.log(`rebuild (warm): ${ms(t6, t())}`);
console.log(`TOTAL cold start to first model: ${ms(t0, t5)}`);
