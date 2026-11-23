// Spike 1b: does a Pyodide memory snapshot (taken after `import build123d`) make start-up fast?
import { loadPyodide } from "pyodide";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
const t = () => performance.now();
const ms = (a, b) => `${((b - a) / 1000).toFixed(1)} s`;
const SNAP = "build123d.snapshot";
const model = `
from build123d import *
with BuildPart() as p:
    Cylinder(50, 35)
    Cylinder(35, 35, mode=Mode.SUBTRACT)
    with PolarLocations(45, 4):
        Cylinder(2.25, 35, mode=Mode.SUBTRACT)
f"faces={len(p.part.faces())} volume={p.part.volume:.0f}"
`;
try {
if (!existsSync(SNAP)) {
  const t0 = t();
  const py = await loadPyodide({ _makeSnapshot: true });
  await py.loadPackage("micropip");
  py.runPython(readFileSync("bootstrap.py", "utf8"));
  await py.runPythonAsync("await bootstrap()");
  await py.runPythonAsync("import build123d");
  // Snapshots need Python to hold no references to JS objects: drop the installer and collect.
  py.runPython(`
import sys, gc
for name in [m for m in sys.modules if m.startswith(("micropip", "pyodide.http", "pyodide_js", "js"))]:
    del sys.modules[name]
for name in [g for g in list(globals()) if not g.startswith("__")]:
    del globals()[name]
gc.collect()
`);
  writeFileSync(SNAP, py.makeMemorySnapshot());
  console.log(`snapshot written: ${(statSync(SNAP).size / 1e6).toFixed(0)} MB in ${ms(t0, t())}`);
} else {
  const t0 = t();
  const py = await loadPyodide({ _loadSnapshot: readFileSync(SNAP) });
  const t1 = t();
  console.log(`loaded from snapshot: ${ms(t0, t1)}`);
  await py.runPythonAsync("import build123d");
  const t2 = t();
  console.log(`import build123d: ${ms(t1, t2)}`);
  console.log(`model: ${await py.runPythonAsync(model)} in ${ms(t2, t())}`);
  console.log(`TOTAL start to first model: ${ms(t0, t())}`);
}
} catch (e) {
  console.log("ERROR: " + String(e.message || e).split("\n").slice(-8).join("\n").slice(0, 1500));
  process.exit(1);
}
